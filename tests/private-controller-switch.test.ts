import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalRuntimeError, LocalRuntimeId } from "@/lib/private/core/local-provider";
import { builtinDescriptor } from "@/lib/private/core/provider-policy";
import { PrivateChatController } from "@/lib/private/web/private-chat-controller";
import { BuiltinPromptApiProvider } from "@/lib/private/web/prompt-api";
import { IndexedDBThreadStore } from "@/lib/private/web/thread-store";

import { CHROME_NAV, fakeLanguageModel } from "./helpers/fake-language-model";
import { descriptor, MockLocalProvider } from "./helpers/mock-local-provider";
import { installNetworkTrap } from "./helpers/network-trap";

/** The chat controller on the built-in model, and switching engines between turns. */

let store: IndexedDBThreadStore;
let trap: ReturnType<typeof installNetworkTrap>;
beforeEach(async () => {
  trap = installNetworkTrap();
  store = await IndexedDBThreadStore.open(new IDBFactory());
});
afterEach(() => {
  store.close();
  expect(trap.requests).toEqual([]);
  trap.restore();
});

async function setup(replies: string[][], options: Parameters<typeof fakeLanguageModel>[0] = {}) {
  const fake = fakeLanguageModel({ availability: "available", replies, ...options });
  const builtin = new BuiltinPromptApiProvider("chrome", { isSecureContext: true, navigator: CHROME_NAV, LanguageModel: fake.api });
  await builtin.load(builtinDescriptor("chrome"), () => {});
  const webllm = new MockLocalProvider();
  const errors: [LocalRuntimeError, LocalRuntimeId][] = [];
  const c = new PrivateChatController({
    provider: webllm,
    store,
    profileKey: "anon",
    deviceId: "dev",
    writeClipboard: async () => {},
    onRuntimeError: (error, provider) => errors.push([error, provider]),
  });
  await c.init();
  return { fake, builtin, webllm, c, errors };
}

describe("controller on the built-in model", () => {
  it("answers through the Prompt API with the system prompt and history, and records the model id", async () => {
    const { fake, builtin, webllm, c } = await setup([["one"], ["two"]]);
    c.setModel(builtinDescriptor("chrome", builtin.contextWindowTokens ?? undefined), builtin);
    await c.send("first");
    await c.send("second");
    expect(webllm.requests).toEqual([]);
    const last = fake.state.prompts.at(-1)!;
    expect(last.input).toBe("second");
    expect(last.initialPrompts?.[0].role).toBe("system");
    expect(last.initialPrompts?.slice(1)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ]);
    const assistant = c.getState().messages.filter((m) => m.role === "assistant");
    expect(assistant.map((m) => [m.content, m.localModel])).toEqual([
      ["one", "builtin/chrome-gemini-nano"],
      ["two", "builtin/chrome-gemini-nano"],
    ]);
  });

  it("keeps literal <think> text (only Qwen3 on WebLLM needs the think filter)", async () => {
    const { builtin, c } = await setup([["a <think>b</think> c"]]);
    c.setModel(builtinDescriptor("chrome"), builtin);
    await c.send("q");
    expect(c.getState().messages.at(-1)!.content).toBe("a <think>b</think> c");
  });

  it("Stop aborts the built-in stream and keeps the partial answer", async () => {
    const { builtin, c } = await setup([["partial ", "<wait>"]]);
    c.setModel(builtinDescriptor("chrome"), builtin);
    const pending = c.send("q");
    for (let i = 0; i < 20 && !c.getState().messages.at(-1)?.content; i++) await new Promise((r) => setTimeout(r, 5));
    c.stop();
    await pending;
    expect(c.getState().messages.at(-1)).toMatchObject({ content: "partial ", status: "complete" });
    expect(c.getState().streamingId).toBeNull();
  });

  it("a message too long for the built-in context window is refused, not truncated", async () => {
    const { fake, builtin, c } = await setup([], { contextWindow: 1500 });
    c.setModel(builtinDescriptor("chrome", builtin.contextWindowTokens ?? undefined), builtin);
    await c.send("x".repeat(4000));
    expect(c.getState().messages.at(-1)).toMatchObject({ status: "error", errorKind: "context_exceeded" });
    expect(fake.state.prompts).toEqual([]);
  });

  it("switches engines between turns and reports which engine failed", async () => {
    const { fake, builtin, webllm, c, errors } = await setup([["from nano"]]);
    c.setModel(builtinDescriptor("chrome"), builtin);
    await c.send("one");
    c.setModel(descriptor("M"), webllm);
    webllm.replies.push(["from qwen"]);
    await c.send("two");
    expect(fake.state.prompts).toHaveLength(1);
    expect(webllm.requests).toHaveLength(1);

    c.setModel(builtinDescriptor("chrome"), builtin);
    await builtin.unload();
    await c.send("three");
    expect(errors.map(([e, p]) => [e.kind, p])).toEqual([["not_loaded", "builtin-prompt-api"]]);
  });
});
