import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import { FileViewer } from '../../lib-orchestrator/fileViewer/fileViewer.js'

class SmokeFileViewer extends SmokeHarness {
  private readonly workspace: string
  private readonly external: string
  private readonly ownerId = 'file-viewer-smoke-window'
  private readonly sessionId = 'file-viewer-smoke-session'

  private constructor(root: string) {
    super()
    this.workspace = join(root, 'workspace')
    this.external = join(root, 'external')
  }

  static async run(): Promise<void> {
    const temporary = mkdtempSync(join(tmpdir(), 'jamat-v3-file-viewer-smoke-'))
    const root = realpathSync.native(temporary)
    try { await new SmokeFileViewer(root).execute() }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }

  private async execute(): Promise<void> {
    this.seed()
    const viewer = new FileViewer()

    const markdown = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'README.md',
      true,
    )
    if (!markdown.ok) throw new Error(`FAILED: ${markdown.code}: ${markdown.detail}`)
    this.check('Markdown is classified with rendered, raw, diff and hex modes',
      markdown.value.kind.kind === 'markdown'
      && markdown.value.modes.join() === 'rendered,raw,diff,hex')
    const page = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'docs/report.html',
      true,
    )
    if (!page.ok) throw new Error(`FAILED: ${page.code}: ${page.detail}`)
    // The language table knows `html`, so this opened as its own highlighted source until the page
    // kind existed. `text` is the other half: without it the frame has nothing to draw.
    this.check('a page is classified as a page and read as text',
      page.value.kind.kind === 'html'
      && page.value.modes.join() === 'rendered,raw,diff,hex')
    const pageText = await viewer.text(this.ownerId, page.value.documentId)
    this.check('page content is read through its document grant',
      pageText.ok && pageText.kind === 'text' && pageText.text.includes('<h1>Report</h1>'))

    const markdownText = await viewer.text(this.ownerId, markdown.value.documentId)
    this.check('Markdown content is read through its document grant',
      markdownText.ok && markdownText.kind === 'text' && markdownText.text.includes('# Smoke'))

    const linked = await viewer.relativeResource(
      this.ownerId,
      markdown.value.documentId,
      'assets/pixel.png',
    )
    if (!linked.ok) throw new Error(`FAILED: ${linked.code}: ${linked.detail}`)
    this.check('a relative image becomes an opaque resource grant',
      linked.value.mimeType === 'image/png'
      && await viewer.resourceAccess(linked.value.resourceId) !== null)
    const escaped = await viewer.relativeResource(
      this.ownerId,
      markdown.value.documentId,
      '../external/outside.txt',
    )
    this.check('a relative resource cannot leave the workspace grant',
      !escaped.ok && escaped.code === 'outside-root')

    const extensionless = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'docs/guide',
    )
    this.check('an absent extensionless Markdown link falls back to .md',
      extensionless.ok && extensionless.value.name === 'guide.md')

    const mdext = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'docs/example.mdext',
    )
    this.check('.mdext keeps the extended Markdown flavor',
      mdext.ok && mdext.value.kind.kind === 'markdown'
      && mdext.value.kind.flavor === 'mdext')
    const code = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'src/main.ts',
    )
    this.check('source code carries its Shiki language',
      code.ok && code.value.kind.kind === 'code'
      && code.value.kind.language === 'typescript')

    const gif = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'assets/animated.gif',
    )
    this.check('GIF is an animated preview with Hex available',
      gif.ok && gif.value.kind.kind === 'image' && gif.value.kind.animated
      && gif.value.modes.join() === 'preview,hex')
    const video = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'assets/clip.mp4',
    )
    this.check('video is exposed as range-streamable preview data',
      video.ok && video.value.kind.kind === 'video'
      && video.value.kind.mimeType === 'video/mp4')

    const binary = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      'payload.bin',
    )
    if (!binary.ok) throw new Error(`FAILED: ${binary.code}: ${binary.detail}`)
    const first = await viewer.chunk(this.ownerId, binary.value.documentId, 0)
    if (!first.ok) throw new Error(`FAILED: ${first.code}: ${first.detail}`)
    const second = await viewer.chunk(this.ownerId, binary.value.documentId, first.value.length)
    this.check('binary Hex data is paged in 64 KiB chunks',
      binary.value.kind.kind === 'hex' && first.value.length === 64 * 1024
      && !first.value.eof && second.ok && second.value.eof)

    const workspaceRoot = await viewer.rootDirectory(this.ownerId, this.sessionId, this.workspace)
    if (!workspaceRoot.ok) throw new Error(`FAILED: ${workspaceRoot.code}: ${workspaceRoot.detail}`)
    const docs = workspaceRoot.value.entries.find((entry) => entry.name === 'docs')
    if (!docs) throw new Error('FAILED: the docs directory is missing')
    const nested = await viewer.directoryEntry(
      this.ownerId,
      workspaceRoot.value.directoryId,
      docs.entryId,
    )
    this.check('Directory Explorer opens only server-issued entry tokens',
      nested.ok && nested.value.entries.some((entry) => entry.name === 'example.mdext'))

    const projectRoot = await viewer.projectDirectory(this.ownerId, this.sessionId, this.workspace)
    if (!projectRoot.ok) throw new Error(`FAILED: ${projectRoot.code}: ${projectRoot.detail}`)
    this.check('Project Folder starts at cwd with the containing filesystem root',
      projectRoot.value.path === this.workspace
      && projectRoot.value.rootPath === parse(this.workspace).root
      && projectRoot.value.canGoParent)
    const projectParent = await viewer.parentDirectory(
      this.ownerId,
      projectRoot.value.directoryId,
    )
    if (!projectParent.ok) throw new Error(`FAILED: ${projectParent.code}: ${projectParent.detail}`)
    const externalEntry = projectParent.value.entries.find((entry) => entry.name === 'external')
    if (!externalEntry) throw new Error('FAILED: the external sibling is missing')
    const browsedExternal = await viewer.directoryEntry(
      this.ownerId,
      projectParent.value.directoryId,
      externalEntry.entryId,
    )
    if (!browsedExternal.ok)
      throw new Error(`FAILED: ${browsedExternal.code}: ${browsedExternal.detail}`)
    const outsideEntry = browsedExternal.value.entries.find((entry) => entry.name === 'outside.txt')
    if (!outsideEntry) throw new Error('FAILED: the outside file is missing')
    const browsedFile = await viewer.openFileEntry(
      this.ownerId,
      browsedExternal.value.directoryId,
      outsideEntry.entryId,
    )
    this.check('a file reached above cwd carries a filesystem source',
      browsedFile.ok && browsedFile.value.source.kind === 'filesystem')
    const restoredBrowse = browsedFile.ok
      ? await viewer.openFilesystem(
        this.ownerId,
        this.sessionId,
        this.workspace,
        browsedFile.value.path,
      )
      : browsedFile
    this.check('filesystem source restore re-derives the session volume root',
      restoredBrowse.ok && restoredBrowse.value.source.kind === 'filesystem')

    const outsidePath = join(this.external, 'outside.txt')
    const refused = await viewer.openWorkspace(
      this.ownerId,
      this.sessionId,
      this.workspace,
      outsidePath,
    )
    this.check('plain workspace open refuses an external path',
      !refused.ok && refused.code === 'outside-root')
    const external = await viewer.openChanged(this.ownerId, {
      sessionId: this.sessionId,
      cwd: this.workspace,
      path: outsidePath,
      nodeKind: 'file',
    })
    if (!external.ok) throw new Error(`FAILED: ${external.code}: ${external.detail}`)
    const externalDirectory = await viewer.directoryForDocument(
      this.ownerId,
      external.value.documentId,
    )
    this.check('a proven external file grants only its parent directory',
      external.value.source.kind === 'external'
      && externalDirectory.ok && !externalDirectory.value.canGoParent)

    viewer.revokeOwner(this.ownerId)
    this.check('owner revocation expires documents and resources',
      !(await viewer.text(this.ownerId, markdown.value.documentId)).ok
      && await viewer.resourceAccess(linked.value.resourceId) === null)
    console.log(`\nsmoke-file-viewer: ${this.passed} checks passed`)
  }

  private seed(): void {
    for (const path of [this.workspace, this.external, join(this.workspace, 'assets'),
      join(this.workspace, 'docs'), join(this.workspace, 'src')])
      mkdirSync(path, { recursive: true })
    writeFileSync(join(this.workspace, 'README.md'), '# Smoke\n\n![pixel](assets/pixel.png)\n')
    writeFileSync(join(this.workspace, 'docs', 'guide.md'), '# Guide\n')
    writeFileSync(join(this.workspace, 'docs', 'report.html'),
      '<html><body><h1>Report</h1></body></html>\n')
    writeFileSync(join(this.workspace, 'docs', 'example.mdext'), ':::note[Smoke]\nBody\n:::\n')
    writeFileSync(join(this.workspace, 'src', 'main.ts'), 'export const smoke = true\n')
    writeFileSync(join(this.workspace, 'assets', 'pixel.png'), Buffer.from([137, 80, 78, 71]))
    writeFileSync(join(this.workspace, 'assets', 'animated.gif'), Buffer.from('GIF89a'))
    writeFileSync(join(this.workspace, 'assets', 'clip.mp4'), Buffer.from('smoke-video'))
    writeFileSync(join(this.workspace, 'payload.bin'), Buffer.alloc(70 * 1024, 7))
    writeFileSync(join(this.external, 'outside.txt'), 'outside\n')
  }

}

void SmokeFileViewer.run().catch((error: unknown) => SmokeRun.failed('smoke-file-viewer', error))
