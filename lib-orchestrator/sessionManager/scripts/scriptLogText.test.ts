import { describe, expect, it } from 'vitest'

import { type ScriptLogHeader, ScriptLogText } from './scriptLogText'

describe('lib-orchestrator/sessionManager/scripts/scriptLogText', () => {
  const headerConst: ScriptLogHeader = {
    phase: 'before',
    scriptId: 'setup',
    name: 'Setup',
    parentId: 'parent-1',
    parentTitle: 'i12 fix the login',
    runId: 'run-1',
    startedAt: Date.UTC(2026, 9, 7, 10, 0, 0),
    endedAt: Date.UTC(2026, 9, 7, 10, 0, 23, 600),
    exitCode: 1,
    reason: 'exit code 1',
    commands: [
      { command: 'pnpm install', cwd: 'Q:\\Work\\app' },
      { command: 'pnpm -C web install', cwd: 'Q:\\Work\\app\\web' },
    ],
  }

  it('names the run and every command with its directory in the header', () => {
    const { text, truncated } = ScriptLogText.of(headerConst, ['done'])

    expect(truncated).toBe(false)
    expect(text).toContain('Script:    Setup (setup)')
    expect(text).toContain('Phase:     before')
    expect(text).toContain('Parent:    i12 fix the login (parent-1)')
    expect(text).toContain('Run:       run-1')
    expect(text).toContain('Started:   2026-10-07T10:00:00.000Z')
    expect(text).toContain('Ended:     2026-10-07T10:00:23.600Z')
    expect(text).toContain('Duration:  23.6 s')
    expect(text).toContain('Exit code: 1')
    expect(text).toContain('Reason:    exit code 1')
    expect(text).toContain('  pnpm install\n    in Q:\\Work\\app\n')
    expect(text).toContain('  pnpm -C web install\n    in Q:\\Work\\app\\web\n')
    expect(text.endsWith('\ndone\n')).toBe(true)
  })

  it('says when there is no exit code, no reason and no command', () => {
    const { text } = ScriptLogText.of({ ...headerConst, exitCode: undefined, reason: undefined, commands: [] }, [])

    expect(text).toContain('Exit code: none')
    expect(text).not.toContain('Reason:')
    expect(text).toContain('Commands:  none')
  })

  it('removes the dim markers from a row and keeps the other text', () => {
    const { text } = ScriptLogText.of(headerConst, ['\u001b[2m> pnpm install\u001b[22m ok \u001b[31mred\u001b[0m'])

    expect(text).toContain('\n> pnpm install ok \u001b[31mred\u001b[0m\n')
    expect(text).not.toContain('\u001b[2m')
    expect(text).not.toContain('\u001b[22m')
  })

  it('cuts a 1 MB row set to the cap, dropping the earliest rows, and says so in the header', () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => `row ${String(index).padStart(5, '0')} ${'x'.repeat(90)}`)
    const { text, truncated } = ScriptLogText.of(headerConst, rows)

    expect(truncated).toBe(true)
    const bytes = Buffer.byteLength(text, 'utf8')
    expect(bytes).toBeLessThanOrEqual(ScriptLogText.maxBytesConst)
    expect(bytes).toBeGreaterThan(ScriptLogText.maxBytesConst - 200)
    expect(text).not.toContain('row 00000 ')
    expect(text.endsWith(`${rows[rows.length - 1]}\n`)).toBe(true)
    const dropped = /Truncated: the earliest (\d+) rows were removed to keep the log under 256 KiB/.exec(text)
    expect(dropped).not.toBeNull()
    expect(text).toContain(`\n${rows[Number(dropped![1])]}\n`)
    expect(text).not.toContain(`\n${rows[Number(dropped![1]) - 1]}\n`)
  })

  it('counts the cap in UTF-8 bytes', () => {
    const rows = Array.from({ length: 2_000 }, () => 'ž'.repeat(100))
    const { text, truncated } = ScriptLogText.of(headerConst, rows)

    expect(truncated).toBe(true)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(ScriptLogText.maxBytesConst)
  })
})
