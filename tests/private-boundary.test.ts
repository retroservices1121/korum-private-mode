import { readFileSync, statSync } from "node:fs";
import { glob } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static, TRANSITIVE import boundaries for Private Mode.
 *
 *  1. Portable core (`lib/private/core/**`): no React, Next, DOM or network,
 *     and nothing outside the core except type-only `lib/ai/types`.
 *  2. Everything reachable from the app (`app/**`, `components/**`, `lib/**`)
 *     may import only an explicit allowlist of packages (UI, Markdown, the
 *     on-device engine). Any analytics, error-reporting, auth, database or
 *     server SDK therefore fails this test by construction, without the test
 *     having to name one. It also calls no network primitive directly and
 *     contains no server API path.
 *
 * Comments are stripped before scanning source text (a comment is not a
 * request). The runtime tests (`private-no-network`, `private-unavailable`)
 * are the real proof; this is the backstop that names the import path.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;

function read(file: string) {
  return readFileSync(file, "utf8");
}

/** Removes block and line comments, keeping string literals intact enough for scanning. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function isFile(candidate: string) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveImport(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(importer), specifier);
  else return null;
  for (const ext of EXTENSIONS) if (isFile(base + ext)) return base + ext;
  return null;
}

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

function importsOf(file: string): ImportEdge[] {
  const source = stripComments(read(file));
  const edges: ImportEdge[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    edges.push({ specifier, typeOnly: /^(?:import|export)\s+type\s/.test(match[0]) });
  }
  return edges;
}

/** Every repo file and external package reachable from `entries`, with a path back for messages. */
function reachable(entries: string[]) {
  const parent = new Map<string, string | null>();
  const external = new Map<string, string>(); // package -> importer
  const queue = [...entries];
  for (const entry of entries) parent.set(entry, null);
  while (queue.length) {
    const current = queue.shift()!;
    for (const { specifier } of importsOf(current)) {
      const resolved = resolveImport(specifier, current);
      if (!resolved) {
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
          if (!external.has(specifier)) external.set(specifier, current);
        }
        continue;
      }
      if (parent.has(resolved)) continue;
      parent.set(resolved, current);
      // Stylesheets and JSON data are bundled, not executed: nothing to follow.
      if (/\.(tsx?|m?js)$/.test(resolved)) queue.push(resolved);
    }
  }
  const chain = (file: string) => {
    const out: string[] = [];
    for (let f: string | null | undefined = file; f; f = parent.get(f)) out.unshift(path.relative(ROOT, f));
    return out.join("\n  → ");
  };
  return { files: [...parent.keys()], external, chain };
}

async function files(patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: ROOT })) out.push(path.join(ROOT, entry));
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

describe("portable core boundary", async () => {
  const core = await files(["lib/private/core/**/*.{ts,tsx}"]);

  it("finds the core modules", () => {
    expect(core.map(rel).sort()).toEqual(
      expect.arrayContaining([
        "lib/private/core/local-provider.ts",
        "lib/private/core/model-catalog.ts",
        "lib/private/core/thread-schema.ts",
        "lib/private/core/tier-policy.ts",
      ]),
    );
  });

  it("imports only the core and type-only lib/ai/types", () => {
    const violations: string[] = [];
    for (const file of core) {
      for (const edge of importsOf(file)) {
        const resolved = resolveImport(edge.specifier, file);
        if (resolved) {
          const target = rel(resolved);
          if (target.startsWith("lib/private/core/")) continue;
          if (target === "lib/ai/types.ts" && edge.typeOnly) continue;
          violations.push(`${rel(file)} imports ${target}${edge.typeOnly ? " (type)" : ""}`);
        } else {
          violations.push(`${rel(file)} imports package ${edge.specifier}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("references no DOM, storage, React, Next or network globals", () => {
    const forbidden =
      /\b(window|document|navigator|indexedDB|localStorage|sessionStorage|fetch|XMLHttpRequest|WebSocket|EventSource|React|useState|useEffect)\b|["']use client["']|from\s+["'](react|react-dom|next)(\/[^"']*)?["']/;
    const violations = core
      .map((file) => {
        const match = stripComments(read(file)).match(forbidden);
        return match ? `${rel(file)}: ${match[0]}` : null;
      })
      .filter(Boolean);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

/**
 * Every third-party package the shipped app may import. Adding one is a
 * deliberate, reviewed change: it must not collect data, report errors,
 * authenticate users or talk to a server.
 */
const ALLOWED_PACKAGES = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react-dom(\/client)?$/,
  /^next(\/(font\/google|link|navigation))?$/,
  /^next-themes$/,
  /^@mlc-ai\/web-llm$/,
  /^lucide-react$/,
  /^radix-ui$/,
  /^sonner$/,
  /^react-markdown$/,
  /^remark-gfm$/,
  /^rehype-highlight$/,
  /^clsx$/,
  /^tailwind-merge$/,
  /^class-variance-authority$/,
];

describe("the app reaches nothing but local code and allowlisted packages", async () => {
  const roots = await files(["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"]);
  const graph = reachable(roots);
  const reached = graph.files.map(rel);

  it("covers the app root, the private UI, the engine worker and the shared composer", () => {
    expect(reached).toEqual(
      expect.arrayContaining([
        "app/layout.tsx",
        "app/private/page.tsx",
        "components/private/private-app.tsx",
        "lib/private/web/webllm-worker.ts",
        "lib/private/web/private-chat-controller.ts",
        "lib/private/web/provider-factory.ts",
        "components/chat/composer.tsx",
      ]),
    );
  });

  it("imports only allowlisted packages (no analytics, error reporting, auth, DB or server SDKs)", () => {
    const violations = [...graph.external]
      .filter(([pkg]) => !pkg.startsWith("node:"))
      .filter(([pkg]) => !ALLOWED_PACKAGES.some((pattern) => pattern.test(pkg)))
      .map(([pkg, importer]) => `${pkg}\n  ← ${graph.chain(importer)}`);
    expect(violations, violations.join("\n\n")).toEqual([]);
  });

  it("imports no Node built-in (everything runs in the browser)", () => {
    const violations = [...graph.external].filter(([pkg]) => pkg.startsWith("node:")).map(([pkg]) => pkg);
    expect(violations).toEqual([]);
  });

  it("contains no server API paths", () => {
    const forbidden = /["'`]\/api\//;
    const violations = graph.files
      .map((file) => {
        const match = stripComments(read(file)).match(forbidden);
        return match ? `${rel(file)}: ${match[0]}` : null;
      })
      .filter(Boolean);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("calls no network primitive directly", () => {
    // Model artifacts are downloaded only by the pinned, integrity-checked
    // loader in the engine worker, which receives `fetch` as an injected
    // function; nothing calls a network API by name.
    const forbidden = /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b/;
    const violations = graph.files
      .map((file) => {
        const match = stripComments(read(file)).match(forbidden);
        return match ? `${rel(file)}: ${match[0]}` : null;
      })
      .filter(Boolean);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the root layout injects no third-party script", () => {
    const layout = stripComments(read(path.join(ROOT, "app/layout.tsx")));
    expect(layout).not.toMatch(/<script|<Script\b|next\/script|dangerouslySetInnerHTML/);
  });
});
