import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionAutomationGroups as Groups, runCli } from '../../skills/codex/session-automation-groups/scripts/session-automation-groups.mjs'

const sessionId = '10000000-0000-4000-8000-000000000001'
const configIdentity = '20000000-0000-4000-8000-000000000001'
const request = { sessionId, configIdentity, channel: 'development', state: 'working', activeColor: 'magenta' }

function world() {
  const session = { sessionId, group: null, color: null, note: 'Ticket: #4\nWorktree: tree' }
  const calls = []
  const client = args => {
    calls.push(args)
    if (args[0] === 'status') return { ok: true, value: { identity: { configIdentity, runtimeChannel: 'development' } } }
    if (args[1] === 'list') return { ok: true, value: { sessions: [structuredClone(session)] } }
    session[args[1]] = args[5]
    return { ok: true, value: {} }
  }
  return { session, calls, client }
}

test('worker transitions work without a coordinator, preserve notes, and restore the active color on follow-up', () => {
  const w = world()
  for (const [state, group, color] of [
    ['working', 'automation', 'magenta'], ['waiting', 'waiting', 'orange'],
    ['working', 'automation', 'magenta'], ['waiting', 'waiting', 'orange'],
    ['completed', 'completed', 'green'], ['working', 'automation', 'magenta'],
    ['blocked', 'blocked', 'red'],
  ]) {
    assert.equal(Groups.apply(w.client, { ...request, state }).ok, true)
    assert.deepEqual([w.session.group, w.session.color], [group, color])
  }
  assert.equal(w.session.note, 'Ticket: #4\nWorktree: tree')
  assert.ok(w.calls.every(args => args[0] === 'status' || ['list', 'group', 'color'].includes(args[1])))
})

test('reconciliation changes no correct field, explicit note can replace or clear it', () => {
  const w = world()
  Groups.apply(w.client, request)
  assert.deepEqual(Groups.apply(w.client, request).value.changed, [])
  assert.deepEqual(Groups.apply(w.client, { ...request, note: '' }).value.changed, ['note'])
  assert.equal(w.session.note, '')
  w.session.note = null
  assert.deepEqual(Groups.apply(w.client, { ...request, note: '' }).value.changed, [])
})

test('partial failure is named and a retry repairs only the outstanding field', () => {
  const w = world()
  const result = Groups.apply(args => args[1] === 'color'
    ? { ok: false, error: { detail: 'unavailable' } } : w.client(args), request)
  assert.equal(result.ok, false)
  assert.deepEqual(result.error.changed, ['group'])
  assert.equal(result.error.observed.value.group, 'automation')
  assert.deepEqual(Groups.apply(w.client, request).value.changed, ['color'])
})

test('missing group fails before any other presentation change', () => {
  const w = world()
  const result = Groups.apply(args => args[1] === 'group'
    ? { ok: false, error: { detail: 'group missing' } } : w.client(args), request)
  assert.equal(result.ok, false)
  assert.deepEqual(result.error.changed, [])
  assert.equal(w.session.color, null)
})

test('wrong controller, unknown session and invalid identity cannot mutate a session', () => {
  for (const change of [{ configIdentity: sessionId }, { sessionId: configIdentity }, { sessionId: undefined }]) {
    const w = world()
    assert.equal(Groups.apply(w.client, { ...request, ...change }).ok, false)
    assert.equal(w.session.group, null)
  }
})

test('a claimed write must pass read-back; idle and ended are not semantic outcomes', () => {
  const w = world()
  assert.equal(Groups.apply(args => ['group', 'color'].includes(args[1])
    ? { ok: true, value: {} } : w.client(args), request).ok, false)
  for (const state of ['idle', 'ended', 'landed', 'unknown'])
    assert.throws(() => Groups.presentation(state), /Unknown automation state/)
})

test('describe is offline and CLI refuses unsafe or contradictory selectors before launching', () => {
  const launch = () => { throw new Error('must not launch') }
  assert.deepEqual(runCli(['describe', '--state', 'working'], {}, launch), { ok: true, value: { group: 'automation', color: 'blue' } })
  for (const args of [
    ['apply', '--self', '--state', 'completed'],
    ['apply', '--self', '--session-id', sessionId, '--state', 'working'],
    ['describe', '--state', 'working', '--state', 'waiting'],
    ['describe', '--state', 'completed', '--note', 'x'],
  ]) assert.equal(runCli(args, {}, launch).ok, false)
  const env = { JAMAT_V3_SESSION_ID: sessionId, JAMAT_V3_SESSION_CONTROLLER: configIdentity, JAMAT_V3_SESSION_CHANNEL: 'development' }
  assert.equal(runCli(['apply', '--self', '--state', 'working', '--channel', 'production'], env, launch).ok, false)
})
