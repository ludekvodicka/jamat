import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  SessionSubagentEntry,
  SessionSubagentState,
  SessionSubagentTranscript,
} from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { SubagentTranscriptEntry, SubagentTranscriptText, SubagentTranscriptView } from './subagentTranscriptView'

describe('app-client-ui/renderer/taskView/subagentTranscriptView', () => {
  afterEach(() => cleanup())

  function transcript(entries: SessionSubagentEntry[], state: SessionSubagentState = 'done'):
  Extract<SessionSubagentTranscript, { kind: 'transcript' }> {
    return {
      kind: 'transcript',
      revision: '1:2',
      header: { agentType: 'general-purpose', description: 'Add a comment', model: 'claude-opus-5', state, contextTokens: 31_200 },
      entries,
      earlierStepsOmitted: false,
    }
  }

  it('draws every entry kind', () => {
    const { container } = render(<SubagentTranscriptView transcript={transcript([
      { kind: 'prompt', text: 'Add a comment line', truncated: false },
      { kind: 'thinking', at: 1 },
      { kind: 'message', role: 'assistant', text: 'I will edit it', truncated: false, at: 2 },
      { kind: 'tool', tool: 'Bash', summary: 'node -e 1', output: 'ok', outputTruncated: true, failed: false, at: 3 },
      { kind: 'edit', path: 'scratch.ts', added: 1, removed: 0, preview: '+// note', at: 4 },
      { kind: 'compact', at: 5 },
      { kind: 'interrupted', at: 6 },
      { kind: 'error', text: 'API error', at: 7 },
      { kind: 'message', role: 'user', text: 'Go on', truncated: true, at: 8 },
    ])} />)

    expect(screen.getByText('general-purpose: Add a comment')).toBeTruthy()
    expect(screen.getByText('Done · claude-opus-5 · 31,200 context tokens')).toBeTruthy()
    expect(screen.getByText('Add a comment line')).toBeTruthy()
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.getByText('I will edit it')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('node -e 1')).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
    expect(screen.getByText('The rest of this output is cut.')).toBeTruthy()
    expect(screen.getByText('scratch.ts')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('-0')).toBeTruthy()
    expect(container.querySelector('[data-sign="added"]')?.textContent).toBe('+// note\n')
    expect(screen.getByRole('separator').textContent).toBe('Context compacted')
    expect(screen.getByText('Interrupted by the user')).toBeTruthy()
    expect(screen.getByText('API error')).toBeTruthy()
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('The rest of this text is cut.')).toBeTruthy()
    expect(screen.queryByTestId('task-view-step')).toBeNull()
  })

  it('draws an encrypted Codex message as such, and a Codex child titled by its nickname alone', () => {
    render(<SubagentTranscriptView transcript={{
      ...transcript([
        { kind: 'encrypted', at: 1 },
        { kind: 'tool', tool: 'exec', summary: 'Get-ChildItem docs/architecture', output: null, outputTruncated: false, failed: false, at: 2 },
      ]),
      header: { agentType: 'Jason', description: 'Jason', model: 'gpt-6-astra', state: 'done', contextTokens: 25_164 },
    }} />)

    expect(screen.getByText('encrypted message')).toBeTruthy()
    expect(screen.getByText('Jason')).toBeTruthy()
    expect(screen.getByText('exec')).toBeTruthy()
    expect(screen.getByText('Get-ChildItem docs/architecture')).toBeTruthy()
    expect(screen.getByText('Done · gpt-6-astra · 25,164 context tokens')).toBeTruthy()
  })

  it('throws on an entry kind it does not know', () => {
    const unknown = { kind: 'telepathy', at: null } as unknown as SessionSubagentEntry
    expect(() => SubagentTranscriptEntry({ entry: unknown })).toThrow('Unknown sub-agent entry')
  })

  it('shows 20 lines of output and the rest on request', () => {
    const output = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n')
    const { container } = render(<SubagentTranscriptView transcript={transcript([
      { kind: 'tool', tool: 'Bash', summary: 'seq 25', output, outputTruncated: false, failed: false, at: 1 },
    ])} />)

    expect(container.querySelector('.task-view__output')?.textContent?.split('\n')).toHaveLength(20)
    fireEvent.click(screen.getByText('Show all 25 lines'))
    expect(container.querySelector('.task-view__output')?.textContent).toBe(output)
    fireEvent.click(screen.getByText('Show less'))
    expect(container.querySelector('.task-view__output')?.textContent?.split('\n')).toHaveLength(20)
  })

  it('draws the current step at the bottom while the agent runs', () => {
    render(<SubagentTranscriptView transcript={transcript([
      { kind: 'tool', tool: 'Read', summary: 'docs/x.md', output: 'text', outputTruncated: false, failed: false, at: 1 },
      { kind: 'tool', tool: 'Bash', summary: 'pnpm test', output: null, outputTruncated: false, failed: false, at: 2 },
    ], 'running')} />)

    expect(screen.getByTestId('task-view-step').textContent).toBe('Now: Bash pnpm test')
  })

  it('draws markup and control sequences as plain text', () => {
    const { container } = render(<SubagentTranscriptView transcript={transcript([
      { kind: 'message', role: 'assistant', text: '<script>alert(1)</script> **bold** [link](x)', truncated: false, at: 1 },
      { kind: 'tool', tool: 'Bash', summary: 'ls', output: '\u001b[31mred\u001b[0m <img src=x>', outputTruncated: false, failed: true, at: 2 },
    ])} />)

    expect(screen.getByText('<script>alert(1)</script> **bold** [link](x)')).toBeTruthy()
    expect(screen.getByText('red <img src=x>')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
    expect(screen.getByText('failed')).toBeTruthy()
  })

  it('removes CSI and OSC sequences', () => {
    expect(SubagentTranscriptText.plainOf('\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done')).toBe('ok done')
  })
})
