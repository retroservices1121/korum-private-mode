# Korum Private Mode

Korum Private Mode is the open-source client and on-device runtime behind
<https://korum.to/private>. It is a private AI chat that runs entirely in your
browser. Inference runs on your device, and your prompts and replies stay there.

This repository contains the Private Mode client and runtime only.

## Built-in models

Private Mode defaults to the browser's built-in model when it can run. Desktop
Chrome 148 or later provides Gemini Nano, and Chrome handles any initial model
download when you click **Enable**. Microsoft Edge offers a built-in model as a
developer preview behind a browser flag or an origin trial. Private Mode labels
it Aion Instruct when it can confirm Edge 158 or later and uses “Microsoft Edge
built-in model” otherwise. Korum has no Edge origin-trial registration. [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
[Edge Prompt API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api)

Private Mode requires a secure context and a verified Google Chrome or Microsoft
Edge brand in `navigator.userAgentData.brands` before using the Prompt API.
This gate matters because the API itself does not guarantee local inference.

The Apple Foundation Models provider is a stub for a future native iOS or macOS
shell and always reports unavailable on the web.

## WebLLM model tiers

WebLLM 0.2.88 runs these opt-in **Better quality** upgrades on WebGPU inside a
Web Worker. Choose a tier and start the download while you keep chatting with
the built-in model. You can switch when the tier is ready. Private Mode reuses
complete cached downloads and remembers your provider and tier choices. If the
built-in model is unavailable, you can still choose a WebLLM tier.

The catalog is in `lib/private/core/model-catalog.ts`. Every tier comes in two
builds: `q4f16_1` for GPUs that support `shader-f16`, and `q4f32_1` for GPUs
that don't. The app picks the right build automatically.

| Tier  | Label    | Model                 | Download (approx.) |
| ----- | -------- | --------------------- | ------------------ |
| `L`   | Best     | Qwen3 8B              | 4.6 GB             |
| `M`   | Balanced | Qwen3 4B              | 2.3 GB             |
| `S`   | Light    | Llama 3.2 3B Instruct | 1.8 GB             |
| `XS`  | Lite     | Qwen3 1.7B            | 1.0 GB             |
| `XXS` | Mini     | Qwen3 0.6B            | 0.4 GB             |

The UI labels Lite "lower quality" and Mini "lowest quality". Mini is the
default on phones and tablets and on low-memory devices. Lite is a manual
upgrade from Mini and a step-down target from Light. Qwen3's hybrid "thinking"
mode is turned off.

### How a tier is selected

The selection logic is `pickTier` in `lib/private/core/tier-policy.ts`. It is a
pure function with table tests in `tests/private-tier-policy.test.ts`.

1. **Floor.** If WebGPU is missing, there is no adapter, the only adapter is a
   software fallback, or there isn't enough free storage for the smallest
   tier, the result is *unavailable*.
2. **Selectable tiers.** A tier is selectable if it fits in free storage (its
   download size plus 20% headroom, when the browser reports a quota) and is
   not blocked.
3. **Recommendation** (`heuristicTier`). The thresholds are provisional.
   - **Mini:** used on phones and tablets (a mobile user agent,
     `userAgentData.mobile`, or iPadOS in desktop mode), whatever memory they
     report, and when known device memory is below 4 GB.
   - **Best:** needs `shader-f16`, `navigator.deviceMemory` of at least 8, a
     `maxBufferSize` of at least 1 GiB, an NVIDIA, AMD or Apple GPU, and at
     least 10 GB of free storage.
   - **Balanced:** needs at least 8 GB of device memory and at least 5 GB of
     free storage (or an unknown amount).
   - **Light:** used in all other cases.
   - **Unknown device memory.** `deviceMemory` is Chromium-only, so on other
     browsers memory is usually unknown. An Apple GPU with `shader-f16` gets
     Balanced. Everything else gets Light. Phones still get Mini.
4. **Choice.** You can keep "auto" or pick any selectable tier by hand.

### How step-down works

Some load or runtime failures show that a tier doesn't fit the device: out of
memory, GPU device lost, or pipeline creation failed. On one of these,
`lib/private/web/engine-recovery.ts` does the following:

1. It records the failure. Only the tier and a timestamp are stored, never any
   content.
2. It runs `pickTier` again:
   - In auto mode, it steps down (L → M → S → XS → XXS) past any tier that failed in
     the last 7 days.
   - Two failures within 7 days block a tier, even if you picked it by hand.
   - Auto mode never steps up, and never falls back to a cloud model.
3. If the next tier down is already cached, it loads straight away. If not, the
   download needs your explicit approval.
4. If no tier is left, the app shows the unavailable state.

Downloading Best always needs a click, as does any stepped-down tier. In the
web app, every first download needs a click.

## Privacy guarantees

Each guarantee below lists where the code enforces it and which tests check
it.

- **On-device inference.** All engines implement `LocalProvider`
  (`lib/private/core/local-provider.ts`). The browser built-in model uses
  the Prompt API without sending requests from the page. Google documents
  Gemini Nano's offline behavior in Chrome.

  > Subsequent use of the model does not require a network connection. No data is sent to Google or any third party when using the model.

  [Google's Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api)

  `e2e/builtin.spec.ts` verifies that enabling the built-in model and chatting
  make zero page requests once the offline shell is ready. WebLLM runs in a
  dedicated worker (`lib/private/web/webllm-worker.ts`).
  `tests/private-no-network.test.ts` uses a mock provider to check for network
  calls during send, stream, stop, regenerate, copy, export and thread management.
- **No cloud fallback.** If neither on-device option can run, the app shows
  an unavailable state (`components/private/unavailable-state.tsx`). See
  `lib/private/core/provider-policy.ts` and
  `tests/private-unavailable.test.tsx`. In `e2e/privacy.spec.ts`, a production
  build without a GPU shows this state. The test checks observed traffic for
  cross-origin requests and calls to a server API.
- **No analytics, auth or error reporting.** The root layout (`app/layout.tsx`)
  mounts none of these. `tests/private-boundary.test.ts` only allows imports
  from an allowlist of packages and rejects analytics, error-reporting, auth,
  database and server SDKs. The app uses system fonts.
- **Local storage only.**
  - Chats are stored in IndexedDB, in the `korum-private` database
    (`lib/private/web/thread-store.ts`). They have no extra at-rest encryption
    beyond the browser's origin isolation.
  - WebLLM model files are stored in Cache Storage. The browser manages its
    own built-in model.
  - Provider and tier choices and failure history are stored in `localStorage`.
  - Export to JSON or Markdown writes a local file (`lib/private/core/thread-export.ts`)
    and uploads nothing.
  - The app asks for `navigator.storage.persist()` when a WebLLM download starts,
    when a WebLLM model is ready, and when the first chat is saved
    (`lib/private/web/storage-persistence.ts`). If storage isn't protected, it
    suggests exporting your chats.
- **Hash-pinned WebLLM models.**
  - `lib/private/core/model-pins.generated.json` pins every model file to an
    exact upstream revision, byte size and SHA-256. Each WebGPU kernel library
    is pinned to an exact commit, size and SHA-256.
  - `lib/private/web/artifact-integrity.ts` checks the size and hash of every
    file before the engine can use it, both on download and on every cache
    read. A file that doesn't match is deleted.
  - The engine can't read unpinned URLs, and it can't add to the cache itself.
  - Downloads use `credentials: "omit"` and `redirect: "error"`.
  - Tests: `tests/private-integrity.test.ts`, `tests/private-cache-completeness.test.ts`.
- **Strict CSP.** `lib/private/core/private-headers.mjs` sets the headers for
  `/private` and the direct `/private-offline/` shell URLs:
  - `connect-src` allows only `'self'` and the models origin.
  - `img-src`, `media-src`, `frame-src` and `object-src` are `'none'`.
  - `frame-ancestors`, `form-action` and `base-uri` are `'none'`.
  - `Referrer-Policy: no-referrer` is set.
  - Development builds also allow `'unsafe-eval'`.
  - `e2e/csp-offline.spec.ts` checks these headers.
- **Works offline after the first load.** In production builds, a service
  worker scoped to `/private` precaches a static offline shell.
  - The postbuild step generates the worker and shell
    (`scripts/build-private-offline.mjs`, `lib/private/web/offline-worker.js`,
    `lib/private/web/offline-policy.js`).
  - Once a model is downloaded, chat works without a network.
  - `e2e/csp-offline.spec.ts` tests a cold reload while offline.
  - `tests/private-offline*.test.ts` covers the offline policy and build.

**Limits:**

- The first page load needs network access, and so does each model download.
- The WebLLM models host (Cloudflare R2 by default) sees WebLLM download
  requests, including your IP address and which model files you fetch. Your
  browser manages built-in model downloads separately.
- You have to trust your browser, its WebGPU implementation and your GPU
  driver.
- Anyone with access to your browser profile can read your local data.
- Safari may clear site data after 7 days without a visit. The app shows a
  notice about this.

## Requirements

- Node.js 22 or later (`engines` in `package.json`).
- A supported browser with a usable built-in model or a desktop browser with
  WebGPU for WebLLM. On Safari, Private Mode is labelled
  as beta ("Private Mode on Safari is in beta"), and the app shows a notice
  that Safari's storage-eviction rules apply.

## Run

```sh
npm ci
npm run dev
```

Open <http://localhost:3000/private>. The root path `/` redirects there.

## Test

```sh
npm run typecheck   # next typegen && tsc --noEmit
npm test            # Vitest unit/integration tests (happy-dom, fake-indexeddb)
npm run lint        # ESLint
npm run build       # next build + offline-shell postbuild
npm run test:e2e    # Playwright (Chromium and WebKit)
```

`npm run test:e2e` starts two production servers, one after the other:

- **Port 3100:** the normal production build (`npm run build && next start`).
  It runs the unavailable-state, privacy, CSP and offline tests, plus the
  built-in browser tests in `e2e/builtin.spec.ts` with a test-injected
  `LanguageModel` in Chromium and WebKit.
- **Port 3101:** the same app built with `KORUM_E2E_MOCK_PROVIDER=1` into a
  separate `.next-e2e-mock` directory. A scripted mock engine replaces WebLLM,
  so the scripted WebLLM chat UI tests can run without a GPU.

The end-to-end setup has these safeguards:

- The mock code is removed from normal builds.
  `tests/private-e2e-mock-inert.test.ts` checks this.
- `next.config.ts` refuses to build the mock without its own output directory,
  and refuses it entirely when `KORUM_DEPLOY=1` is set.
- The Playwright network guard handles intercepted requests to other origins
  locally. It cannot observe worker-originated traffic in WebKit. See
  `e2e/support/network.ts`.
- The e2e builds clear `NEXT_PUBLIC_KORUM_MODELS_BASE_URL` and the mock
  variables, so they always use the defaults.
- Set `KORUM_E2E_REUSE=1` to reuse servers that are already running.

You may need `npx playwright install` the first time.

Once dependencies are installed, the build can run offline. The app uses
Tailwind's default system sans-serif and monospace stacks.

## Model hosting and CORS

By default, models are fetched from
`https://pub-26cf84f7e330452fb4b2b8bc10a3c55b.r2.dev`
(`lib/private/core/models-host.ts`). This is Korum's R2 mirror of the pinned
files. Automatic model and artifact downloads at runtime do not contact Hugging
Face or GitHub. Clicking a link in a reply is the user's own navigation.

Korum's current R2 bucket CORS configuration allows `https://korum.to`,
`https://www.korum.to` and `http://localhost:3000`. That allowlist may change.

If you self-host on any other origin, you need your own mirror:

1. Serve the **identical** files, so they match the SHA-256 pins in
   `lib/private/core/model-pins.generated.json`.
2. Allow your origin in the mirror's CORS policy.
3. Set the URL at build time. It must be `https`, or `localhost`, and it is
   also added to the CSP `connect-src`.

   ```sh
   NEXT_PUBLIC_KORUM_MODELS_BASE_URL=https://models.example.com npm run build
   ```

The mirror must use the key layout from `keyLayout` in the pins file:

```
<base>/v1/models/<model_id>/resolve/<revision>/<path>   # e.g. v1/models/Qwen3-8B-q4f16_1-MLC/resolve/<sha>/params_shard_0.bin
<base>/v1/libs/<commit>/<file>                          # e.g. v1/libs/<sha>/Qwen3-8B-q4f16_1_cs1k-webgpu.wasm
```

- `<model_id>`, `<revision>` and the file list come from `models[]` in the pins
  file. Each model has a matching upstream repo, `hfRepo` (for example
  `mlc-ai/Qwen3-8B-q4f16_1-MLC`).
- The kernel libraries come from `libs[]`, which are files from
  `mlc-ai/binary-mlc-llm-libs` at the pinned commit.

## Extending

Add a runtime ID and model descriptor in
`lib/private/core/local-provider.ts`, implement `LocalProvider`, and integrate
the provider in `lib/private/web/provider-factory.ts`. Provider selection lives
in `lib/private/core/provider-policy.ts` and lifecycle management in
`lib/private/web/engine-manager.ts`. Keep `lib/private/core/` free of React,
Next, DOM, `fetch` and storage APIs. `tests/private-boundary.test.ts` enforces
this.

## Licenses

The code in this repository is licensed under the **Apache License 2.0**,
Copyright 2026 Mobi Media, Inc. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

The model weights are **not** part of this repository and are **not**
relicensed by this project. Each model keeps its own license:

- **Gemini Nano and Microsoft Edge built-in models:** their browser vendors
  provide them under their own terms. This repository does not distribute them.
- **Qwen3-8B, Qwen3-4B, Qwen3-1.7B, Qwen3-0.6B:** Apache License 2.0, by the Qwen team
  (Alibaba Cloud). Each model card lists `license: apache-2.0` and ships an
  Apache-2.0 LICENSE.
  - <https://huggingface.co/Qwen/Qwen3-8B>
  - <https://huggingface.co/Qwen/Qwen3-4B>
  - <https://huggingface.co/Qwen/Qwen3-1.7B>
  - <https://huggingface.co/Qwen/Qwen3-0.6B>
- **Llama-3.2-3B-Instruct:** the Llama 3.2 Community License Agreement, which
  is not an open-source license, plus the Llama 3.2 Acceptable Use Policy. The
  key obligations are:
  - If you distribute the Llama Materials, or a product or service that
    contains them, you must include a copy of the license and prominently
    display "Built with Llama".
  - You must keep this notice in a "Notice" text file distributed with the
    materials: "Llama 3.2 is licensed under the Llama 3.2 Community License,
    Copyright © Meta Platforms, Inc. All Rights Reserved." This repository's
    copy is in [`NOTICE`](NOTICE).
  - If you use Llama Materials or their outputs to create, train or fine-tune
    an AI model that you distribute or make available, its name must start
    with "Llama".
  - Your use must comply with the Acceptable Use Policy.
  - Under Section 2, the licensee must request a license from Meta if, as of
    the Llama 3.2 release date, monthly active users of products or services
    made available by or for the licensee or its affiliates exceeded 700
    million in the preceding calendar month. The licensee may exercise the
    agreement's rights only after Meta expressly grants them.
  - Section 2 does not apply to recipients who receive Llama Materials or
    derivatives from a licensee as part of an integrated end-user product.
  - The Acceptable Use Policy's EU restriction covers the *multimodal* Llama
    3.2 models only. The 3B model used here is text-only.

  Sources:
  - <https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct/blob/main/LICENSE.txt>
  - <https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE>
  - <https://www.llama.com/llama3_2/use-policy/>

  Copies of the license and the Acceptable Use Policy are in
  [`third_party/llama-3.2/`](third_party/llama-3.2/).
- **Quantized MLC builds.** The MLC weight conversions follow the upstream
  model licenses. [MLC model files](https://huggingface.co/mlc-ai)
- **WebGPU model libraries.** The MLC project publishes these libraries. See
  that repository for its terms. [binary-mlc-llm-libs](https://github.com/mlc-ai/binary-mlc-llm-libs)
- **WebLLM** (`@mlc-ai/web-llm`) is licensed under Apache-2.0.

**Built with Llama.**

This summary is not legal advice. The linked licenses govern.

## Contributing and security

Issues and pull requests are welcome. Please run the checks above before
submitting.

To report a security vulnerability, don't open a public issue. Open a private
security advisory on GitHub for this repository instead.
