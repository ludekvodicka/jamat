/**
 * Per-token-type API-equivalent cost calculation for supported models.
 *
 * Each token type is priced separately because input, output, cache writes, and
 * cache reads have different rates. A single blended per-token rate
 * (cost ÷ totalTokens) skews badly whenever a request's cache/output mix differs
 * from the historical average, so the rolling-window stats must price each type.
 *
 * Rates are USD per token and mirror ccusage's embedded PREFETCHED_CLAUDE_PRICING
 * (which in turn tracks the LiteLLM/Anthropic public price list). >200k input
 * tiering is applied for models that publish it (Sonnet, Opus 1M-context).
 *
 * Sources: https://www.anthropic.com/pricing + ccusage dist PREFETCHED_CLAUDE_PRICING
 * OpenAI rates verified 2026-07-14:
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.5
 */

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface TokenRatesInternal {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

type PricingTier =
  | { kind: 'incremental'; threshold: number; rates: TokenRatesInternal }
  | { kind: 'requestMultiplier'; threshold: number; inputMultiplier: number; outputMultiplier: number };

interface Pricing extends TokenRatesInternal { tier?: PricingTier }

const M = 1e-6; // $ per million → $ per token

const OPUS_LEGACY: Pricing = { input: 15 * M, output: 75 * M, cacheCreate: 18.75 * M, cacheRead: 1.5 * M };
const OPUS_CURRENT: Pricing = { input: 5 * M, output: 25 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M };

// Sonnet 3.5 / 3.7 / 4.x: $3 / $15 / $3.75 / $0.30, with a >200k tier ($6 / $22.50 / $7.50 / $0.60).
const SONNET: Pricing = {
  input: 3 * M, output: 15 * M, cacheCreate: 3.75 * M, cacheRead: 0.3 * M,
  tier: {
    kind: 'incremental',
    threshold: 200_000,
    rates: { input: 6 * M, output: 22.5 * M, cacheCreate: 7.5 * M, cacheRead: 0.6 * M },
  },
};

const SONNET_5: Pricing = { input: 2 * M, output: 10 * M, cacheCreate: 2.5 * M, cacheRead: 0.2 * M };

// Haiku 4.5: $1 / $5 / $1.25 / $0.10.
const HAIKU_45: Pricing = { input: 1 * M, output: 5 * M, cacheCreate: 1.25 * M, cacheRead: 0.1 * M };

// Haiku 3 / 3.5: $0.80 / $4 / $1.00 / $0.08.
const HAIKU_35: Pricing = { input: 0.8 * M, output: 4 * M, cacheCreate: 1 * M, cacheRead: 0.08 * M };

// Fable 5 (claude-fable-5): $10 / $50 / $12.50 / $1.00 — back-derived to match ccusage's
// LiteLLM-sourced cost exactly (verified: 8180·10 + 2273·50 + 54072·12.5 + 40216·1 per MTok
// = $0.9116, ccusage's reported daily cost for this model to the cent).
const FABLE: Pricing = { input: 10 * M, output: 50 * M, cacheCreate: 12.5 * M, cacheRead: 1 * M };

const OPENAI_LONG_CONTEXT: PricingTier = {
  kind: 'requestMultiplier', threshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5,
};
const GPT_56_SOL: Pricing = {
  input: 5 * M, output: 30 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M,
  tier: OPENAI_LONG_CONTEXT,
};
const GPT_55: Pricing = {
  input: 5 * M, output: 30 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M,
  tier: OPENAI_LONG_CONTEXT,
};

/**
 * Resolve a model id to a price table by family. Handles ccusage/LiteLLM-style
 * names ("anthropic/claude-opus-4-8", "claude-3-5-haiku-20241022", "claude-sonnet-4-6").
 */
function resolvePricing(model: string): Pricing | null {
  const m = model.toLowerCase();
  if (m === 'gpt-5.6-sol') return GPT_56_SOL;
  if (m === 'gpt-5.5') return GPT_55;
  if (!m.includes('claude')) return null;
  if (m.includes('fable')) return FABLE;
  if (m.includes('opus')) return /opus-4-(?:[5-9]|\d{2})/.test(m) ? OPUS_CURRENT : OPUS_LEGACY;
  if (m.includes('haiku')) {
    // 4.x / 4-5 haiku vs the older 3 / 3.5 haiku.
    if (/haiku-4|haiku-3-5|3-5-haiku|haiku4/.test(m)) {
      return /haiku-4|haiku4/.test(m) ? HAIKU_45 : HAIKU_35;
    }
    return /3-5|3\.5/.test(m) ? HAIKU_35 : HAIKU_45;
  }
  if (m.includes('sonnet-5')) return SONNET_5;
  if (m.includes('sonnet')) return SONNET;
  return null;
}

/** Cost for a single token type, splitting at the supplied threshold. */
function tieredCost(tokens: number, threshold: number, base: number, above: number): number {
  if (tokens <= 0) return 0;
  if (tokens > threshold) return threshold * base + (tokens - threshold) * above;
  return tokens * base;
}

function baseCost(t: TokenCounts, p: Pricing): number {
  return t.input * p.input + t.output * p.output + t.cacheCreate * p.cacheCreate + t.cacheRead * p.cacheRead;
}

/**
 * Per-token-type rates for a model, in USD per million tokens (for display).
 * Returns null when the model is unknown. Tiered/multiplied rates are ignored here —
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
 * Returns null when the model is unknown.
 */
export function costForTokens(model: string, t: TokenCounts): number | null {
  const p = resolvePricing(model);
  if (!p) return null;
  if (!p.tier) return baseCost(t, p);
  if (p.tier.kind === 'incremental') {
    const tier = p.tier;
    return (
      tieredCost(t.input, tier.threshold, p.input, tier.rates.input) +
      tieredCost(t.output, tier.threshold, p.output, tier.rates.output) +
      tieredCost(t.cacheCreate, tier.threshold, p.cacheCreate, tier.rates.cacheCreate) +
      tieredCost(t.cacheRead, tier.threshold, p.cacheRead, tier.rates.cacheRead)
    );
  }
  else if (p.tier.kind === 'requestMultiplier') {
    const longContext = t.input + t.cacheCreate + t.cacheRead > p.tier.threshold;
    if (!longContext) return baseCost(t, p);
    return (
      t.input * p.input * p.tier.inputMultiplier +
      t.cacheCreate * p.cacheCreate * p.tier.inputMultiplier +
      t.cacheRead * p.cacheRead * p.tier.inputMultiplier +
      t.output * p.output * p.tier.outputMultiplier
    );
  }
  else
    throw new Error(`Unknown pricing tier: ${JSON.stringify(p.tier)}`);
}
