"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Composer, type ComposerHandle } from "@/components/chat/composer";
import { BuiltinSetup } from "@/components/private/builtin-setup";
import { ModelSetup } from "@/components/private/model-setup";
import { BetaBadge, PrivateChip, SAFARI_BETA_TEXT } from "@/components/private/private-badges";
import { PrivateMessageList } from "@/components/private/private-message-list";
import { PrivateSidebar } from "@/components/private/private-sidebar";
import { ProviderBar } from "@/components/private/provider-bar";
import { UnavailableState } from "@/components/private/unavailable-state";
import {
  BUILTIN_MODEL,
  BUILTIN_PRIVACY_COPY,
  builtinUsable,
  type BuiltinVendor,
} from "@/lib/private/core/provider-policy";
import { downloadTextFile } from "@/lib/private/web/browser";
import { StoragePersistence } from "@/lib/private/web/storage-persistence";
import { acquireEngineLock, type EngineLock } from "@/lib/private/web/engine-lock";
import {
  chatModelName,
  isUnavailable,
  PrivateEngineManager,
  type EngineState,
} from "@/lib/private/web/engine-manager";
import { loadPrefs, prefsExist, savePrefs, type PrivatePrefs } from "@/lib/private/web/prefs";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { detectBuiltin } from "@/lib/private/web/prompt-api";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";
import { submitPrivateMessage } from "@/lib/private/web/submit";
import {
  createBuiltinProvider,
  createLocalProvider,
  probeFor,
} from "@/lib/private/web/provider-factory";

type ShellPhase = "starting" | "locked" | "no_storage" | "running";

/**
 * The Private Mode surface. Everything here is local: the browser's built-in
 * model (Prompt API, main thread) or a WebLLM tier (in a worker), and
 * IndexedDB history. There is no fetch, no analytics and no error
 * reporting; the layout above mounts no telemetry providers.
 */
export function PrivateApp() {
  const [shell, setShell] = useState<ShellPhase>("starting");
  const [manager, setManager] = useState<PrivateEngineManager | null>(null);
  const [controller, setController] = useState<PrivateChatController | null>(null);
  const [cleared, setCleared] = useState<"partial" | "first_run" | null>(null);
  const [safariNotice, setSafariNotice] = useState(false);

  const prefsRef = useRef<PrivatePrefs | null>(null);
  /** Stable for the component's lifetime; asks for persistent storage at most once per trigger. */
  const [persistence] = useState(() => new StoragePersistence());

  // ---------------------------------------------------------------- startup
  useEffect(() => {
    let lock: EngineLock | null = null;
    let disposed = false;
    let store: IndexedDBThreadStore | null = null;
    let engines: PrivateEngineManager | null = null;

    void (async () => {
      lock = await acquireEngineLock();
      if (disposed) return lock?.release();
      if (!lock) {
        setShell("locked");
        return;
      }

      void persistence.check();
      const hadPrefs = prefsExist();
      prefsRef.current = loadPrefs();
      const prefs = prefsRef.current;

      try {
        store = await IndexedDBThreadStore.open();
      } catch {
        setShell("no_storage");
        return;
      }
      const openStore = store;

      const initializedAt = await openStore.getMeta<number>("initializedAt");
      if (!initializedAt) {
        await openStore.setMeta("initializedAt", Date.now());
        setCleared(hadPrefs ? "partial" : "first_run");
      }

      const webllm = await createLocalProvider();
      if (disposed) return webllm.dispose();

      const chat = new PrivateChatController({
        provider: webllm,
        store: openStore,
        profileKey: "anon",
        deviceId: prefs.deviceId,
        writeClipboard: (text) => navigator.clipboard.writeText(text),
        onUserMessageSaved: () => void persistence.request("first_chat_saved"),
        onRuntimeError: (error, provider) => engines?.handleRuntimeError(error, provider),
      });
      engines = new PrivateEngineManager({
        controller: chat,
        webllm,
        probe: () => probeFor(webllm),
        detectBuiltin: () => detectBuiltin(),
        createBuiltin: createBuiltinProvider,
        getPrefs: () => prefsRef.current!,
        setPrefs: (next) => {
          prefsRef.current = next;
          savePrefs(next);
        },
        meta: {
          get: (key) => openStore.getMeta(key),
          set: (key, value) => openStore.setMeta(key, value),
        },
        persistence,
        notify: (message) => toast.message(message),
        onCleared: () => setCleared("partial"),
      });
      await chat.init();
      if (disposed) return;
      setController(chat);
      setManager(engines);
      setShell("running");
      await engines.start();
      if (disposed) return;
      const state = engines.getState();
      setSafariNotice(state.isSafari && !prefs.safariNoticeSeen);
    })();

    return () => {
      disposed = true;
      engines?.dispose();
      store?.close();
      lock?.release();
    };
  }, [persistence]);

  const dismissSafari = () => {
    setSafariNotice(false);
    if (!prefsRef.current) return;
    prefsRef.current = { ...prefsRef.current, safariNoticeSeen: true };
    savePrefs(prefsRef.current);
  };

  return (
    <PrivateShell
      shell={shell}
      manager={manager}
      controller={controller}
      cleared={cleared}
      safariNotice={safariNotice}
      onDismissSafari={dismissSafari}
      persistence={persistence}
    />
  );
}

