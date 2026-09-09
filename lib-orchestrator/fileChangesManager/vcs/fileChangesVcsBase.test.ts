import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileChangesVcsBase, type VcsCommandOutcome } from './fileChangesVcsBase'

/**
 * What both adapters used to hold a copy of.
 *
 * `nodeKindOf` and `repositoryPath` were byte for byte identical between them, and `succeeded` and
 * `detailOf` differed only in the tool's name - so a fix for UNC paths, or a new failure to report,
 * landed on one side and not the other with nothing to say so.
 */
describe('lib-orchestrator/fileChangesManager/vcs/fileChangesVcsBase', () => {
  /** A subclass exists only to reach the protected members, which is how both real ones use them. */
  class Probe extends FileChangesVcsBase {
    readonly id = 'git' as const
    protected readonly toolName = 'testvcs'

    static kindOf(path: string): Promise<'file' | 'directory'> {
      return Probe.nodeKindOf(path)
    }

    static pathOf(path: string): string { return Probe.repositoryPath(path) }

    static worked(outcome: VcsCommandOutcome): boolean { return Probe.succeeded(outcome) }

    reason(outcome: VcsCommandOutcome): string { return this.detailOf(outcome) }
  }

  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'jamat-vcs-base-'))
    roots.push(path)
    return path
  }

  const outcomeOf = (over: Partial<VcsCommandOutcome> = {}): VcsCommandOutcome =>
    ({ code: 0, stdout: '', stderr: '', failure: null, ...over })

  it('tells a directory from a file, and calls anything unreadable a file', async () => {
    const cwd = await root()
    await mkdir(join(cwd, 'folder'))
    await writeFile(join(cwd, 'a.ts'), 'a')

    expect(await Probe.kindOf(join(cwd, 'folder'))).to.equal('directory')
    expect(await Probe.kindOf(join(cwd, 'a.ts'))).to.equal('file')
    // Neither there nor readable: a file, because that is what every caller draws it as.
    expect(await Probe.kindOf(join(cwd, 'gone.ts'))).to.equal('file')
  })

  it('spells a repository path with forward slashes and no leading dot', () => {
    expect(Probe.pathOf('src\\a.ts')).to.equal('src/a.ts')
    expect(Probe.pathOf('./src/a.ts')).to.equal('src/a.ts')
    expect(Probe.pathOf('.\\src\\a.ts')).to.equal('src/a.ts')
    expect(Probe.pathOf('src/a.ts')).to.equal('src/a.ts')
  })

  it('calls a command successful only when it both ran and exited zero', () => {
    expect(Probe.worked(outcomeOf())).to.equal(true)
    expect(Probe.worked(outcomeOf({ code: 1 }))).to.equal(false)
    expect(Probe.worked(outcomeOf({ failure: 'timeout' }))).to.equal(false)
    // The exit code says nothing while a failure is set, and neither answer is "it worked".
    expect(Probe.worked(outcomeOf({ code: 0, failure: 'command-missing' }))).to.equal(false)
  })

  describe('why a command did not work', () => {
    it('prefers what the tool said, and cuts it', () => {
      const probe = new Probe()

      expect(probe.reason(outcomeOf({ code: 1, stderr: '  not a working copy  ' })))
        .to.equal('not a working copy')
      // stdout only when stderr is empty: some tools report a refusal on the wrong stream.
      expect(probe.reason(outcomeOf({ code: 1, stdout: 'nothing here' })))
        .to.equal('nothing here')
      expect(probe.reason(outcomeOf({ code: 1, stderr: 'x'.repeat(5_000 ) })).length)
        .to.be.at.most(2_000)
    })

    it('names the tool when it said nothing at all', () => {
      const probe = new Probe()

      expect(probe.reason(outcomeOf({ failure: 'command-missing' })))
        .to.equal('testvcs could not run (command-missing)')
      expect(probe.reason(outcomeOf({ code: 128 })))
        .to.equal('testvcs exited with 128')
    })
  })
})
