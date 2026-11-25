import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionAutomationGroups as Groups, runCli } from '../../skills/codex/session-automation-groups/scripts/session-automation-groups.mjs'

const sessionId = '10000000-0000-4000-8000-000000000001'
const configIdentity = '20000000-0000-4000-8000-000000000001'
const request = { sessionId, configIdentity, channel: 'development', state: 'working', activeColor: 'magenta' }
const selfEnv = { JAMAT_V3_SESSION_ID: sessionId, JAMAT_V3_SESSION_CONTROLLER: configIdentity, JAMAT_V3_SESSION_CHANNEL: 'development' }

function world() {
  const session = { sessionId, group: 'automation', color: 'magenta', note: 'Ticket: #4\nWorktree: tree' }
  const calls = []
  const client = args => {
    calls.push(args)
    if (args[0] === 'status') return { ok: true, value: { identity: { configIdentity, runtimeChannel: 'development' } } }
    if (args[1] === 'list') return { ok: true, value: { sessions: [structuredClone(session)] } }
    if (args[1] === 'automation' && args[4] === '--state') session.automationState = args[5]
    else if (args[1] === 'note' && args[4] === '--note') session.note = args[5]
    else return { ok: false, error: { detail: `unexpected write ${args.join(' ')}` } }
    return { ok: true, value: {} }
  }
  return { session, calls, client }
}
const writes = calls => calls.filter(args => args[0] !== 'status' && args[1] !== 'list').map(args => args[1])

test('worker transitions write only the state and preserve the note, group and color', () => {
  const w = world()
  for (const state of ['working', 'waiting', 'working', 'waiting', 'completed', 'working', 'blocked']) {
    assert.equal(Groups.apply(w.client, { ...request, state }).ok, true)
    assert.equal(w.session.automationState, state)
  }
  assert.deepEqual([w.session.group, w.session.color], ['automation', 'magenta'])
  assert.equal(w.session.note, 'Ticket: #4\nWorktree: tree')
  assert.ok(writes(w.calls).every(verb => verb === 'automation'))
})

