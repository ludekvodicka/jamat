export type RuntimeChannel = 'production' | 'development'

export interface ConfigIdentityDocument {
  schemaVersion: 1
  configIdentity: string
  runtimeChannel: RuntimeChannel
  createdAt: string
}
