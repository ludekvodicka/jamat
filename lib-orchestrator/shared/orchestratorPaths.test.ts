import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OrchestratorPaths } from './orchestratorPaths'

describe('lib-orchestrator/shared/orchestratorPaths', () => {
  const saved = process.env.JAMAT_V3_LOCAL_STATE_DIR

  beforeEach(() => {
    delete process.env.JAMAT_V3_LOCAL_STATE_DIR
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
    else process.env.JAMAT_V3_LOCAL_STATE_DIR = saved
  })

  it('roots machine state at jamat-v3', () => {
    expect(OrchestratorPaths.machineRoot().endsWith('jamat-v3')).toBe(true)
  })

  it('lets JAMAT_V3_LOCAL_STATE_DIR replace the root', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(OrchestratorPaths.machineRoot()).toBe(join('C:', 'tmp', 'state-root'))
  })

  it('keeps the default machine root independent of the state override', () => {
    const defaultRoot = OrchestratorPaths.defaultMachineRoot()
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')

    expect(OrchestratorPaths.defaultMachineRoot()).toBe(defaultRoot)
    expect(OrchestratorPaths.defaultMachineRoot()).not.toBe(OrchestratorPaths.machineRoot())
  })

  // The Host writes under host/ and the client under client-ui/ in the same root; a shared segment
  // would let one subsystem's cleanup reach another's files.
  it('scopes under orchestrator/, disjoint from the host and client-ui scopes', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    const root = OrchestratorPaths.machineRoot()
    const directory = OrchestratorPaths.directory('identity-a', 'production')
    expect(directory).toBe(join(root, 'orchestrator', 'identity-a', 'production'))
    expect(directory.startsWith(join(root, 'host'))).toBe(false)
    expect(directory.startsWith(join(root, 'client-ui'))).toBe(false)
  })

  it('puts each channel in its own directory', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(OrchestratorPaths.directory('identity-a', 'production'))
      .not.toBe(OrchestratorPaths.directory('identity-a', 'development'))
  })

  it('derives every orchestrator path from the channel directory', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    const directory = OrchestratorPaths.directory('identity-a', 'production')
    expect(OrchestratorPaths.relocationJournalsDirectory('identity-a', 'production'))
      .toBe(join(directory, 'project-relocations'))
    expect(OrchestratorPaths.relocationLeftoversFile('identity-a', 'production'))
      .toBe(join(directory, 'relocation-leftovers.json'))
    expect(OrchestratorPaths.configSnapshotsDirectory('identity-a', 'production'))
      .toBe(join(directory, 'config-snapshots'))
    expect(OrchestratorPaths.sessionRecordsFile('identity-a', 'production'))
      .toBe(join(directory, 'session-records.json'))
    expect(OrchestratorPaths.sessionSnapshotsDirectory('identity-a', 'production'))
      .toBe(join(directory, 'session-snapshots'))
    expect(OrchestratorPaths.sessionNumbersFile('identity-a', 'production'))
      .toBe(join(directory, 'session-numbers.json'))
    expect(OrchestratorPaths.codexRolloutCwdFile('identity-a', 'production'))
      .toBe(join(directory, 'codex-rollout-cwd.json'))
    expect(OrchestratorPaths.rateMonitorCacheFile('identity-a', 'production'))
      .toBe(join(directory, 'rate-monitor-cache.json'))
  })

  // One file, one latch. A counter sharing the records file would be lost to the records' damage,
  // and the records are rewritten on every reconcile tick while this one is written once a session.
  it('keeps the session numbers in their own file, apart from the records', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(OrchestratorPaths.sessionNumbersFile('identity-a', 'production'))
      .not.toBe(OrchestratorPaths.sessionRecordsFile('identity-a', 'production'))
  })

  // The two rings rotate on different cadences, so one must never be able to delete the other's
  // recovery points.
  it('keeps the session snapshots apart from the config snapshots', () => {
    process.env.JAMAT_V3_LOCAL_STATE_DIR = join('C:', 'tmp', 'state-root')
    expect(OrchestratorPaths.sessionSnapshotsDirectory('identity-a', 'production'))
      .not.toBe(OrchestratorPaths.configSnapshotsDirectory('identity-a', 'production'))
  })
})