const PROBING_STATE: EngineState = {
  phase: "probing",
  builtin: { status: { kind: "absent" }, phase: "idle", progress: null, error: null },
  webllm: null,
  active: null,
  autoSwitch: false,
  upgradeOpen: false,
  isSafari: false,
};
const probingSnapshot = () => PROBING_STATE;

/** What the notice area above the messages shows. */
function EngineNotice({
  shell,
  state,
  manager,
  cleared,
  safariNotice,
  onDismissSafari,
}: {
  shell: ShellPhase;
  state: EngineState;
  manager: PrivateEngineManager | null;
  cleared: "partial" | "first_run" | null;
  safariNotice: boolean;
  onDismissSafari: () => void;
}) {
  if (shell === "locked") {
    return (
      <p className="text-muted-foreground p-10 text-center text-sm" role="alert">
        Private Mode is open in another tab. Close it there to use Private Mode here.
      </p>
    );
  }
  if (shell === "no_storage") {
    return (
      <p className="text-muted-foreground p-10 text-center text-sm" role="alert">
        Private Mode needs browser storage, which is unavailable here (for example in a private
        browsing window).
      </p>
    );
  }
  if (shell === "starting" || !manager || state.phase === "probing") {
    return <p className="text-muted-foreground p-10 text-center text-sm">Checking this device…</p>;
  }
  if (isUnavailable(state)) {
    return (
      <UnavailableState
        reason={state.webllm.reason}
        builtin={state.builtin.status}
        onRetryBlocked={() => void manager.retryBlocked()}
      />
    );
  }

  const { builtin, webllm } = state;
  const vendor: BuiltinVendor | null = builtinUsable(builtin.status) ? builtin.status.vendor : null;
  const hasBuiltin = vendor !== null;
  const parts: React.ReactNode[] = [];

  if (vendor && state.active === "builtin" && builtin.phase !== "ready") {
    parts.push(
      <BuiltinSetup
        key="builtin"
        vendor={vendor}
        status={builtin.status.kind}
        phase={builtin.phase}
        progress={builtin.progress}
        error={builtin.error}
        // Synchronous in the click handler: the browser's download needs user activation.
        onEnable={() => void manager.enableBuiltin()}
        onShowUpgrades={
          webllm?.kind === "setup" && !state.upgradeOpen ? () => manager.openUpgrade(true) : undefined
        }
      />,
    );
  }

  const showWebLLM =
    webllm?.kind === "setup" && (state.upgradeOpen || state.active === "webllm");
  if (showWebLLM && webllm.kind === "setup") {
    parts.push(
      <ModelSetup
        key="webllm"
        variant={hasBuiltin ? "upgrade" : "setup"}
        builtinName={vendor ? BUILTIN_MODEL[vendor].modelName : null}
        autoSwitch={state.autoSwitch}
        onAutoSwitchChange={hasBuiltin ? (value) => manager.setAutoSwitch(value) : undefined}
        onClose={hasBuiltin ? () => manager.openUpgrade(false) : undefined}
        builtinUnverified={builtin.status.kind === "unverified"}
        tier={webllm.decision.tier}
        recommended={webllm.decision.recommended}
        selectable={webllm.decision.selectable}
        shaderF16={webllm.decision.artifact.requiresShaderF16}
        cached={webllm.cached}
        phase={webllm.phase}
        progress={webllm.progress}
        error={webllm.error}
        steppedDown={webllm.decision.steppedDown}
        showSafariNotice={safariNotice}
        safariBeta={state.isSafari}
        clearedNotice={hasBuiltin ? null : cleared}
        onDownload={() => void manager.downloadSelected()}
        onCancel={() => manager.cancelLoad()}
        onChooseTier={(tier) => void manager.chooseTier(tier)}
        onDismissSafari={onDismissSafari}
      />,
    );
  }
  return parts.length ? <>{parts}</> : null;
}

