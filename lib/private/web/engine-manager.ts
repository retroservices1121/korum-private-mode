/**
 * Which on-device model Private Mode runs, and the lifecycle of each (no
 * React, no network). The UI subscribes; tests drive it with mock engines.
 *
 *   - The browser's built-in model (Prompt API) is the default whenever it is
 *     usable (`planProvider`). If the browser still has to download it, that
 *     takes a click (`enableBuiltin()` must run inside the click handler).
 *   - WebLLM tiers are opt-in "better quality" upgrades. A download runs in
 *     the background while the user keeps chatting on the built-in model; on
 *     completion the user switches, or it switches by itself only if they
 *     asked for that. A tier already on this device is never downloaded
 *     again (cache-completeness check through Cache Storage).
 *   - Capacity failures step a WebLLM tier down.
 *   - Nothing usable → the unavailable state. Never a cloud model.
 */

import {
  LocalRuntimeError,
  type CapabilityReport,
  type LocalModelDescriptor,
  type LocalProvider,
  type LocalRuntimeErrorKind,
  type LocalRuntimeId,
  type LoadProgress,
} from "@/lib/private/core/local-provider";
import { TIER_ORDER, type ModelTier } from "@/lib/private/core/model-catalog";
import {
  BUILTIN_MODEL,
  builtinDescriptor,
  builtinUsable,
  planProvider,
  type BuiltinModelDescriptor,
  type BuiltinStatus,
  type BuiltinVendor,
} from "@/lib/private/core/provider-policy";
import {
  clearFailures,
  pickTier,
  type TierDecision,
  type UnavailableReason,
} from "@/lib/private/core/tier-policy";

import { recoverFromCapacityFailure } from "./engine-recovery";
import { BuiltinSessionCreateError } from "./prompt-api";
import type { PrivatePrefs } from "./prefs";
import type { PrivateChatController, PrivateChatState } from "./private-chat-controller";
import type { PersistTrigger } from "./storage-persistence";

export type OkDecision = Extract<TierDecision, { status: "ok" }>;

export type WebLLMEngine = LocalProvider<LocalModelDescriptor> & {
  dispose(): void;
  load(
    model: LocalModelDescriptor,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
    allowDownload?: boolean,
  ): Promise<void>;
};
export type BuiltinEngine = LocalProvider<BuiltinModelDescriptor> & {
  readonly contextWindowTokens: number | null;
  dispose(): void;
};

export interface BuiltinUi {
  status: BuiltinStatus;
  phase: "idle" | "loading" | "ready";
  /** 0..1 from the browser's `downloadprogress`, while it downloads. */
  progress: number | null;
  error: LocalRuntimeErrorKind | null;
}

export type WebLLMUi =
  | { kind: "unavailable"; reason: UnavailableReason }
  | {
      kind: "setup";
      decision: OkDecision;
      /** `null`: not checked yet (checked when the upgrade panel opens). */
      cached: boolean | null;
      phase: "idle" | "checking" | "loading";
      progress: LoadProgress | null;
      error: LocalRuntimeErrorKind | null;
    }
  | { kind: "ready"; decision: OkDecision };

export type ActiveProvider = "builtin" | "webllm" | null;

export interface EngineState {
  /** "probing" until the first decision is made. */
  phase: "probing" | "decided";
  builtin: BuiltinUi;
  webllm: WebLLMUi | null;
  /** The engine the chat uses (or will use once it is ready). */
  active: ActiveProvider;
  /** Switch to the WebLLM tier by itself when its download finishes. */
  autoSwitch: boolean;
  /** The "Better quality" panel is open. */
  upgradeOpen: boolean;
  isSafari: boolean;
}

export interface EngineManagerDeps {
  controller: {
    getState(): Pick<PrivateChatState, "turnInProgress">;
    setModel: PrivateChatController["setModel"];
  };
  webllm: WebLLMEngine;
  probe: () => Promise<CapabilityReport>;
  detectBuiltin: () => Promise<BuiltinStatus>;
  createBuiltin: (vendor: BuiltinVendor) => BuiltinEngine;
  getPrefs: () => PrivatePrefs;
  setPrefs: (prefs: PrivatePrefs) => void;
  meta: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  persistence: { request(trigger: PersistTrigger): Promise<unknown> };
  /** Short user-facing notice (a toast in the app). */
  notify?: (message: string) => void;
  /** The browser cleared a model KORUM had downloaded. */
  onCleared?: () => void;
  now?: () => number;
}

