import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TerminalDetector, type TerminalDetectorDeps } from './terminalDetector'
import { TerminalDetectorLimits } from './terminalDetectorLimits'
import type { TerminalMenuCapture } from './terminalDetectorApi.types'

describe('lib-orchestrator/terminalDetector/terminalDetector', () => {
  const created: string[] = []
  let clock = 1_000

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
    clock = 1_000
  })

  function workspace(files: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-terminal-detector-'))
    created.push(root)
    for (const file of files) {
      const full = join(root, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x', 'utf8')
    }
    return root
  }

  function detector(cwd: string | null, overrides: Partial<TerminalDetectorDeps> = {}): TerminalDetector {
    return new TerminalDetector({
      workingContext: (sessionId) => Promise.resolve(cwd === null
        ? { ok: false, code: 'unknown-session', detail: `Session ${sessionId} does not exist` }
        : { ok: true, value: { sessionId, cwd, agent: null, worktree: null } }),
      changedPaths: () => Promise.resolve([]),
      ...overrides,
    }, () => clock)
  }

  function capture(
    token: string | null,
    selection: string | null = null,
    fallbackToken: string | null = null,
  ): TerminalMenuCapture {
    return { token, selection, contextText: token ?? '', fallbackToken }
  }

  it('turns a path under the cursor into a file detection whose id resolves back', async () => {
    const root = workspace(['src/report.md'])
    const target = join(root, 'src', 'report.md')
    const subject = detector(root)

    const result = await subject.detect('s1', capture('src/report.md'))

    expect(result.detections).to.have.length(1)
    const detection = result.detections[0]
    expect(detection.kind).to.equal('file')
    expect(subject.pathOf(result.requestId, detection.detectionId))
      .to.deep.equal({ sessionId: 's1', path: target, kind: 'file', line: null, opensExternally: false })
  })

  /**
   * The menu draws one opening row per file and the channel that acts on it asks this same question
   * again, so both readings are taken here: a row that offers the desktop over a file the detector
   * would then refuse is a dead row, and the two answers coming apart is the only way to get one.
   */
  it('says a pdf opens outside, in the detection and in the hit behind it', async () => {
    const root = workspace(['docs/report.pdf', 'docs/report.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture('docs/report.pdf'))
    const detection = result.detections[0]

    if (detection.kind !== 'file') throw new Error('expected a file detection')
    expect(detection.opensExternally).to.equal(true)
    expect(subject.pathOf(result.requestId, detection.detectionId)?.opensExternally).to.equal(true)

    const plain = await subject.detect('s1', capture('docs/report.md'))
    const other = plain.detections[0]
    if (other.kind !== 'file') throw new Error('expected a file detection')
    expect(other.opensExternally).to.equal(false)
    expect(subject.pathOf(plain.requestId, other.detectionId)?.opensExternally).to.equal(false)
  })

  /** The extension is read however it was printed: a shell prints what the filesystem holds. */
  it('answers for a listed child too, and reads the extension in any case', async () => {
    const root = workspace(['docs/a.md', 'docs/manual.PDF'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture(join(root, 'docs')))
    const detection = result.detections[0]

    if (detection.kind !== 'directory') throw new Error('expected a directory detection')
    expect(detection.children.map((child) => [child.name, child.opensExternally]))
      .to.deep.equal([['a.md', false], ['manual.PDF', true]])
  })

  /** A directory named `notes.pdf` is still a directory, and the desktop is not how one opens. */
  it('never offers the desktop for a directory', async () => {
    const root = workspace(['notes.pdf/a.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture(join(root, 'notes.pdf')))
    const detection = result.detections[0]

    expect(detection.kind).to.equal('directory')
    expect(subject.pathOf(result.requestId, detection.detectionId)?.opensExternally).to.equal(false)
  })

  it('reads a detected directory and gives every child its own id', async () => {
    const root = workspace(['src/a.md', 'src/b.md', 'src/nested/c.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture(join(root, 'src')))
    const detection = result.detections[0]

    expect(detection.kind).to.equal('directory')
    if (detection.kind !== 'directory') throw new Error('expected a directory detection')
    expect(detection.children.map((child) => child.name)).to.deep.equal(['a.md', 'b.md'])
    expect(detection.childrenTruncated).to.equal(false)
    expect(subject.pathOf(result.requestId, detection.children[0].detectionId))
      .to.include({ path: join(root, 'src', 'a.md'), kind: 'file' })
  })

  it('caps the children it lists and says it did', async () => {
    const names = Array.from({ length: TerminalDetectorLimits.directoryChildrenMax + 3 },
      (_, index) => `src/f${index}.md`)
    const root = workspace(names)
    const subject = detector(root)

    const detection = (await subject.detect('s1', capture(join(root, 'src')))).detections[0]

    if (detection.kind !== 'directory') throw new Error('expected a directory detection')
    expect(detection.children).to.have.length(TerminalDetectorLimits.directoryChildrenMax)
    expect(detection.childrenTruncated).to.equal(true)
  })

  it('takes the selection as a second token and does not repeat the same one', async () => {
    const root = workspace(['a.md', 'b.md'])
    const subject = detector(root)

    const both = await subject.detect('s1', capture('a.md', 'b.md'))
    const same = await subject.detect('s1', capture('a.md', 'a.md'))

    expect(both.detections).to.have.length(2)
    expect(same.detections).to.have.length(1)
  })

  /*
   * The scan guesses how a source wrapped a path over two rows and hands both readings over: the
   * stitched one and the single-row run it came from. The disk settles it, so a guess that glued
   * two unrelated rows together costs a `stat` instead of the path that was under the pointer.
   */
  it('falls back to the single-row run when the stitched token names nothing', async () => {
    const root = workspace(['src/report.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture('src/report.mdsrc/other.md', null, 'src/report.md'))

    expect(result.detections.map((detection) => detection.kind)).to.deep.equal(['file'])
    const found = result.detections[0]
    expect(found.kind === 'file' ? found.path : null).to.equal(join(root, 'src', 'report.md'))
  })

  it('offers a URL from the surrounding text beside the path detections', async () => {
    const root = workspace(['a.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', {
      token: 'a.md',
      selection: null,
      fallbackToken: null,
      contextText: 'wrote a.md, see https://example.com/why for the reason',
    })

    expect(result.detections.map((detection) => detection.kind)).to.deep.equal(['file', 'url'])
    const url = result.detections[1]
    if (url.kind !== 'url') throw new Error('expected a url detection')
    expect(subject.pathOf(result.requestId, url.detectionId))
      .to.include({ path: 'https://example.com/why', kind: 'url' })
  })

  it('detects nothing at all when the session is unknown and the token is relative', async () => {
    const subject = detector(null)

    expect((await subject.detect('gone', capture('src/report.md'))).detections).to.deep.equal([])
  })

  it('asks the change log with the session working context', async () => {
    const root = workspace(['far/report.md'])
    let seen: unknown = null
    const subject = detector(root, {
      changedPaths: (context) => {
        seen = context
        return Promise.resolve([{ path: join(root, 'far', 'report.md'), nodeKind: 'file' as const }])
      },
    })

    const result = await subject.detect('s1', capture('cut\\report.md'))

    expect(seen).to.deep.equal({ sessionId: 's1', cwd: root, agent: null })
    expect(result.detections[0].kind).to.equal('file')
  })

  it('forgets a request once its time is up', async () => {
    const root = workspace(['a.md'])
    const subject = detector(root)

    const result = await subject.detect('s1', capture('a.md'))
    clock += TerminalDetectorLimits.requestTtlMilliseconds + 1

    expect(subject.pathOf(result.requestId, result.detections[0].detectionId)).to.equal(null)
  })

  it('refuses an id that belongs to another request, and an unknown one', async () => {
    const root = workspace(['a.md', 'b.md'])
    const subject = detector(root)

    const first = await subject.detect('s1', capture('a.md'))
    const second = await subject.detect('s1', capture('b.md'))

    expect(subject.pathOf(first.requestId, second.detections[0].detectionId)).to.equal(null)
    expect(subject.pathOf(first.requestId, 'made-up')).to.equal(null)
    expect(subject.pathOf('made-up', first.detections[0].detectionId)).to.equal(null)
  })

  it('drops the oldest request once too many are open', async () => {
    const root = workspace(['a.md'])
    const subject = detector(root)

    const first = await subject.detect('s1', capture('a.md'))
    for (let index = 0; index < TerminalDetectorLimits.requestsMax; index++)
      await subject.detect('s1', capture('a.md'))

    expect(subject.pathOf(first.requestId, first.detections[0].detectionId)).to.equal(null)
  })

  describe('register of proven opens', () => {
    it('remembers an exact path', () => {
      const subject = detector(null)
      subject.markOpened('Q:\\Proj\\src\\a.ts', 'file')

      expect(subject.wasOpened('Q:\\Proj\\src\\a.ts')).to.equal(true)
      expect(subject.wasOpened('Q:\\Proj\\src\\b.ts')).to.equal(false)
    })

    it('covers a file inside a directory that was opened', () => {
      const subject = detector(null)
      subject.markOpened('Q:\\Proj\\src', 'directory')

      expect(subject.wasOpened('Q:\\Proj\\src\\deep\\a.ts')).to.equal(true)
      expect(subject.wasOpened('Q:\\Proj\\other\\a.ts')).to.equal(false)
    })

    it('does not let an opened file cover its siblings', () => {
      const subject = detector(null)
      subject.markOpened('Q:\\Proj\\src\\a.ts', 'file')

      expect(subject.wasOpened('Q:\\Proj\\src\\a.ts\\nested.ts')).to.equal(false)
    })

    it('forgets the least recently opened path once it is full', () => {
      const subject = detector(null)
      subject.markOpened('Q:\\Proj\\first.ts', 'file')
      for (let index = 0; index < TerminalDetectorLimits.openedPathsMax; index++)
        subject.markOpened(`Q:\\Proj\\f${index}.ts`, 'file')

      expect(subject.wasOpened('Q:\\Proj\\first.ts')).to.equal(false)
    })
  })
})
