import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileViewerLimits } from '../fileViewerLimits'
import { FileDirectoryReader } from './fileDirectoryReader'

/**
 * The reader behind the Project Folder panel and the File tools explorer. It had no test file at
 * all: the review deleted its symlink-out-of-root refusal and its entry ceiling in one go and every
 * test in the library stayed green.
 */
describe('lib-orchestrator/fileViewer/directory/fileDirectoryReader', () => {
  const roots: string[] = []

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'jamat-directory-reader-'))
    roots.push(path)
    return path
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('lists what is there, directories before files', async () => {
    const cwd = await root()
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'a.txt'), 'a')
    await writeFile(join(cwd, 'b.txt'), 'b')

    const read = await new FileDirectoryReader().read(cwd, cwd)

    expect(read.publicEntries.map((entry) => entry.name)).to.deep.equal(['src', 'a.txt', 'b.txt'])
    expect(read.truncated).to.equal(false)
  })

  /**
   * A link is followed only as far as the grant root reaches. Without the check the entry comes back
   * openable, and the explorer then draws a way out of the project as an ordinary row.
   */
  it('refuses to open a link whose target is outside the root', async () => {
    const cwd = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    const read = await new FileDirectoryReader().read(cwd, cwd)
    const entry = read.publicEntries.find((candidate) => candidate.name === 'escape')

    expect(entry?.openable).to.equal(false)
    expect(entry?.detail ?? '').to.contain('outside')
  })

  it('answers for a link that points at nothing without throwing', async () => {
    const cwd = await root()
    await symlink(join(cwd, 'gone'), join(cwd, 'dangling'), 'file')

    const read = await new FileDirectoryReader().read(cwd, cwd)
    const entry = read.publicEntries.find((candidate) => candidate.name === 'dangling')

    expect(entry?.openable).to.equal(false)
  })

  /**
   * The ceiling, and the fact that what survives it is the front of the SORTED names. Cutting the
   * raw `readdir` order showed an arbitrary five thousand of a hundred thousand entries - a
   * directory simply absent because the filesystem returned it late, and a different five thousand
   * next time.
   *
   * The ordering half of that is not observable here: NTFS and every filesystem this suite runs on
   * hand `readdir` back in name order already, so sorting first cannot be told from not sorting.
   * What this pins is the ceiling and the deterministic front of the list. Said plainly rather than
   * counted as coverage of the sort.
   *
   * It says its own budget because it is the one case here that is disk-bound rather than compute-
   * bound: 5 005 files created, 5 000 of them stat-ed, and the same 5 005 removed again. The same
   * work measured 1 567 ms on an idle machine, 23 309 ms under twenty-four concurrent disk workers
   * and 39 658 ms under forty-eight - so the 20 s it used to carry timed out, and the package's own
   * 30 s default would have timed out as well. That 20 s was written while the default was vitest's
   * 5 s and quietly became a REDUCTION the day this package took 30 s. 120 s is the shape the
   * real-git cases in this package already use, for the same reason: a budget is there to catch a
   * case that is wedged, and a loaded machine does not wedge this one.
   */
  it('cuts a long listing deterministically, from the front of the sorted names', {
    timeout: 120_000,
  }, async () => {
    const cwd = await root()
    const count = FileViewerLimits.directoryEntries + 5
    // Written together rather than one after another: five thousand sequential writes are slower
    // than the read this test is about.
    await Promise.all(Array.from({ length: count }, (_, index) =>
      writeFile(join(cwd, `file-${String(index).padStart(6, '0')}.txt`), 'x')))

    const read = await new FileDirectoryReader().read(cwd, cwd)

    expect(read.truncated).to.equal(true)
    expect(read.publicEntries).to.have.length(FileViewerLimits.directoryEntries)
    expect(read.publicEntries[0]?.name).to.equal('file-000000.txt')
    expect(read.publicEntries.at(-1)?.name)
      .to.equal(`file-${String(FileViewerLimits.directoryEntries - 1).padStart(6, '0')}.txt`)
  })
})
