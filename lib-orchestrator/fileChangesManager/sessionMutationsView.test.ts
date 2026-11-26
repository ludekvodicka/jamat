import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ParsedFileChangesLog, ParsedSubagentLog } from './logs/fileChangesLogSource'
import { FileChangesLogSourceAntigravity } from './logs/fileChangesLogSourceAntigravity'
import { FileChangesLogSourceClaude } from './logs/fileChangesLogSourceClaude'
import { FileChangesLogSourceCodex } from './logs/fileChangesLogSourceCodex'
import type { FileChangesAgentId } from './fileChangesManagerApi.types'
import {
  sessionMutationExtractor,
  type SessionMutationBatch,
  type SessionMutationRole,
} from './sessionMutationsView'

class ClaudeProbe extends FileChangesLogSourceClaude {
  full(content: string): ParsedFileChangesLog { return this.parse(content) }
  sub(content: string): ParsedSubagentLog { return this.parseSubagent(content) }
}
class CodexProbe extends FileChangesLogSourceCodex {
  full(content: string): ParsedFileChangesLog { return this.parse(content) }
  sub(content: string): ParsedSubagentLog { return this.parseSubagent(content) }
}
class AntigravityProbe extends FileChangesLogSourceAntigravity {
  full(content: string): ParsedFileChangesLog { return this.parse(content) }
}

