import { expect, it, vi } from 'vitest'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { RemoteSidebarPorts } from './remoteSidebarPorts'

it('retains an import operation ID across a lost reply and replacement view', async () => {
  const sessionId = 'source-import-retry'
  let lost = true
  const requestSidebar = vi.fn(async (_endpoint, _view, request) => {
    if (lost) return { ok: false, error: 'Response lost' }
    const bytes = new TextEncoder().encode(JSON.stringify({ sessionId, request, result: { ok: true, value: { kind: 'taken', notes: [{ text: 'Source prompt' }], index: 0 } } }))
    return { ok: true, value: { ok: true, value: { transferId: 'transfer', version: 'v', offset: 0, totalBytes: bytes.length, base64: btoa(String.fromCharCode(...bytes)) } } }
  })
  const bridge = { requestSidebar } as unknown as AppClientUiBridge['remote']
  const view = { sessionId, viewId: 'view', viewerId: 'window', epoch: 'epoch' }
  const first = new RemoteSidebarPorts('peer', sessionId, async () => view, bridge)
  expect((await first.notes.importPrompt(sessionId)).ok).toBe(false)
  first.close()
  lost = false
  const second = new RemoteSidebarPorts('peer', sessionId, async () => ({ ...view, viewId: 'replacement' }), bridge)
  expect(await second.notes.importPrompt(sessionId)).toMatchObject({ ok: true, value: { kind: 'taken' } })
  expect(requestSidebar.mock.calls[1][2].operationId).toBe(requestSidebar.mock.calls[0][2].operationId)
  await second.notes.importPrompt(sessionId)
  expect(requestSidebar.mock.calls[2][2].operationId).not.toBe(requestSidebar.mock.calls[0][2].operationId)
  second.close()
})
