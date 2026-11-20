import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalRuntimeError, type LocalChunk } from "@/lib/private/core/local-provider";
import { BUILTIN_LANGUAGES, BUILTIN_MODEL, builtinDescriptor } from "@/lib/private/core/provider-policy";
import { detectAppleFoundation } from "@/lib/private/web/apple-foundation";
import {
  BuiltinPromptApiProvider,
  detectBuiltin,
  dropOldestTurn,
  expectations,
  identifyBuiltinVendor,
  type BrowserLike,
} from "@/lib/private/web/prompt-api";

import { CHROME_NAV, EDGE_NAV, fakeLanguageModel, OLDER_EDGE_NAV, OPERA_NAV, UNVERSIONED_EDGE_NAV } from "./helpers/fake-language-model";
import { installNetworkTrap } from "./helpers/network-trap";

/**
 * The browser's built-in model through the Prompt API (`LanguageModel`):
 * detection in every availability state, browser verification, create()
 * failures, streaming, abort and history trimming — all with zero network.
 */

let trap: ReturnType<typeof installNetworkTrap>;
beforeEach(() => {
  trap = installNetworkTrap();
});
afterEach(() => {
  expect(trap.requests).toEqual([]);
  trap.restore();
});

function browser(nav: BrowserLike["navigator"], fake?: ReturnType<typeof fakeLanguageModel>): BrowserLike {
  return { isSecureContext: true, navigator: nav, ...(fake ? { LanguageModel: fake.api } : {}) };
}

