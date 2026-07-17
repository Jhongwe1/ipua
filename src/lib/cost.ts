// src/lib/cost.ts — 成本記帳的純函式（v2.0.0 Phase J）。
// 定價存 model_prices 表（migration 0004），這裡只做匹配與算錢 — 沒有 I/O、好測。
// 匹配規則：精確名優先 > 最長前綴（pattern 尾端 '*'）；都沒中＝null（UI 顯示「未定價」）。
// 錢永遠是「估算值」：token 數是上游回報的、定價是管理員手填的，僅供報告不作執法。

export interface PriceRow {
  pattern: string;
  input_usd_per_m: number;
  output_usd_per_m: number;
  note?: string;
  updated_at?: string;
}

/** 從定價表挑出 model 適用的一列：精確 > 最長前綴 > null。 */
export function pickPrice(model: string, prices: PriceRow[]): PriceRow | null {
  if (!model) return null;
  let best: PriceRow | null = null;
  let bestLen = -1;
  for (const p of prices) {
    const pat = String(p.pattern || "");
    if (!pat) continue;
    if (pat === model) return p; // 精確命中直接回（不可能被更長前綴打敗）
    if (pat.charAt(pat.length - 1) === "*") {
      const prefix = pat.slice(0, -1);
      if (model.indexOf(prefix) === 0 && prefix.length > bestLen) {
        best = p;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/**
 * 算一組 token 用量的美元成本；沒定價或兩個 token 數都是 null → null。
 * 單邊 null（例：只掃到 output）當 0 算 — 寧可低估也要給個數字。
 */
export function costUSD(
  tokens_in: number | null | undefined,
  tokens_out: number | null | undefined,
  price: PriceRow | null
): number | null {
  if (!price) return null;
  if (tokens_in == null && tokens_out == null) return null;
  const tin = Number(tokens_in) || 0;
  const tout = Number(tokens_out) || 0;
  return (
    (tin / 1e6) * (Number(price.input_usd_per_m) || 0) + (tout / 1e6) * (Number(price.output_usd_per_m) || 0)
  );
}
