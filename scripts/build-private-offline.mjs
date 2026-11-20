/** Postbuild: publish the static, credential-free /private HTML/RSC and every build static asset.
 * All chunks are included deliberately: this covers workers, lazy imports and fonts
 * without relying on undocumented client-reference manifest graph traversal.
 */
import { readFile, readdir, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { privateHeaders } from "../lib/private/core/private-headers.mjs";
import { modelsOrigin } from "../lib/private/core/models-host.ts";

export async function buildPrivateOffline(root = process.cwd()) {
  // A mock-engine e2e build lives in its own distDir; it never publishes an offline shell.
  if (process.env.KORUM_E2E_MOCK_PROVIDER === "1") throw new Error("Refusing to publish the offline shell from an e2e mock build");
  const at = (file) => path.join(root, file);
  const buildId = (await readFile(at(".next/BUILD_ID"), "utf8")).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(buildId)) throw new Error("Invalid private shell build id");
  const out = at(`public/private-offline/${buildId}`);
  await mkdir(out, { recursive: true });
  const shell = at(".next/server/app/private");
  await copyFile(`${shell}.html`, `${out}/shell.html`);
  // Not `*.rsc`: Next treats any `.rsc` path as an RSC request and never serves it from public/
  // (404), which made the precache, and so the worker install, fail. The worker sets the RSC type.
  await copyFile(`${shell}.rsc`, `${out}/shell-rsc.txt`);
  async function files(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map((e) => e.isDirectory() ? files(path.join(dir, e.name)) : path.join(dir, e.name)))).flat();
  }
  const assets = (await files(at(".next/static"))).map((p) => `/_next/static/${path.relative(at(".next/static"), p).split(path.sep).join("/")}`).sort();
  const manifest = { buildId, shell: `/private-offline/${buildId}/shell.html`, rsc: `/private-offline/${buildId}/shell-rsc.txt`, assets };
  const policy = (await readFile(at("lib/private/web/offline-policy.js"), "utf8")).replaceAll("export ", "");
  const worker = await readFile(at("lib/private/web/offline-worker.js"), "utf8");
  await writeFile(at("public/private-sw.js"), `const PRIVATE_HEADERS = ${JSON.stringify(privateHeaders(modelsOrigin(), process.env.NODE_ENV === "development"))};\nconst MANIFEST = ${JSON.stringify(manifest)};\n${policy}\n${worker}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifest = await buildPrivateOffline();
  console.log(`Private offline shell: ${manifest.buildId}, ${manifest.assets.length} static assets`);
}
