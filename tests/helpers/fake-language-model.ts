import type {
  LanguageModelAvailability,
  LanguageModelCreateOptions,
  LanguageModelSessionLike,
  LanguageModelStatic,
} from "@/lib/private/web/prompt-api";

export function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

export interface FakeLanguageModelOptions {
  availability?: LanguageModelAvailability;
  /** Progress fractions emitted on create() when the model is not yet available. */
  progress?: number[];
  /** create() rejects with this DOMException name (once per entry, in order). */
  createErrors?: string[];
  /** Reply chunks for each prompt, in order. `"<wait>"` blocks until aborted. */
  replies?: string[][];
  /** promptStreaming() rejects with QuotaExceededError while initialPrompts are longer than this. */
  maxInitialPrompts?: number;
  contextWindow?: number;
  /** Return a ReadableStream instead of an async iterable. */
  readableStream?: boolean;
}

/**
 * A scripted Prompt API. Records every call so tests can check that the same
 * expectations reach availability() and create(), what history was sent,
 * and that sessions are destroyed.
 */
export function fakeLanguageModel(options: FakeLanguageModelOptions = {}) {
  const state = {
    availability: options.availability ?? "available",
    availabilityCalls: [] as unknown[],
    createCalls: [] as LanguageModelCreateOptions[],
    prompts: [] as { input: string; initialPrompts: LanguageModelCreateOptions["initialPrompts"] }[],
    destroyed: 0,
    createErrors: [...(options.createErrors ?? [])],
    replies: (options.replies ?? []).map((r) => [...r]),
  };

  const api: LanguageModelStatic = {
    async availability(opts) {
      state.availabilityCalls.push(opts);
      return state.availability;
    },
    async create(opts) {
      state.createCalls.push(opts);
      const error = state.createErrors.shift();
      if (error) throw domError(error);
      if (opts.signal?.aborted) throw domError("AbortError");
      if (state.availability !== "available" && opts.monitor) {
        const listeners: ((e: { loaded: number }) => void)[] = [];
        opts.monitor({ addEventListener: (_type, listener) => listeners.push(listener) });
        for (const loaded of options.progress ?? [0, 0.5, 1]) {
          await Promise.resolve();
          for (const l of listeners) l({ loaded });
        }
        state.availability = "available";
      }
      const initialPrompts = opts.initialPrompts;
      const session: LanguageModelSessionLike = {
        contextWindow: options.contextWindow ?? 6000,
        destroy() {
          state.destroyed++;
        },
        promptStreaming(input, promptOptions) {
          state.prompts.push({ input, initialPrompts });
          const tooLong =
            options.maxInitialPrompts !== undefined && (initialPrompts?.length ?? 0) > options.maxInitialPrompts;
          const reply = state.replies.shift() ?? ["ok"];
          const signal = promptOptions?.signal;
          async function* chunks() {
            if (tooLong) throw domError("QuotaExceededError");
            for (const chunk of reply) {
              if (chunk === "<wait>") {
                await new Promise<void>((resolve) => {
                  if (signal?.aborted) return resolve();
                  signal?.addEventListener("abort", () => resolve(), { once: true });
                });
                throw domError("AbortError");
              }
              if (signal?.aborted) throw domError("AbortError");
              yield chunk;
            }
          }
          if (!options.readableStream) return chunks();
          const iterator = chunks();
          return new ReadableStream<string>({
            async pull(controller) {
              try {
                const { done, value } = await iterator.next();
                if (done) controller.close();
                else controller.enqueue(value);
              } catch (error) {
                controller.error(error);
              }
            },
          });
        },
      };
      return session;
    },
  };
  return { api, state };
}

export const CHROME_NAV = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  userAgentData: {
    mobile: false,
    brands: [
      { brand: "Chromium", version: "148" },
      { brand: "Google Chrome", version: "148" },
      { brand: "Not/A)Brand", version: "99" },
    ],
  },
};

export const EDGE_NAV = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0",
  userAgentData: {
    mobile: false,
    brands: [
      { brand: "Chromium", version: "158" },
      { brand: "Microsoft Edge", version: "158" },
    ],
  },
};

export const OLDER_EDGE_NAV = {
  userAgent: EDGE_NAV.userAgent.replace("Edg/158", "Edg/128"),
  userAgentData: { mobile: false, brands: [{ brand: "Microsoft Edge", version: "128" }] },
};

export const UNVERSIONED_EDGE_NAV = {
  userAgent: CHROME_NAV.userAgent,
  userAgentData: { mobile: false, brands: [{ brand: "Microsoft Edge", version: "unknown" }] },
};

export const OPERA_NAV = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 OPR/130.0.0.0",
  userAgentData: {
    mobile: false,
    brands: [
      { brand: "Chromium", version: "148" },
      { brand: "Opera", version: "130" },
    ],
  },
};
