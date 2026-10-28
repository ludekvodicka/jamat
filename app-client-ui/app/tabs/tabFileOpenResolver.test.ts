import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FileViewerOpenResult } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { SessionWorkingContextResult } from '../../../lib-orchestrator/sessionManager/sessionManager'
import { TerminalDetector } from '../../../lib-orchestrator/terminalDetector/terminalDetector'
import { TabFileOpenResolver } from './tabFileOpenResolver'

class TabFileOpenResolverTestSessions {
  readonly calls: string[] = []
  answer: SessionWorkingContextResult | null = null

  workingContext(sessionId: string): Promise<SessionWorkingContextResult> {
    this.calls.push(sessionId)
    return Promise.resolve(this.answer ?? {
      ok: true,
      value: { sessionId, cwd: 'Q:\\Apps\\Project', agent: null, worktree: null },
    })
  }
}

class TabFileOpenResolverTestDetector {
  readonly opened: { path: string; kind: 'file' | 'directory' }[] = []

  markOpened(path: string, kind: 'file' | 'directory'): void {
    this.opened.push({ path, kind })
  }
}

class TabFileOpenResolverTestViewer {
  readonly opens: { ownerId: string; sessionId: string; cwd: string | null; path: string }[] = []
  readonly releases: { ownerId: string; documentId: string }[] = []
  answer: FileViewerOpenResult = TabFileOpenResolverTestViewer.document(
    'report.md',
    {
      kind: 'workspace',
      sessionId: 'session-one',
      path: 'Q:\\Apps\\Project\\reports\\report.md',
    },
  )

  openDetected(
    ownerId: string,
    sessionId: string,
    cwd: string | null,
    path: string,
  ): Promise<FileViewerOpenResult> {
    this.opens.push({ ownerId, sessionId, cwd, path })
    return Promise.resolve(this.answer)
  }

  release(ownerId: string, documentId: string): void {
    this.releases.push({ ownerId, documentId })
  }

  static document(
    name: string,
    source: Extract<FileViewerOpenResult, { ok: true }>['value']['source'],
  ): FileViewerOpenResult {
    return {
      ok: true,
      value: {
        documentId: `grant-${name}`,
        documentKey: `key-${name}`,
        source,
        path: source.path,
        name,
        size: 12,
        contentVersion: 'version-1',
        kind: { kind: 'markdown', flavor: 'markdown' },
        modes: ['rendered', 'raw'],
      },
    }
  }
}

describe('app-client-ui/app/tabs/tabFileOpenResolver', () => {
  it('passes a relative path through the authoritative session cwd and releases its grant', async () => {
    const sessions = new TabFileOpenResolverTestSessions()
    const viewer = new TabFileOpenResolverTestViewer()
    const detector = new TabFileOpenResolverTestDetector()
    const resolver = new TabFileOpenResolver(sessions, viewer, detector)

    expect(await resolver.resolve('session-one', 'reports/report.md')).toEqual({
      ok: true,
      source: {
        kind: 'workspace',
        sessionId: 'session-one',
        path: 'Q:\\Apps\\Project\\reports\\report.md',
      },
      documentKey: 'key-report.md',
      title: 'report.md',
    })
    expect(sessions.calls).toEqual(['session-one'])
    expect(viewer.opens).toEqual([{
      ownerId: 'remote-control',
      sessionId: 'session-one',
      cwd: 'Q:\\Apps\\Project',
      path: 'reports/report.md',
    }])
    expect(viewer.releases).toEqual([{
      ownerId: 'remote-control',
      documentId: 'grant-report.md',
    }])
    expect(detector.opened).toEqual([{
      path: 'Q:\\Apps\\Project\\reports\\report.md',
      kind: 'file',
    }])
  })

  it('records a detected proof outside the session filesystem before releasing its grant', async () => {
    const sessions = new TabFileOpenResolverTestSessions()
    const viewer = new TabFileOpenResolverTestViewer()
    viewer.answer = TabFileOpenResolverTestViewer.document('shared.md', {
      kind: 'detected',
      sessionId: 'session-one',
      path: 'D:\\Shared\\shared.md',
    })
    const detector = new TerminalDetector({
      workingContext: (sessionId) => sessions.workingContext(sessionId),
      changedPaths: () => Promise.resolve([]),
    })
    const resolver = new TabFileOpenResolver(sessions, viewer, detector)

    expect(await resolver.resolve('session-one', 'D:\\Shared\\shared.md')).toMatchObject({
      ok: true,
      source: { kind: 'detected', path: 'D:\\Shared\\shared.md' },
    })
    expect(viewer.releases).toEqual([{
      ownerId: 'remote-control',
      documentId: 'grant-shared.md',
    }])
    expect(detector.wasOpened('D:\\Shared\\shared.md')).toBe(true)
  })

  it('maps a missing path without manufacturing or releasing a grant', async () => {
    const sessions = new TabFileOpenResolverTestSessions()
    const viewer = new TabFileOpenResolverTestViewer()
    viewer.answer = { ok: false, code: 'not-found', detail: 'The file does not exist' }
    const detector = new TabFileOpenResolverTestDetector()
    const resolver = new TabFileOpenResolver(sessions, viewer, detector)

    expect(await resolver.resolve('session-one', 'missing.md')).toEqual({
      ok: false,
      code: 'not-found',
      detail: 'The file does not exist',
    })
    expect(viewer.releases).toEqual([])
    expect(detector.opened).toEqual([])
  })

  it('refuses before resolving a path when the session working context disappeared', async () => {
    const sessions = new TabFileOpenResolverTestSessions()
    sessions.answer = {
      ok: false,
      code: 'unknown-session',
      detail: 'Session session-one does not exist',
    }
    const viewer = new TabFileOpenResolverTestViewer()
    const detector = new TabFileOpenResolverTestDetector()
    const resolver = new TabFileOpenResolver(sessions, viewer, detector)

    expect(await resolver.resolve('session-one', 'reports/report.md')).toEqual({
      ok: false,
      code: 'not-found',
      detail: 'Session session-one does not exist',
    })
    expect(viewer.opens).toEqual([])
    expect(viewer.releases).toEqual([])
    expect(detector.opened).toEqual([])
  })
})