export function descriptorFor(decision: OkDecision): LocalModelDescriptor {
  return {
    id: decision.model.id,
    tier: decision.tier,
    displayName: decision.model.displayName,
    contextWindowTokens: decision.artifact.contextWindowTokens,
    artifact: decision.artifact,
  };
}

/** The model the chat can use right now, or null. */
export function chatModelName(state: EngineState): string | null {
  if (state.active === "builtin" && state.builtin.phase === "ready" && "vendor" in state.builtin.status) {
    const { model, vendor } = state.builtin.status;
    return BUILTIN_MODEL[model ?? vendor].displayName;
  }
  if (state.active === "webllm" && state.webllm?.kind === "ready") return state.webllm.decision.model.displayName;
  return null;
}

/** Neither the built-in model nor a WebLLM tier can run here. */
export function isUnavailable(state: EngineState): state is EngineState & { webllm: { kind: "unavailable" } } {
  return state.phase === "decided" && !builtinUsable(state.builtin.status) && state.webllm?.kind === "unavailable";
}

export class PrivateEngineManager {
  private state: EngineState = {
    phase: "probing",
    builtin: { status: { kind: "absent" }, phase: "idle", progress: null, error: null },
    webllm: null,
    active: null,
    autoSwitch: false,
    upgradeOpen: false,
    isSafari: false,
  };
  private listeners = new Set<() => void>();
  private report: CapabilityReport | null = null;
  private builtinEngine: BuiltinEngine | null = null;
  private builtinModel: BuiltinModelDescriptor | null = null;
  private builtinAbort: AbortController | null = null;
  private webllmAbort: AbortController | null = null;
  private webllmModel: LocalModelDescriptor | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: EngineManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): EngineState => this.state;

  private set(patch: Partial<EngineState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setBuiltin(patch: Partial<BuiltinUi>) {
    this.set({ builtin: { ...this.state.builtin, ...patch } });
  }

  private setActive(active: ActiveProvider) {
    this.set({ active });
    if (active === null) this.deps.controller.setModel(null);
    if (active === "builtin") this.deps.controller.setModel(this.builtinModel, this.builtinEngine ?? undefined);
    if (active === "webllm") this.deps.controller.setModel(this.webllmModel, this.deps.webllm);
  }

  private remember(provider: "builtin" | "webllm") {
    const prefs = this.deps.getPrefs();
    if (prefs.provider !== provider) this.deps.setPrefs({ ...prefs, provider });
  }

  // ------------------------------------------------------------------ start
  /** Probes both engines and picks the default. No download, no network. */
  async start(): Promise<void> {
    const [report, builtin] = await Promise.all([
      this.deps.probe(),
      this.deps.detectBuiltin().catch((): BuiltinStatus => ({ kind: "absent" })),
    ]);
    if (this.disposed) return;
    this.report = report;
    if (builtinUsable(builtin)) this.builtinEngine = this.deps.createBuiltin(builtin.vendor);
    this.set({ isSafari: report.isSafari, builtin: { ...this.state.builtin, status: builtin } });
    await this.decide();
  }

  /** Re-runs the provider choice (startup, retry after a blocked tier). */
  async decide(previousError: LocalRuntimeErrorKind | null = null): Promise<void> {
    const prefs = this.deps.getPrefs();
    const builtin = this.state.builtin.status;
    // Only inspect WebLLM cache entries when they can affect the initial choice.
    const needCache = !builtinUsable(builtin) || prefs.provider === "webllm";
    const selection = await this.refreshWebLLM(needCache, previousError);
    if (!selection) return;
    const { decision, cached } = selection;
    if (decision.status === "ok" && !this.isSelected(decision)) return;
    const plan = planProvider({ builtin, webllm: decision, webllmCached: cached === true, preference: prefs.provider });

    switch (plan.kind) {
      case "builtin":
        this.set({ phase: "decided" });
        this.setActive("builtin");
        if (!plan.needsEnable && this.state.builtin.phase === "idle") await this.enableBuiltin();
        break;
      case "webllm_load":
        this.set({ phase: "decided", active: "webllm" });
        if (!previousError) await this.startLoad(plan.decision, true);
        break;
      case "webllm_setup":
        this.set({ phase: "decided", active: "webllm" });
        break;
      case "unavailable":
        this.set({ phase: "decided", active: null });
        break;
    }
  }

  private async refreshWebLLM(
    checkCache: boolean,
    previousError: LocalRuntimeErrorKind | null,
  ): Promise<{ decision: TierDecision; cached: boolean | null } | null> {
    if (this.disposed || this.webllmAbort || this.isWebLLMLoading()) return null;
    const report = this.report;
    if (!report) return null;
    const prefs = this.deps.getPrefs();
    const decision = pickTier(report, { choice: prefs.choice, failures: prefs.failures, now: this.now() });
    if (decision.status === "unavailable") {
      this.set({ webllm: { kind: "unavailable", reason: decision.reason } });
      return { decision, cached: null };
    }
    const setup = {
      kind: "setup", decision, cached: null, phase: "idle", progress: null, error: previousError,
    } as const;
    if (checkCache) {
      const result = await this.checkSelection(setup);
      return result ? { decision, cached: result.cached } : null;
    }
    this.set({ webllm: setup });
    return { decision, cached: null };
  }

  private isSelected(decision: OkDecision): boolean {
    const webllm = this.state.webllm;
    return webllm?.kind === "setup" && webllm.phase === "idle" && webllm.decision === decision;
  }

  private isWebLLMLoading(): boolean {
    return this.state.webllm?.kind === "setup" && this.state.webllm.phase === "loading";
  }

  private async checkSelection(setup: Extract<WebLLMUi, { kind: "setup" }>) {
    const checking = { ...setup, phase: "checking" } as const;
    this.set({ webllm: checking });
    const descriptor = descriptorFor(checking.decision);
    const cached = await this.deps.webllm.isCached(descriptor).catch(() => false);
    const downloaded = cached ? undefined : await this.deps.meta.get<string[]>("downloadedModelIds").catch(() => undefined);
    if (this.disposed || this.state.webllm !== checking) return null;
    if (downloaded?.includes(descriptor.artifact.modelId)) this.deps.onCleared?.();
    const settled = { ...checking, cached, phase: "idle" } as const;
    this.set({ webllm: settled });
    return this.state.webllm === settled ? settled : null;
  }

  // -------------------------------------------------------- built-in model
  /**
   * Starts the built-in model. When the browser still has to download it,
   * this MUST be called synchronously from a click handler: `create()` needs
   * transient user activation, and is called before any await here.
   */
  enableBuiltin(): Promise<void> {
    const status = this.state.builtin.status;
    if (this.disposed || !builtinUsable(status) || this.state.builtin.phase !== "idle") return Promise.resolve();
    const { vendor } = status;
    const model = status.model ?? vendor;
    const engine = (this.builtinEngine ??= this.deps.createBuiltin(vendor));
    const abort = new AbortController();
    this.builtinAbort = abort;
    this.setBuiltin({ phase: "loading", progress: null, error: null });

    const loading = engine.load(
      builtinDescriptor(model),
      (progress) => {
        if (this.state.builtin.phase === "loading") this.setBuiltin({ progress: progress.fraction });
      },
      abort.signal,
    );
    return loading.then(
      () => {
        this.builtinAbort = null;
        this.builtinModel = builtinDescriptor(model, engine.contextWindowTokens ?? undefined);
        this.setBuiltin({ status: { ...status, kind: "available" }, phase: "ready", progress: null, error: null });
        if (this.state.active === "builtin") this.setActive("builtin");
      },
      async (error: unknown) => {
        this.builtinAbort = null;
        const kind = error instanceof LocalRuntimeError ? error.kind : "unknown";
        await this.recheckBuiltin(kind);
      },
    );
  }

  private async recheckBuiltin(kind: LocalRuntimeErrorKind) {
    if (this.disposed) return;
    const previous = this.state.builtin.status;
    this.builtinModel = null;
    this.setBuiltin({ phase: "loading", progress: null, error: null });
    if (this.state.active === "builtin") this.deps.controller.setModel(null);
    await this.builtinEngine?.unload().catch(() => undefined);
    const advertised = await this.deps.detectBuiltin().catch((): BuiltinStatus => ({ kind: "absent" }));
    const fresh: BuiltinStatus = kind === "unsupported" && builtinUsable(previous)
      ? { ...previous, kind: "unavailable" }
      : advertised;
    if (this.disposed) return;
    if (!builtinUsable(fresh) || !builtinUsable(previous) || fresh.vendor !== previous.vendor) {
      this.builtinEngine = null;
    }
    this.setBuiltin({ status: fresh, phase: "idle", progress: null, error: kind === "cancelled" ? null : kind });
    if (builtinUsable(fresh) || this.state.active !== "builtin") return;
    const webllm = this.state.webllm;
    if (!webllm || webllm.kind === "unavailable") {
      this.setActive(null);
      return;
    }
    this.setActive("webllm");
    if (webllm.kind === "setup" && webllm.phase === "idle" && webllm.cached === null) {
      await this.checkSelection(webllm);
    }
  }

  /** Back to the built-in model (frees the WebLLM model's GPU memory). */
  async useBuiltin(): Promise<void> {
    if (this.disposed || this.deps.controller.getState().turnInProgress || !builtinUsable(this.state.builtin.status)) return;
    this.remember("builtin");
    this.setActive("builtin");
    this.set({ upgradeOpen: false });
    if (this.state.webllm?.kind === "ready") {
      const decision = this.state.webllm.decision;
      this.webllmModel = null;
      await this.deps.webllm.unload().catch(() => undefined);
      this.set({ webllm: { kind: "setup", decision, cached: true, phase: "idle", progress: null, error: null } });
    }
    if (this.state.builtin.phase === "idle" && this.state.builtin.status.kind === "available") {
      await this.enableBuiltin();
    }
  }

  // ------------------------------------------------------------ WebLLM tiers
  openUpgrade(open = true): void {
    this.set({ upgradeOpen: open });
    const webllm = this.state.webllm;
    if (open && webllm?.kind === "setup" && webllm.phase === "idle" && webllm.cached === null) {
      void this.checkSelection(webllm);
    }
  }

  setAutoSwitch(autoSwitch: boolean): void {
    this.set({ autoSwitch });
  }

  async chooseTier(tier: ModelTier): Promise<void> {
    if (this.disposed || this.webllmAbort || this.state.webllm?.kind !== "setup" || this.isWebLLMLoading()) return;
    const prefs = this.deps.getPrefs();
    this.deps.setPrefs({ ...prefs, choice: tier });
    await this.refreshWebLLM(true, null);
  }

  async retryBlocked(): Promise<void> {
    const prefs = this.deps.getPrefs();
    let failures = prefs.failures;
    for (const tier of TIER_ORDER) failures = clearFailures(failures, tier);
    this.deps.setPrefs({ ...prefs, failures });
    await this.decide();
  }

  /** The download / load button (always an explicit click). */
  async downloadSelected(): Promise<void> {
    const webllm = this.state.webllm;
    if (webllm?.kind !== "setup" || webllm.phase !== "idle" || webllm.cached === null) return;
    await this.startLoad(webllm.decision, webllm.cached);
  }

  /** Switch to the WebLLM tier: instantly when loaded, else load it from this device. */
  async useWebLLM(): Promise<void> {
    if (this.disposed || this.deps.controller.getState().turnInProgress) return;
    const webllm = this.state.webllm;
    if (webllm?.kind === "ready") {
      this.remember("webllm");
      this.setActive("webllm");
      this.set({ upgradeOpen: false });
      return;
    }
    if (webllm?.kind === "setup" && webllm.cached && webllm.phase === "idle") {
      this.set({ autoSwitch: true });
      await this.startLoad(webllm.decision, true);
    }
  }

  cancelLoad(): void {
    this.webllmAbort?.abort();
  }

  private async startLoad(decision: OkDecision, cached: boolean): Promise<void> {
    if (this.disposed || this.webllmAbort) return;
    const descriptor = descriptorFor(decision);
    const abort = new AbortController();
    this.webllmAbort = abort;
    this.set({ webllm: { kind: "setup", decision, cached, phase: "loading", progress: null, error: null } });
    if (!cached) void this.deps.persistence.request("model_download_started");

    try {
      await this.deps.webllm.load(
        descriptor,
        (progress) => {
          const current = this.state.webllm;
          if (current?.kind === "setup" && current.phase === "loading") this.set({ webllm: { ...current, progress } });
        },
        abort.signal,
        !cached,
      );
      void this.deps.persistence.request("model_ready");
      const downloaded = (await this.deps.meta.get<string[]>("downloadedModelIds").catch(() => undefined)) ?? [];
      if (!downloaded.includes(descriptor.artifact.modelId)) {
        await this.deps.meta.set("downloadedModelIds", [...downloaded, descriptor.artifact.modelId]).catch(() => undefined);
      }
      this.webllmModel = descriptor;
      const shouldSwitch = this.state.autoSwitch || this.state.active !== "builtin";
      this.set({ webllm: { kind: "ready", decision }, autoSwitch: false });
      if (shouldSwitch) {
        this.remember("webllm");
        this.setActive("webllm");
        this.set({ upgradeOpen: false });
      }
    } catch (error) {
      const runtime = error instanceof LocalRuntimeError ? error : new LocalRuntimeError("unknown");
      if (runtime.kind === "cancelled") {
        this.set({ webllm: { kind: "setup", decision, cached, phase: "idle", progress: null, error: null } });
        return;
      }
      if (runtime.kind === "quota_exceeded" || runtime.kind === "integrity_failed") {
        await this.deps.webllm.deleteCached(descriptor).catch(() => undefined);
      }
      if (runtime.isLoadCapacityFailure) {
        // load() has settled. Keep the loading UI locked while selecting a lower tier.
        this.webllmAbort = null;
        await this.recover(runtime.kind, decision.tier);
        return;
      }
      this.set({
        webllm: {
          kind: "setup",
          decision,
          cached: runtime.kind === "integrity_failed" || runtime.kind === "cache_missing" || runtime.kind === "quota_exceeded"
            ? false
            : cached,
          phase: "idle",
          progress: null,
          error: runtime.kind,
        },
      });
    } finally {
      if (this.webllmAbort === abort) this.webllmAbort = null;
    }
  }

  /**
   * Capacity failure at load or mid-generation: unload,
   * record the tier failure, step down. A cached lower tier loads; an
   * uncached one waits for a click. If the WebLLM tier was in use and the
   * built-in model is usable, the chat moves back to the built-in model.
   */
  async recover(kind: LocalRuntimeErrorKind, failedTier: ModelTier): Promise<void> {
    const report = this.report;
    if (!report) return;
    const wasActive = this.state.active === "webllm";
    const webllm = this.state.webllm;
    if (webllm?.kind === "ready") {
      this.set({ webllm: { kind: "setup", decision: webllm.decision, cached: true, phase: "loading", progress: null, error: null } });
    }
    this.webllmModel = null;
    if (wasActive) this.deps.controller.setModel(null);
    await this.deps.webllm.unload().catch(() => undefined);

    const prefs = this.deps.getPrefs();
    const { failures, next } = await recoverFromCapacityFailure({
      report,
      choice: prefs.choice,
      failures: prefs.failures,
      failedTier,
      now: this.now(),
      isCached: (decision) => this.deps.webllm.isCached(descriptorFor(decision)),
    });
    this.deps.setPrefs({ ...this.deps.getPrefs(), failures });

    const builtinOk = builtinUsable(this.state.builtin.status);
    if (next.action === "load" && (wasActive || !builtinOk)) {
      await this.startLoad(next.decision, true);
      return;
    }
    if (next.action === "unavailable") {
      this.set({ webllm: { kind: "unavailable", reason: next.reason } });
    } else {
      this.set({
        webllm: {
          kind: "setup",
          decision: next.decision,
          cached: next.action === "load",
          phase: "idle",
          progress: null,
          error: kind,
        },
      });
    }
    if (wasActive && builtinOk) {
      this.deps.notify?.("Switched back to the browser's built-in model.");
      this.setActive("builtin");
      if (this.state.builtin.phase === "idle" && this.state.builtin.status.kind === "available") {
        await this.enableBuiltin();
      }
    }
  }

  // ----------------------------------------------------- generation failures
  /** A failure reported by the chat controller during generation. */
  handleRuntimeError(error: LocalRuntimeError, provider: LocalRuntimeId): void {
    if (provider === "builtin-prompt-api") {
      if (this.state.builtin.phase === "ready") {
        if (error instanceof BuiltinSessionCreateError) {
          void this.recheckBuiltin(error.kind);
        } else if (error.kind === "not_loaded") {
          this.deps.notify?.("The built-in model stopped. Restarting it…");
          void this.recheckBuiltin(error.kind).then(() => {
            if (this.state.active === "builtin" && this.state.builtin.status.kind === "available") {
              return this.enableBuiltin();
            }
          });
        }
      }
      return;
    }
    const webllm = this.state.webllm;
    const tier = webllm?.kind === "ready" ? webllm.decision.tier : null;
    if (error.isLoadCapacityFailure && tier) {
      this.deps.notify?.("The on-device model ran out of resources. Trying a lighter setup…");
      void this.recover(error.kind, tier);
    } else if (error.kind === "worker_failed" || error.kind === "not_loaded") {
      // Not evidence the tier doesn't fit: retry the same decision.
      this.deps.notify?.("The on-device model stopped. Reloading it…");
      this.webllmModel = null;
      if (this.state.active === "webllm") this.deps.controller.setModel(null);
      void (async () => {
        const selection = await this.refreshWebLLM(true, null);
        if (
          selection?.decision.status === "ok" && selection.cached &&
          this.state.active === "webllm" && this.isSelected(selection.decision)
        ) {
          await this.startLoad(selection.decision, true);
        }
      })();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.webllmAbort?.abort();
    this.builtinAbort?.abort();
    this.builtinEngine?.dispose();
    this.deps.webllm.dispose();
    this.listeners.clear();
  }
}
