import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileChangesVcsSvn } from './fileChangesVcsSvn'
import type {
  CommandOutcome,
  CommandRunner,
} from '../../shared/commandInvoker.types'

describe('lib-orchestrator/fileChangesManager/vcs/fileChangesVcsSvn', () => {
  it('names its own default and history baselines', () => {
    const adapter = new FileChangesVcsSvn()

    expect(adapter.defaultBaselineRef).to.deep.equal({ kind: 'svn-base', revision: 'BASE' })
    expect(adapter.historyBaselineRef('42'))
      .to.deep.equal({ kind: 'svn-revision', revision: '42' })
  })

  const created: string[] = []

  class Runner implements CommandRunner {
    constructor(private readonly answer: (args: string[]) => CommandOutcome) {}

    async run(_cwd: string, args: string[]): Promise<CommandOutcome> {
      return this.answer(args)
    }
  }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function workingCopy(): { root: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-svn-vcs-'))
    const cwd = join(root, 'nested')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'changed.ts'), 'current\n', 'utf8')
    created.push(root)
    return { root, cwd }
  }

  function ok(stdout = ''): CommandOutcome {
    return { code: 0, stdout, stderr: '', failure: null }
  }

  function detectionAnswer(root: string, args: string[]): CommandOutcome | null {
    if (args[0] !== 'info') return null
    const item = args[args.indexOf('--show-item') + 1]
    if (item === 'wc-root') return ok(root)
    else if (item === 'url') return ok('https://svn.example/repo/trunk/nested')
    else if (item === 'relative-url') return ok('^/trunk/nested')
    else throw new Error(item)
  }

  it('parses file and directory working states and excludes normal rows', async () => {
    const { root, cwd } = workingCopy()
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(`<?xml version="1.0"?>
      <status><target path=".">
        <entry path="changed.ts"><wc-status item="modified" props="none" revision="2"/></entry>
        <entry path="new"><wc-status item="unversioned" props="none"/></entry>
        <entry path="normal.ts"><wc-status item="normal" props="none" revision="2"/></entry>
      </target></status>`))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.status(detected)).toEqual({
      ok: true,
      value: { externalRoots: [], entries: [
        expect.objectContaining({ repositoryPath: 'nested/changed.ts', status: 'modified' }),
        expect.objectContaining({ repositoryPath: 'nested/new', status: 'untracked' }),
      ] },
    })
  })

  it('filters verbose log paths to the cwd and preserves copy metadata', async () => {
    const { root, cwd } = workingCopy()
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(`<?xml version="1.0"?>
      <log><logentry revision="42"><author>Ada</author><date>2026-08-14T08:00:00.000Z</date>
        <paths>
          <path action="M" kind="file">/trunk/nested/changed.ts</path>
          <path action="A" kind="file" copyfrom-path="/trunk/nested/old.ts">/trunk/nested/new.ts</path>
          <path action="M" kind="file">/trunk/sibling.ts</path>
        </paths><msg>message</msg></logentry></log>`))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.history(detected, 10)).toEqual({
      ok: true,
      value: [expect.objectContaining({
        revision: '42',
        label: 'r42',
        entries: [
          expect.objectContaining({ repositoryPath: 'nested/changed.ts', status: 'modified' }),
          expect.objectContaining({
            repositoryPath: 'nested/new.ts',
            previousRepositoryPath: 'nested/old.ts',
            status: 'copied',
          }),
        ],
      })],
    })
  })

  it('keeps nested external roots and their changed files', async () => {
    const { root, cwd } = workingCopy()
    const vcs = new FileChangesVcsSvn(new Runner((args) => detectionAnswer(root, args) ?? ok(`
      <status><target path=".">
        <entry path="shared"><wc-status item="external" props="none"/></entry>
      </target><target path="shared">
        <entry path="shared/a.ts"><wc-status item="modified" props="none"/></entry>
        <entry path="shared/b.ts"><wc-status item="modified" props="none"/></entry>
      </target></status>`)))

    const result = await vcs.status((await vcs.detect(cwd))!)

    expect(result).toEqual({ ok: true, value: {
      externalRoots: [join(cwd, 'shared')],
      entries: [
        expect.objectContaining({ absolutePath: join(cwd, 'shared/a.ts'), status: 'modified' }),
        expect.objectContaining({ absolutePath: join(cwd, 'shared/b.ts'), status: 'modified' }),
      ],
    } })
  })

  it('uses the local BASE target and repository URL for a selected revision', async () => {
    const { root, cwd } = workingCopy()
    const targets: string[] = []
    const runner = new Runner((args) => {
      const detected = detectionAnswer(root, args)
      if (detected) return detected
      if (args[0] === 'cat') {
        targets.push(args.at(-1)!)
        return ok('before\n')
      }
      throw new Error(JSON.stringify(args))
    })
    const vcs = new FileChangesVcsSvn(runner)
    const detected = (await vcs.detect(cwd))!

    await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-base', revision: 'BASE' })
    await vcs.readBaseline(detected, 'nested/changed.ts', { kind: 'svn-revision', revision: '42' })
    expect(targets).toEqual([
      join(root, 'nested', 'changed.ts'),
      'https://svn.example/repo/trunk/nested/changed.ts',
    ])
  })

  /**
   * What `svn status --ignore-externals` actually prints, checked against svn 1.14.5: the external
   * itself as an `X` row and nothing else - no narration, because with that switch svn never
   * descends into one. The fixture here used to carry that narration and a filter for it, so a test
   * named after the filter passed over input the command under it cannot produce. CRLF, because that
   * is what svn prints on the first target platform and the trimming has to survive it.
   */
  it('reads dirty from the cheap status probe and does not count the external itself', async () => {
    const { root, cwd } = workingCopy()
    const externalOnly = 'X       shared\r\n'
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(externalOnly))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: false })
  })

  // A bare carriage return is not a change. Without the trim it is a line of length one, and the
  // working copy is marked dirty by a blank line.
  it('does not read a blank line as a change', async () => {
    const { root, cwd } = workingCopy()
    const blank = '\r\n\r\n'
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(blank))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: false })
  })

  it('counts a change beside an external row, CRLF and all', async () => {
    const { root, cwd } = workingCopy()
    const changed = 'X       shared\r\nM       nested\\changed.ts\r\n'
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(changed))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: true })
  })

  it('counts an unversioned file as dirty, for parity with git', async () => {
    const { root, cwd } = workingCopy()
    const unversioned = `?       new.txt
`
    const runner = new Runner((args) => detectionAnswer(root, args) ?? ok(unversioned))
    const vcs = new FileChangesVcsSvn(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: true })
  })

  it('probes without the full-walk flags status uses', async () => {
    const { root, cwd } = workingCopy()
    const seen: string[][] = []
    const runner = new Runner((args) => {
      seen.push(args)
      return detectionAnswer(root, args) ?? ok('')
    })
    const vcs = new FileChangesVcsSvn(runner)
    await vcs.dirty((await vcs.detect(cwd))!)

    const probe = seen.at(-1)!
    expect(probe).toContain('--ignore-externals')
    expect(probe).not.toContain('--xml')
    expect(probe).not.toContain('infinity')
  })
})
