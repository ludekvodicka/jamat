/**
 * Per-token-type cost calculation for Claude models.
 *
 * Each token type is priced separately — output is ~5× input, cache-create is
 * 1.25× input, and cache-read is ~0.1× input. A single blended per-token rate
 * (cost ÷ totalTokens) skews badly whenever a request's cache/output mix differs
 * from the historical average, so the rolling-window stats must price each type.
 *
 * Rates are USD per token and mirror ccusage's embedded PREFETCHED_CLAUDE_PRICING
 * (which in turn tracks the LiteLLM/Anthropic public price list). >200k input
 * tiering is applied for models that publish it (Sonnet, Opus 1M-context).
 *
 * Source: https://www.anthropic.com/pricing  +  ccusage dist PREFETCHED_CLAUDE_PRICING
 */

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface Pricing {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  // Optional >200k-input tier (applied to tokens beyond the 200k threshold).
  above200k?: { input: number; output: number; cacheCreate: number; cacheRead: number };
}

const M = 1e-6; // $ per million → $ per token

// Opus 4.x (and 3 Opus): $15 / $75 / $18.75 / $1.50 per MTok.
const OPUS: Pricing = { input: 15 * M, output: 75 * M, cacheCreate: 18.75 * M, cacheRead: 1.5 * M };

// Sonnet 3.5 / 3.7 / 4.x: $3 / $15 / $3.75 / $0.30, with a >200k tier ($6 / $22.50 / $7.50 / $0.60).
const SONNET: Pricing = {
  input: 3 * M, output: 15 * M, cacheCreate: 3.75 * M, cacheRead: 0.3 * M,
  above200k: { input: 6 * M, output: 22.5 * M, cacheCreate: 7.5 * M, cacheRead: 0.6 * M },
};

// Haiku 4.5: $1 / $5 / $1.25 / $0.10.
const HAIKU_45: Pricing = { input: 1 * M, output: 5 * M, cacheCreate: 1.25 * M, cacheRead: 0.1 * M };

// Haiku 3 / 3.5: $0.80 / $4 / $1.00 / $0.08.
const HAIKU_35: Pricing = { input: 0.8 * M, output: 4 * M, cacheCreate: 1 * M, cacheRead: 0.08 * M };

// Fable 5 (claude-fable-5): $10 / $50 / $12.50 / $1.00 — back-derived to match ccusage's
// LiteLLM-sourced cost exactly (verified: 8180·10 + 2273·50 + 54072·12.5 + 40216·1 per MTok
// = $0.9116, ccusage's reported daily cost for this model to the cent).
const FABLE: Pricing = { input: 10 * M, output: 50 * M, cacheCreate: 12.5 * M, cacheRead: 1 * M };

const TIER_THRESHOLD = 200_000;

/**
 * Resolve a model id to a price table by family. Handles ccusage/LiteLLM-style
 * names ("anthropic/claude-opus-4-8", "claude-3-5-haiku-20241022", "claude-sonnet-4-6").
 */
function resolvePricing(model: string): Pricing | null {
  const m = model.toLowerCase();
  if (!m.includes('claude')) return null;
  if (m.includes('fable')) return FABLE;
  if (m.includes('opus')) return OPUS;
  if (m.includes('haiku')) {
    // 4.x / 4-5 haiku vs the older 3 / 3.5 haiku.
    if (/haiku-4|haiku-3-5|3-5-haiku|haiku4/.test(m)) {
      return /haiku-4|haiku4/.test(m) ? HAIKU_45 : HAIKU_35;
    }
    return /3-5|3\.5/.test(m) ? HAIKU_35 : HAIKU_45;
  }
  if (m.includes('sonnet')) return SONNET;
  return null;
}

/** Cost for a single token type, splitting at the 200k threshold when a tier exists. */
function tieredCost(tokens: number, base: number, above?: number): number {
  if (tokens <= 0) return 0;
  if (above != null && tokens > TIER_THRESHOLD) {
    return TIER_THRESHOLD * base + (tokens - TIER_THRESHOLD) * above;
  }
  return tokens * base;
}

/**
 * Per-token-type rates for a model, in USD per million tokens (for display).
 * Returns null when the model is unknown. Tiered (>200k) rates are ignored here —
 * these are the base/headline numbers shown next to a model chip.
 */
export function modelRates(model: string): { input: number; output: number; cacheCreate: number; cacheRead: number } | null {
  const p = resolvePricing(model);
  if (!p) return null;
  return {
    input: p.input / M,
    output: p.output / M,
    cacheCreate: p.cacheCreate / M,
    cacheRead: p.cacheRead / M,
  };
}

/**
 * USD cost for the given token counts under the given model.
 * Returns null when the model is unknown (caller can fall back).
 */
export function costForTokens(model: string, t: TokenCounts): number | null {
  const p = resolvePricing(model);
  if (!p) return null;
  const a = p.above200k;
  return (
    tieredCost(t.input, p.input, a?.input) +
    tieredCost(t.output, p.output, a?.output) +
    tieredCost(t.cacheCreate, p.cacheCreate, a?.cacheCreate) +
    tieredCost(t.cacheRead, p.cacheRead, a?.cacheRead)
  );
}
