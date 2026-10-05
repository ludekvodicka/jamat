import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  ConfigOpRefusal,
  ConfigOpResult,
  ConfigSectionSpec,
} from '../../../lib-orchestrator/configStore/configStore.types'
import type {
  RemoteControlTerminal,
  RemoteControlTerminalKeep,
  RemoteControlTerminalTakeRefusal,
  RemoteControlTerminalTakeResult,
} from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { AppClientUiIpcInvokeMap } from '../../shared/appClientUiIpc'
import type { DirectoryNote, DirectoryNotesImportRefusal, DirectoryNotesValue } from '../../shared/directoryNotes'
import { ServiceDirectoryNotesIpc } from './serviceDirectoryNotesIpc'

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcMainMock.handlers.set(channel, handler)
    },
  },
}))

describe('app-client-ui/app/directoryNotes/serviceDirectoryNotesIpc', () => {
  const cwdConst = 'C:\\work\\app'
  /** What the take under test does with the keep it is handed, and what it answers. */
  interface TakeScript {
    /** The prompt text handed to the keep; absent means the take never reaches the keep. */
    text?: string
    answer(kept: ReturnType<RemoteControlTerminalKeep> | null): RemoteControlTerminalTakeResult
  }

  let raw: unknown
  let reads: number
  let damage: ConfigOpRefusal | null
  let saveAnswer: ConfigOpResult
  let written: DirectoryNotesValue[]
  let known: boolean
  let takes: string[]
  let script: TakeScript
  let changed: string[]

  function configUnderTest(): ConfigStore {
    return {
      readSection: (spec: ConfigSectionSpec<DirectoryNotesValue>) => {
        reads += 1
        return spec.coerce(raw, () => {})
      },
      sectionDamage: () => {
        reads += 1
        return damage
      },
      saveSection: (_spec: unknown, value: DirectoryNotesValue) => {
        written.push(value)
        if (saveAnswer.ok) raw = value
        return saveAnswer
      },
    } as unknown as ConfigStore
  }

  const sessionsUnderTest: Pick<SessionManager, 'workingContext'> = {
    workingContext: (sessionId) => Promise.resolve(known
      ? { ok: true, value: { sessionId, cwd: cwdConst, agent: null, worktree: null } }
      : { ok: false, code: 'unknown-session', detail: `Session ${sessionId} does not exist` }),
  }

  const terminalUnderTest: Pick<RemoteControlTerminal, 'take'> = {
    take: (sessionId, keep) => {
      takes.push(sessionId)
      const kept = script.text === undefined ? null : keep(script.text)
      return Promise.resolve(script.answer(kept))
    },
  }

  beforeEach(() => {
    ipcMainMock.handlers.clear()
    raw = undefined
    reads = 0
    damage = null
    saveAnswer = { ok: true }
    written = []
    known = true
    takes = []
    script = { text: 'draft', answer: (kept) => kept?.ok === true ? { kind: 'taken' } : refusedKeep(kept) }
    changed = []
    new ServiceDirectoryNotesIpc(
      configUnderTest(),
      sessionsUnderTest,
      terminalUnderTest,
      (directory) => changed.push(directory),
    ).initialize()
  })

  function refusedKeep(kept: ReturnType<RemoteControlTerminalKeep> | null): RemoteControlTerminalTakeResult {
    if (kept === null || kept.ok) throw new Error('the script expected a refused keep')
    return { kind: 'refused', reason: 'keep-refused', detail: kept.detail }
  }

  async function invoke(
    channel: keyof AppClientUiIpcInvokeMap,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = ipcMainMock.handlers.get(channel)
    if (!handler) throw new Error(`No handler for ${channel}`)
    return handler({} as IpcMainInvokeEvent, ...args)
  }

  function notes(count: number): DirectoryNote[] {
    return Array.from({ length: count }, (_, index) => ({ text: `note ${index + 1}` }))
  }

  it('registers a handler for every channel it declares', () => {
    expect([...ipcMainMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceDirectoryNotesIpc.channelsConst).sort())
  })

  describe('get', () => {
    it('answers unknown-session without reading the config', async () => {
      known = false

      expect(await invoke('directoryNotes:get', 's-gone')).toEqual({
        ok: true,
        value: { ok: false, code: 'unknown-session', detail: 'Session s-gone does not exist' },
      })
      expect(reads).toBe(0)
    })

    it.each(['config-latched', 'section-damaged'] as const)('refuses the read when the store answers %s', async (code) => {
      damage = { ok: false, code, detail: 'hand edited' }

      expect(await invoke('directoryNotes:get', 's-1'))
        .toEqual({ ok: true, value: { ok: false, code, detail: 'hand edited' } })
    })

    it('answers the default set for a directory nobody wrote for', async () => {
      expect(await invoke('directoryNotes:get', 's-1'))
        .toEqual({ ok: true, value: { ok: true, value: { directory: cwdConst, notes: [{ text: '' }] } } })
    })

    it('answers the stored set however the directory was spelled', async () => {
      raw = { 'c:/work/app/': [{ text: 'kept', sticky: true }] }

      expect(await invoke('directoryNotes:get', 's-1')).toEqual({
        ok: true,
        value: { ok: true, value: { directory: cwdConst, notes: [{ text: 'kept', sticky: true }] } },
      })
    })
  })

  describe('save', () => {
    it('refuses a set over the limits as invalid-section without a write', async () => {
      for (const offered of [notes(51), [{ text: 'x'.repeat(20_001) }], []]) {
        const answer = await invoke('directoryNotes:save', 's-1', offered)
        expect(answer).toMatchObject({ ok: true, value: { ok: false, code: 'invalid-section' } })
      }
      expect(written).toEqual([])
      expect(changed).toEqual([])
    })

    it('answers unknown-session without a write', async () => {
      known = false

      expect(await invoke('directoryNotes:save', 's-gone', notes(1)))
        .toMatchObject({ ok: true, value: { ok: false, code: 'unknown-session' } })
      expect(written).toEqual([])
    })

    it('writes the directory beside the others and tells the windows once', async () => {
      raw = { '/srv/other': [{ text: 'other' }] }

      expect(await invoke('directoryNotes:save', 's-1', [{ text: 'a', large: true, sticky: false }]))
        .toEqual({ ok: true, value: { ok: true } })
      expect(written).toEqual([{ '/srv/other': [{ text: 'other' }], [cwdConst]: [{ text: 'a', large: true }] }])
      expect(changed).toEqual([cwdConst])
    })

    it.each(['config-latched', 'section-damaged', 'invalid-section'] as const)(
      'sends no event when the store answers %s', async (code) => {
        saveAnswer = { ok: false, code, detail: 'refused' }

        expect(await invoke('directoryNotes:save', 's-1', notes(2)))
          .toEqual({ ok: true, value: { ok: false, code, detail: 'refused' } })
        expect(changed).toEqual([])
      },
    )

    it('throws on a refusal code this wire does not know', async () => {
      saveAnswer = { ok: false, code: 'disk-full', detail: 'refused' } as unknown as ConfigOpResult

      expect(await invoke('directoryNotes:save', 's-1', notes(2))).toMatchObject({
        ok: false,
        error: expect.stringContaining('Unexpected directoryNotes save result'),
      })
      expect(changed).toEqual([])
    })
  })

  describe('import', () => {
    it('refuses an unknown session before the take', async () => {
      known = false

      expect(await invoke('directoryNotes:import', 's-gone')).toEqual({
        ok: true,
        value: { kind: 'refused', reason: 'unknown-session', detail: 'Session s-gone does not exist' },
      })
      expect(takes).toEqual([])
    })

    it('refuses a damaged section as storage before the take', async () => {
      damage = { ok: false, code: 'section-damaged', detail: 'hand edited' }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: { kind: 'refused', reason: 'storage', detail: 'hand edited' },
      })
      expect(takes).toEqual([])
    })

    it('stores the prompt in the one empty note, keeps its flags and tells the windows once', async () => {
      raw = { [cwdConst]: [{ text: '', sticky: true }] }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: { kind: 'taken', notes: [{ text: 'draft', sticky: true }], index: 0 },
      })
      expect(written).toEqual([{ [cwdConst]: [{ text: 'draft', sticky: true }] }])
      expect(takes).toEqual(['s-1'])
      expect(changed).toEqual([cwdConst])
    })

    it('appends the prompt to a set that holds text', async () => {
      raw = { [cwdConst]: notes(2) }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: { kind: 'taken', notes: [...notes(2), { text: 'draft' }], index: 2 },
      })
    })

    it('hands the store refusal back to the take and stores nothing', async () => {
      saveAnswer = { ok: false, code: 'config-latched', detail: 'config.json is unreadable' }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: { kind: 'refused', reason: 'storage', detail: 'config.json is unreadable' },
      })
      expect(changed).toEqual([])
    })

    it('refuses a 51st note in the keep without a write', async () => {
      raw = { [cwdConst]: notes(50) }

      expect(await invoke('directoryNotes:import', 's-1'))
        .toMatchObject({ ok: true, value: { kind: 'refused', reason: 'storage' } })
      expect(written).toEqual([])
      expect(changed).toEqual([])
    })

    it('answers partial with the stored note and tells the windows once', async () => {
      script = {
        text: 'draft',
        answer: () => ({ kind: 'partial', reason: 'text-remains', detail: 'text is still there' }),
      }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: {
          kind: 'partial',
          notes: [{ text: 'draft' }],
          index: 0,
          reason: 'text-remains',
          detail: 'text is still there',
        },
      })
      expect(changed).toEqual([cwdConst])
    })

    it('answers empty with no event', async () => {
      script = { answer: () => ({ kind: 'empty' }) }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({ ok: true, value: { kind: 'empty' } })
      expect(changed).toEqual([])
    })

    const refusalsConst: readonly [RemoteControlTerminalTakeRefusal, DirectoryNotesImportRefusal][] = [
      ['unknown-session', 'unknown-session'],
      ['not-live', 'not-live'],
      ['not-agent', 'not-agent'],
      ['unreadable', 'unreadable'],
      ['dialog', 'dialog'],
      ['no-prompt', 'no-prompt'],
      ['too-tall', 'too-tall'],
      ['placeholder', 'placeholder'],
      ['in-flight', 'in-flight'],
      ['read-only', 'read-only'],
      ['keep-refused', 'storage'],
      ['unavailable', 'unavailable'],
      ['failed', 'failed'],
    ]

    it.each(refusalsConst)('maps the take refusal %s to %s with no event', async (reason, expected) => {
      script = { answer: () => ({ kind: 'refused', reason, detail: 'refused here' }) }

      expect(await invoke('directoryNotes:import', 's-1')).toEqual({
        ok: true,
        value: { kind: 'refused', reason: expected, detail: 'refused here' },
      })
      expect(changed).toEqual([])
    })

    it.each([
      { kind: 'taken' },
      { kind: 'partial', reason: 'not-erased', detail: 'not erased' },
    ] as const)('throws when a take answers $kind without a stored note', async (answer) => {
      script = { answer: () => answer }

      expect(await invoke('directoryNotes:import', 's-1')).toMatchObject({
        ok: false,
        error: expect.stringContaining('without a stored note'),
      })
      expect(changed).toEqual([])
    })
  })
})