test('waiting on a working session changes only automationState; repeating it changes nothing', () => {
  const w = world()
  w.session.automationState = 'working'
  const result = Groups.apply(w.client, { ...request, state: 'waiting' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value, { sessionId, state: 'waiting', automationState: 'waiting', changed: ['automationState'] })
  assert.deepEqual(writes(w.calls), ['automation'])
  assert.deepEqual(w.calls.find(args => args[1] === 'automation').slice(0, 6),
    ['sessions', 'automation', '--session-id', sessionId, '--state', 'waiting'])
  assert.deepEqual(Groups.apply(w.client, { ...request, state: 'waiting' }).value.changed, [])
  assert.deepEqual(writes(w.calls), ['automation'])
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

test('a note file with a final newline is written and read back trimmed, as the store keeps it', () => {
  const w = world()
  const client = args => args[1] === 'note' ? w.client([...args.slice(0, 5), args[5].trim()]) : w.client(args)
  const result = Groups.apply(client, { ...request, note: 'Waiting: approve the plan\r\n' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(w.session.note, 'Waiting: approve the plan')
  assert.deepEqual(result.value.changed, ['automationState', 'note'])
  assert.deepEqual(Groups.apply(client, { ...request, note: 'Waiting: approve the plan\n' }).value.changed, [])
})

test('partial failure is named and a retry repairs only the outstanding field', () => {
  const w = world()
  const blocked = { ...request, state: 'blocked', note: 'Blocked: no access' }
  const result = Groups.apply(args => args[1] === 'note'
    ? { ok: false, error: { detail: 'unavailable' } } : w.client(args), blocked)
  assert.equal(result.ok, false)
  assert.deepEqual(result.error.changed, ['automationState'])
  assert.equal(result.error.failedField, 'note')
  assert.equal(result.error.observed.value.automationState, 'blocked')
  assert.deepEqual(Groups.apply(w.client, blocked).value.changed, ['note'])
})

test('a failed sessions automation fails before the note is replaced', () => {
  const w = world()
  const result = Groups.apply(args => args[1] === 'automation'
    ? { ok: false, error: { detail: 'sessions.automation is unavailable' } } : w.client(args), { ...request, note: 'new' })
  assert.equal(result.ok, false)
  assert.equal(result.error.failedField, 'automationState')
  assert.deepEqual(result.error.changed, [])
  assert.equal(w.session.note, 'Ticket: #4\nWorktree: tree')
  assert.deepEqual(writes(w.calls), [])
})

test('wrong controller, unknown session and invalid identity cannot mutate a session', () => {
  for (const change of [{ configIdentity: sessionId }, { sessionId: configIdentity }, { sessionId: undefined }]) {
    const w = world()
    assert.equal(Groups.apply(w.client, { ...request, ...change }).ok, false)
    assert.equal(w.session.automationState, undefined)
  }
})

test('a claimed write must pass read-back; idle and ended are not semantic outcomes', () => {
  const w = world()
  assert.equal(Groups.apply(args => args[1] === 'automation'
    ? { ok: true, value: {} } : w.client(args), request).ok, false)
  for (const state of ['idle', 'ended', 'landed', 'unknown'])
    assert.throws(() => Groups.presentation(state), /Unknown automation state/)
})

test('an unknown state is refused before any CLI call', () => {
  const launch = () => { throw new Error('must not launch') }
  for (const state of ['idle', 'automation', 'done']) {
    const result = runCli(['apply', '--self', '--state', state], selfEnv, launch)
    assert.equal(result.ok, false)
    assert.match(result.error.detail, /Unknown automation state/)
  }
  const w = world()
  assert.throws(() => Groups.apply(w.client, { ...request, state: 'idle' }), /Unknown automation state/)
  assert.deepEqual(w.calls, [])
})

test('describe answers the state and the active color', () => {
  const launch = () => { throw new Error('must not launch') }
  assert.deepEqual(runCli(['describe', '--state', 'working'], {}, launch),
    { ok: true, value: { state: 'working', color: 'blue' } })
  assert.deepEqual(runCli(['describe', '--state', 'blocked', '--active-color', 'magenta'], {}, launch),
    { ok: true, value: { state: 'blocked', color: 'magenta' } })
  assert.equal(runCli(['describe', '--state', 'working', '--active-color', 'purple'], {}, launch).ok, false)
})

test('describe is offline and CLI refuses unsafe or contradictory selectors before launching', () => {
  const launch = () => { throw new Error('must not launch') }
  for (const args of [
    ['apply', '--self', '--state', 'completed'],
    ['apply', '--self', '--session-id', sessionId, '--state', 'working'],
    ['describe', '--state', 'working', '--state', 'waiting'],
    ['describe', '--state', 'completed', '--note', 'x'],
  ]) assert.equal(runCli(args, {}, launch).ok, false)
  assert.equal(runCli(['apply', '--self', '--state', 'working', '--channel', 'production'], selfEnv, launch).ok, false)
})

test('apply --self writes the state and the note through the CLI wrapper and leaves group and color', () => {
  const w = world()
  const launched = []
  const launch = (_node, [wrapper, ...args]) => {
    launched.push(wrapper)
    assert.deepEqual(args.slice(-4), ['--config-identity', configIdentity, '--channel', 'development'])
    const envelope = w.client(args.slice(0, -4))
    return { status: envelope.ok ? 0 : 2, stdout: JSON.stringify(envelope) }
  }
  const result = runCli(['apply', '--self', '--state', 'waiting', '--note', 'Waiting: review', '--jamat-cli', 'stub.mjs'],
    selfEnv, launch)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value.changed, ['automationState', 'note'])
  assert.ok(launched.every(wrapper => wrapper === 'stub.mjs'))
  assert.deepEqual([w.session.automationState, w.session.group, w.session.color, w.session.note],
    ['waiting', 'automation', 'magenta', 'Waiting: review'])
})
