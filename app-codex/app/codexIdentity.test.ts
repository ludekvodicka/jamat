import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodexSessionLaunch } from '../../lib-orchestrator/sessionManager/codexSessionIdentity'
import { CodexIdentity } from './codexIdentity'

const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const child = '33333333-3333-4333-8333-333333333333'
const launch: CodexSessionLaunch = {
  schemaVersion: 1, jamatSessionId: 'jamat', launchId: 'launch', mode: 'new', cwd: '/work',
  receiptFile: '/identity',
  client: {command: 'codex', prefixArgs: [], args: []},
  server: {command: 'codex', prefixArgs: [], args: ['app-server']},
}
const reply = (id: number, threadId: string, more: object = {}) => ({
  id, result: {thread: {id: threadId, source: 'vscode', parentThreadId: null, ...more}},
})

test('binds only the response to the native terminal request, not background history or notifications', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/start', params: {}})
  identity.sent({id: 2, method: 'thread/read', params: {threadId: second}})
  assert.equal(identity.received(reply(2, second)), null)
  assert.equal(identity.received({method: 'thread/started', params: {thread: {id: child}}}), null)
  assert.equal(identity.received(reply(99, child)), null)
  assert.deepEqual(identity.received(reply(1, first)), {
    schemaVersion: 1, jamatSessionId: 'jamat', launchId: 'launch', nativeSessionId: first, sequence: 1,
  })
})

test('independent terminals can use the same RPC request ID without sharing identities', () => {
  const a = new CodexIdentity(launch)
  const b = new CodexIdentity({...launch, jamatSessionId: 'other', launchId: 'other-launch'})
  for (const identity of [a, b]) identity.sent({id: 1, method: 'thread/start', params: {}})
  assert.equal(a.received(reply(1, first))?.nativeSessionId, first)
  assert.equal(b.received(reply(1, second))?.nativeSessionId, second)
})

test('fork uses its own thread.id even when sessionId is the parent tree ID', () => {
  const identity = new CodexIdentity({...launch, mode: 'fork', forkParentId: first})
  identity.sent({id: 1, method: 'thread/fork', params: {threadId: first}})
  assert.equal(identity.received(reply(1, second, {forkedFromId: first, sessionId: first}))?.nativeSessionId, second)
})

test('refuses a resume response that names another conversation', () => {
  const identity = new CodexIdentity({...launch, mode: 'resume', nativeSessionId: first})
  identity.sent({id: 1, method: 'thread/resume', params: {threadId: first}})
  assert.throws(() => identity.received(reply(1, second)), /different thread/)
})

test('refuses an initial operation inconsistent with the Jamat launch', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/resume', params: {threadId: second}})
  assert.throws(() => identity.received(reply(1, second)), /requested new thread/)
})

test('child browsing cannot replace the primary identity', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/start', params: {}})
  identity.received(reply(1, first))
  identity.sent({id: 2, method: 'thread/resume', params: {threadId: child}})
  assert.equal(identity.received(reply(2, child, {source: {subAgent: {thread_spawn: {parent_thread_id: first}}}})), null)
  identity.sent({id: 3, method: 'thread/resume', params: {threadId: child}})
  assert.equal(identity.received(reply(3, child, {threadSource: 'subagent', parentThreadId: first})), null)
})

test('clear/new updates the identity and a late prior response cannot restore the old thread', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/start', params: {}})
  identity.received(reply(1, first))
  identity.sent({id: 2, method: 'thread/resume', params: {threadId: first}})
  identity.sent({id: 3, method: 'thread/start', params: {sessionStartSource: 'clear'}})
  assert.equal(identity.received(reply(3, second))?.nativeSessionId, second)
  assert.equal(identity.received(reply(2, first)), null)
})

test('an error yields no identity and its later duplicate cannot bind', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/start', params: {}})
  assert.equal(identity.received({id: 1, error: {message: 'failed'}}), null)
  assert.equal(identity.received(reply(1, first)), null)
})

test('missing identity and duplicate pending request IDs fail explicitly', () => {
  const identity = new CodexIdentity(launch)
  identity.sent({id: 1, method: 'thread/start', params: {}})
  assert.throws(() => identity.sent({id: 1, method: 'thread/start', params: {}}), /Duplicate/)
  assert.throws(() => identity.received({id: 1, result: {}}), /valid thread.id/)
})
