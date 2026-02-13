import { MODEL_PRICING, type TokenUsage, type ModelPricing } from './types.js';

/**
 * Estimate cost in USD from token usage and model name.
 * Falls back to a generic mid-tier pricing if model is unknown.
 */
export function estimateCost(model: string, tokens: TokenUsage): number {
  const pricing = findPricing(model);

  const inputCost = (tokens.input / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (tokens.output / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (tokens.cacheRead / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1);
  const cacheWriteCost = (tokens.cacheWrite / 1_000_000) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion * 1.25);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Find pricing for a model, trying exact match first, then prefix/substring match.
 */
function findPricing(model: string): ModelPricing {
  const normalized = model.toLowerCase();

  // Exact match
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];

  // Prefix / substring match
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return pricing;
    }
  }

  // Heuristic fallback: mid-tier pricing
  return { inputPerMillion: 3, outputPerMillion: 15 };
}

/**
 * Sum multiple TokenUsage objects.
 */
export function sumTokens(...usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, t) => ({
      input: acc.input + t.input,
      output: acc.output + t.output,
      reasoning: acc.reasoning + t.reasoning,
      cacheRead: acc.cacheRead + t.cacheRead,
      cacheWrite: acc.cacheWrite + t.cacheWrite,
      total: acc.total + t.total,
    }),
    emptyTokenUsage(),
  );
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
