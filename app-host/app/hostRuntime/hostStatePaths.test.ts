import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostStatePaths } from './hostStatePaths.js'

describe('app-host/app/hostRuntime/hostStatePaths', () => {
  const saved = {
    localState: process.env.JAMAT_V3_LOCAL_STATE_DIR,
    hostState: process.env.JAMAT_V3_HOST_STATE_DIR,
  }

  beforeEach(() => {
    delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    delete process.env.JAMAT_V3_HOST_STATE_DIR
  })

  afterEach(() => {
    restore('JAMAT_V3_LOCAL_STATE_DIR', saved.localState)
    restore('JAMAT_V3_HOST_STATE_DIR', saved.hostState)
  })

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  // The separate root is what keeps a V3 Host from contending for a V2 Host's lock.
  it('roots machine state at jamat-v3', () => {
    expect(HostStatePaths.machineRoot().endsWith('jamat-v3')).toBe(true)
  })

  it('lets JAMAT_V3_LOCAL_STATE_DIR replace the root', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(HostStatePaths.machineRoot()).toBe(join('C:', 'tmp', 'state-root'))
  })

  it('puts each channel in its own directory under the host scope', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(HostStatePaths.directory('identity-a', 'production')).toBe(
      join('C:', 'tmp', 'state-root', 'host', 'identity-a', 'production'),
    )
    expect(HostStatePaths.directory('identity-a', 'development')).toBe(
      join('C:', 'tmp', 'state-root', 'host', 'identity-a', 'development'),
    )
  })

  // An override that named one channel's directory would collapse both channels into it, and the
  // second Host could then never take its own lock.
  it('treats JAMAT_V3_HOST_STATE_DIR as the scope root, not one channel directory', () => {
    process.env.JAMAT_V3_HOST_STATE_DIR = join('C:', 'tmp', 'host-scope')
    expect(HostStatePaths.directory('identity-a', 'production')).toBe(
      join('C:', 'tmp', 'host-scope', 'identity-a', 'production'),
    )
    expect(HostStatePaths.directory('identity-a', 'production'))
      .not.toBe(HostStatePaths.directory('identity-a', 'development'))
  })

  it('derives every host file from the channel directory', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    const directory = HostStatePaths.directory('identity-a', 'production')
    expect(HostStatePaths.descriptor('identity-a', 'production'))
      .toBe(join(directory, 'descriptor.json'))
    expect(HostStatePaths.lock('identity-a', 'production'))
      .toBe(join(directory, 'host.lock'))
    expect(HostStatePaths.registry('identity-a', 'production'))
      .toBe(join(directory, 'host-state.json'))
    expect(HostStatePaths.log('identity-a', 'production'))
      .toBe(join(directory, 'host.log.jsonl'))
  })
})
