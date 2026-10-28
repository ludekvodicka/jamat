import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords } from './finishTestRecords'
import { DispositionStep } from './dispositionStep'

describe('DispositionStep', () => {
  async function fixture() {
    const h = await finishTestRecords({ step: 'disposing', verified: [{ root: 'root', revision: 487, paths: ['worker'], at: 1 }], checkBaseline: { lock: 'baseline' } })
    let left = ['lock']
    const svn: ConstructorParameters<typeof DispositionStep>[1] = { changes: async () => ({ ok: true, value: left.map((path) => ({ path, conflict: false, kind: 'item' })) }),
      revertSetup: vi.fn(async () => { left = []; return { ok: true as const, value: undefined } }) }
    return { ...h, svn, step: new DispositionStep(h.records, svn), left: (paths: string[]) => { left = paths } }
  }

  it('disposes proven setup/check changes before issuing the clean permit and stopping', async () => {
    const h = await fixture()
    expect(await h.step.run('worker', '/saved')).toMatchObject({ kind: 'clean', allowed: ['lock'] })
    expect(h.svn.revertSetup).toHaveBeenCalledWith(expect.any(String), ['lock'], { lock: 'baseline' }, expect.stringContaining('setup'))
    expect(h.records.get('worker')?.worktreeLifecycle?.step).toBe('stopping-worker')
  })

  it('keeps the worker and files when the guarded revert preserves later user edits or a directory', async () => {
    const h = await fixture()
    h.svn.revertSetup = async () => ({ ok: true, value: undefined })
    expect(await h.step.run('worker', '/saved')).toBeNull()
    expect(h.records.get('worker')?.worktreeLifecycle).toMatchObject({ wait: { kind: 'removal-blocked' }, facts: { worker: { liveness: 'alive' } } })
  })

  it('keep-worktree ends dispositions without reverting or stopping the worker', async () => {
    const h = await fixture()
    expect(await h.step.run('worker', '/saved', true)).toBeNull()
    expect(h.svn.revertSetup).not.toHaveBeenCalled()
    expect(h.records.get('worker')?.worktreeLifecycle?.phase).toBe('kept')
  })
})