const EMPTY_STATE = {
  threads: [],
  activeThreadId: null,
  messages: [],
  streamingId: null,
  turnInProgress: false,
  recoveredInterrupted: 0,
};
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_STATE;

function PrivateShell({
  shell,
  manager,
  controller,
  cleared,
  safariNotice,
  onDismissSafari,
  persistence,
}: {
  shell: ShellPhase;
  manager: PrivateEngineManager | null;
  controller: PrivateChatController | null;
  cleared: "partial" | "first_run" | null;
  safariNotice: boolean;
  onDismissSafari: () => void;
  persistence: StoragePersistence;
}) {
  const engine = useSyncExternalStore(
    manager?.subscribe ?? noopSubscribe,
    manager?.getState ?? probingSnapshot,
    probingSnapshot,
  );
  const modelName = shell === "running" ? chatModelName(engine) : null;
  const ready = modelName !== null;
  const safariBeta = engine.isSafari;
  const builtinVendor =
    engine.active === "builtin" && builtinUsable(engine.builtin.status) ? engine.builtin.status.vendor : null;
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
        {shell === "running" && manager && (
          <ProviderBar
            state={engine}
            turnInProgress={state.turnInProgress}
            onOpenUpgrade={() => manager.openUpgrade(true)}
            onUseBuiltin={() => void manager.useBuiltin()}
            onUseWebLLM={() => void manager.useWebLLM()}
          />
        )}
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
          <EngineNotice
            shell={shell}
            state={engine}
            manager={manager}
            cleared={cleared}
            safariNotice={safariNotice}
            onDismissSafari={onDismissSafari}
          />
          {state.recoveredInterrupted > 0 && (
            <p className="text-muted-foreground mx-auto max-w-3xl px-4 pt-4 text-xs">
              {state.recoveredInterrupted === 1 ? "An answer was" : "Some answers were"} cut off
              when this tab closed. They are marked interrupted.
            </p>
          )}
          {ready && state.messages.length === 0 && !engine.upgradeOpen && (
            <div className="mx-auto max-w-xl px-6 py-20 text-center">
              <h1 className="text-lg font-semibold tracking-tight">Private Mode</h1>
              {builtinVendor ? (
                <p className="text-muted-foreground mt-2 text-sm leading-6" data-privacy-copy="builtin">
                  Answers come from {BUILTIN_MODEL[builtinVendor].displayName}.{" "}
                  {BUILTIN_PRIVACY_COPY[builtinVendor]} Your messages stay in this browser and are
                  never sent to KORUM.
                </p>
              ) : (
                <p className="text-muted-foreground mt-2 text-sm leading-6">
                  Answers come from a model running on this device. Your messages stay in this
                  browser and are never sent to KORUM.
                </p>
              )}
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
          submitDisabled={state.turnInProgress}
          autoFocus
          modeSlot={<PrivateChip model={modelName} beta={safariBeta} />}
          placeholder={ready ? "Ask privately…" : "Private Mode isn't ready on this device"}
          footnote="Runs on this device. Nothing you type here is sent to KORUM."
        />
      </div>
    </div>
  );
}
