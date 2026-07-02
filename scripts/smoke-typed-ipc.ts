/**
 * Smoke for the typed-IPC helpers. Type-only: every assertion below is a
 * `@ts-expect-error` line that MUST fail at compile time. If tsc compiles
 * this file cleanly, the helpers aren't enforcing the contract and the
 * smoke fails.
 *
 * Run: `npx tsc --noEmit scripts/smoke-typed-ipc.ts` (or part of global tsc).
 * tsx execution is a no-op.
 */

import { invokeChannel, sendChannel, onChannel, registerHandler } from '../app-electron/src/shared/typed-ipc'

// ────────────────────────────────────────────────────────────────────────────
// Positive samples — these MUST compile cleanly
// ────────────────────────────────────────────────────────────────────────────

void async function () {
  // Correct args + correct return type usage.
  const content: string | null = await invokeChannel('file:read', 'Q:/x.txt')
  void content

  // Optional-trailing args are allowed.
  const baseline = await invokeChannel('file-diff:get-baseline', 'Q:/x.ts', { kind: 'off' })
  void baseline

  // Send with correct args.
  sendChannel('pty:write', 'term-1', 'hello\n')

  // Event listener with correct args shape.
  const dispose = onChannel('pty:output', (id: string, data: string) => {
    void id
    void data
  })
  dispose()

  // Handler with correct return shape.
  registerHandler('file:read', async (_e, filePath) => {
    void filePath
    return null
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Negative samples — `@ts-expect-error` ensures these DON'T compile
// ────────────────────────────────────────────────────────────────────────────

void async function () {
  // @ts-expect-error wrong channel name
  await invokeChannel('file:nope', 'Q:/x.txt')

  // @ts-expect-error wrong arg type (boolean instead of string)
  await invokeChannel('file:read', true)

  // @ts-expect-error too few args
  await invokeChannel('file:write')

  // @ts-expect-error too many args
  await invokeChannel('file:read', 'a', 'b')

  // @ts-expect-error send channel used as invoke
  await invokeChannel('pty:write', 'term-1', 'hello\n')

  // @ts-expect-error wrong arg type on send
  sendChannel('pty:write', 1, 2)

  // @ts-expect-error event channel used as send
  sendChannel('pty:output', 'term-1', 'data')

  // @ts-expect-error handler returns wrong type (number instead of string | null)
  registerHandler('file:read', async () => 42)

  // @ts-expect-error handler missing return on invoke channel that requires it
  registerHandler('file:read', async () => {})

  // @ts-expect-error event callback wrong shape
  onChannel('pty:output', (id: number) => { void id })

  // @ts-expect-error handler arg type drifts (number vs declared string)
  registerHandler('file:read', async (_e, filePath: number) => { void filePath; return null })

  // @ts-expect-error handler arg count drift (extra param)
  registerHandler('file:read', async (_e, filePath: string, extra: string) => { void filePath; void extra; return null })

  // @ts-expect-error invokeChannel result widened beyond declared (string | null)
  const widened: number = await invokeChannel('file:read', 'x')
  void widened
}

console.log('=== PASS (smoke-typed-ipc: enforcement verified at compile time)')
