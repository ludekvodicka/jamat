import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostDescriptorPaths } from './hostDescriptorPaths'

describe('lib-orchestrator/hostClient/hostDescriptorPaths', () => {
  const savedStateRoot = process.env.JAMAT_V3_LOCAL_STATE_DIR
  const savedHostRoot = process.env.JAMAT_V3_HOST_STATE_DIR

  beforeEach(() => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    delete process.env.JAMAT_V3_HOST_STATE_DIR
  })

  afterEach(() => {
    if (savedStateRoot === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = savedStateRoot
    if (savedHostRoot === undefined) delete process.env.JAMAT_V3_HOST_STATE_DIR
    else process.env.JAMAT_V3_HOST_STATE_DIR = savedHostRoot
  })

  // The literal shape is the mirror: app-host's HostStatePaths.descriptor() writes exactly this, and
  // a client that computes anything else reads a file no Host ever publishes.
  it('reads the Host scope of the machine root, one directory per channel', () => {
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'production'))
      .toBe(join('C:', 'tmp', 'state-root', 'host', 'identity-a', 'production', 'descriptor.json'))
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'development'))
      .toBe(join('C:', 'tmp', 'state-root', 'host', 'identity-a', 'development', 'descriptor.json'))
  })

  it('stays out of the orchestrator scope its own library writes in', () => {
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'production'))
      .not.toContain(join('state-root', 'orchestrator'))
  })

  // Consuming the override verbatim as one channel's directory is what collapses both channels onto
  // a single descriptor, which is how a client ends up driving the other channel's Host.
  it('lets JAMAT_V3_HOST_STATE_DIR replace the scope root, never one channel directory', () => {
    process.env.JAMAT_V3_HOST_STATE_DIR = join('D:', 'hosts')
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'production'))
      .toBe(join('D:', 'hosts', 'identity-a', 'production', 'descriptor.json'))
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'development'))
      .toBe(join('D:', 'hosts', 'identity-a', 'development', 'descriptor.json'))
  })

  it('keeps two config identities apart under the same override', () => {
    process.env.JAMAT_V3_HOST_STATE_DIR = join('D:', 'hosts')
    expect(HostDescriptorPaths.descriptorFile('identity-a', 'production'))
      .not.toBe(HostDescriptorPaths.descriptorFile('identity-b', 'production'))
  })
})