it('binds source detections to owner/session, preserves line paths and refuses expiry or redirected junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jamat-remote-detect-'))
  try {
    await mkdir(join(root, 'one'))
    await mkdir(join(root, 'two'))
    await writeFile(join(root, 'one', 'a.ts'), 'source')
    await writeFile(join(root, 'two', 'a.ts'), 'other')
    let now = 1
    const sessions = { workingContext: async (sessionId: string) => ({ ok: true as const, value: { sessionId, cwd: root, agent: null, worktree: null } }) }
    const detector = new TerminalDetector({ workingContext: sessions.workingContext, changedPaths: async () => [] }, () => now)
    const viewer = new TabFileOpenResolverTestViewer()
    const resolver = new TabFileOpenResolver(sessions, viewer, detector)
    const capture = (token: string) => ({ token, selection: null, contextText: token, fallbackToken: null })
    const detected = await resolver.detect('source-view', 'session-one', capture(join(root, 'one', 'a.ts') + ':12:3'))
    const file = detected.detections.find((item) => item.kind === 'file')!
    expect(file).toMatchObject({ kind: 'file', line: 12, column: 3 })
    expect(await resolver.detected('foreign', 'session-one', detected.requestId, file.detectionId, 'file')).toMatchObject({ ok: false, code: 'proof-expired' })
    expect(await resolver.detected('source-view', 'foreign', detected.requestId, file.detectionId, 'file')).toMatchObject({ ok: false })
    expect(await resolver.detected('source-view', 'session-one', detected.requestId, '../a.ts', 'file')).toMatchObject({ ok: false })
    expect(viewer.opens).toHaveLength(0)
    expect(await resolver.detected('source-view', 'session-one', detected.requestId, file.detectionId, 'file')).toMatchObject({ ok: true })
    const directory = await resolver.detect('source-view', 'session-one', capture(join(root, 'one')))
    expect(await resolver.detected('source-view', 'session-one', directory.requestId, directory.detections[0].detectionId, 'directory')).toMatchObject({ ok: true, value: { sessionId: 'session-one' } })
    now += 10 * 60_000
    expect(await resolver.detected('source-view', 'session-one', detected.requestId, file.detectionId, 'file')).toMatchObject({ ok: false, code: 'proof-expired' })
    const link = join(root, 'link')
    await symlink(join(root, 'one'), link, 'junction')
    const linked = await resolver.detect('source-view', 'session-one', capture(join(link, 'a.ts')))
    await rm(link)
    await symlink(join(root, 'two'), link, 'junction')
    expect(await resolver.detected('source-view', 'session-one', linked.requestId, linked.detections[0].detectionId, 'file')).toMatchObject({ ok: false, code: 'proof-expired' })
    expect(viewer.opens).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