describe('lib-orchestrator/fileChangesManager/sessionMutationsView', () => {
  const fixtures = join(import.meta.dirname, 'logs', 'fixtures')

  function filesOf(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name)
      return statSync(path).isDirectory() ? filesOf(path) : [path]
    })
  }

  /** Lines in chunks of `size`, the state carried through `JSON.stringify` between chunks when `roundTrip`. */
  function extract(
    agentId: FileChangesAgentId,
    role: SessionMutationRole,
    content: string,
    size: number,
    roundTrip = false,
  ): SessionMutationBatch {
    const lines = content.split('\n')
    const out: SessionMutationBatch = { mutations: [], shellRuns: [] }
    let extractor = sessionMutationExtractor(agentId, role)
    for (let at = 0; at < lines.length; at += size) {
      extractor.push(lines.slice(at, at + size))
      const batch = extractor.drain()
      out.mutations.push(...batch.mutations)
      out.shellRuns.push(...batch.shellRuns)
      if (roundTrip)
        extractor = sessionMutationExtractor(agentId, role, JSON.parse(JSON.stringify(extractor.state())))
    }
    return out
  }

  const antigravityTranscript = [
    { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-21T14:39:00Z',
      tool_calls: [{ name: 'write_file', args: { Path: '"Q:/Project/early.ts"', Content: '"x"' } }] },
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-21T14:40:00Z',
      content: '<USER_REQUEST>\nUpdate app.ts\n</USER_REQUEST>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-21T14:40:05Z', tool_calls: [
      { name: 'edit_file', args: { Path: '"Q:/Project/app.ts"', Target: '"old"', Replacement: '"new"' } },
      { name: 'run_command', args: { CommandLine: '"pnpm test"' } },
      { name: 'write_file', args: { Path: 'Q:/Project/b.ts', Content: 'b' } },
    ] },
  ].map((record) => JSON.stringify(record)).join('\n')

  const cases: { name: string; agentId: FileChangesAgentId; content: string }[] = [
    ...filesOf(fixtures).sort().map((file) => ({
      name: relative(fixtures, file).split(sep).join('/'),
      agentId: (relative(fixtures, file).startsWith('claude') ? 'claude' : 'codex') as FileChangesAgentId,
      content: readFileSync(file, 'utf8'),
    })),
    { name: 'antigravity (inline)', agentId: 'antigravity', content: antigravityTranscript },
  ]

  function fullSession(agentId: FileChangesAgentId, content: string): SessionMutationBatch {
    const parsed = agentId === 'claude' ? new ClaudeProbe().full(content)
      : agentId === 'codex' ? new CodexProbe().full(content)
        : new AntigravityProbe().full(content)
    return { mutations: parsed.groups.flatMap((group) => [...group.mutations]), shellRuns: [...parsed.shellRuns] }
  }

  function fullSubagent(agentId: 'claude' | 'codex', content: string): SessionMutationBatch {
    const parsed = agentId === 'claude' ? new ClaudeProbe().sub(content) : new CodexProbe().sub(content)
    return { mutations: [...parsed.mutations], shellRuns: [...parsed.shellRuns] }
  }

  it.each(cases)('$name: the extractor in 1, 7 and all-line chunks gives what the full parser gives', ({ agentId, content }) => {
    const session = fullSession(agentId, content)
    for (const size of [1, 7, Number.MAX_SAFE_INTEGER]) {
      expect(extract(agentId, 'session', content, size)).toEqual(session)
      expect(extract(agentId, 'session', content, size, true)).toEqual(session)
    }
    if (agentId === 'antigravity') return
    const subagent = fullSubagent(agentId, content)
    for (const size of [1, 7, Number.MAX_SAFE_INTEGER]) {
      expect(extract(agentId, 'subagent', content, size)).toEqual(subagent)
      expect(extract(agentId, 'subagent', content, size, true)).toEqual(subagent)
    }
  })

  it('finds something to compare in the fixtures: mutations and shell runs of every agent', () => {
    const totals = cases.map(({ agentId, content }) => extract(agentId, 'session', content, 1))
    expect(totals.reduce((sum, batch) => sum + batch.mutations.length, 0)).toBeGreaterThanOrEqual(10)
    expect(totals.reduce((sum, batch) => sum + batch.shellRuns.length, 0)).toBeGreaterThanOrEqual(4)
  })

  describe('Claude', () => {
    const prompt = JSON.stringify({ type: 'user', uuid: 'm1', timestamp: '2026-11-26T08:00:00.000Z', message: { content: 'Go' } })
    const edit = (id: string, at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [
      { type: 'tool_use', id, name: 'Edit', input: { file_path: 'Q:/P/a.ts', old_string: 'a', new_string: 'b' } },
    ] } })
    const result = (id: string, at: string, isError: boolean) => JSON.stringify({ type: 'user', timestamp: at, message: { content: [
      { type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) },
    ] } })

    it('confirms an Edit whose tool_result arrives in the next chunk, once', () => {
      const extractor = sessionMutationExtractor('claude', 'session')
      extractor.push([prompt, edit('e1', '2026-11-26T08:00:01.000Z')])
      expect(extractor.drain().mutations).toEqual([])
      extractor.push([result('e1', '2026-11-26T08:00:02.000Z', false)])
      const mutations = extractor.drain().mutations
      expect(mutations).toEqual([expect.objectContaining({ mutationId: 'e1', path: 'Q:/P/a.ts',
        createdAt: Date.parse('2026-11-26T08:00:01.000Z') })])
      extractor.push([result('e1', '2026-11-26T08:00:03.000Z', false)])
      expect(extractor.drain().mutations).toEqual([])
    })

    it('drops an Edit whose tool_result in the next chunk is an error', () => {
      const extractor = sessionMutationExtractor('claude', 'session')
      extractor.push([prompt, edit('e1', '2026-11-26T08:00:01.000Z')])
      extractor.push([result('e1', '2026-11-26T08:00:02.000Z', true)])
      expect(extractor.drain().mutations).toEqual([])
    })

    it('drops an Edit issued before the first prompt, as the full parser does', () => {
      const content = [edit('early', '2026-11-26T07:59:00.000Z'), result('early', '2026-11-26T07:59:01.000Z', false),
        prompt, edit('late', '2026-11-26T08:00:01.000Z'), result('late', '2026-11-26T08:00:02.000Z', false)].join('\n')
      expect(extract('claude', 'session', content, 1).mutations.map((mutation) => mutation.mutationId)).toEqual(['late'])
      expect(fullSession('claude', content).mutations.map((mutation) => mutation.mutationId)).toEqual(['late'])
      expect(extract('claude', 'subagent', content, 1).mutations.map((mutation) => mutation.mutationId)).toEqual(['early', 'late'])
    })

    it('carries a pending Edit through a JSON round trip of the state', () => {
      const first = sessionMutationExtractor('claude', 'session')
      first.push([prompt, edit('e1', '2026-11-26T08:00:01.000Z')])
      const second = sessionMutationExtractor('claude', 'session', JSON.parse(JSON.stringify(first.state())))
      second.push([result('e1', '2026-11-26T08:00:02.000Z', false)])
      expect(second.drain().mutations.map((mutation) => mutation.mutationId)).toEqual(['e1'])
    })
  })

  describe('Codex', () => {
    const prompt = JSON.stringify({ timestamp: '2026-11-26T08:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Go' } })
    const patch = (callId: string, success: boolean, changes: Record<string, unknown>) => JSON.stringify({
      timestamp: '2026-11-26T08:00:01.000Z', type: 'event_msg',
      payload: { type: 'patch_apply_end', call_id: callId, success, changes } })

    it('takes no mutation from a failed patch_apply_end', () => {
      const extractor = sessionMutationExtractor('codex', 'session')
      extractor.push([prompt, patch('p1', false, { 'Q:/P/a.ts': { type: 'add', content: 'a' } })])
      expect(extractor.drain().mutations).toEqual([])
    })

    it('keeps the old path of a move as previousPath', () => {
      const extractor = sessionMutationExtractor('codex', 'session')
      extractor.push([prompt, patch('p1', true, { 'Q:/P/a.ts': { type: 'update', unified_diff: '@@', move_path: 'Q:/P/b.ts' } })])
      expect(extractor.drain().mutations).toEqual([expect.objectContaining({
        kind: 'move', path: 'Q:/P/b.ts', previousPath: 'Q:/P/a.ts' })])
    })

    it('drops a patch applied before the first prompt group', () => {
      const extractor = sessionMutationExtractor('codex', 'session')
      extractor.push([patch('early', true, { 'Q:/P/a.ts': { type: 'add', content: 'a' } })])
      extractor.push([prompt, patch('late', true, { 'Q:/P/b.ts': { type: 'add', content: 'b' } })])
      expect(extractor.drain().mutations.map((mutation) => mutation.mutationId)).toEqual(['late-0'])
    })

    it('opens a pending fallback prompt across a JSON round trip of the state', () => {
      const fallback = JSON.stringify({ timestamp: '2026-11-26T08:00:00.000Z', type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] } })
      const first = sessionMutationExtractor('codex', 'session')
      first.push([fallback])
      const second = sessionMutationExtractor('codex', 'session', JSON.parse(JSON.stringify(first.state())))
      second.push([patch('p1', true, { 'Q:/P/a.ts': { type: 'add', content: 'a' } })])
      expect(second.drain().mutations.map((mutation) => mutation.mutationId)).toEqual(['p1-0'])
    })
  })

  it('drops an Antigravity edit before the first user input', () => {
    expect(extract('antigravity', 'session', antigravityTranscript, 1).mutations.map((mutation) => mutation.path))
      .toEqual(['Q:/Project/app.ts', 'Q:/Project/b.ts'])
  })

  it('refuses a state of another agent and an Antigravity sub-agent', () => {
    const claude = sessionMutationExtractor('claude', 'session')
    expect(() => sessionMutationExtractor('codex', 'session', { ...claude.state() as object, fallback: 'x' })).toThrow()
    expect(() => sessionMutationExtractor('claude', 'session', { sequence: -1 })).toThrow()
    expect(() => sessionMutationExtractor('antigravity', 'subagent')).toThrow(/no sub-agent/)
  })
})
