// 成本純函式（v2.0.0 Phase J）：pickPrice 匹配優先序與 costUSD 算錢。
import { describe, it, expect } from "vitest";
import { pickPrice, costUSD, type PriceRow } from "../../src/lib/cost.js";

const P = (pattern: string, input = 1, output = 2): PriceRow => ({
  pattern: pattern,
  input_usd_per_m: input,
  output_usd_per_m: output
});

describe("pickPrice", () => {
  it("精確名優先於任何前綴", () => {
    const prices = [P("gpt-4o*", 99, 99), P("gpt-4o-mini", 0.15, 0.6)];
    expect(pickPrice("gpt-4o-mini", prices)!.input_usd_per_m).toBe(0.15);
  });
  it("多個前綴命中 → 取最長", () => {
    const prices = [P("gpt-4o*", 2.5, 10), P("gpt-4o-mini*", 0.15, 0.6), P("gpt*", 9, 9)];
    expect(pickPrice("gpt-4o-mini-2024", prices)!.input_usd_per_m).toBe(0.15);
    expect(pickPrice("gpt-4o-2024", prices)!.input_usd_per_m).toBe(2.5);
    expect(pickPrice("gpt-3.5", prices)!.input_usd_per_m).toBe(9);
  });
  it("沒對上／model 空字串 → null；'*' 單獨＝全部模型的兜底", () => {
    expect(pickPrice("claude-x", [P("gpt*")])).toBeNull();
    expect(pickPrice("", [P("*")])).toBeNull();
    expect(pickPrice("anything", [P("*", 1, 1)])).not.toBeNull();
  });
});

describe("costUSD", () => {
  it("token/1e6 × 單價，input 與 output 分開算", () => {
    expect(costUSD(1_000_000, 500_000, P("m", 2, 10))).toBeCloseTo(2 + 5, 10);
  });
  it("沒定價或兩個 token 都 null → null；單邊 null 當 0（寧可低估）", () => {
    expect(costUSD(100, 100, null)).toBeNull();
    expect(costUSD(null, null, P("m"))).toBeNull();
    expect(costUSD(null, 1_000_000, P("m", 5, 2))).toBeCloseTo(2, 10);
  });
});
