import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexLaunchPermissions } from './codexLaunchPermissions'

for (const method of ['thread/start', 'thread/resume', 'thread/fork'])
  test(`YOLO replaces terminal permission defaults on the initial ${method}`, () => {
    const permissions = new CodexLaunchPermissions(true)
    const request = {id: 7, method, params: {
      threadId: 'parent', approvalPolicy: 'on-request', sandbox: 'workspace-write',
      permissions: 'workspace', model: 'model-one', config: {model_reasoning_effort: 'high'},
    }}
    assert.deepEqual(permissions.request(request), {id: 7, method, params: {
      threadId: 'parent', approvalPolicy: 'never', sandbox: 'danger-full-access',
      model: 'model-one', config: {model_reasoning_effort: 'high'},
    }})
    assert.equal(request.params.permissions, 'workspace')
    permissions.confirmed()
    if (method === 'thread/start')
      assert.deepEqual(permissions.request(request), {id: 7, method, params: {
        threadId: 'parent', approvalPolicy: 'never', sandbox: 'danger-full-access',
        model: 'model-one', config: {model_reasoning_effort: 'high'},
      }})
    else if (method === 'thread/resume' || method === 'thread/fork')
      assert.equal(permissions.request(request), request)
    else throw new Error(`Unknown test method: ${method}`)
  })

test('disabled YOLO preserves native permissions and absent launch settings', () => {
  const permissions = new CodexLaunchPermissions(false)
  const request = {id: 'first', method: 'thread/start', params: {approvalPolicy: 'on-request', sandbox: 'read-only'}}
  assert.equal(permissions.request(request), request)
})

test('native permission changes on later turns are preserved', () => {
  const permissions = new CodexLaunchPermissions(true)
  permissions.confirmed()
  const request = {id: 9, method: 'turn/start', params: {
    threadId: 'primary', approvalPolicy: 'on-request', sandboxPolicy: {type: 'readOnly'},
  }}
  assert.equal(permissions.request(request), request)
})

test('history, turns, notifications and invalid frames do not consume the launch choice', () => {
  const permissions = new CodexLaunchPermissions(true)
  for (const request of [null, [], 'text', {method: 'thread/start', params: {}},
    {id: 1, method: 'thread/start', params: null},
    {id: 2, method: 'thread/read', params: {threadId: 'history'}},
    {id: 'title', method: 'thread/start', params: {threadSource: 'thread_title', sandbox: 'read-only'}},
    {id: 3, method: 'turn/start', params: {threadId: 'child', approvalPolicy: 'on-request'}}])
    assert.equal(permissions.request(request), request)
  const request = {id: 4, method: 'thread/resume', params: {threadId: 'existing'}}
  const expected = {...request, params: {...request.params, approvalPolicy: 'never', sandbox: 'danger-full-access'}}
  assert.deepEqual(permissions.request(request), expected)
  assert.deepEqual(permissions.request({...request, id: 5}), {...expected, id: 5})
})