async function collect(stream: AsyncIterable<LocalChunk>): Promise<LocalChunk[]> {
  const out: LocalChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const text = (chunks: LocalChunk[]) =>
  chunks.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("identifyBuiltinVendor", () => {
  it.each([
    ["Google Chrome brands", CHROME_NAV, "chrome"],
    ["Microsoft Edge brands", EDGE_NAV, "edge"],
    ["Opera brands", OPERA_NAV, null],
    ["Chromium only", { userAgentData: { brands: [{ brand: "Chromium" }] } }, null],
    ["Brave brands", { userAgentData: { brands: [{ brand: "Brave" }, { brand: "Chromium" }] } }, null],
    ["mobile Chrome", { userAgentData: { mobile: true, brands: [{ brand: "Google Chrome" }] } }, null],
    ["UA only: Chrome", { userAgent: CHROME_NAV.userAgent }, null],
    ["UA only: Edge", { userAgent: EDGE_NAV.userAgent }, null],
    ["UA only: Opera", { userAgent: OPERA_NAV.userAgent }, null],
    ["UA only: Brave (navigator.brave)", { userAgent: CHROME_NAV.userAgent, brave: {} }, null],
    ["UA only: HeadlessChrome", { userAgent: "Mozilla/5.0 HeadlessChrome/159.0.0.0 Safari/537.36" }, null],
    ["UA only: Android Chrome", { userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/148.0 Mobile Safari/537.36" }, null],
    ["UA only: Safari", { userAgent: "Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15" }, null],
    ["no navigator", undefined, null],
  ] as const)("%s", (_name, nav, expected) => {
    expect(identifyBuiltinVendor(nav as BrowserLike["navigator"], true)).toBe(expected);
  });

  it.each([false, undefined])("blocks trusted brands when secure context is %s", async (isSecureContext) => {
    const fake = fakeLanguageModel();
    const win = { ...browser(CHROME_NAV, fake), isSecureContext };
    expect(await detectBuiltin(win)).toEqual({ kind: "unverified" });
    const provider = new BuiltinPromptApiProvider("chrome", win);
    expect(await provider.isCached()).toBe(false);
    await expect(provider.load(builtinDescriptor("chrome"), () => {})).rejects.toMatchObject({ kind: "unsupported" });
    expect(fake.state.availabilityCalls).toEqual([]);
    expect(fake.state.createCalls).toEqual([]);
  });

  it("rejects a conflicting UA even with a Chrome brand", () => {
    expect(identifyBuiltinVendor({ ...CHROME_NAV, userAgent: OPERA_NAV.userAgent }, true)).toBeNull();
    expect(identifyBuiltinVendor({ ...CHROME_NAV, userAgent: EDGE_NAV.userAgent }, true)).toBeNull();
  });
});

describe("detectBuiltin", () => {
  it("API absent → absent", async () => {
    expect(await detectBuiltin(browser(CHROME_NAV))).toEqual({ kind: "absent" });
  });

  it.each(["unavailable", "downloadable", "downloading", "available"] as const)(
    "Chrome, availability %s",
    async (availability) => {
      const fake = fakeLanguageModel({ availability });
      expect(await detectBuiltin(browser(CHROME_NAV, fake))).toEqual({ kind: availability, vendor: "chrome" });
      // Same expectations as create() will get; nothing created or downloaded.
      expect(fake.state.availabilityCalls).toEqual([expectations()]);
      expect(fake.state.createCalls).toEqual([]);
    },
  );

  it.each([
    ["confirmed Edge 158", EDGE_NAV, "builtin/edge-aion-instruct", "Aion Instruct (built into Edge)"],
    ["Edge UA version fallback", { ...UNVERSIONED_EDGE_NAV, userAgent: EDGE_NAV.userAgent },
      "builtin/edge-aion-instruct", "Aion Instruct (built into Edge)"],
    ["older Edge", OLDER_EDGE_NAV, "builtin/edge", "Microsoft Edge built-in model"],
    ["brand version takes precedence", { ...OLDER_EDGE_NAV, userAgent: EDGE_NAV.userAgent },
      "builtin/edge", "Microsoft Edge built-in model"],
    ["unversioned Edge", UNVERSIONED_EDGE_NAV, "builtin/edge", "Microsoft Edge built-in model"],
  ] as const)("%s reports the correct model identity", async (_name, nav, id, displayName) => {
    expect(identifyBuiltinVendor(nav, true)).toBe("edge");
    const status = await detectBuiltin(browser(nav, fakeLanguageModel({ availability: "available" })));
    expect(status.kind).toBe("available");
    if (status.kind !== "available") throw new Error("Expected an available Edge model");
    const key = status.model ?? status.vendor;
    expect(builtinDescriptor(key)).toMatchObject({ vendor: "edge", id, displayName });
    expect(BUILTIN_MODEL[key].modelName).toBe(id === "builtin/edge" ? displayName : "Aion Instruct");
  });

  it("plain Chromium-like browser: API present, Chrome UA, no brands (secure context) → unverified", async () => {
    const fake = fakeLanguageModel({ availability: "downloadable" });
    const win = { isSecureContext: true, navigator: { userAgent: CHROME_NAV.userAgent }, LanguageModel: fake.api };
    expect(await detectBuiltin(win)).toEqual({ kind: "unverified" });
    expect(fake.state.availabilityCalls).toEqual([]);
  });

  it("a non-Chrome/Edge browser exposing the API is unverified and never asked", async () => {
    const fake = fakeLanguageModel({ availability: "available" });
    expect(await detectBuiltin(browser(OPERA_NAV, fake))).toEqual({ kind: "unverified" });
    expect(fake.state.availabilityCalls).toEqual([]);
  });

  it("availability() throwing → unavailable", async () => {
    const fake = fakeLanguageModel();
    fake.api.availability = async () => {
      throw new Error("boom");
    };
    expect(await detectBuiltin(browser(CHROME_NAV, fake))).toEqual({ kind: "unavailable", vendor: "chrome" });
  });

  it("uses one language constant, English for now", () => {
    expect(BUILTIN_LANGUAGES).toEqual(["en"]);
    expect(expectations()).toEqual({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  });
});

describe("BuiltinPromptApiProvider.load", () => {
  it("downloadable: create() with a monitor reports download progress, then loads", async () => {
    const fake = fakeLanguageModel({ availability: "downloadable", progress: [0, 0.25, 0.75, 1], contextWindow: 9000 });
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fake));
    const progress: number[] = [];
    await provider.load(builtinDescriptor("chrome"), (p) => progress.push(p.fraction));
    expect(progress).toEqual([0, 0.25, 0.75, 1]);
    expect(fake.state.createCalls[0]).toMatchObject(expectations());
    expect(provider.contextWindowTokens).toBe(9000);
    expect(await provider.isCached()).toBe(true);
  });

  it.each([
    ["NotAllowedError", "not_allowed"],
    ["NetworkError", "download_failed"],
    ["NotSupportedError", "unsupported"],
    ["SomethingElse", "unknown"],
  ])("create() rejecting %s → %s", async (name, kind) => {
    const fake = fakeLanguageModel({ availability: "downloadable", createErrors: [name] });
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fake));
    const error = await provider.load(builtinDescriptor("chrome"), () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect((error as LocalRuntimeError).kind).toBe(kind);
    await expect(collect(provider.stream({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 }))).rejects.toMatchObject({ kind: "not_loaded" });
  });

  it("an aborted load is cancelled", async () => {
    const fake = fakeLanguageModel();
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fake));
    const abort = new AbortController();
    abort.abort();
    await expect(provider.load(builtinDescriptor("chrome"), () => {}, abort.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("calls create() synchronously, so a click's user activation reaches it", () => {
    const fake = fakeLanguageModel({ availability: "downloadable" });
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fake));
    void provider.load(builtinDescriptor("chrome"), () => {});
    expect(fake.state.createCalls).toHaveLength(1);
  });
});

describe("BuiltinPromptApiProvider.stream", () => {
  async function loaded(options: Parameters<typeof fakeLanguageModel>[0] = {}) {
    const fake = fakeLanguageModel(options);
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fake));
    await provider.load(builtinDescriptor("chrome"), () => {});
    return { fake, provider };
  }

  const history = [
    { role: "system" as const, content: "SYS" },
    { role: "user" as const, content: "q1" },
    { role: "assistant" as const, content: "a1" },
    { role: "user" as const, content: "q2" },
    { role: "assistant" as const, content: "a2" },
    { role: "user" as const, content: "q3" },
  ];

  it.each([false, true])("streams chunks (ReadableStream: %s), seeding a fresh session with the history", async (readableStream) => {
    const { fake, provider } = await loaded({ replies: [["Hel", "lo", "!"]], readableStream });
    const chunks = await collect(provider.stream({ messages: history, maxTokens: 100 }));
    expect(text(chunks)).toBe("Hello!");
    expect(chunks.at(-1)).toMatchObject({ type: "done", model: "builtin/chrome-gemini-nano", finishReason: "stop" });
    expect(fake.state.prompts).toEqual([{ input: "q3", initialPrompts: history.slice(0, -1) }]);
    const turnCreate = fake.state.createCalls.at(-1)!;
    expect(turnCreate).toMatchObject(expectations());
    expect(turnCreate).not.toHaveProperty("temperature");
    expect(turnCreate).not.toHaveProperty("topK");
    expect(turnCreate).not.toHaveProperty("samplingMode");
    // The per-turn session is destroyed afterwards (the base session stays).
    expect(fake.state.destroyed).toBe(1);
  });

  it("abort stops the stream quietly and destroys the session", async () => {
    const { fake, provider } = await loaded({ replies: [["partial ", "<wait>"]] });
    const abort = new AbortController();
    const chunks: LocalChunk[] = [];
    const run = (async () => {
      for await (const chunk of provider.stream({ messages: history, maxTokens: 100, signal: abort.signal })) {
        chunks.push(chunk);
        if (chunk.type === "text") abort.abort();
      }
    })();
    await run;
    expect(text(chunks)).toBe("partial ");
    expect(chunks.some((c) => c.type === "done")).toBe(false);
    expect(fake.state.destroyed).toBe(1);
  });

  it("QuotaExceededError drops the oldest turns and retries", async () => {
    const { fake, provider } = await loaded({ maxInitialPrompts: 3, replies: [["never"], ["fits"]] });
    const chunks = await collect(provider.stream({ messages: history, maxTokens: 100 }));
    expect(text(chunks)).toBe("fits");
    expect(fake.state.prompts.map((p) => p.initialPrompts)).toEqual([
      history.slice(0, -1),
      [history[0], history[3], history[4]],
    ]);
    expect(fake.state.prompts.every((p) => p.input === "q3")).toBe(true);
    // Both per-turn sessions are destroyed.
    expect(fake.state.destroyed).toBe(2);
  });

  it("QuotaExceededError with nothing left to drop → context_exceeded", async () => {
    const { provider } = await loaded({ maxInitialPrompts: 0 });
    await expect(collect(provider.stream({ messages: history, maxTokens: 100 }))).rejects.toMatchObject({
      kind: "context_exceeded",
    });
  });

  it("dropOldestTurn keeps the system prompt and opens on a user turn", () => {
    expect(dropOldestTurn(history.slice(0, -1))).toEqual([history[0], history[3], history[4]]);
    expect(dropOldestTurn([history[0]])).toBeNull();
  });

  it("not loaded → not_loaded", async () => {
    const provider = new BuiltinPromptApiProvider("chrome", browser(CHROME_NAV, fakeLanguageModel()));
    await expect(collect(provider.stream({ messages: history, maxTokens: 1 }))).rejects.toMatchObject({ kind: "not_loaded" });
  });

  it("the provider never deletes the browser's model", async () => {
    const { fake, provider } = await loaded();
    await provider.deleteCached();
    await provider.unload();
    expect(fake.state.destroyed).toBe(1); // only the base session
    expect(await provider.countTokens()).toBeNull();
  });
});

describe("Apple Foundation Models stub", () => {
  it("is always unavailable on the web, bridge or not", () => {
    expect(detectAppleFoundation({})).toEqual({ kind: "unavailable", reason: "no_bridge" });
    expect(
      detectAppleFoundation({ webkit: { messageHandlers: { korumFoundationModels: { postMessage() {} } } } }),
    ).toEqual({ kind: "unavailable", reason: "not_implemented" });
  });
});
