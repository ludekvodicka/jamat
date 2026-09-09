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
