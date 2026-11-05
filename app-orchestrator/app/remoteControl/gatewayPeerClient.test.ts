import { afterEach, expect, it } from 'vitest'
import { ProcessCalls } from '../../../lib-orchestrator/shared/processCalls'
import { GatewayPeerClient } from './gatewayPeerClient'

const ports: ProcessCalls[] = []
afterEach(() => { for (const port of ports.splice(0)) port.close() })

it('waits for gateway revocation and flushes only after ordered final events and stop acknowledgement', async () => {
  let acknowledge!: () => void, main!: ProcessCalls, client!: GatewayPeerClient
  const wait = new Promise<void>(resolve => { acknowledge = resolve }), order: string[] = [], requests: string[] = []
  const gateway = new ProcessCalls({ send: message => main.receive(structuredClone(message)),
    invoke: async (_target, method) => {
      requests.push(method)
      if (method === 'revoke') await wait
      else if (method === 'stop') gateway.emit('peer-work', 'audit', { at: 123 })
      else if (method !== 'initialize') throw new Error(`Unexpected request: ${method}`)
    }, event: () => {}, report: () => {} })
  main = new ProcessCalls({ send: message => gateway.receive(structuredClone(message)), invoke: async () => {},
    event: (target, name, value) => {
      if (target === 'peers') client.event(name, value)
      else if (target === 'peer-work') order.push(name)
      else throw new Error(`Unknown fixture target: ${target}`)
    }, report: () => {} })
  ports.push(gateway, main)
  client = new GatewayPeerClient(main, () => order.push('changed'), () => order.push('flush'))
  await client.initialize({ identity: {} as never, privateKey: 'private', trust: [], bundleText: null })
  gateway.emit('peers', 'state', { listener: { status: 'disabled' }, inbound: [] })
  expect(client.snapshot()).toEqual([])
  let revoked = false
  const revoke = client.closeEndpoint('computer', 'endpoint').then(() => { revoked = true })
  await Promise.resolve(); expect(revoked).toBe(false)
  acknowledge(); await revoke
  await Promise.all([client.stop(), client.stop()])
  expect(requests).toEqual(['initialize', 'revoke', 'stop'])
  expect(order).toEqual(['changed', 'audit', 'flush'])
})
