import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClientStatePaths } from './clientStatePaths'

describe('app-client-ui/app/clientState/clientStatePaths', () => {
  const rootOverride = join(tmpdir(), 'jamat-v3-state-root')
  const identity = '3f6a2c1e-0b7d-4a5f-9c11-4d2e6b8a0f31'
  let previousOverride: string | undefined

  beforeEach(() => {
    previousOverride = process.env.JAMAT_V3_LOCAL_STATE_DIR
    process.env.JAMAT_V3_LOCAL_STATE_DIR = rootOverride
  })

  afterEach(() => {
    if (previousOverride === undefined)
      delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else
      process.env.JAMAT_V3_LOCAL_STATE_DIR = previousOverride
  })

  it('treats the override as the state root, not as one channel directory', () => {
    expect(ClientStatePaths.machineRoot()).toBe(rootOverride)
    expect(ClientStatePaths.directory(identity, 'development'))
      .toBe(join(rootOverride, 'client-ui', identity, 'development'))
  })

  it('keeps two channels in two directories', () => {
    expect(ClientStatePaths.directory(identity, 'development'))
      .not.toBe(ClientStatePaths.directory(identity, 'production'))
  })

  // The Host owns `host/` under the same machine root; the two subtrees must never overlap.
  it('stays disjoint from the host subtree', () => {
    const directory = ClientStatePaths.directory(identity, 'production')
    expect(directory).not.toBe(join(rootOverride, 'host', identity, 'production'))
    expect(directory.startsWith(join(rootOverride, 'client-ui'))).toBe(true)
  })

  it('puts state, snapshots and control files inside the channel directory', () => {
    const directory = ClientStatePaths.directory(identity, 'development')
    expect(ClientStatePaths.stateFile(identity, 'development'))
      .toBe(join(directory, 'client-state.json'))
    expect(ClientStatePaths.snapshotsDirectory(identity, 'development'))
      .toBe(join(directory, 'snapshots'))
    expect(ClientStatePaths.controlDescriptorFile(identity, 'development'))
      .toBe(join(directory, 'remote-control.json'))
    expect(ClientStatePaths.controlInstanceDescriptorFile(
      identity,
      'development',
      'instance-1',
      1_000,
    )).toBe(join(directory, 'control-descriptors', '1000-instance-1.json'))
    expect(ClientStatePaths.controlAuditFile(identity, 'development'))
      .toBe(join(directory, 'remote-control-audit.jsonl'))
    expect(ClientStatePaths.remoteEndpointIdentityFile(identity, 'development'))
      .toBe(join(directory, 'remote-endpoint.json'))
  })

  it('shares one reMarkable tool root across profiles and channels', () => {
    expect(ClientStatePaths.toolsDirectory()).toBe(join(rootOverride, 'tools'))
    expect(ClientStatePaths.remarkableToolsDirectory())
      .toBe(join(rootOverride, 'tools', 'remarkable'))
  })

  it('keeps reMarkable credentials, runs and imports inside one profile and channel', () => {
    const directory = join(
      ClientStatePaths.directory(identity, 'development'),
      'remarkable',
    )
    expect(ClientStatePaths.remarkableDirectory(identity, 'development')).toBe(directory)
    expect(ClientStatePaths.remarkableCredentialFile(identity, 'development'))
      .toBe(join(directory, 'credential.json'))
    expect(ClientStatePaths.remarkableRunsDirectory(identity, 'development'))
      .toBe(join(directory, 'runs'))
    expect(ClientStatePaths.remarkableImportsDirectory(identity, 'development'))
      .toBe(join(directory, 'imports'))
    expect(ClientStatePaths.remarkableDirectory(identity, 'development'))
      .not.toBe(ClientStatePaths.remarkableDirectory(identity, 'production'))
    expect(ClientStatePaths.remarkableDirectory(identity, 'development'))
      .not.toBe(ClientStatePaths.remarkableDirectory(`${identity}-other`, 'development'))
  })

  it('keeps one remote machine identity outside every config identity and channel', () => {
    const machineDirectory = join(rootOverride, 'remote-control')
    expect(ClientStatePaths.remoteControlMachineDirectory()).toBe(machineDirectory)
    expect(ClientStatePaths.remoteMachineIdentityFile())
      .toBe(join(machineDirectory, 'machine-identity.json'))
    expect(ClientStatePaths.remotePeerCredentialsFile())
      .toBe(join(machineDirectory, 'peer-credentials.json'))
  })
})
