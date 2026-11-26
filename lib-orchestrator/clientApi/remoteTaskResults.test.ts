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

  it('accepts a service script run in task listings and refuses unknown script ids', () => {
    const listRequest = { kind: 'list' } as const
    const run = (scriptId: string) => ({
      runId: 'svc-1', phase: 'inner', scriptId, name: 'dev', title: 'dev', state: 'running',
      summary: 'dev', startedAt: 100, commands: [], row: true, log: 'none',
    })
    const envelope = (scriptId: string) => ({
      sessionId: 'session',
      request: listRequest,
      result: { ok: true, value: { listing: { kind: 'tasks', olderFinished: 0, catchingUp: false, rows: [] }, scripts: { runs: [run(scriptId)] } } },
    })
    expect(RemoteTaskResults.parse('session', listRequest, envelope('service'))).toMatchObject({
      ok: true,
      value: { scripts: { runs: [{ runId: 'svc-1', scriptId: 'service' }] } },
    })
    expect(() => RemoteTaskResults.parse('session', listRequest, envelope('other'))).toThrow()
  })

  it('accepts an optional string stateWord on script output and refuses a non-string one', () => {
    const withWord = { ...value, result: { ok: true, value: { ...value.result.value, state: 'failed', stateWord: 'Exited' } } }
    expect(RemoteTaskResults.parse('session', request, withWord)).toMatchObject({
      ok: true,
      value: { state: 'failed', stateWord: 'Exited' },
    })
    const badWord = { ...value, result: { ok: true, value: { ...value.result.value, stateWord: 42 } } }
    expect(() => RemoteTaskResults.parse('session', request, badWord)).toThrow()
  })

  it('accepts optional runs on shell rows and refuses unknown values', () => {
    const listRequest = { kind: 'list' } as const
    const envelope = (runs?: unknown) => ({
      sessionId: 'session',
      request: listRequest,
      result: { ok: true, value: {
        listing: { kind: 'tasks', olderFinished: 0, catchingUp: false, rows: [
          { kind: 'shell', shellId: 'b1', command: 'codex exec x', description: null, state: 'running', startedAt: 10, endedAt: null, ...(runs === undefined ? {} : { runs }) },
        ] },
        scripts: null,
      } },
    })
    expect(RemoteTaskResults.parse('session', listRequest, envelope('agent'))).toMatchObject({
      ok: true, value: { listing: { rows: [{ shellId: 'b1', runs: 'agent' }] } },
    })
    expect(RemoteTaskResults.parse('session', listRequest, envelope('command'))).toMatchObject({
      ok: true, value: { listing: { rows: [{ shellId: 'b1', runs: 'command' }] } },
    })
    expect(RemoteTaskResults.parse('session', listRequest, envelope())).toMatchObject({
      ok: true, value: { listing: { rows: [{ shellId: 'b1' }] } },
    })
    expect(() => RemoteTaskResults.parse('session', listRequest, envelope('other'))).toThrow()
  })
})
