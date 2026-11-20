import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalRuntimeError,
  type CapabilityReport,
  type LoadProgress,
  type LocalModelDescriptor,
  type ModelDescriptorBase,
} from "@/lib/private/core/local-provider";
import { planProvider, type BuiltinStatus } from "@/lib/private/core/provider-policy";
import { pickTier } from "@/lib/private/core/tier-policy";
import { chatModelName, isUnavailable, PrivateEngineManager } from "@/lib/private/web/engine-manager";
import type { PrivatePrefs } from "@/lib/private/web/prefs";
import { BuiltinPromptApiProvider, detectBuiltin } from "@/lib/private/web/prompt-api";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { CHROME_NAV, fakeLanguageModel, OPERA_NAV } from "./helpers/fake-language-model";
import { CAPABLE_REPORT, MockLocalProvider } from "./helpers/mock-local-provider";
import { installNetworkTrap } from "./helpers/network-trap";

/**
 * Provider selection: the browser's built-in model is the
 * default; WebLLM tiers are opt-in upgrades; a cached tier is never
 * downloaded again; nothing usable → unavailable, never the cloud.
 */

const NO_GPU: CapabilityReport = { ...CAPABLE_REPORT, hasWebGPU: false, hasAdapter: false };
const now = Date.now();
const okDecision = pickTier(CAPABLE_REPORT, { choice: "auto", failures: {}, now });
const noGpuDecision = pickTier(NO_GPU, { choice: "auto", failures: {}, now });
const chrome = (kind: "available" | "downloadable" | "downloading" | "unavailable"): BuiltinStatus => ({
  kind,
  vendor: "chrome",
});

describe("planProvider", () => {
  it.each([
    ["built-in available → built-in, ready", chrome("available"), okDecision, false, null, { kind: "builtin", needsEnable: false }],
    ["built-in downloadable → built-in, needs a click", chrome("downloadable"), okDecision, false, null, { kind: "builtin", needsEnable: true }],
    ["built-in downloading → built-in, needs a click", chrome("downloading"), okDecision, false, null, { kind: "builtin", needsEnable: true }],
    ["built-in even when a tier is cached (no preference)", chrome("available"), okDecision, true, null, { kind: "builtin" }],
    ["built-in when the user chose it", chrome("available"), okDecision, true, "builtin", { kind: "builtin" }],
    ["chosen WebLLM tier on this device → load it", chrome("available"), okDecision, true, "webllm", { kind: "webllm_load" }],
    ["chosen WebLLM tier evicted → built-in", chrome("available"), okDecision, false, "webllm", { kind: "builtin" }],
    ["no built-in, tier cached → load it (no download)", { kind: "absent" }, okDecision, true, null, { kind: "webllm_load" }],
    ["no built-in, nothing cached → opt-in setup", { kind: "absent" }, okDecision, false, null, { kind: "webllm_setup" }],
    ["unverified built-in is never used", { kind: "unverified" }, okDecision, false, null, { kind: "webllm_setup" }],
    ["built-in unavailable → setup", chrome("unavailable"), okDecision, false, null, { kind: "webllm_setup" }],
    ["nothing usable → unavailable", { kind: "absent" }, noGpuDecision, false, null, { kind: "unavailable", webllm: "no_webgpu" }],
    ["unverified + no WebGPU → unavailable", { kind: "unverified" }, noGpuDecision, false, "builtin", { kind: "unavailable" }],
  ] as const)("%s", (_name, builtin, webllm, cached, preference, expected) => {
    expect(
      planProvider({ builtin: builtin as BuiltinStatus, webllm, webllmCached: cached, preference }),
    ).toMatchObject(expected);
  });
});

// ------------------------------------------------------------------ manager

class FakeWebLLM extends MockLocalProvider {
  cached = false;
  loads: { model: LocalModelDescriptor; progress: (p: LoadProgress) => void }[] = [];
  private release: (() => void) | null = null;
  holdLoads = false;
  loadError: LocalRuntimeError | null = null;
  unloads = 0;
  disposed = false;
  async isCached(model?: LocalModelDescriptor) {
    void model;
    return this.cached;
  }
  async load(model: LocalModelDescriptor, progress?: (p: LoadProgress) => void) {
    this.loads.push({ model, progress: progress ?? (() => {}) });
    if (this.loadError) {
      const error = this.loadError;
      this.loadError = null;
      throw error;
    }
    if (this.holdLoads) await new Promise<void>((resolve) => (this.release = resolve));
    this.loaded = model;
    this.cached = true;
  }
  finishLoad() {
    this.release?.();
    this.release = null;
  }
  async unload() {
    this.unloads++;
    this.loaded = null;
  }
  dispose() {
    this.disposed = true;
  }
}

