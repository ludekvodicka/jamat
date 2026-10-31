import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AttentionItemView } from '../../shared/attention'
import { AppShellItems } from './appShellItems'
import { AttentionStatusItem, type AttentionStatusPorts } from './attentionStatusItem'

function portsOf(next: AttentionStatusPorts['next']): AttentionStatusPorts {
  return { read: async () => ({ ok: true, value: { revision: 0, items: [] } }), subscribe: () => () => {}, reportError: vi.fn(), next }
}

const reviewConst: AttentionItemView = { key: 'draft', kind: 'commit-review', sessionId: 's1', title: 'App - 001', automatic: true }
const markConst: AttentionItemView = { key: 'session-mark:s2', kind: 'session-mark', sessionId: 's2', title: 'App - 002', automatic: false }

describe('app-client-ui/renderer/statusBar/attentionStatusItem', () => {
  it('counts what waits, lists it in the tooltip and asks for the next one on a click', async () => {
    const next = vi.fn<AttentionStatusPorts['next']>(async () => ({ ok: true, value: undefined }))
    render(<AttentionStatusItem items={[reviewConst, markConst]} ports={portsOf(next)} />)
    const button = screen.getByRole('button', { name: '2 waiting for you, show the next one' })
    expect(button).toHaveTextContent('! 2')
    expect(button).toHaveClass('jamat-attention--automatic')
    expect(button).toHaveAttribute('title', 'Click to show the next one:\nCommit review: App - 001\nNeeds a look: App - 002')
    await act(async () => fireEvent.click(button))
    expect(next).toHaveBeenCalledOnce()
  })

  it('stays unlit while only items that wait for a click are left, and reports a failed click', async () => {
    const ports = portsOf(async () => ({ ok: false, error: 'renderer gone' }))
    render(<AttentionStatusItem items={[markConst]} ports={ports} />)
    const button = screen.getByRole('button', { name: '1 waiting for you, show the next one' })
    expect(button).not.toHaveClass('jamat-attention--automatic')
    await act(async () => fireEvent.click(button))
    expect(ports.reportError).toHaveBeenCalledWith(expect.stringContaining('The next waiting item could not be shown'))
  })

  it('takes a slot on the right only while something waits, before the terminal widgets', () => {
    const widgets = (items: readonly AttentionItemView[]) => ({
      sessionModel: null,
      compact: {} as Parameters<typeof AppShellItems.right>[3]['compact'],
      rate: {} as Parameters<typeof AppShellItems.right>[3]['rate'],
      attention: { snapshot: { revision: 1, items }, ports: portsOf(vi.fn()) },
    })
    const window = { windowId: 'main', role: 'main' as const, name: 'Main', color: null }
    expect(AppShellItems.right(null, window, null, widgets([])).map((item) => item.key)).toEqual(['window'])
    expect(AppShellItems.right(null, window, null, widgets([reviewConst])).map((item) => item.key)).toEqual(['window', 'attention'])
  })
})
