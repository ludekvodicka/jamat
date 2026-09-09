import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse, relative, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileViewerGrantStore } from './access/fileViewerGrantStore'
import { FileViewer } from './fileViewer'
import type { FileViewerDocumentSource } from './fileViewerApi.types'

describe('fileViewer/fileViewer', () => {
  const roots: string[] = []

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'jamat-file-viewer-'))
    roots.push(path)
    return path
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('opens and reads a workspace text document through its token', async () => {
    const cwd = await root()
    const path = join(cwd, 'main.ts')
    await writeFile(path, 'export const answer = 42\n')
    const viewer = new FileViewer()

    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, path, true)
    expect(opened.ok).to.equal(true)
    if (!opened.ok) return
    expect(opened.value.kind).to.deep.equal({ kind: 'code', language: 'typescript' })
    expect(opened.value.modes).to.deep.equal(['rendered', 'raw', 'diff', 'hex'])
    const content = await viewer.text('window-one', opened.value.documentId)
    expect(content).to.deep.include({ ok: true, kind: 'text', text: 'export const answer = 42\n' })
    expect(await viewer.text('window-two', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'wrong-owner' })
  })

  it('answers what changed under an open document without reading it again', async () => {
    const cwd = await root()
    const path = join(cwd, 'notes.md')
    await writeFile(path, '# One\n')
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, path)
    expect(opened.ok).to.equal(true)
    if (!opened.ok) return

    expect(await viewer.version('window-one', opened.value.documentId))
      .to.deep.equal({ ok: true, kind: 'unchanged' })
    expect(await viewer.version('window-two', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'wrong-owner' })

    await writeFile(path, '# One\n\n# Two\n')
    const changed = await viewer.version('window-one', opened.value.documentId)
    expect(changed).to.deep.include({ ok: true, kind: 'changed' })
    // The version is what the reopen will hold, so a caller can tell one change from the next.
    if (changed.ok && changed.kind === 'changed')
      expect(changed.contentVersion).to.not.equal(opened.value.contentVersion)

    await rm(path)
    expect(await viewer.version('window-one', opened.value.documentId))
      .to.deep.equal({ ok: true, kind: 'missing' })
  })

  it('calls a document that was opened while its file was absent unchanged', async () => {
    const cwd = await root()
    const viewer = new FileViewer()
    const opened = await viewer.openChanged('window-one', {
      sessionId: 'session-one',
      cwd,
      path: join(cwd, 'deleted.ts'),
      nodeKind: 'file',
    })
    expect(opened.ok).to.equal(true)
    if (!opened.ok) return
    expect(opened.value.contentVersion).to.equal(null)

    // A file that was never there is not a file that has just gone: reporting `missing` here would
    // put "the file is gone" on screen for every deleted entry a change list opens.
    expect(await viewer.version('window-one', opened.value.documentId))
      .to.deep.equal({ ok: true, kind: 'unchanged' })

    await writeFile(join(cwd, 'deleted.ts'), 'export const back = true\n')
    expect(await viewer.version('window-one', opened.value.documentId))
      .to.deep.include({ ok: true, kind: 'changed' })
  })

  it('refuses a workspace path outside the trusted root', async () => {
    const cwd = await root()
    const outside = await root()
    const path = join(outside, 'secret.txt')
    await writeFile(path, 'secret')
    const answer = await new FileViewer().openWorkspace('window-one', 'session-one', cwd, path)
    expect(answer).to.deep.include({ ok: false, code: 'outside-root' })
  })

  it('uses the V1 markdown fallback only when an extensionless target is absent', async () => {
    const cwd = await root()
    await writeFile(join(cwd, 'guide.md'), '# Guide\n')
    const answer = await new FileViewer().openWorkspace(
      'window-one',
      'session-one',
      cwd,
      join(cwd, 'guide'),
    )
    expect(answer.ok).to.equal(true)
    if (answer.ok) expect(basename(answer.value.path)).to.equal('guide.md')
  })

  it('revalidates containment when a granted path is replaced by a link', async () => {
    const cwd = await root()
    const outside = await root()
    const folder = join(cwd, 'folder')
    await mkdir(folder)
    await writeFile(join(folder, 'file.txt'), 'inside')
    await writeFile(join(outside, 'file.txt'), 'outside')
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace(
      'window-one',
      'session-one',
      cwd,
      join(folder, 'file.txt'),
    )
    if (!opened.ok) throw new Error(opened.detail)
    await rename(folder, join(cwd, 'original-folder'))
    await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')

    expect(await viewer.text('window-one', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'outside-root' })
  })

  /**
   * The same swap, against every OTHER read that hands bytes back.
   *
   * The revalidation is the whole of this subsystem's correctness - a granted path that is replaced
   * by a link after the grant was minted must stop answering - and it was pinned for `text` alone.
   * Deleting it from `chunk`, from `mediaResource` and from `resourceAccess` left every suite in the
   * repository green, and `resourceAccess` is the LAST check before the protocol streams bytes to
   * the renderer.
   */
  it('revalidates containment on every read that hands bytes back', async () => {
    const cwd = await root()
    const outside = await root()
    const folder = join(cwd, 'folder')
    await mkdir(folder)
    await writeFile(join(folder, 'payload.bin'), Buffer.alloc(64, 7))
    await writeFile(join(folder, 'pixel.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(join(outside, 'payload.bin'), Buffer.alloc(64, 9))
    await writeFile(join(outside, 'pixel.png'), Buffer.from([137, 80, 78, 71]))
    const viewer = new FileViewer()
    const binary = await viewer.openWorkspace(
      'window-one', 'session-one', cwd, join(folder, 'payload.bin'))
    const media = await viewer.openWorkspace(
      'window-one', 'session-one', cwd, join(folder, 'pixel.png'))
    if (!binary.ok) throw new Error(binary.detail)
    if (!media.ok) throw new Error(media.detail)
    // Minted while the path was still honest, which is exactly the resource that must stop working.
    const resource = await viewer.mediaResource('window-one', media.value.documentId)
    if (!resource.ok) throw new Error(resource.detail)

    await rename(folder, join(cwd, 'original-folder'))
    await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')

    expect(await viewer.chunk('window-one', binary.value.documentId, 0))
      .to.deep.include({ ok: false, code: 'outside-root' })
    expect(await viewer.mediaResource('window-one', media.value.documentId))
      .to.deep.include({ ok: false, code: 'outside-root' })
    expect(await viewer.resourceAccess(resource.value.resourceId)).to.equal(null)
  })

  /**
   * The external grant is the widest one this subsystem hands out - a directory outside the
   * workspace, justified by one anchor file a session actually changed - so what keeps it bounded is
   * the containment check on the anchor's own parent. It had no test at all: deleting it let any
   * absolute path restore as an external document.
   */
  it('refuses to restore an external document outside its anchor directory', async () => {
    const cwd = await root()
    const outside = await root()
    const anchor = join(cwd, 'changed.txt')
    await writeFile(anchor, 'changed')
    await writeFile(join(cwd, 'sibling.txt'), 'sibling')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const viewer = new FileViewer()
    const access = {
      sessionId: 'session-one',
      cwd,
      path: anchor,
      nodeKind: 'file' as const,
    }

    const sibling = await viewer.restoreExternal('window-one', access, join(cwd, 'sibling.txt'), false)
    expect(sibling.ok).to.equal(true)

    const refused = await viewer.restoreExternal(
      'window-one', access, join(outside, 'secret.txt'), false)
    expect(refused).to.deep.include({ ok: false, code: 'outside-root' })

    const notAFile = await viewer.restoreExternal(
      'window-one',
      { ...access, nodeKind: 'directory' as const },
      join(cwd, 'sibling.txt'),
      false,
    )
    expect(notAFile).to.deep.include({ ok: false, code: 'not-file' })
  })

  /**
   * The same swap as the test above, against the OTHER half of the surface. Every navigation here
   * resolves the real path before it checks containment, except that walking up used to check the
   * lexical parent and then list the resolved one - so renaming a parent out of the way and putting
   * a junction in its place (no administrator rights needed on Windows) handed back the names, sizes
   * and times of a directory outside the grant root. Reproduced against this class before the fix.
   */
  it('refuses to walk up into a parent that has been replaced by a link', async () => {
    const cwd = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const folder = join(cwd, 'folder')
    const sub = join(folder, 'sub')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'file.txt'), 'inside')
    const viewer = new FileViewer()
    // The grant the File tools explorer gets: a document, then the directory it sits in.
    const document = await viewer.openWorkspace('window-one', 'session-one', cwd, join(sub, 'file.txt'))
    if (!document.ok) throw new Error(document.detail)
    const opened = await viewer.directoryForDocument('window-one', document.value.documentId)
    if (!opened.ok) throw new Error(opened.detail)

    await rename(folder, join(cwd, 'moved'))
    await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')

    const up = await viewer.parentDirectory('window-one', opened.value.directoryId)

    expect(up).to.deep.include({ ok: false, code: 'outside-root' })
  })

  /**
   * The gate whose whole sentence is "only relative local resources are allowed". Asking about the
   * still-encoded string let `%2F…` past it, and the two refusals downstream do not answer alike -
   * `outside-root` for a path that exists, `not-found` for one that does not - so a rendered markdown
   * document was an existence oracle for any absolute path on the drive.
   */
  it('refuses an absolute resource reference however it is spelled', async () => {
    const cwd = await root()
    const outside = await root()
    const present = join(outside, 'known.txt')
    await writeFile(present, 'known')
    const document = join(cwd, 'notes.md')
    await writeFile(document, '# notes\n')
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, document)
    if (!opened.ok) throw new Error(opened.detail)

    const encoded = present.split(sep).map(encodeURIComponent).join('%2F')
    const absent = join(outside, 'absent.txt').split(sep).map(encodeURIComponent).join('%2F')

    const forPresent = await viewer.relativeResource('window-one', opened.value.documentId, encoded)
    const forAbsent = await viewer.relativeResource('window-one', opened.value.documentId, absent)

    expect(forPresent).to.deep.include({ ok: false, code: 'invalid-reference' })
    // The two answers must not differ: telling them apart is what makes the surface an oracle.
    expect(forAbsent).to.deep.equal(forPresent)
  })

  /*
   * The text kinds were whatever was left after excluding image, video and hex, so a kind added
   * later - a pdf, an archive - would have been read as UTF-8 and handed over as text.
   */
  it('refuses to read a document that is not one of the text kinds', async () => {
    const cwd = await root()
    const path = join(cwd, 'payload.bin')
    await writeFile(path, Buffer.alloc(32, 7))
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, path)
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.kind.kind).to.equal('hex')

    expect(await viewer.text('window-one', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'not-text' })
  })

  /*
   * The three doors carried one errno table three times, and `not-file` was recognised by matching
   * the reader's prose - so rewording that sentence would have turned every "you opened a directory"
   * into `invalid-source`, with nothing failing anywhere.
   */
  it('says which refusal it is for a directory, a missing path and a missing directory', async () => {
    const cwd = await root()
    await mkdir(join(cwd, 'folder'))
    const viewer = new FileViewer()

    expect(await viewer.openWorkspace('window-one', 'session-one', cwd, join(cwd, 'folder')))
      .to.deep.include({ ok: false, code: 'not-file' })
    expect(await viewer.openWorkspace('window-one', 'session-one', cwd, join(cwd, 'gone.ts')))
      .to.deep.include({ ok: false, code: 'not-found', detail: 'The file does not exist' })
    expect(await viewer.rootDirectory('window-one', 'session-one', join(cwd, 'gone')))
      .to.deep.include({ ok: false, code: 'not-found', detail: 'The directory does not exist' })
  })

  it('pages binary content in fixed chunks', async () => {
    const cwd = await root()
    const path = join(cwd, 'payload.bin')
    await writeFile(path, Buffer.alloc(70 * 1024, 7))
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, path)
    if (!opened.ok) throw new Error(opened.detail)

    const first = await viewer.chunk('window-one', opened.value.documentId, 0)
    expect(first.ok).to.equal(true)
    if (!first.ok) return
    expect(first.value.length).to.equal(64 * 1024)
    expect(first.value.eof).to.equal(false)
    const second = await viewer.chunk('window-one', opened.value.documentId, first.value.length)
    expect(second.ok).to.equal(true)
    if (second.ok) expect(second.value.eof).to.equal(true)
  })

  it('lists directories and opens a file entry without accepting a new path', async () => {
    const cwd = await root()
    await mkdir(join(cwd, 'source'))
    await writeFile(join(cwd, 'source', 'main.cpp'), 'int main() {}\n')
    await writeFile(join(cwd, 'README.md'), '# Readme\n')
    const viewer = new FileViewer()

    const listing = await viewer.rootDirectory('window-one', 'session-one', cwd)
    if (!listing.ok) throw new Error(listing.detail)
    expect(listing.value.entries.map((entry) => entry.name)).to.deep.equal(['source', 'README.md'])
    const source = listing.value.entries[0]
    const nested = await viewer.directoryEntry('window-one', listing.value.directoryId, source.entryId)
    if (!nested.ok) throw new Error(nested.detail)
    const opened = await viewer.openFileEntry(
      'window-one',
      nested.value.directoryId,
      nested.value.entries[0].entryId,
    )
    expect(opened.ok).to.equal(true)
    if (opened.ok) expect(opened.value.kind).to.deep.equal({ kind: 'code', language: 'cpp' })
  })

  it('keeps the sidebar root at cwd and gives Project Folder the containing filesystem root', async () => {
    const cwd = await root()
    const viewer = new FileViewer()

    const sidebar = await viewer.rootDirectory('window-one', 'session-one', cwd)
    const project = await viewer.projectDirectory('window-one', 'session-one', cwd)
    const canonicalCwd = await realpath(cwd)

    if (!sidebar.ok) throw new Error(sidebar.detail)
    if (!project.ok) throw new Error(project.detail)
    expect(sidebar.value.rootPath).to.equal(sidebar.value.path)
    expect(sidebar.value.canGoParent).to.equal(false)
    expect(project.value.rootPath).to.equal(parse(canonicalCwd).root)
    expect(project.value.path).to.equal(canonicalCwd)
    expect(project.value.relativePath)
      .to.equal(relative(parse(canonicalCwd).root, canonicalCwd).replace(/\\/g, '/'))
    expect(project.value.canGoParent).to.equal(true)
  })

  it('opens a file reached above cwd with a restorable filesystem source', async () => {
    const sandbox = await root()
    const cwd = join(sandbox, 'project')
    const sibling = join(sandbox, 'shared')
    await mkdir(cwd)
    await mkdir(sibling)
    await writeFile(join(sibling, 'shared.md'), '# Shared\n')
    const viewer = new FileViewer()

    const project = await viewer.projectDirectory('window-one', 'session-one', cwd)
    if (!project.ok) throw new Error(project.detail)
    const parent = await viewer.parentDirectory('window-one', project.value.directoryId)
    if (!parent.ok) throw new Error(parent.detail)
    const shared = parent.value.entries.find((entry) => entry.name === 'shared')
    if (!shared) throw new Error('The sibling directory is missing')
    const directory = await viewer.directoryEntry('window-one', parent.value.directoryId, shared.entryId)
    if (!directory.ok) throw new Error(directory.detail)
    const opened = await viewer.openFileEntry(
      'window-one',
      directory.value.directoryId,
      directory.value.entries[0].entryId,
    )
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source).to.deep.equal({
      kind: 'filesystem',
      sessionId: 'session-one',
      path: await realpath(join(sibling, 'shared.md')),
    })

    const restored = await viewer.openFilesystem(
      'window-one',
      'session-one',
      cwd,
      opened.value.path,
      true,
    )
    if (!restored.ok) throw new Error(restored.detail)
    expect(restored.value.source.kind).to.equal('filesystem')
    expect(restored.value.modes).to.deep.equal(['rendered', 'raw', 'diff', 'hex'])
  })

  it('rejects relative and cross-volume filesystem restore paths', async () => {
    const cwd = await root()
    const viewer = new FileViewer()

    expect(await viewer.openFilesystem('window-one', 'session-one', cwd, 'relative.md'))
      .to.deep.include({ ok: false, code: 'invalid-source' })
    if (process.platform === 'win32') {
      const currentDrive = parse(cwd).root.slice(0, 1).toUpperCase()
      const otherDrive = currentDrive === 'C' ? 'D' : 'C'
      expect(await viewer.openFilesystem(
        'window-one',
        'session-one',
        cwd,
        `${otherDrive}:\\outside.md`,
      )).to.deep.include({ ok: false, code: 'outside-root' })
    }
  })

  it('grants an external changed file and limits its explorer to the parent', async () => {
    const cwd = await root()
    const external = await root()
    const path = join(external, 'outside.md')
    await writeFile(path, '# Outside\n')
    const viewer = new FileViewer()
    const opened = await viewer.openChanged('window-one', {
      sessionId: 'session-one',
      cwd,
      path,
      nodeKind: 'file',
    })
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source.kind).to.equal('external')
    const listing = await viewer.directoryForDocument('window-one', opened.value.documentId)
    if (!listing.ok) throw new Error(listing.detail)
    expect(listing.value.canGoParent).to.equal(false)
  })

  it('opens a detected path inside cwd as a workspace source', async () => {
    const cwd = await root()
    const path = join(cwd, 'notes.md')
    await writeFile(path, '# Notes\n')

    const opened = await new FileViewer().openDetected('window-one', 'session-one', cwd, path)
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source).to.deep.equal({
      kind: 'workspace',
      sessionId: 'session-one',
      path: await realpath(path),
    })
  })

  it('resolves a relative detected path against the session cwd', async () => {
    const cwd = await root()
    expect(await realpath(cwd)).not.to.equal(await realpath(process.cwd()))
    const reports = join(cwd, 'reports')
    const path = join(reports, 'report.md')
    await mkdir(reports)
    await writeFile(path, '# Report\n')

    const opened = await new FileViewer().openDetected(
      'window-one',
      'session-one',
      cwd,
      'reports/report.md',
    )
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source).to.deep.equal({
      kind: 'workspace',
      sessionId: 'session-one',
      path: await realpath(path),
    })
  })

  it('opens a detected path on the session drive outside cwd as a filesystem source', async () => {
    const sandbox = await root()
    const cwd = join(sandbox, 'project')
    const sibling = join(sandbox, 'shared')
    await mkdir(cwd)
    await mkdir(sibling)
    const path = join(sibling, 'shared.md')
    await writeFile(path, '# Shared\n')

    const opened = await new FileViewer().openDetected('window-one', 'session-one', cwd, path)
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source).to.deep.equal({
      kind: 'filesystem',
      sessionId: 'session-one',
      path: await realpath(path),
    })
  })

  it('falls back to a detected source rooted at the target filesystem root', async () => {
    const target = await root()
    const path = join(target, 'report.md')
    await writeFile(path, '# Report\n')
    const viewer = new FileViewer()

    const opened = await viewer.openDetected('window-one', 'session-one', null, path)
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source).to.deep.equal({
      kind: 'detected',
      sessionId: 'session-one',
      path: await realpath(path),
    })
    const listing = await viewer.directoryForDocument('window-one', opened.value.documentId)
    if (!listing.ok) throw new Error(listing.detail)
    expect(listing.value.rootPath).to.equal(parse(await realpath(path)).root)
  })

  /*
   * One live cwd and every leg of the cascade: the narrowest source that can prove itself again
   * wins, and only a target the session's own filesystem root cannot reach becomes `detected`.
   */
  it('walks the detected cascade from workspace through filesystem to detected', async () => {
    const sandbox = await realpath(await root())
    const cwd = join(sandbox, 'project')
    const sibling = join(sandbox, 'shared')
    await mkdir(cwd)
    await mkdir(sibling)
    await writeFile(join(cwd, 'inside.md'), '# Inside\n')
    await writeFile(join(sibling, 'beside.md'), '# Beside\n')
    const viewer = new FileViewer()

    const inside = await viewer.openDetected('window-one', 'session-one', cwd, join(cwd, 'inside.md'))
    const beside = await viewer.openDetected('window-one', 'session-one', cwd, join(sibling, 'beside.md'))
    if (!inside.ok) throw new Error(inside.detail)
    if (!beside.ok) throw new Error(beside.detail)
    expect(inside.value.source.kind).to.equal('workspace')
    expect(beside.value.source.kind).to.equal('filesystem')

    // The third leg needs a second filesystem root; where the repository and the temp directory
    // share one, the two above are the whole cascade this machine can show.
    if (parse(process.cwd()).root.toLowerCase() !== parse(sandbox).root.toLowerCase()) {
      const crossing = join(sandbox, 'crossing')
      await symlink(process.cwd(), crossing, process.platform === 'win32' ? 'junction' : 'dir')
      const far = await viewer.openDetected(
        'window-one',
        'session-one',
        cwd,
        join(crossing, 'package.json'),
      )
      if (!far.ok) throw new Error(far.detail)
      expect(far.value.source).to.deep.equal({
        kind: 'detected',
        sessionId: 'session-one',
        path: await realpath(join(process.cwd(), 'package.json')),
      })
    }
  })

  it('keys a panel by session and canonical path, however that path is spelled', async () => {
    const directory = join(parse(process.cwd()).root, 'work', 'reports')
    const key = FileViewer.panelKeyOf('session-one', directory)

    expect(FileViewer.panelKeyOf('session-one', directory)).to.equal(key)
    expect(FileViewer.panelKeyOf('session-one', join(directory, 'nested'))).to.not.equal(key)
    expect(FileViewer.panelKeyOf('session-two', directory)).to.not.equal(key)
    expect(FileViewer.panelKeyOf('session-one', `${directory}${sep}`)).to.equal(key)
    if (process.platform === 'win32') {
      expect(FileViewer.panelKeyOf('session-one', directory.replace(/\\/g, '/'))).to.equal(key)
      expect(FileViewer.panelKeyOf('session-one', directory.toUpperCase())).to.equal(key)
    }
  })

  it('revalidates a detected grant when its path is replaced by a link', async () => {
    const cwd = await root()
    const outside = await root()
    const folder = join(cwd, 'folder')
    await mkdir(folder)
    await writeFile(join(folder, 'file.txt'), 'inside')
    await writeFile(join(outside, 'file.txt'), 'outside')
    const viewer = new FileViewer()
    const opened = await viewer.openDetected(
      'window-one',
      'session-one',
      cwd,
      join(folder, 'file.txt'),
    )
    if (!opened.ok) throw new Error(opened.detail)
    await rename(folder, join(cwd, 'original-folder'))
    await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir')

    expect(await viewer.text('window-one', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'outside-root' })
  })

  it('roots a detected directory at the target filesystem root and stops navigation there', async () => {
    const target = await realpath(await root())
    const viewer = new FileViewer()
    const filesystemRoot = parse(target).root

    const listing = await viewer.directoryAt('window-one', 'session-one', target, filesystemRoot)
    if (!listing.ok) throw new Error(listing.detail)
    expect(listing.value.rootPath).to.equal(filesystemRoot)
    expect(listing.value.canGoParent).to.equal(true)

    const atRoot = await viewer.directoryAt(
      'window-one',
      'session-one',
      filesystemRoot,
      filesystemRoot,
    )
    if (!atRoot.ok) throw new Error(atRoot.detail)
    expect(atRoot.value.canGoParent).to.equal(false)
    expect(await viewer.parentDirectory('window-one', atRoot.value.directoryId))
      .to.deep.include({ ok: false, code: 'outside-root' })
  })

  /*
   * The grant root is derived from where the target really lives, so the caller's proof has to have
   * been taken there too: a lexical proof against the session's drive passes while a junction hands
   * the grant to another one.
   */
  it('refuses a detected directory the caller proved as another root or as a link', async () => {
    const target = await realpath(await root())
    const elsewhere = await realpath(await root())
    const link = join(elsewhere, 'link')
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const viewer = new FileViewer()

    expect(await viewer.directoryAt('window-one', 'session-one', target, target))
      .to.deep.include({ ok: false, code: 'outside-root' })
    expect(await viewer.directoryAt('window-one', 'session-one', link, parse(target).root))
      .to.deep.include({ ok: false, code: 'outside-root' })
  })

  it('places a detected source outside the workspace and still throws on an unknown kind', async () => {
    const cwd = await root()
    await writeFile(join(cwd, 'main.ts'), 'export const answer = 42\n')
    const grants = new FileViewerGrantStore()
    const viewer = new FileViewer({ grants })

    const target = await realpath(cwd)
    const listing = await viewer.directoryAt('window-one', 'session-one', target, parse(target).root)
    if (!listing.ok) throw new Error(listing.detail)
    const entry = listing.value.entries[0]
    const opened = await viewer.openFileEntry('window-one', listing.value.directoryId, entry.entryId)
    if (!opened.ok) throw new Error(opened.detail)
    expect(opened.value.source.kind).to.equal('detected')

    const unknown = grants.putDirectory({
      ownerId: 'window-one',
      rootPath: listing.value.rootPath,
      path: listing.value.path,
      source: { kind: 'invented' } as unknown as FileViewerDocumentSource,
    })
    grants.setDirectoryEntries(unknown, new Map([
      [entry.entryId, { public: entry, path: entry.path, targetKind: 'file' as const }],
    ]))
    const refused = await viewer.openFileEntry('window-one', unknown, entry.entryId)
    expect(refused).to.deep.include({ ok: false, code: 'invalid-source' })
    if (!refused.ok) expect(refused.detail).to.contain('Unknown file viewer source')
  })

  it('issues a stream resource only for the owning window', async () => {
    const cwd = await root()
    const path = join(cwd, 'pixel.png')
    await writeFile(path, Buffer.from([137, 80, 78, 71]))
    const viewer = new FileViewer()
    const opened = await viewer.openWorkspace('window-one', 'session-one', cwd, path)
    if (!opened.ok) throw new Error(opened.detail)
    expect(await viewer.mediaResource('window-two', opened.value.documentId))
      .to.deep.include({ ok: false, code: 'wrong-owner' })
    const resource = await viewer.mediaResource('window-one', opened.value.documentId)
    expect(resource.ok).to.equal(true)
    if (resource.ok)
      expect(basename((await viewer.resourceAccess(resource.value.resourceId))!.path))
        .to.equal('pixel.png')
  })
})
