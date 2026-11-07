import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentMemoryListing } from '../../../../lib-orchestrator/agentMemory/agentMemoryApi.types'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { ControlBridgeFixture } from '../../ipc/fixtures/controlBridgeFixture'
import { AgentMemoryDialog } from './agentMemoryDialog'

describe('app-client-ui/renderer/overlays/agentMemory/agentMemoryDialog', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  function mount() {
    const listing: AgentMemoryListing = {
      agentId: 'claude', directory: 'C:/Users/u/.claude/projects/Q--App/memory', scope: 'project', truncated: false,
      files: [
        { name: 'MEMORY.md', size: 40, modifiedAt: 1, writtenByConversation: false },
        { name: 'private.md', size: 10, modifiedAt: 2, writtenByConversation: true },
      ],
    }
    const texts: Record<string, string> = { 'MEMORY.md': '- [Private](private.md) - a fact', 'private.md': 'secret fact' }
    const calls: { operation: string; body: Record<string, unknown> }[] = []
    const bridge = {
      control: {
        call: async (operation: string, body: Record<string, unknown>) => {
          calls.push({ operation, body })
          if (operation === 'agentMemory.list') {
            const target = body.target as { scope?: string; agentId?: string }
            if (target.scope === 'user')
              return ControlBridgeFixture.valueOf(operation, { ok: true, value: {
                agentId: target.agentId, directory: `C:/Users/u/.${target.agentId}`, scope: 'user', truncated: false,
                files: [{ name: target.agentId === 'claude' ? 'CLAUDE.md' : 'AGENTS.md', size: 5, modifiedAt: 1, writtenByConversation: false }],
              } })
            return ControlBridgeFixture.valueOf(operation, { ok: true, value: listing })
          }
          if (operation === 'agentMemory.read') {
            const name = body.name as string
            return ControlBridgeFixture.valueOf(operation, { ok: true, value: { name, text: texts[name] ?? `${name} text`, modifiedAt: name === 'private.md' ? 2 : 1 } })
          }
          if (operation === 'agentMemory.write') return ControlBridgeFixture.valueOf(operation, { ok: true, value: { modifiedAt: 3 } })
          if (operation === 'agentMemory.delete') return ControlBridgeFixture.valueOf(operation, { ok: true, value: { indexLinesRemoved: 1 } })
          return { ok: false, error: `No stub for ${operation}` }
        },
      },
    }
    Object.defineProperty(window, 'appClient', { configurable: true, value: bridge as unknown as AppClientUiBridge })
    const onClose = vi.fn()
    const view = render(<AgentMemoryDialog initialSession="s1" onClose={onClose} sessions={[
      { key: 's0', label: 'Other - 001 (Codex)', target: { sessionId: 's0' } },
      { key: 's1', label: 'App - 014 (Claude)', target: { sessionId: 's1' } },
    ]} />)
    return { ...view, calls, onClose }
  }

  it('lists the files, marks those the session wrote, and opens a linked one', async () => {
    const view = mount()
    expect((view.getByLabelText('Session') as HTMLSelectElement).value).toBe('s1')

    expect(await view.findByText('private.md')).toBeTruthy()
    expect(view.getByLabelText('written by this session')).toBeTruthy()
    fireEvent.click(await view.findByText('Private'))

    await waitFor(() => expect(view.getByText('secret fact')).toBeTruthy())
  })

  it('saves an edit against the version it read, and deletes after a confirmation', async () => {
    const view = mount()
    fireEvent.click(await view.findByText('private.md'))
    await view.findByText('secret fact')

    fireEvent.click(view.getByRole('button', { name: 'Edit' }))
    fireEvent.change(view.getByLabelText('Edit private.md'), { target: { value: 'changed' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(view.calls.find((call) => call.operation === 'agentMemory.write')?.body)
      .toEqual({ target: { sessionId: 's1' }, name: 'private.md', text: 'changed', expectedModifiedAt: 2 }))

    fireEvent.click(await view.findByRole('button', { name: 'Delete' }))
    expect(view.calls.some((call) => call.operation === 'agentMemory.delete')).toBe(false)
    fireEvent.click(view.getAllByRole('button', { name: 'Delete' }).at(-1)!)
    await waitFor(() => expect(view.calls.find((call) => call.operation === 'agentMemory.delete')?.body)
      .toEqual({ target: { sessionId: 's1' }, name: 'private.md' }))
    expect(await view.findByText(/private\.md deleted; 1 line\(s\) of MEMORY\.md/)).toBeTruthy()
  })

  it('shows the user-level files of both agents on the Global memory tab', async () => {
    const view = mount()
    await view.findByText('private.md')

    fireEvent.click(view.getByRole('tab', { name: 'Global memory' }))

    expect(await view.findByText('CLAUDE.md')).toBeTruthy()
    expect(await view.findByText('AGENTS.md')).toBeTruthy()
    expect(view.getByText('Claude')).toBeTruthy()
    expect(view.getByText('Codex')).toBeTruthy()
    expect(view.calls.filter((call) => call.operation === 'agentMemory.list').map((call) => call.body.target))
      .toEqual(expect.arrayContaining([{ scope: 'user', agentId: 'claude' }, { scope: 'user', agentId: 'codex' }]))
    fireEvent.click(view.getByText('AGENTS.md'))
    await waitFor(() => expect(view.getByText('AGENTS.md text')).toBeTruthy())
  })
})
