// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalModelDescriptor } from "@/lib/private/core/local-provider";
import { enableLabel } from "@/components/private/builtin-setup";
import { UPGRADE_HEADING } from "@/components/private/model-setup";
import { UNAVAILABLE_HEADLINE } from "@/components/private/unavailable-state";

import { CHROME_NAV, EDGE_NAV, fakeLanguageModel, OPERA_NAV } from "./helpers/fake-language-model";
import { installNetworkTrap } from "./helpers/network-trap";

/**
 * /private with the browser's built-in model: it is the default, its own name
 * and the vendor's privacy wording are shown, a browser download needs a
 * click and shows progress, WebLLM tiers are an opt-in upgrade, and nothing
 * here touches the network. Without either engine: the unavailable state.
 */

const webllmState = vi.hoisted(() => ({ created: 0, loads: 0, cached: false }));

vi.mock("@/lib/private/web/webllm-provider", async () => {
  const { MockLocalProvider } = await import("./helpers/mock-local-provider");
  class WebLLMLocalProvider extends MockLocalProvider {
    constructor() {
      super();
      webllmState.created++;
    }
    async isCached() {
      return webllmState.cached;
    }
    async load(model: LocalModelDescriptor) {
      webllmState.loads++;
      await super.load(model);
    }
    dispose() {}
  }
  return { WebLLMLocalProvider };
});

const gpu = {
  requestAdapter: async () => ({
    features: new Set(["shader-f16"]),
    limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
    info: { vendor: "nvidia" },
    isFallbackAdapter: false,
  }),
};

let root: Root | null;
let container: HTMLDivElement;
let trap: ReturnType<typeof installNetworkTrap>;

function setBrowser(nav: { userAgent: string; userAgentData: unknown }, fake: ReturnType<typeof fakeLanguageModel> | null, withGpu: boolean) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: nav.userAgent });
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value: nav.userAgentData });
  if (withGpu) Object.defineProperty(navigator, "gpu", { configurable: true, value: gpu });
  if (fake) (globalThis as Record<string, unknown>).LanguageModel = fake.api;
}

async function waitFor(predicate: () => boolean, rounds = 80) {
  for (let i = 0; i < rounds && !predicate(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  expect(predicate()).toBe(true);
}

async function renderApp() {
  const { PrivateApp } = await import("@/components/private/private-app");
  root = createRoot(container);
  await act(async () => root!.render(<PrivateApp />));
}

const text = () => container.textContent ?? "";
const textarea = () => container.querySelector("textarea")!;
const button = (label: string | RegExp) =>
  [...container.querySelectorAll("button")].find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""),
  );

async function click(el: Element | undefined) {
  expect(el).toBeDefined();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function send(prompt: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea(), prompt);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  trap = installNetworkTrap();
  vi.stubGlobal("isSecureContext", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  webllmState.created = 0;
  webllmState.loads = 0;
  webllmState.cached = false;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("korum-private");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  trap.restore();
  vi.unstubAllGlobals();
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.gpu;
  delete nav.userAgentData;
  delete (globalThis as Record<string, unknown>).LanguageModel;
});

