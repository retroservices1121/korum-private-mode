import type { BrowserContext, Page } from "@playwright/test";

/**
 * TEST-SIDE ONLY. Installs a scripted Prompt API (`window.LanguageModel`)
 * plus `navigator.userAgentData` brands before any page script runs, so the
 * real built-in-model provider in the production bundle is exercised in
 * headless Chromium and WebKit. Nothing here is in
 * the app bundle.
 *
 * The reply mirrors `e2eMockReply()` (lib/private/web/e2e-mock-provider.ts):
 * it echoes the prompt's `KORUM-CANARY-…` token into remote, same-origin and
 * data: images, raw `<img>` HTML, inline code and a link, so the renderer
 * canary checks run on the built-in path too. It never touches the network.
 */

export interface FakeLanguageModelConfig {
  availability: "unavailable" | "downloadable" | "downloading" | "available";
  /** Which browser the page believes it is. */
  brand: "Google Chrome" | "Microsoft Edge" | "Opera";
  /** downloadprogress fractions emitted on the first create(), when not yet available. */
  progress?: number[];
  /** Delay between progress events, ms. */
  progressDelayMs?: number;
}

declare global {
  interface Window {
    __fakeLM?: { availabilityCalls: number; createCalls: number; prompts: number; userActivation: boolean[] };
  }
}

function install(config: FakeLanguageModelConfig) {
  const TINY_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const reply = (lastUserText: string, turn: number) => {
    const canary = /KORUM-CANARY-[0-9A-Za-z-]+/.exec(lastUserText)?.[0] ?? "KORUM-CANARY-none";
    return [
      `Mock answer ${turn} for ${canary}.`,
      "",
      `![remote](https://canary.test/img?c=${canary})`,
      "",
      `![same-origin](/canary-same-origin?c=${canary})`,
      "",
      `![inline](${TINY_PNG})`,
      "",
      `<img src="https://canary.test/raw?c=${canary}" alt="raw">`,
      "",
      `Inline HTML as code: \`<img src="https://canary.test/code?c=${canary}">\``,
      "",
      `[canary link](https://canary.test/link?c=${canary})`,
    ].join("\n");
  };
  const abortError = () => new DOMException("aborted", "AbortError");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const stats = { availabilityCalls: 0, createCalls: 0, prompts: 0, userActivation: [] as boolean[] };
  window.__fakeLM = stats;
  let availability = config.availability;
  let turn = 0;
  // Transient user activation, as Chrome requires for a download (WebKit without the API: assume a click).
  const activated = () => (navigator.userActivation ? navigator.userActivation.isActive : true);

  const brands = [
    { brand: "Chromium", version: "148" },
    { brand: config.brand, version: "148" },
    { brand: "Not/A)Brand", version: "99" },
  ];
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { brands, mobile: false, platform: "Linux" },
  });

  type Options = {
    signal?: AbortSignal;
    monitor?: (m: { addEventListener(type: string, cb: (e: { loaded: number }) => void): void }) => void;
  };

  const LanguageModel = {
    async availability() {
      stats.availabilityCalls++;
      return availability;
    },
    async create(options: Options = {}) {
      stats.createCalls++;
      stats.userActivation.push(activated());
      if (options.signal?.aborted) throw abortError();
      if (availability === "unavailable") throw new DOMException("unavailable", "NotSupportedError");
      if (availability !== "available") {
        if (!activated()) throw new DOMException("needs a click", "NotAllowedError");
        const listeners: ((e: { loaded: number }) => void)[] = [];
        options.monitor?.({ addEventListener: (_type, cb) => listeners.push(cb) });
        for (const loaded of config.progress ?? [0, 0.25, 0.5, 0.75, 1]) {
          await sleep(config.progressDelayMs ?? 150);
          for (const cb of listeners) cb({ loaded });
        }
        availability = "available";
      }
      return {
        contextWindow: 6144,
        destroy() {},
        promptStreaming(input: string, opts: { signal?: AbortSignal } = {}) {
          stats.prompts++;
          const text = reply(input, ++turn);
          const parts = text.match(/[\s\S]{1,48}/g) ?? [];
          return new ReadableStream<string>({
            async pull(controller) {
              await sleep(5);
              if (opts.signal?.aborted) return controller.error(abortError());
              const next = parts.shift();
              if (next === undefined) controller.close();
              else controller.enqueue(next);
            },
          });
        },
      };
    },
  };
  Object.defineProperty(window, "LanguageModel", { configurable: true, value: LanguageModel });
}

export async function installFakeLanguageModel(target: Page | BrowserContext, config: FakeLanguageModelConfig) {
  await target.addInitScript(install, config);
}
