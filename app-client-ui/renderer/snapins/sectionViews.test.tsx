import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { SnapinSection } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import { SectionViews } from './sectionViews'

export const sections: SnapinSection[] = [
  { kind: 'notice', tone: 'warning', text: 'A warning' },
  { kind: 'items', actions: [{ id: 'new.action', label: 'Process selected', scope: 'selection', tone: 'primary' }], groups: [
    { title: 'Project', mode: 'wt', items: [{ key: 'one', title: 'One', mode: 'wt', state: 'ready', tone: 'neutral', selectable: true, actions: [] }] },
    { title: 'Mixed', items: [{ key: 'two', title: 'Two', mode: 'wc', state: 'held', hold: 'A hold', tone: 'attention', selectable: false, actions: [] }] },
  ] },
  { kind: 'progress', rows: [{ label: 'Queued', value: '2' }] },
  { kind: 'log', lines: [{ at: 1, level: 'info', text: 'A log entry' }] },
]
it('renders all kinds, group/item modes, and only selectable checkboxes', () => {
  render(<SectionViews sections={sections} onPress={() => {}} />)
  for (const text of ['A warning', 'WT', 'WC', 'A hold', 'Queued', '2', 'A log entry']) expect(screen.getByText(text)).toBeTruthy()
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
})
it('keeps selection across pushes and forwards opaque action ids', () => {
  const press = vi.fn()
  const view = render(<SectionViews sections={sections} onPress={press} />)
  fireEvent.click(screen.getByRole('checkbox'))
  view.rerender(<SectionViews sections={structuredClone(sections)} onPress={press} />)
  fireEvent.click(screen.getByRole('button', { name: 'Process selected' }))
  expect(press).toHaveBeenCalledWith('new.action', ['one'])
})
it('throws on an unknown section kind', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => render(<SectionViews sections={[{ kind: 'future' } as unknown as SnapinSection]} onPress={() => {}} />)).toThrow('Unknown snap-in section')
  error.mockRestore()
})

it('renders projects sharing a group title without duplicate React keys', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const sameTitles = structuredClone(sections)
  const items = sameTitles.find((section) => section.kind === 'items')!
  items.groups[1].title = items.groups[0].title
  render(<SectionViews sections={sameTitles} onPress={() => {}} />)
  expect(screen.getAllByRole('region', { name: 'Project' })).toHaveLength(2)
  expect(error).not.toHaveBeenCalled()
  error.mockRestore()
})
