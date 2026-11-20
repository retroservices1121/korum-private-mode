import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { estimateTokens, localBudget } from "@/lib/private/core/context-budget";
import { MODEL_CATALOG, tierTitle } from "@/lib/private/core/model-catalog";
import { stripThinking, ThinkFilter } from "@/lib/private/core/think-filter";

describe("localBudget", () => {
  const base = { system: "sys", contextWindowTokens: 4096, maxOutputTokens: 1024 };

  it("drops the oldest turns first and never opens on an assistant turn", () => {
    const history = [
      { role: "user" as const, content: "a".repeat(4000) },
      { role: "assistant" as const, content: "b".repeat(4000) },
      { role: "user" as const, content: "c".repeat(2000) },
      { role: "assistant" as const, content: "d".repeat(2000) },
      { role: "user" as const, content: "newest" },
    ];
    const result = localBudget({ ...base, history, counts: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(result.messages.at(-1)?.content).toBe("newest");
    expect(result.messages[1].role).toBe("user");
    expect(result.droppedTurns).toBeGreaterThan(0);
  });

  it("refuses an oversized newest message instead of truncating it", () => {
    const result = localBudget({
      ...base,
      history: [{ role: "user", content: "x" }],
      counts: [3, 5000],
    });
    expect(result).toMatchObject({ ok: false, reason: "too_long", messageTokens: 5000 });
  });

  it("uses tokenizer counts when given", () => {
    const history = [{ role: "user" as const, content: "short" }];
    const result = localBudget({ ...base, history, counts: [1, 3100] });
    expect(result.ok).toBe(false); // 3100 + template > 4096 - 1024 output - 32 fixed - system
  });

  it("estimates pessimistically for CJK and emoji", () => {
    expect(estimateTokens("你好世界")).toBeGreaterThanOrEqual(4);
    expect(estimateTokens("🙂🙂")).toBeGreaterThanOrEqual(4);
  });
});

describe("think filter (never show hidden reasoning)", () => {
  it("strips a think block split across chunks", () => {
    const filter = new ThinkFilter();
    const out = ["<thi", "nk>secret reas", "oning</th", "ink>\n\nThe answer", " is 4."]
      .map((c) => filter.push(c))
      .join("");
    expect(out + filter.flush()).toBe("The answer is 4.");
  });

  it("drops an unterminated think block", () => {
    expect(stripThinking("<think>never closed")).toBe("");
  });

  it("leaves ordinary text alone", () => {
    expect(stripThinking("a < b and <thing>")).toBe("a < b and <thing>");
  });
});

describe("model catalog matches WebLLM 0.2.88 prebuilt records", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@mlc-ai/web-llm"), "utf8");

  for (const model of MODEL_CATALOG) {
    for (const artifact of [model.webllm.f16, model.webllm.f32]) {
      it(`${artifact.modelId} exists upstream with the same kernel`, () => {
        expect(source).toContain(`model_id: "${artifact.modelId}"`);
        const kernel = artifact.modelLibUrl.split("/").at(-1)!;
        expect(source).toContain(kernel);
        expect(artifact.modelLibUrl).toMatch(/\/v1\/libs\/[a-f0-9]{40}\//);
      });
    }
  }

  it("labels Lite honestly", () => {
    expect(tierTitle("XS")).toBe("Lite: lower quality");
    expect(tierTitle("S")).toBe("Light");
  });

  it("has exactly one model per tier, XS/S/M/L = Qwen3-1.7B / Llama-3.2-3B / Qwen3-4B / Qwen3-8B", () => {
    expect(MODEL_CATALOG.map((m) => [m.tier, m.id])).toEqual([
      ["XS", "local/qwen3-1.7b"],
      ["S", "local/llama-3.2-3b"],
      ["M", "local/qwen3-4b"],
      ["L", "local/qwen3-8b"],
    ]);
  });
});
