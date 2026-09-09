import type { RuntimeChannel } from '../wire/hostWire.js'

export interface ConfigIdentityDocument {
  schemaVersion: 1
  configIdentity: string
  runtimeChannel: RuntimeChannel
  createdAt: string
}
