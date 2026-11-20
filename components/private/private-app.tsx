"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { ModelSetup } from "@/components/private/model-setup";
import { BetaBadge, PrivateChip, SAFARI_BETA_TEXT } from "@/components/private/private-badges";
import { PrivateMessageList } from "@/components/private/private-message-list";
import { PrivateSidebar } from "@/components/private/private-sidebar";
import { UnavailableState } from "@/components/private/unavailable-state";
import {
  LocalRuntimeError,
  type CapabilityReport,
  type LocalModelDescriptor,
  type LocalRuntimeErrorKind,
  type LoadProgress,
} from "@/lib/private/core/local-provider";
import { TIER_ORDER, type ModelTier } from "@/lib/private/core/model-catalog";
import {
  clearFailures,
  pickTier,
  type TierDecision,
  type UnavailableReason,
} from "@/lib/private/core/tier-policy";
import { downloadTextFile } from "@/lib/private/web/browser";
import { StoragePersistence } from "@/lib/private/web/storage-persistence";
import { acquireEngineLock, type EngineLock } from "@/lib/private/web/engine-lock";
import { loadPrefs, prefsExist, savePrefs, type PrivatePrefs } from "@/lib/private/web/prefs";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";
import { recoverFromCapacityFailure } from "@/lib/private/web/engine-recovery";
import { submitPrivateMessage } from "@/lib/private/web/submit";
import { createLocalProvider, probeFor, type PrivateEngine } from "@/lib/private/web/provider-factory";

type OkDecision = Extract<TierDecision, { status: "ok" }>;

type EngineState =
  | { kind: "probing" }
  | { kind: "locked" }
  | { kind: "no_storage" }
  | { kind: "unavailable"; reason: UnavailableReason }
  | {
      kind: "setup";
      decision: OkDecision;
      cached: boolean;
      phase: "idle" | "loading";
      progress: LoadProgress | null;
      error: LocalRuntimeErrorKind | null;
    }
  | { kind: "ready"; decision: OkDecision };

function descriptorFor(decision: OkDecision): LocalModelDescriptor {
  return {
    id: decision.model.id,
    tier: decision.tier,
    displayName: decision.model.displayName,
    contextWindowTokens: decision.artifact.contextWindowTokens,
    artifact: decision.artifact,
  };
}

/**
 * The Private Mode surface. Everything here is local: capability probe,
 * engine (in a worker), IndexedDB history. There is no fetch, no analytics
 * and no error reporting; the layout above mounts no telemetry providers.
 */
