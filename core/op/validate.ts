/**
 * Positional arg validator (plan 002 D1). Validates an op's `args` tuple against its `ParamSchema`
 * (one ArgSpec per positional parameter): arity (required vs trailing-optional vs rest) + per-arg
 * type. Zero-dep. An op without a schema passes its args through untouched.
 */

import type { ParamSchema } from './types.js'

export type ValidateResult =
  | { ok: true; args: unknown[] }
  | { ok: false; error: string }

function typeError(type: string, v: unknown, label: string): string | null {
  if (type === 'any') return null
  const actual = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
  if (type === 'object') return actual === 'object' ? null : `${label} must be object (got ${actual})`
  if (type === 'array') return actual === 'array' ? null : `${label} must be array (got ${actual})`
  return actual === type ? null : `${label} must be ${type} (got ${actual})`
}

export function validateArgs(schema: ParamSchema | undefined, args: unknown[]): ValidateResult {
  if (!schema) return { ok: true, args }

  for (let i = 0; i < schema.length; i++) {
    const spec = schema[i]!
    if (spec.rest) {
      // The rest spec absorbs every remaining arg.
      for (let j = i; j < args.length; j++) {
        const e = typeError(spec.type, args[j], `arg ${j}`)
        if (e) return { ok: false, error: e }
      }
      return { ok: true, args }
    }
    const v = args[i]
    if (v === undefined) {
      if (spec.optional) continue
      return { ok: false, error: `missing required arg ${i} (${spec.type})` }
    }
    const e = typeError(spec.type, v, `arg ${i}`)
    if (e) return { ok: false, error: e }
  }
  return { ok: true, args }
}
