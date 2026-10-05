import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import type { DirectoryNote } from '../../../../shared/directoryNotes'
import { TerminalNotesMessages } from './terminalNotesMessages'
import { useTerminalNotes } from './useTerminalNotes'
import type { TerminalNotesModel } from './useTerminalNotes'

describe('app-client-ui/renderer/panels/terminal/notes/useTerminalNotes', () => {
  interface Call {
    args: unknown[]
    settle(value: unknown): void
  }

  let gets: Call[]
  let saves: Call[]
  let imports: Call[]
  let listeners: ((directory: string) => void)[]
  let pasted: string[]
  let pasteAccepted: boolean
  let taken: number
  let model: TerminalNotesModel | null

  function called(list: Call[]) {
    return (...args: unknown[]): Promise<unknown> =>
      new Promise((resolve) => { list.push({ args, settle: resolve }) })
  }

  function Harness(props: { sessionId?: string; enabled?: boolean }): React.JSX.Element {
    model = useTerminalNotes({
      sessionId: props.sessionId ?? 's1',
      enabled: props.enabled ?? true,
      paste: (text) => {
        pasted.push(text)
        return pasteAccepted
      },
      onTaken: () => { taken += 1 },
    })
    return <div />
  }

  beforeEach(() => {
    vi.useFakeTimers()
    gets = []
    saves = []
    imports = []
    listeners = []
    pasted = []
    pasteAccepted = true
    taken = 0
    model = null
    const bridge = {
      directoryNotes: { get: called(gets), save: called(saves), importPrompt: called(imports) },
      onDirectoryNotesChanged: (callback: (directory: string) => void) => {
        listeners.push(callback)
        return () => { listeners = listeners.filter((listener) => listener !== callback) }
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    // Unmounting disposes the queue, which still sends a pending edit through the bridge.
    cleanup()
    vi.useRealTimers()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function read(): TerminalNotesModel {
    if (model === null) throw new Error('the hook has not run')
    return model
  }

  async function settle(call: Call, value: unknown): Promise<void> {
    await act(async () => {
      call.settle(value)
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function run(action: () => void): Promise<void> {
    await act(async () => {
      action()
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function elapse(milliseconds: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
  }

  function snapshot(texts: readonly string[], directory = 'C:/work'): unknown {
    return { ok: true, value: { ok: true, value: { directory, notes: texts.map((text) => ({ text })) } } }
  }

  const savedConst = { ok: true, value: { ok: true } }

  async function ready(texts: readonly string[]): Promise<ReturnType<typeof render>> {
    const view = render(<Harness />)
    await settle(gets[0], snapshot(texts))
    return view
  }

  function texts(): string[] {
    return read().entries.map((entry) => entry.text)
  }

  describe('loading', () => {
    it('reads nothing before the tab is first shown, then exactly once', async () => {
      const view = render(<Harness enabled={false} />)
      expect(gets).toHaveLength(0)
      expect(read().phase).toBe('idle')

      view.rerender(<Harness enabled />)
      expect(gets).toHaveLength(1)
      expect(gets[0].args).toEqual(['s1'])
      await settle(gets[0], snapshot(['a']))
      expect(read().phase).toBe('ready')
      expect(read().directory).toBe('C:/work')

      view.rerender(<Harness enabled={false} />)
      view.rerender(<Harness enabled />)
      expect(gets).toHaveLength(1)
      expect(texts()).toEqual(['a'])
    })

    it('keeps the editor and its unsaved text while another tab is shown', async () => {
      const view = await ready(['a'])
      await run(() => read().update(read().entries[0].id, 'typed'))

      view.rerender(<Harness enabled={false} />)

      expect(texts()).toEqual(['typed'])
      await elapse(500)
      expect(saves.map((call) => call.args)).toEqual([['s1', [{ text: 'typed' }]]])
    })

    it('shows a refused read as failed with nothing to edit, and Retry reads again', async () => {
      render(<Harness />)
      await settle(gets[0], { ok: true, value: { ok: false, code: 'section-damaged', detail: 'not a list' } })

      expect(read().phase).toBe('failed')
      expect(read().entries).toEqual([])
      expect(read().error).toContain('not a list')
      await run(() => read().add())
      expect(read().entries).toEqual([])

      await run(() => read().retry())
      expect(gets).toHaveLength(2)
      await settle(gets[1], snapshot(['back']))
      expect(read().phase).toBe('ready')
      expect(read().error).toBeNull()
      expect(texts()).toEqual(['back'])
    })
  })

  describe('saving', () => {
    it('saves 500 ms after the last edit and at once on blur', async () => {
      await ready([''])
      const id = read().entries[0].id
      await run(() => read().update(id, 'a'))
      await elapse(400)
      await run(() => read().update(id, 'ab'))
      await elapse(400)
      expect(saves).toHaveLength(0)
      await elapse(100)
      expect(saves.map((call) => call.args[1])).toEqual([[{ text: 'ab' }]])
      await settle(saves[0], savedConst)

      await run(() => read().update(id, 'abc'))
      await run(() => read().commitNow())

      expect(saves.map((call) => call.args[1])).toEqual([[{ text: 'ab' }], [{ text: 'abc' }]])
    })

    it('shows a failed save with Retry and keeps the text', async () => {
      await ready([''])
      await run(() => read().update(read().entries[0].id, 'kept'))
      await elapse(500)

      await settle(saves[0], { ok: true, value: { ok: false, code: 'config-latched', detail: 'unreadable' } })

      expect(read().error).toContain('unreadable')
      expect(texts()).toEqual(['kept'])
      await run(() => read().retry())
      expect(saves).toHaveLength(2)
      await settle(saves[1], savedConst)
      expect(read().error).toBeNull()
    })

    it('stores the flags and the order the editor shows', async () => {
      await ready(['a'])
      await run(() => read().add())
      const second = read().entries[1].id
      expect(read().focusId).toBe(second)
      await run(() => read().update(second, 'b'))
      await run(() => read().toggleLarge(second))
      await run(() => read().toggleSticky(read().entries[0].id))
      await elapse(500)

      expect(saves[0].args[1]).toEqual([{ text: 'a', sticky: true }, { text: 'b', large: true }])
    })
  })

  describe('sync', () => {
    it('reads its own directory again when it holds nothing unsaved', async () => {
      await ready(['a'])

      await run(() => listeners.forEach((listener) => listener('c:\\work\\')))
      expect(gets).toHaveLength(2)
      await settle(gets[1], snapshot(['from other window']))

      expect(texts()).toEqual(['from other window'])
    })

    it('ignores another directory', async () => {
      await ready(['a'])

      await run(() => listeners.forEach((listener) => listener('C:/other')))

      expect(gets).toHaveLength(1)
    })

    it('ignores the event while an edit is pending or a save is in flight', async () => {
      await ready(['a'])
      await run(() => read().update(read().entries[0].id, 'mine'))

      await run(() => listeners.forEach((listener) => listener('C:/work')))
      expect(gets).toHaveLength(1)
      await elapse(500)
      await run(() => listeners.forEach((listener) => listener('C:/work')))
      expect(gets).toHaveLength(1)
      expect(texts()).toEqual(['mine'])
    })

    it('ignores the event during an import', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })
      expect(read().importing).toBe(true)

      await run(() => listeners.forEach((listener) => listener('C:/work')))

      expect(gets).toHaveLength(1)
    })

    it('drops an answer when an edit was made while it was out', async () => {
      await ready(['a'])
      await run(() => listeners.forEach((listener) => listener('C:/work')))
      await run(() => read().update(read().entries[0].id, 'newer'))

      await settle(gets[1], snapshot(['older']))

      expect(texts()).toEqual(['newer'])
    })
  })

  it('finishes the old session\'s save under that session and reads the new one lazily', async () => {
    const view = await ready(['a'])
    await run(() => read().update(read().entries[0].id, 'old edit'))

    view.rerender(<Harness sessionId="s2" enabled={false} />)

    expect(saves.map((call) => call.args)).toEqual([['s1', [{ text: 'old edit' }]]])
    expect(read().phase).toBe('idle')
    expect(read().entries).toEqual([])
    expect(gets).toHaveLength(1)
    view.rerender(<Harness sessionId="s2" enabled />)
    expect(gets.map((call) => call.args)).toEqual([['s1'], ['s2']])
    await settle(saves[0], savedConst)
    await settle(gets[1], snapshot(['new'], 'C:/new'))
    expect(texts()).toEqual(['new'])
    expect(read().error).toBeNull()
  })

  describe('import', () => {
    it('sends the pending edit before it asks main to import', async () => {
      await ready(['a'])
      await run(() => read().update(read().entries[0].id, 'unsaved'))

      await run(() => { void read().importPrompt() })
      expect(saves.map((call) => call.args[1])).toEqual([[{ text: 'unsaved' }]])
      expect(imports).toHaveLength(0)

      await settle(saves[0], savedConst)
      expect(imports.map((call) => call.args)).toEqual([['s1']])
    })

    it('stops before the IPC when the pending edit could not be saved', async () => {
      await ready(['a'])
      await run(() => read().update(read().entries[0].id, 'unsaved'))
      await run(() => { void read().importPrompt() })

      await settle(saves[0], { ok: true, value: { ok: false, code: 'section-damaged', detail: 'broken' } })

      expect(imports).toHaveLength(0)
      expect(read().importing).toBe(false)
      expect(read().notice).toContain('broken')
    })

    it('locks the editors while it runs and ignores a second click', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })

      expect(read().importing).toBe(true)
      await run(() => { void read().importPrompt() })
      await run(() => read().update(read().entries[0].id, 'typed'))
      await run(() => read().add())
      expect(imports).toHaveLength(1)
      expect(texts()).toEqual(['a'])
    })

    it('adopts the stored list on taken, focuses the note and reports the erase', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })

      await settle(imports[0], { ok: true, value: { kind: 'taken', notes: [{ text: 'a' }, { text: 'draft' }], index: 1 } })

      expect(texts()).toEqual(['a', 'draft'])
      expect(read().focusId).toBe(read().entries[1].id)
      expect(read().importing).toBe(false)
      expect(read().notice).toBeNull()
      expect(taken).toBe(1)
      await elapse(1_000)
      expect(saves).toHaveLength(0)
    })

    it('adopts the stored list on partial and says what is left', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })

      await settle(imports[0], {
        ok: true,
        value: { kind: 'partial', notes: [{ text: 'draft' }], index: 0, reason: 'text-remains', detail: 'still there' },
      })

      expect(texts()).toEqual(['draft'])
      expect(read().notice).toContain('#1')
      expect(taken).toBe(0)
    })

    it('leaves the list alone on empty and on a refusal', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })
      await settle(imports[0], { ok: true, value: { kind: 'empty' } })
      expect(read().notice).toBe(TerminalNotesMessages.emptyConst)
      expect(texts()).toEqual(['a'])

      await run(() => { void read().importPrompt() })
      expect(read().notice).toBeNull()
      await settle(imports[1], { ok: true, value: { kind: 'refused', reason: 'dialog', detail: 'dialog' } })
      expect(read().notice).toBe(TerminalNotesMessages.refusal({ kind: 'refused', reason: 'dialog', detail: 'dialog' }))
      expect(texts()).toEqual(['a'])
      expect(taken).toBe(0)
    })

    it('reads the notes again after the channel failed', async () => {
      await ready(['a'])
      await run(() => { void read().importPrompt() })

      await settle(imports[0], { ok: false, error: 'channel closed' })
      expect(read().notice).toContain('channel closed')
      expect(gets).toHaveLength(2)
      await settle(gets[1], snapshot(['a', 'stored by main']))

      expect(texts()).toEqual(['a', 'stored by main'])
      expect(read().importing).toBe(false)
      expect(read().notice).toContain('channel closed')
    })
  })

  describe('paste', () => {
    it('does nothing for a note of blanks', async () => {
      await ready(['  \n '])

      await run(() => read().paste(read().entries[0].id))

      expect(pasted).toEqual([])
    })

    it('changes nothing and says so when the terminal refused the write', async () => {
      await ready(['a', 'b'])
      pasteAccepted = false

      await run(() => read().paste(read().entries[0].id))

      expect(pasted).toEqual(['a'])
      expect(texts()).toEqual(['a', 'b'])
      expect(read().notice).toBe(TerminalNotesMessages.pasteRefusedConst)
      await elapse(1_000)
      expect(saves).toHaveLength(0)
    })

    it('drops a pasted note after the write was accepted and saves that', async () => {
      await ready(['a', 'b'])

      await run(() => read().paste(read().entries[0].id))

      expect(texts()).toEqual(['b'])
      await elapse(500)
      expect(saves[0].args[1]).toEqual([{ text: 'b' }] satisfies DirectoryNote[])
    })
  })
})