export function PrivateApp() {
  const [engine, setEngine] = useState<EngineState>({ kind: "probing" });
  const [controller, setController] = useState<PrivateChatController | null>(null);
  const [cleared, setCleared] = useState<"partial" | "first_run" | null>(null);
  const [safariNotice, setSafariNotice] = useState(false);
  const [isSafari, setIsSafari] = useState(false);

  const providerRef = useRef<PrivateEngine | null>(null);
  const storeRef = useRef<IndexedDBThreadStore | null>(null);
  const controllerRef = useRef<PrivateChatController | null>(null);
  const reportRef = useRef<CapabilityReport | null>(null);
  const prefsRef = useRef<PrivatePrefs | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  /** Stable for the component's lifetime; asks for persistent storage at most once per trigger. */
  const [persistence] = useState(() => new StoragePersistence());
  const decideRef = useRef<(previousError?: LocalRuntimeErrorKind | null) => Promise<void>>(
    async () => {},
  );
  const recoverRef = useRef<(kind: LocalRuntimeErrorKind, failedTier: ModelTier) => Promise<void>>(
    async () => {},
  );
  /** Tier of the model currently loaded, for generation-time failures. */
  const loadedTierRef = useRef<ModelTier | null>(null);

  const startLoad = useCallback(async (decision: OkDecision, cached: boolean) => {
    const provider = providerRef.current;
    const store = storeRef.current;
    if (!provider || !store) return;
    const descriptor = descriptorFor(decision);
    const abort = new AbortController();
    loadAbortRef.current = abort;
    setEngine({ kind: "setup", decision, cached, phase: "loading", progress: null, error: null });

    try {
      await provider.load(
        descriptor,
        (progress) =>
          setEngine((current) =>
            current.kind === "setup" && current.phase === "loading" ? { ...current, progress } : current,
          ),
        abort.signal,
      );
      void persistence.request("model_ready");
      const downloaded = (await store.getMeta<string[]>("downloadedModelIds")) ?? [];
      if (!downloaded.includes(descriptor.artifact.modelId)) {
        await store.setMeta("downloadedModelIds", [...downloaded, descriptor.artifact.modelId]);
      }
      controllerRef.current?.setModel(descriptor);
      loadedTierRef.current = decision.tier;
      setEngine({ kind: "ready", decision });
    } catch (error) {
      const runtime = error instanceof LocalRuntimeError ? error : new LocalRuntimeError("unknown");
      if (runtime.kind === "cancelled") {
        setEngine({ kind: "setup", decision, cached, phase: "idle", progress: null, error: null });
        return;
      }
      if (runtime.kind === "quota_exceeded" || runtime.kind === "integrity_failed") {
        await provider.deleteCached(descriptor).catch(() => undefined);
      }
      if (runtime.isLoadCapacityFailure) {
        await recoverRef.current(runtime.kind, decision.tier);
        return;
      }
      setEngine({ kind: "setup", decision, cached, phase: "idle", progress: null, error: runtime.kind });
    } finally {
      loadAbortRef.current = null;
    }
  }, [persistence]);

  const decide = useCallback(
    async (previousError: LocalRuntimeErrorKind | null = null) => {
      const report = reportRef.current;
      const prefs = prefsRef.current;
      const provider = providerRef.current;
      if (!report || !prefs || !provider) return;

      const decision = pickTier(report, {
        choice: prefs.choice,
        failures: prefs.failures,
        now: Date.now(),
      });
      if (decision.status === "unavailable") {
        setEngine({ kind: "unavailable", reason: decision.reason });
        return;
      }
      const cached = await provider.isCached(descriptorFor(decision));
      const store = storeRef.current;
      const downloaded = (await store?.getMeta<string[]>("downloadedModelIds")) ?? [];
      if (!cached && downloaded.includes(decision.artifact.modelId)) setCleared("partial");

      // Loading from this device's cache is not a download; anything else needs a click.
      if (cached && !previousError) {
        await startLoad(decision, true);
        return;
      }
      setEngine({ kind: "setup", decision, cached, phase: "idle", progress: null, error: previousError });
    },
    [startLoad],
  );

  /**
   * Capacity failure at load or mid-generation: dispose the model, record the tier failure, step down; a cached lower tier loads, an
   * uncached one waits for an explicit download click.
   */
  const recover = useCallback(
    async (kind: LocalRuntimeErrorKind, failedTier: ModelTier) => {
      const report = reportRef.current;
      const prefs = prefsRef.current;
      const provider = providerRef.current;
      if (!report || !prefs || !provider) return;
      controllerRef.current?.setModel(null);
      loadedTierRef.current = null;
      await provider.unload().catch(() => undefined);

      const { failures, next } = await recoverFromCapacityFailure({
        report,
        choice: prefs.choice,
        failures: prefs.failures,
        failedTier,
        now: Date.now(),
        isCached: (decision) => provider.isCached(descriptorFor(decision)),
      });
      prefsRef.current = { ...prefs, failures };
      savePrefs(prefsRef.current);

      if (next.action === "unavailable") {
        setEngine({ kind: "unavailable", reason: next.reason });
      } else if (next.action === "load") {
        await startLoad(next.decision, true);
      } else {
        setEngine({
          kind: "setup",
          decision: next.decision,
          cached: false,
          phase: "idle",
          progress: null,
          error: kind,
        });
      }
    },
    [startLoad],
  );

  useEffect(() => {
    decideRef.current = decide;
    recoverRef.current = recover;
  }, [decide, recover]);

  // ---------------------------------------------------------------- startup
  useEffect(() => {
    let lock: EngineLock | null = null;
    let disposed = false;

    void (async () => {
      lock = await acquireEngineLock();
      if (disposed) return lock?.release();
      if (!lock) {
        setEngine({ kind: "locked" });
        return;
      }

      void persistence.check();
      const hadPrefs = prefsExist();
      const prefs = loadPrefs();
      prefsRef.current = prefs;

      let store: IndexedDBThreadStore;
      try {
        store = await IndexedDBThreadStore.open();
      } catch {
        setEngine({ kind: "no_storage" });
        return;
      }
      storeRef.current = store;

      const initializedAt = await store.getMeta<number>("initializedAt");
      if (!initializedAt) {
        await store.setMeta("initializedAt", Date.now());
        setCleared(hadPrefs ? "partial" : "first_run");
      }

      const provider = await createLocalProvider();
      if (disposed) return;
      providerRef.current = provider;

      const chat = new PrivateChatController({
        provider,
        store,
        profileKey: "anon",
        deviceId: prefs.deviceId,
        writeClipboard: (text) => navigator.clipboard.writeText(text),
        onUserMessageSaved: () => void persistence.request("first_chat_saved"),
        onRuntimeError: (error) => {
          const tier = loadedTierRef.current;
          if (error.isLoadCapacityFailure && tier) {
            toast.error("The on-device model ran out of resources. Trying a lighter setup…");
            void recoverRef.current(error.kind, tier);
          } else if (error.kind === "worker_failed" || error.kind === "not_loaded") {
            // Not evidence the tier doesn't fit: retry the same decision.
            toast.error("The on-device model stopped. Reloading it…");
            controllerRef.current?.setModel(null);
            loadedTierRef.current = null;
            void decideRef.current();
          }
        },
      });
      controllerRef.current = chat;
      await chat.init();
      if (disposed) return;
      setController(chat);

      const report = await probeFor(provider);
      reportRef.current = report;
      setIsSafari(report.isSafari);
      setSafariNotice(report.isSafari && !prefs.safariNoticeSeen);
      await decide();
    })();

    return () => {
      disposed = true;
      loadAbortRef.current?.abort();
      providerRef.current?.dispose();
      storeRef.current?.close();
      lock?.release();
    };
  }, [decide, persistence]);

  // --------------------------------------------------------------- handlers
  const chooseTier = (tier: ModelTier) => {
    if (!prefsRef.current) return;
    prefsRef.current = { ...prefsRef.current, choice: tier };
    savePrefs(prefsRef.current);
    void decide();
  };

  const retryBlocked = () => {
    if (!prefsRef.current) return;
    let failures = prefsRef.current.failures;
    for (const tier of TIER_ORDER) failures = clearFailures(failures, tier);
    prefsRef.current = { ...prefsRef.current, failures };
    savePrefs(prefsRef.current);
    void decide();
  };

  const dismissSafari = () => {
    setSafariNotice(false);
    if (!prefsRef.current) return;
    prefsRef.current = { ...prefsRef.current, safariNoticeSeen: true };
    savePrefs(prefsRef.current);
  };

  // ----------------------------------------------------------------- render
  let main: React.ReactNode;
  switch (engine.kind) {
    case "probing":
      main = <p className="text-muted-foreground p-10 text-center text-sm">Checking this device…</p>;
      break;
    case "locked":
      main = (
        <p className="text-muted-foreground p-10 text-center text-sm" role="alert">
          Private Mode is open in another tab. Close it there to use Private Mode here.
        </p>
      );
      break;
    case "no_storage":
      main = (
        <p className="text-muted-foreground p-10 text-center text-sm" role="alert">
          Private Mode needs browser storage, which is unavailable here (for example in a private
          browsing window).
        </p>
      );
      break;
    case "unavailable":
      main = <UnavailableState reason={engine.reason} onRetryBlocked={retryBlocked} />;
      break;
    case "setup":
      main = (
        <ModelSetup
          tier={engine.decision.tier}
          recommended={engine.decision.recommended}
          selectable={engine.decision.selectable}
          shaderF16={engine.decision.artifact.requiresShaderF16}
          cached={engine.cached}
          phase={engine.phase}
          progress={engine.progress}
          error={engine.error}
          steppedDown={engine.decision.steppedDown}
          showSafariNotice={safariNotice}
          safariBeta={isSafari}
          clearedNotice={cleared}
          onDownload={() => void startLoad(engine.decision, engine.cached)}
          onCancel={() => loadAbortRef.current?.abort()}
          onChooseTier={chooseTier}
          onDismissSafari={dismissSafari}
        />
      );
      break;
    case "ready":
      main = null;
      break;
  }

  const modelName = engine.kind === "ready" ? engine.decision.model.displayName : null;
  return (
    <PrivateShell
      controller={controller}
      ready={engine.kind === "ready"}
      modelName={modelName}
      notice={main}
      safariBeta={isSafari}
      persistence={persistence}
    />
  );
}