describe("/private with the browser's built-in model", () => {
  it("available: the default, named, with Google's own wording; a chat stays off the network", async () => {
    const fake = fakeLanguageModel({ availability: "available", replies: [["Hello ", "from Nano"]] });
    setBrowser(CHROME_NAV, fake, true);
    await renderApp();
    await waitFor(() => !textarea().disabled);

    expect(text()).toContain("On this device: Gemini Nano (built into Chrome)");
    const chip = [...container.querySelectorAll("span")].find((s) => s.textContent?.startsWith("Private · On this device"))!;
    expect(chip.textContent).toContain("Gemini Nano (built into Chrome)");
    const copy = container.querySelector('[data-privacy-copy="builtin"]')!.textContent!;
    expect(copy).toContain(
      "Chrome runs Gemini Nano on your device. Google says: “Subsequent use of the model does not require a network connection. No data is sent to Google or any third party when using the model.”",
    );
    // No download offered, nothing downloaded; the upgrade is a choice.
    expect(text()).not.toContain("Set up Private Mode");
    expect(button("Better quality…")).toBeDefined();
    expect(webllmState.loads).toBe(0);

    await send("KORUM-CANARY-builtin");
    await waitFor(() => text().includes("Hello from Nano"));
    expect(fake.state.prompts.at(-1)!.input).toBe("KORUM-CANARY-builtin");
    expect(trap.requests).toEqual([]);
  });

  it("downloadable: Enable needs a click, shows Chrome's download progress, then chat is ready", async () => {
    const fake = fakeLanguageModel({ availability: "downloadable", progress: [0, 0.4, 1] });
    setBrowser(CHROME_NAV, fake, true);
    await renderApp();
    await waitFor(() => Boolean(button(enableLabel("chrome"))));
    expect(button("Enable — Chrome downloads it once")).toBeDefined();
    expect(text()).toContain("Chrome does the download, not KORUM");
    expect(textarea().disabled).toBe(true);
    expect(fake.state.createCalls).toEqual([]);

    await click(button(enableLabel("chrome")));
    await waitFor(() => !textarea().disabled);
    expect(fake.state.createCalls).toHaveLength(1);
    expect(text()).toContain("On this device: Gemini Nano (built into Chrome)");
    expect(trap.requests).toEqual([]);
  });

  it("downloading: progress % from downloadprogress is shown while Chrome downloads", async () => {
    const fake = fakeLanguageModel({ availability: "downloading" });
    let progress: ((e: { loaded: number }) => void) | null = null;
    let finish: (() => void) | null = null;
    const original = fake.api.create;
    fake.api.create = async (options) => {
      options.monitor?.({ addEventListener: (_t, l) => (progress = l) });
      await new Promise<void>((resolve) => (finish = resolve));
      fake.state.availability = "available";
      return original({ ...options, monitor: undefined });
    };
    setBrowser(CHROME_NAV, fake, true);
    await renderApp();
    await waitFor(() => text().includes("Chrome has started downloading Gemini Nano"));
    await click(button(enableLabel("chrome")));
    await act(async () => progress!({ loaded: 0.42 }));
    expect(text()).toContain("Chrome is downloading Gemini Nano… 42%");
    await act(async () => finish!());
    await waitFor(() => !textarea().disabled);
  });

  it("Edge: Aion Instruct with Microsoft's own wording", async () => {
    setBrowser(EDGE_NAV, fakeLanguageModel({ availability: "available" }), true);
    await renderApp();
    await waitFor(() => !textarea().disabled);
    expect(text()).toContain("Aion Instruct (built into Edge)");
    expect(text()).toContain("Microsoft says: “The data input to the model never leaves the device.”");
  });

  it.each([
    ["NotAllowedError", "downloadable", "Enable — Chrome downloads it once"],
    ["NetworkError", "available", "Start Gemini Nano"],
    ["NotSupportedError", "unavailable", null],
    ["UnexpectedError", "available", "Start Gemini Nano"],
  ] as const)("after a successful turn, %s rechecks readiness and routes to %s", async (error, availability, action) => {
    const fake = fakeLanguageModel({ replies: [["First answer"], ["Recovered answer"]] });
    setBrowser(CHROME_NAV, fake, false);
    await renderApp();
    await waitFor(() => !textarea().disabled);
    await send("First question");
    await waitFor(() => text().includes("First answer") && !button("Stop generating"));

    fake.state.availability = availability;
    fake.state.createErrors.push(error);
    await send("Next question");
    await waitFor(() => textarea().disabled && (action ? Boolean(button(action)) : text().includes(UNAVAILABLE_HEADLINE)));
    expect(fake.state.availabilityCalls).toHaveLength(2);
    expect(fake.state.createCalls).toHaveLength(3);

    if (action) {
      await click(button(action));
      await waitFor(() => !textarea().disabled);
      await send("Try again");
      await waitFor(() => text().includes("Recovered answer"));
    }
    expect(trap.requests).toEqual([]);
  });

  it.each([
    ["chrome", CHROME_NAV, "Chrome"],
    ["edge", EDGE_NAV, "Edge"],
  ] as const)("%s download setup and retry use vendor-specific details", async (vendor, nav, browser) => {
    const fake = fakeLanguageModel({ availability: "downloadable", createErrors: ["NetworkError"] });
    setBrowser(nav, fake, false);
    await renderApp();
    await waitFor(() => Boolean(button(enableLabel(vendor))));
    expect(text().includes("Chrome does the download, not KORUM.")).toBe(vendor === "chrome");
    await click(button(enableLabel(vendor)));
    await waitFor(() => text().includes(`${browser} couldn't download the model.`));
    expect(text().toLowerCase()).toContain("try again");
    expect(text().includes("unmetered connection")).toBe(vendor === "chrome");
    await click(button(enableLabel(vendor)));
    await waitFor(() => !textarea().disabled);
  });

  it("better quality: the tier downloads while chatting on the built-in model, then the user switches", async () => {
    setBrowser(CHROME_NAV, fakeLanguageModel({ availability: "available" }), true);
    await renderApp();
    await waitFor(() => !textarea().disabled);
    await click(button("Better quality…"));
    await waitFor(() => text().includes(UPGRADE_HEADING));
    const download = button(/download$/);
    await click(download);
    await waitFor(() => Boolean(button(/^Switch to /)));
    expect(webllmState.loads).toBe(1);
    // Still on the built-in model until the user switches.
    expect(text()).toContain("On this device: Gemini Nano (built into Chrome)");
    await click(button(/^Switch to /));
    await waitFor(() => !text().includes("On this device: Gemini Nano"));
    expect(text()).toMatch(/On this device: (Qwen3|Llama)/);
    expect(button("Use Gemini Nano instead")).toBeDefined();
    expect(trap.requests).toEqual([]);
  });

  it("a browser we can't verify (Opera) with no WebGPU: unavailable, both reasons, composer disabled", async () => {
    const fake = fakeLanguageModel({ availability: "available" });
    setBrowser(OPERA_NAV, fake, false);
    await renderApp();
    await waitFor(() => text().includes(UNAVAILABLE_HEADLINE));
    expect(container.querySelector('[data-unavailable="builtin"]')!.textContent).toContain("can't verify that it runs on this device");
    expect(container.querySelector('[data-unavailable="webllm"]')!.textContent).toContain("does not offer WebGPU");
    expect(textarea().disabled).toBe(true);
    expect(fake.state.createCalls).toEqual([]);
    expect(container.querySelectorAll("a[href]")).toHaveLength(0);
    expect(trap.requests).toEqual([]);
  });

  it("Chrome says its model can't run here, and no WebGPU: unavailable with Chrome's requirements", async () => {
    setBrowser(CHROME_NAV, fakeLanguageModel({ availability: "unavailable" }), false);
    await renderApp();
    await waitFor(() => text().includes(UNAVAILABLE_HEADLINE));
    expect(text()).toContain("Chrome says Gemini Nano can't run on this device");
    expect(text()).toContain("22 GB of free disk space");
    expect(textarea().disabled).toBe(true);
    expect(trap.requests).toEqual([]);
  });

  it("an unverified built-in model with WebGPU: the opt-in WebLLM setup, with a note", async () => {
    setBrowser(OPERA_NAV, fakeLanguageModel({ availability: "available" }), true);
    await renderApp();
    await waitFor(() => text().includes("Set up Private Mode"));
    expect(text()).toContain("KORUM can't verify that it runs on this device");
    expect(webllmState.loads).toBe(0);
    expect(textarea().disabled).toBe(true);
  });
});
