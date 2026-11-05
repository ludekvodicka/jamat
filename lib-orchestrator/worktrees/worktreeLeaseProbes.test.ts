import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as { file: string; options: { cwd?: string } }[])
vi.mock('node:child_process', async (actual) => ({
  ...await actual<typeof import('node:child_process')>(),
  execFile: vi.fn((file: string, _args: string[], options: { cwd?: string }, done: (error: Error | null, stdout: string) => void) => {
    calls.push({ file, options })
    done(null, file === 'powershell.exe' && calls.length === 2 ? '[1,2]' : '638900000000000000')
  }),
}))

const { WorktreeLease } = await import('./worktreeLease')

// Jamat 098: an orphaned birth probe kept its inherited cwd inside the worktree, and the removal failed with EPERM.
describe.skipIf(process.platform === 'linux')('WorktreeLease process probes', () => {
  it('start every process probe in the OS temp directory, never in the caller directory', async () => {
    await WorktreeLease['birth'](process.pid)
    await WorktreeLease['machineSvnProcesses']()
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.options.cwd).toBe(tmpdir())
  })
})
