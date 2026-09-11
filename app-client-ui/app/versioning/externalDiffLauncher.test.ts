import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileChangesBaselineContentResult } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { CommandInvoker } from '../../../lib-orchestrator/shared/commandInvoker'
import { ExternalDiffLauncher } from './externalDiffLauncher'

describe('app-client-ui/app/versioning/externalDiffLauncher', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function fixture(argumentTemplate = '/base:"$1" /mine:"$2" "%bname" "%yname" "two words"') {
    const root = await mkdtemp(join(tmpdir(), 'jamat-external-diff-test-'))
    roots.push(root)
    const mine = join(root, 'working $1 %base file.txt')
    await writeFile(mine, 'mine', 'utf8')
    let close: () => void = () => {}
    const closed = new Promise<void>((resolve) => { close = resolve })
    const launchInteractive = vi.fn<CommandInvoker['launchInteractive']>(async () => ({ ok: true, closed }))
    const readBaseline = vi.fn<() => Promise<FileChangesBaselineContentResult>>(async () => ({ ok: true, kind: 'content', content: 'původní\n', label: 'SVN BASE' }))
    const fileAccess = vi.fn(() => ({ ok: true as const, value: { sessionId: 'session', cwd: root, path: mine, nodeKind: 'file' as const, status: 'modified' as const } }))
    const launcher = new ExternalDiffLauncher({ readBaseline, fileAccess, tmpRoot: root, commands: { launchInteractive }, reportError: vi.fn(),
      toolOf: () => ({ kind: 'external', command: 'diff tool', argumentTemplate }) })
    return { root, mine, launcher, launchInteractive, fileAccess, readBaseline, close,
      request: { snapshotId: 'snapshot', fileId: 'file', baselineId: 'baseline' } }
  }

  it('passes the real working file, splits before substitution, and removes only its baseline on close', async () => {
    const f = await fixture()
    const old = join(f.root, 'jamat-v3-diff-old')
    await mkdir(old)
    await utimes(old, new Date(0), new Date(0))
    expect(await f.launcher.launch('owner', f.request)).toEqual({ ok: true })
    expect(f.fileAccess).toHaveBeenCalledWith('owner', 'snapshot', 'file')
    const invocation = f.launchInteractive.mock.calls[0]![0]
    const base = invocation.args[0]!.slice('/base:'.length)
    expect(await readFile(base, 'utf8')).toBe('původní\n')
    expect(invocation.args.slice(1)).toEqual([`/mine:${f.mine}`, 'SVN BASE', 'Working tree', 'two words'])
    expect(await readdir(f.root)).not.toContain('jamat-v3-diff-old')
    await writeFile(f.mine, 'edited in the tool', 'utf8')
    f.close()
    await vi.waitFor(async () => expect(await readdir(f.root)).toEqual(['working $1 %base file.txt']))
    expect(await readFile(f.mine, 'utf8')).toBe('edited in the tool')
  })

  it('writes an empty baseline for an addition and cleans a failed launch immediately', async () => {
    const f = await fixture()
    f.readBaseline.mockResolvedValue({ ok: true, kind: 'missing', label: 'BASE' })
    f.launchInteractive.mockImplementation(async (invocation) => {
      expect(await readFile(invocation.args[0]!.slice(6), 'utf8')).toBe('')
      return { ok: false, detail: 'ENOENT' }
    })
    expect(await f.launcher.launch('owner', f.request)).toEqual({ ok: false, detail: 'Cannot start diff tool: ENOENT' })
    expect(await readdir(f.root)).toEqual(['working $1 %base file.txt'])
  })

  it('refuses binary and expired baselines without starting a process', async () => {
    const f = await fixture()
    for (const baseline of [{ ok: true, kind: 'binary', detail: 'Binary file' }, { ok: false, code: 'snapshot-expired', detail: 'Expired' }] as const) {
      f.readBaseline.mockResolvedValue(baseline)
      expect(await f.launcher.launch('owner', f.request)).toEqual({ ok: false, detail: baseline.detail })
    }
    expect(f.launchInteractive).not.toHaveBeenCalled()
    expect(await readdir(f.root)).toEqual(['working $1 %base file.txt'])
  })

  it('keeps saved templates with named placeholders working', async () => {
    const f = await fixture('/base:%base /mine:%mine')
    expect(await f.launcher.launch('owner', f.request)).toEqual({ ok: true })
    expect(f.launchInteractive.mock.calls[0]![0].args[1]).toBe(`/mine:${f.mine}`)
    f.close()
    await vi.waitFor(async () => expect(await readdir(f.root)).toEqual(['working $1 %base file.txt']))
  })
})