const EMPTY_STATE = {
  threads: [],
  activeThreadId: null,
  messages: [],
  streamingId: null,
  recoveredInterrupted: 0,
};
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_STATE;

function PrivateShell({
  controller,
  ready,
  modelName,
  notice,
  safariBeta,
  persistence,
}: {
  controller: PrivateChatController | null;
  ready: boolean;
  modelName: string | null;
  notice: React.ReactNode;
  safariBeta: boolean;
  persistence: StoragePersistence;
}) {
  const persistState = useSyncExternalStore(
    persistence.subscribe,
    persistence.getState,
    () => "checking" as const,
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? emptySnapshot,
    emptySnapshot,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const exportThread = async (format: "json" | "md") => {
    const file = await controller?.exportActive(format);
    if (file) downloadTextFile(file.fileName, file.text, file.mime);
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="border-border hidden w-[264px] shrink-0 border-r md:block">
        <PrivateSidebar
          threads={state.threads}
          activeThreadId={state.activeThreadId}
          onSelect={(id) => void controller?.selectThread(id)}
          onNew={() => void controller?.newThread()}
          onDelete={(id) => void controller?.deleteThread(id)}
          onExport={(format) => void exportThread(format)}
          persistState={persistState}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border flex items-center justify-between gap-2 border-b px-3 py-2 md:hidden">
          <span className="text-sm font-semibold tracking-[0.18em] uppercase">Korum · Private</span>
        </header>
        {safariBeta && (
          <div
            role="note"
            className="border-border flex items-center justify-center gap-2 border-b px-3 py-1.5 text-xs"
          >
            <BetaBadge />
            {SAFARI_BETA_TEXT}. Safari may delete Private Mode data after 7 days without a visit;
            export chats you want to keep.
          </div>
        )}
        <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {notice}
          {state.recoveredInterrupted > 0 && (
            <p className="text-muted-foreground mx-auto max-w-3xl px-4 pt-4 text-xs">
              {state.recoveredInterrupted === 1 ? "An answer was" : "Some answers were"} cut off
              when this tab closed. They are marked interrupted.
            </p>
          )}
          {ready && state.messages.length === 0 && (
            <div className="mx-auto max-w-xl px-6 py-20 text-center">
              <h1 className="text-lg font-semibold tracking-tight">Private Mode</h1>
              <p className="text-muted-foreground mt-2 text-sm leading-6">
                Answers come from a model running on this device. Your messages stay in this
                browser and are never sent to KORUM.
              </p>
            </div>
          )}
          {state.messages.length > 0 && (
            <PrivateMessageList
              messages={state.messages}
              streamingId={state.streamingId}
              onCopy={(id) => controller?.copy(id) ?? Promise.resolve()}
              onThumb={(id, thumb) => void controller?.setThumb(id, thumb)}
              onRegenerate={() => void controller?.regenerate()}
            />
          )}
        </main>
        <Composer
          onSubmit={(text) =>
            void submitPrivateMessage(controller, text, {
              getDraft: () => composerRef.current?.getValue() ?? "",
              restoreDraft: (draft) => composerRef.current?.setValue(draft),
              showError: (message, action) =>
                toast.error(message, action ? { action, duration: 30_000 } : undefined),
            })
          }
          handleRef={composerRef}
          onStop={() => controller?.stop()}
          streaming={state.streamingId !== null}
          disabled={!ready || !controller}
          autoFocus
          modeSlot={<PrivateChip model={modelName} beta={safariBeta} />}
          placeholder={ready ? "Ask privately…" : "Private Mode isn't ready on this device"}
          footnote="Runs on this device. Nothing you type here is sent to KORUM."
        />
      </div>
    </div>
  );
}
