import { describe, expect, it } from 'vitest'
import { RemoteTaskResults } from './remoteTaskResults'

describe('RemoteTaskResults', () => {
  const request = { kind: 'script', runId: 'run' } as const
  const value = { sessionId: 'session', request, result: { ok: true, value: { state: 'succeeded', source: 'log', lines: ['source'], terminal: null } } }
  it('accepts only the requested parent/run and known discriminants', () => {
    expect(RemoteTaskResults.parse('session', request, value)).toMatchObject({ ok: true, value: { lines: ['source'] } })
    for (const changed of [
      { ...value, sessionId: 'foreign' },
      { ...value, request: { ...request, runId: 'foreign' } },
      { ...value, result: { ok: true, value: { ...value.result.value, state: 'unknown' } } },
      { ...value, result: { ok: true, value: { ...value.result.value, source: 'controller' } } },
      { ...value, result: { ok: true, value: { ...value.result.value, terminal: { hostInstanceId: 'host', runtimeSessionId: 'run', generation: -1 } } } },
    ]) expect(() => RemoteTaskResults.parse('session', request, changed)).toThrow()
  })
  it('refuses foreign unchanged revisions and unknown transcript entry tags before publishing', () => {
    const request = { kind: 'transcript', subagentId: 'child', known: 'expected' } as const
    expect(() => RemoteTaskResults.parse('session', request, { sessionId: 'session', request, result: { ok: true, value: { kind: 'unchanged', revision: 'foreign' } } })).toThrow()
    expect(() => RemoteTaskResults.parse('session', request, { sessionId: 'session', request, result: { ok: true, value: { kind: 'transcript', revision: 'revision',
      header: { agentType: '', description: '', model: null, state: 'done', contextTokens: null }, entries: [{ kind: 'execute', command: 'bad' }], earlierStepsOmitted: false } } })).toThrow()
  })
})
