import { describe, expect, it } from 'vitest'

import type { DirectoryNotesImportRefusal } from '../../../../shared/directoryNotes'
import { TerminalNotesMessages } from './terminalNotesMessages'

describe('app-client-ui/renderer/panels/terminal/notes/terminalNotesMessages', () => {
  it('turns a save answer into an outcome and names each refusal', () => {
    expect(TerminalNotesMessages.saveOutcomeOf({ ok: true, value: { ok: true } })).toEqual({ ok: true })
    expect(TerminalNotesMessages.saveOutcomeOf({ ok: false, error: 'channel closed' }))
      .toEqual({ ok: false, detail: 'Notes were not saved: channel closed' })
    for (const code of ['unknown-session', 'config-latched', 'section-damaged', 'invalid-section'] as const) {
      const outcome = TerminalNotesMessages.saveOutcomeOf({ ok: true, value: { ok: false, code, detail: `${code} detail` } })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.detail).toContain(`${code} detail`)
    }
  })

  it('throws on a save code it does not know', () => {
    expect(() => TerminalNotesMessages.saveOutcomeOf({
      ok: true,
      value: { ok: false, code: 'new-code', detail: '' } as never,
    })).toThrow('Unknown directoryNotes save result')
  })

  it('unwraps a read and names each refusal', () => {
    const snapshot = { directory: 'C:/work', notes: [{ text: '' }] }
    expect(TerminalNotesMessages.snapshotOf({ ok: true, value: { ok: true, value: snapshot } }))
      .toEqual({ ok: true, value: snapshot })
    expect(TerminalNotesMessages.snapshotOf({ ok: false, error: 'channel closed' }))
      .toEqual({ ok: false, detail: 'Notes could not be read: channel closed' })
    for (const code of ['unknown-session', 'config-latched', 'section-damaged'] as const) {
      const read = TerminalNotesMessages.snapshotOf({ ok: true, value: { ok: false, code, detail: `${code} detail` } })
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.detail).toContain(`${code} detail`)
    }
    expect(() => TerminalNotesMessages.snapshotOf({
      ok: true,
      value: { ok: false, code: 'new-code', detail: '' } as never,
    })).toThrow('Unknown directoryNotes read result')
  })

  it('has one distinct sentence for every import refusal', () => {
    const reasons: readonly DirectoryNotesImportRefusal[] = [
      'unknown-session', 'not-live', 'not-agent', 'unreadable', 'dialog', 'no-prompt', 'too-tall',
      'placeholder', 'in-flight', 'read-only', 'storage', 'unavailable', 'failed',
    ]
    const sentences = reasons.map((reason) => TerminalNotesMessages.refusal({ kind: 'refused', reason, detail: 'why' }))

    expect(new Set(sentences).size).toBe(reasons.length)
    expect(TerminalNotesMessages.refusal({ kind: 'refused', reason: 'storage', detail: 'at most 50 notes' }))
      .toContain('at most 50 notes')
    expect(() => TerminalNotesMessages.refusal({ kind: 'refused', reason: 'new-reason' as never, detail: '' }))
      .toThrow('Unknown import refusal')
  })

  it('names the note a partial import went to', () => {
    const base = { kind: 'partial' as const, notes: [{ text: 'a' }, { text: 'b' }], index: 1, detail: 'detail' }

    expect(TerminalNotesMessages.partial({ ...base, reason: 'not-erased' })).toContain('#2')
    expect(TerminalNotesMessages.partial({ ...base, reason: 'text-remains' })).toContain('still in the prompt')
    expect(() => TerminalNotesMessages.partial({ ...base, reason: 'other' as never })).toThrow('Unknown partial import')
  })
})