interface Setup {
  manager: PrivateEngineManager;
  webllm: FakeWebLLM;
  fake: ReturnType<typeof fakeLanguageModel> | null;
  prefs: { current: PrivatePrefs };
  models: (ModelDescriptorBase | null)[];
  engines: (string | undefined)[];
  persist: string[];
  notices: string[];
  controller: PrivateChatController | undefined;
}

function setup(opts: {
  builtin?: "absent" | "available" | "downloadable" | "downloading" | "unavailable" | "unverified";
  report?: CapabilityReport;
  cached?: boolean;
  prefs?: Partial<PrivatePrefs>;
  createErrors?: string[];
  store?: IndexedDBThreadStore;
}): Setup {
  const webllm = new FakeWebLLM();
  webllm.cached = opts.cached ?? false;
  const kind = opts.builtin ?? "available";
  const fake =
    kind === "absent" ? null : fakeLanguageModel({ availability: kind === "unverified" ? "available" : kind, createErrors: opts.createErrors });
  const win = { isSecureContext: true, navigator: kind === "unverified" ? OPERA_NAV : CHROME_NAV, ...(fake ? { LanguageModel: fake.api } : {}) };
  const prefs = {
    current: { deviceId: "d", choice: "auto", provider: null, failures: {}, safariNoticeSeen: false, ...opts.prefs } as PrivatePrefs,
  };
  const models: (ModelDescriptorBase | null)[] = [];
  const engines: (string | undefined)[] = [];
  const persist: string[] = [];
  const notices: string[] = [];
  const meta = new Map<string, unknown>();
  const controller = opts.store && new PrivateChatController({
    provider: new MockLocalProvider(),
    store: opts.store,
    profileKey: "anon",
    deviceId: "d",
    writeClipboard: async () => {},
  });
  const manager = new PrivateEngineManager({
    controller: controller ?? {
      getState: () => ({ turnInProgress: false }),
      setModel(model, provider) {
        models.push(model);
        engines.push(provider?.id);
      },
    },
    webllm,
    probe: async () => opts.report ?? CAPABLE_REPORT,
    detectBuiltin: () => detectBuiltin(win),
    createBuiltin: (vendor) => new BuiltinPromptApiProvider(vendor, win),
    getPrefs: () => prefs.current,
    setPrefs: (next) => (prefs.current = next),
    meta: {
      get: async <T,>(key: string) => meta.get(key) as T | undefined,
      set: async (key, value) => void meta.set(key, value),
    },
    persistence: { request: async (trigger) => persist.push(trigger) },
    notify: (message) => notices.push(message),
  });
  return { manager, webllm, fake, prefs, models, engines, persist, notices, controller };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let trap: ReturnType<typeof installNetworkTrap>;
beforeEach(() => {
  trap = installNetworkTrap();
});
afterEach(() => {
  // No path here makes a network request: built-in inference is in the browser,
  // and the WebLLM engine is a mock.
  expect(trap.requests).toEqual([]);
  trap.restore();
});

describe("PrivateEngineManager", () => {
  it.each(["send", "regenerate"] as const)("blocks switching away from WebLLM during %s storage", async (operation) => {
    const store = await IndexedDBThreadStore.open(new IDBFactory());
    const t = setup({ builtin: "downloadable", cached: true, prefs: { provider: "webllm" }, store });
    const chat = t.controller!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;

    try {
      await chat.init();
      await t.manager.start();
      if (operation === "regenerate") await chat.send("question");
      t.webllm.replies.push(["saved answer"]);

      if (operation === "send") {
        const write = store.putMessage.bind(store);
        vi.spyOn(store, "putMessage").mockImplementationOnce(async (message) => {
          entered.resolve();
          await release.promise;
          await write(message);
        });
        pending = chat.send("question");
      } else {
        const remove = store.deleteMessage.bind(store);
        vi.spyOn(store, "deleteMessage").mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          await remove(id);
        });
        pending = chat.regenerate();
      }

      await entered.promise;
      expect(chat.getState().streamingId).toBeNull();
      await t.manager.useBuiltin();
      expect(t.manager.getState().active).toBe("webllm");
      expect(t.webllm.unloads).toBe(0);

      release.resolve();
      await pending;
      const messages = await store.listMessages(chat.getState().activeThreadId!);
      expect(messages).toHaveLength(2);
      expect(messages.at(-1)).toMatchObject({ content: "saved answer", status: "complete" });

      await t.manager.useBuiltin();
      expect(t.manager.getState()).toMatchObject({
        active: "builtin",
        builtin: { status: { kind: "downloadable" }, phase: "idle" },
      });
      expect(t.webllm.unloads).toBe(1);
    } finally {
      release.resolve();
      await pending;
      t.manager.dispose();
      store.close();
    }
  });

  it("built-in available: the default, ready without a click; WebLLM worker not even asked", async () => {
    const t = setup({ builtin: "available" });
    let cacheChecks = 0;
    t.webllm.isCached = async () => (cacheChecks++, false);
    await t.manager.start();
    const state = t.manager.getState();
    expect(state.active).toBe("builtin");
    expect(state.builtin.phase).toBe("ready");
    expect(chatModelName(state)).toBe("Gemini Nano (built into Chrome)");
    expect(t.models.at(-1)?.id).toBe("builtin/chrome-gemini-nano");
    expect(t.engines.at(-1)).toBe("builtin-prompt-api");
    expect(cacheChecks).toBe(0);
    expect(t.webllm.loads).toEqual([]);
    expect(t.fake!.state.createCalls).toHaveLength(1);
  });

  it("built-in downloadable: waits for the Enable click, then reports progress and becomes ready", async () => {
    const t = setup({ builtin: "downloadable" });
    await t.manager.start();
    expect(t.manager.getState().builtin).toMatchObject({ status: { kind: "downloadable" }, phase: "idle" });
    expect(t.fake!.state.createCalls).toEqual([]); // no download without a click
    expect(chatModelName(t.manager.getState())).toBeNull();

    const seen: (number | null)[] = [];
    t.manager.subscribe(() => seen.push(t.manager.getState().builtin.progress));
    await t.manager.enableBuiltin();
    expect(seen).toEqual(expect.arrayContaining([0, 0.5, 1]));
    expect(t.manager.getState().builtin).toMatchObject({ status: { kind: "available" }, phase: "ready" });
    expect(chatModelName(t.manager.getState())).toBe("Gemini Nano (built into Chrome)");
  });

  it.each([
    ["NotAllowedError", "not_allowed"],
    ["NetworkError", "download_failed"],
  ])("Enable failing with %s stays on the built-in card with an error", async (name, kind) => {
    const t = setup({ builtin: "downloadable", createErrors: [name] });
    await t.manager.start();
    await t.manager.enableBuiltin();
    expect(t.manager.getState().builtin).toMatchObject({ phase: "idle", error: kind, status: { kind: "downloadable" } });
    expect(t.manager.getState().active).toBe("builtin");
    expect(t.webllm.loads).toEqual([]);
  });

  it("upgrade: the tier downloads in the background while the built-in model answers; the user switches", async () => {
    const t = setup({ builtin: "available" });
    await t.manager.start();
    t.manager.openUpgrade(true);
    await flush();
    expect(t.manager.getState().webllm).toMatchObject({ kind: "setup", cached: false });
    t.webllm.holdLoads = true;
    const download = t.manager.downloadSelected();
    await flush();
    expect(t.persist).toContain("model_download_started");
    // Still chatting on the built-in model during the download.
    expect(t.manager.getState().active).toBe("builtin");
    expect(chatModelName(t.manager.getState())).toBe("Gemini Nano (built into Chrome)");
    t.webllm.finishLoad();
    await download;
    // Finished, but no auto-switch: the user decides.
    expect(t.manager.getState().webllm?.kind).toBe("ready");
    expect(t.manager.getState().active).toBe("builtin");
    expect(t.prefs.current.provider).toBeNull();

    await t.manager.useWebLLM();
    expect(t.manager.getState().active).toBe("webllm");
    expect(t.engines.at(-1)).toBe("webllm");
    expect(t.prefs.current.provider).toBe("webllm");

    // And back: the WebLLM model is unloaded, still on this device.
    await t.manager.useBuiltin();
    expect(t.manager.getState().active).toBe("builtin");
    expect(t.webllm.unloads).toBe(1);
    expect(t.manager.getState().webllm).toMatchObject({ kind: "setup", cached: true });
    expect(t.prefs.current.provider).toBe("builtin");
  });

  it("an upgrade waits for a switch even while the built-in model is awaiting Enable", async () => {
    const t = setup({ builtin: "downloadable" });
    await t.manager.start();
    t.manager.openUpgrade();
    await flush();
    await t.manager.downloadSelected();
    expect(t.manager.getState()).toMatchObject({ active: "builtin", webllm: { kind: "ready" } });
    expect(t.fake!.state.createCalls).toEqual([]);
    await t.manager.useWebLLM();
    expect(t.manager.getState().active).toBe("webllm");
  });

  it("a cache miss during startup offers a download without retrying automatically", async () => {
    const t = setup({ builtin: "absent", cached: true });
    t.webllm.loadError = new LocalRuntimeError("cache_missing");
    await t.manager.start();
    expect(t.manager.getState().webllm).toMatchObject({
      kind: "setup", phase: "idle", cached: false, error: "cache_missing",
    });
    expect(t.webllm.loads).toHaveLength(1);
    expect(t.persist).not.toContain("model_download_started");
  });

  it("upgrade with 'switch when ready' switches by itself", async () => {
    const t = setup({ builtin: "available" });
    await t.manager.start();
    t.manager.openUpgrade(true);
    t.manager.setAutoSwitch(true);
    await flush();
    await t.manager.downloadSelected();
    expect(t.manager.getState().active).toBe("webllm");
    expect(t.manager.getState().upgradeOpen).toBe(false);
  });

  it("chosen WebLLM tier already cached: loads from this device at startup, no download", async () => {
    const t = setup({ builtin: "available", cached: true, prefs: { provider: "webllm" } });
    await t.manager.start();
    expect(t.webllm.loads).toHaveLength(1);
    expect(t.persist).not.toContain("model_download_started");
    expect(t.manager.getState().active).toBe("webllm");
    // The built-in model is not started until the user asks for it.
    expect(t.fake!.state.createCalls).toEqual([]);
  });

  it("a cached tier is detected in the upgrade panel and loaded, not downloaded", async () => {
    const t = setup({ builtin: "available", cached: true });
    await t.manager.start();
    expect(t.manager.getState().active).toBe("builtin");
    t.manager.openUpgrade(true);
    await flush();
    expect(t.manager.getState().webllm).toMatchObject({ kind: "setup", cached: true });
    await t.manager.useWebLLM();
    expect(t.persist).not.toContain("model_download_started");
    expect(t.manager.getState().active).toBe("webllm");
  });

  it("no built-in model: WebLLM download requires a click", async () => {
    const t = setup({ builtin: "absent" });
    await t.manager.start();
    expect(t.manager.getState()).toMatchObject({ active: "webllm", webllm: { kind: "setup", phase: "idle" } });
    expect(t.webllm.loads).toEqual([]);
    await t.manager.downloadSelected();
    expect(t.manager.getState().webllm?.kind).toBe("ready");
    expect(t.manager.getState().active).toBe("webllm");
  });

  it("unverified built-in model is never created", async () => {
    const t = setup({ builtin: "unverified" });
    await t.manager.start();
    expect(t.manager.getState().builtin.status).toEqual({ kind: "unverified" });
    expect(t.fake!.state.availabilityCalls).toEqual([]);
    expect(t.fake!.state.createCalls).toEqual([]);
    expect(t.manager.getState().active).toBe("webllm");
  });

  it.each(["absent", "unverified", "unavailable"] as const)(
    "nothing usable (built-in %s, no WebGPU) → unavailable, no model at all",
    async (builtin) => {
      const t = setup({ builtin, report: NO_GPU });
      await t.manager.start();
      const state = t.manager.getState();
      expect(isUnavailable(state)).toBe(true);
      expect(state.active).toBeNull();
      expect(chatModelName(state)).toBeNull();
      expect(t.webllm.loads).toEqual([]);
    },
  );

  it("built-in model usable without WebGPU: not unavailable", async () => {
    const t = setup({ builtin: "available", report: NO_GPU });
    await t.manager.start();
    expect(isUnavailable(t.manager.getState())).toBe(false);
    expect(t.manager.getState().webllm).toEqual({ kind: "unavailable", reason: "no_webgpu" });
    expect(chatModelName(t.manager.getState())).toBe("Gemini Nano (built into Chrome)");
  });

  it("a capacity failure on the active WebLLM tier steps down and moves the chat back to the built-in model", async () => {
    const t = setup({ builtin: "available", cached: true, prefs: { provider: "webllm" } });
    await t.manager.start();
    expect(t.manager.getState().active).toBe("webllm");
    t.webllm.cached = false; // the lower tier is not on this device
    t.manager.handleRuntimeError(new LocalRuntimeError("out_of_memory"), "webllm");
    for (let i = 0; i < 10; i++) await flush();
    const state = t.manager.getState();
    expect(state.active).toBe("builtin");
    expect(state.builtin.phase).toBe("ready");
    expect(state.webllm).toMatchObject({ kind: "setup", error: "out_of_memory", phase: "idle" });
    expect(t.prefs.current.failures.L ?? t.prefs.current.failures.M).toHaveLength(1);
    expect(t.notices).toContain("Switched back to the browser's built-in model.");
  });

  it("a background upgrade failing for capacity does not touch the built-in chat", async () => {
    const t = setup({ builtin: "available" });
    await t.manager.start();
    t.webllm.loadError = new LocalRuntimeError("out_of_memory");
    t.manager.openUpgrade();
    await flush();
    await t.manager.downloadSelected();
    for (let i = 0; i < 5; i++) await flush();
    expect(t.manager.getState().active).toBe("builtin");
    expect(chatModelName(t.manager.getState())).toBe("Gemini Nano (built into Chrome)");
    expect(t.manager.getState().webllm).toMatchObject({ kind: "setup", error: "out_of_memory" });
  });

  it("built-in session lost mid-chat restarts the built-in model", async () => {
    const t = setup({ builtin: "available" });
    await t.manager.start();
    t.manager.handleRuntimeError(new LocalRuntimeError("not_loaded"), "builtin-prompt-api");
    for (let i = 0; i < 5; i++) await flush();
    expect(t.manager.getState().builtin.phase).toBe("ready");
    expect(t.fake!.state.createCalls).toHaveLength(2);
  });

  it("uses only the latest cache check and allows one load at a time", async () => {
    const t = setup({ builtin: "absent" });
    await t.manager.start();
    const checks = new Map<string, (cached: boolean) => void>();
    t.webllm.isCached = (model) => {
      if (!model) throw new Error("Expected a tier to check");
      return new Promise<boolean>((resolve) => checks.set(model.tier, resolve));
    };
    t.webllm.holdLoads = true;

    const older = t.manager.chooseTier("S");
    expect(t.manager.getState().webllm).toMatchObject({ phase: "checking", decision: { tier: "S" } });
    const latest = t.manager.chooseTier("XS");
    expect(t.manager.getState().webllm).toMatchObject({ phase: "checking", decision: { tier: "XS" } });
    await t.manager.downloadSelected();
    expect(t.webllm.loads).toHaveLength(0);

    checks.get("XS")!(false);
    await latest;
    const download = t.manager.downloadSelected();
    checks.get("S")!(true);
    await older;
    await t.manager.chooseTier("S");
    await t.manager.downloadSelected();
    expect(t.manager.getState().webllm).toMatchObject({ phase: "loading", decision: { tier: "XS" } });
    expect(t.webllm.loads.map(({ model }) => model.tier)).toEqual(["XS"]);
    t.webllm.finishLoad();
    await download;
    expect(t.manager.getState().webllm).toMatchObject({ kind: "ready", decision: { tier: "XS" } });
    expect(t.prefs.current.choice).toBe("XS");
  });

  it("dispose stops everything", async () => {
    const t = setup({ builtin: "available" });
    await t.manager.start();
    t.manager.dispose();
    expect(t.webllm.disposed).toBe(true);
  });
});
