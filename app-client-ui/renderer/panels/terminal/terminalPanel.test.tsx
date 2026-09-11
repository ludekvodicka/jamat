import { CommitOpenStore } from '../../versioning/commitOpenStore'
import { act, cleanup, fireEvent, render, type RenderResult, waitFor } from '@testing-library/react'
import type { IDockviewPanelProps } from 'dockview'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSource,
} from '../../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDirectory,
  FileViewerDocument,
  FileViewerDocumentSource,
} from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type {
  SessionsSnapshot,
  TerminalFrame,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type {
  TerminalDetection,
} from '../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type {
  SessionTranscriptReading,
} from '../../../../lib-orchestrator/sessionTranscriptReader/sessionTranscriptReaderApi.types'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { AgentSettingsStore } from '../../contextCompaction/agentSettingsStore'
import { SessionCompact } from '../../contextCompaction/sessionCompact'
import { SnapshotStore } from '../../ipc/snapshotStore'
import { SessionModelStore } from '../../sessionModel/sessionModelStore'
import { SessionRefreshRegistry } from '../../shell/sessionRefreshRegistry'
import { TerminalDraftRegistry } from '../../shell/terminalDraftRegistry'
import { TerminalInputRegistry } from '../../shell/terminalInputRegistry'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { PanelFileToolsRegistry } from '../../fileViewer/panelFileToolsRegistry'
import { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import { SessionsMarksStore } from '../../sessions/sessionsMarksStore'
import { TabDecorationsStore } from '../../widgets/tabs/tabDecorations'
import { TabDecorationsProvider } from '../../widgets/tabs/tabDecorationsContext'
import { PanelSplitParams, type PanelSplitFileItem } from '../../widgets/tabs/panelSplit'
import { TerminalPanel, type TerminalPanelProps } from './terminalPanel'

const xtermMock = vi.hoisted(() => ({
  focuses: 0,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    readonly parser = { registerOscHandler: (): void => {} }
    /** The width table the surface registers on every terminal it opens. */
    readonly unicode = { activeVersion: '6' }
    /** Enough for a right click to be scanned: jsdom lays nothing out, so the scan finds no cell. */
    readonly buffer = {
      active: { getLine: (): undefined => undefined, viewportY: 0, length: 0 },
    }
    /** Read per wheel event by the repeat the attachment installs. */
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    onData(): void {}
    onSelectionChange(): void {}
    getSelection(): string { return '' }
    clearSelection(): void {}
    loadAddon(): void {}
    open(): void {}
    reset(): void {}
    resize(): void {}
    write(): void {}
    dispose(): void {}
    focus(): void { xtermMock.focuses += 1 }
  },
}))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

/** The one dockview event this panel listens to, and the id its decorations are published under. */
class PanelApiFake {
  private readonly active: ((event: { isActive: boolean }) => void)[] = []
  private readonly parameterChanges: ((params: Record<string, unknown>) => void)[] = []
  private parameters: Record<string, unknown> = {}

  /** A tab opened by the launcher is active before its content mounts, so it fires no event. */
  constructor(private readonly panelId: string, private readonly startsActive = false) {}

  props(params: Record<string, unknown>): IDockviewPanelProps {
    this.parameters = params
    return {
      api: {
        id: this.panelId,
        isActive: this.startsActive,
        getParameters: () => this.parameters,
        updateParameters: (next: Record<string, unknown>) => this.writeParameters(next),
        onDidParametersChange: (listener: (params: Record<string, unknown>) => void) => {
          this.parameterChanges.push(listener)
          return {
            dispose: () => {
              const at = this.parameterChanges.indexOf(listener)
              if (at >= 0) this.parameterChanges.splice(at, 1)
            },
          }
        },
        onDidActiveChange: (listener: (event: { isActive: boolean }) => void) => {
          this.active.push(listener)
          return {
            dispose: () => {
              const at = this.active.indexOf(listener)
              if (at >= 0) this.active.splice(at, 1)
            },
          }
        },
      },
      containerApi: {},
      params,
    } as unknown as IDockviewPanelProps
  }

  emitActive(isActive: boolean): void {
    act(() => {
      for (const listener of [...this.active]) listener({ isActive })
    })
  }

  listenerCount(): number {
    return this.active.length
  }

  paramsValue(): Record<string, unknown> {
    return this.parameters
  }

  writeParameters(next: Record<string, unknown>): void {
    this.parameters = next
    for (const listener of [...this.parameterChanges]) listener(next)
  }
}

class TerminalPanelFixtures {
  static document(
    path: string,
    documentId: string,
    source: FileViewerDocumentSource = { kind: 'workspace', sessionId: 'session-1', path },
  ): FileViewerDocument {
    return {
      documentId,
      documentKey: `key:${path}`,
      source,
      path,
      name: path.split(/[/\\]/).at(-1) ?? 'file',
      size: 10,
      contentVersion: '10:1',
      kind: { kind: 'text' },
      modes: ['raw', 'diff'],
    }
  }

  static workingTree(): FileChangesWorkingTreeSnapshot {
    return {
      snapshotId: 'working-tree-snapshot',
      sessionId: 'session-1',
      createdAt: 1,
      externalRoots: [],
      source: {
        requested: null,
        selected: 'checkpoint',
        available: ['checkpoint', 'svn'],
        fallbackReason: null,
      },
      defaultBaseline: {
        baselineId: 'working-tree-baseline',
        kind: 'git-head',
        label: 'Checkpoint HEAD',
        revision: 'HEAD',
        createdAt: null,
      },
      entries: [{
        fileId: 'report-file',
        path: 'C:/work/report.ts',
        displayPath: 'report.ts',
        nodeKind: 'file',
        location: 'workspace',
        status: 'modified',
        previousPath: null,
        previousDisplayPath: null,
        modifiedAt: 1,
        sources: ['vcs'],
        gitState: null,
      }],
      warnings: [],
    }
  }

  static directory(): FileViewerDirectory {
    return {
      directoryId: 'root-directory',
      rootPath: 'C:/work',
      path: 'C:/work',
      relativePath: '',
      canGoParent: false,
      entries: [{
        entryId: 'report-entry',
        name: 'report.ts',
        path: 'C:/work/report.ts',
        nodeKind: 'file',
        targetKind: 'file',
        size: 10,
        modifiedAt: 1,
        openable: true,
        detail: null,
      }],
      truncated: false,
    }
  }

  static splitItem(
    index: number,
    baselineHint?: PanelSplitFileItem['baselineHint'],
  ): PanelSplitFileItem {
    const path = `C:/work/file-${index}.ts`
    return {
      kind: 'file',
      key: `key:${path}`,
      title: `file-${index}.ts`,
      source: { kind: 'workspace', sessionId: 'session-1', path },
      baselineHint,
    }
  }
}

describe('app-client-ui/renderer/panels/terminal/terminalPanel', () => {
  let serve: ((attachId: string, frame: TerminalFrame) => void) | null = null
  /**
   * Every subscription, not just the last: two panels open beside each other is the case that shows
   * a registration belongs to ONE session, and a single-listener stub would leave the first of them
   * waiting for a frame it never sees.
   */
  let listeners: ((attachId: string, frame: TerminalFrame) => void)[] = []
  let remoteListeners: ((endpointId: string, attachId: string, frame: TerminalFrame) => void)[] = []
  let attachId: string | null = null
  let attachIds: string[] = []
  let remoteAttachCalls: { endpointId: string; attachId: string; sessionId: string }[] = []
  /** The bytes that left, and which attach carried them. */
  let inputCalls: { attachId: string; data: string }[] = []
  let store: TabDecorationsStore
  /** What the next attach is answered with, and what a reopen is answered with. */
  let attachAnswer: { ok: true } | { ok: false; code: string; detail: string } = { ok: true }
  let reopenAnswer: { ok: true; value: undefined } | { ok: false; code: string; detail: string } =
    { ok: true, value: undefined }
  /** The channel itself failing, which is not the same as the handler answering with a refusal. */
  let reopenRejects: string | null = null
  let reopened: string[] = []
  let remoteReopened: { endpointId: string; sessionId: string }[] = []
  let remoteAttachAnswer:
    | { ok: true; value: { attachId: string; sessionId: string } }
    | { ok: false; error: { code: string; detail: string } }
  let fileChangesReads = 0
  let workingTreeReads: (FileChangesWorkingTreeSource | null)[]
  let workingTreeAnswer: unknown
  let changedDocument: FileViewerDocument
  let restoredSources: FileViewerDocumentSource[]
  let releasedDocuments: string[]
  let rootDirectoryReads: string[]
  let directory: FileViewerDirectory
  /** What each `detect()` in turn answers with, so two right clicks can find different things. */
  let detections: TerminalDetection[][] = []
  let terminalFileOpens: { requestId: string; detectionId: string }[] = []
  let transcriptReads: string[] = []
  let transcriptAnswer: SessionTranscriptReading = {
    kind: 'none',
    code: 'transcript-not-found',
    reason: 'nothing was written',
  }
  let fileChangesAnswer: unknown = {
    ok: false as const,
    code: 'invalid-context',
    detail: 'no repository here',
  }
  let detectCalls = 0

  function installBridge(): void {
    const bridge = {
      sessions: {
        reopen: (sessionId: string) => {
          reopened.push(sessionId)
          if (reopenRejects !== null) return Promise.reject(new Error(reopenRejects))
          return Promise.resolve({ ok: true as const, value: reopenAnswer })
        },
      },
      terminal: {
        attach: (id: string) => {
          attachId = id
          attachIds.push(id)
          return Promise.resolve({ ok: true as const, value: attachAnswer })
        },
        input: (id: string, data: string) => {
          inputCalls.push({ attachId: id, data })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        resize: () => Promise.resolve({ ok: true as const, value: undefined }),
        // Every local attach now hands its geometry over when it stops being looked at.
        active: () => Promise.resolve({ ok: true as const, value: undefined }),
        detach: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      remote: {
        reopenSession: (endpointId: string, sessionId: string) => {
          remoteReopened.push({ endpointId, sessionId })
          return Promise.resolve({
            ok: true as const,
            value: {
              protocol: 'appjamat-v3-control.v1' as const,
              requestId: 'remote-reopen',
              operation: 'sessions.reopen' as const,
              operationId: null,
              ok: true as const,
              value: { sessionId },
            },
          })
        },
        terminalAttach: (endpointId: string, id: string, spec: { sessionId: string }) => {
          remoteAttachCalls.push({ endpointId, attachId: id, sessionId: spec.sessionId })
          const answer = remoteAttachAnswer.ok
            ? { ok: true as const, value: { attachId: id, sessionId: spec.sessionId } }
            : remoteAttachAnswer
          return Promise.resolve({ ok: true as const, value: answer })
        },
        terminalInput: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: {} },
        }),
        terminalResize: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: {} },
        }),
        terminalActive: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: {} },
        }),
        terminalDetach: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: {} },
        }),
      },
      clipboard: {
        writeText: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      sessionTranscript: {
        get: (sessionId: string) => {
          transcriptReads.push(sessionId)
          return Promise.resolve({ ok: true as const, value: transcriptAnswer })
        },
      },
      // The panel's file-changes read, which the post-mortem block is handed rather than repeating.
      fileChanges: {
        list: () => {
          fileChangesReads += 1
          return Promise.resolve({ ok: true as const, value: fileChangesAnswer })
        },
        workingTree: (_sessionId: string, source: FileChangesWorkingTreeSource | null) => {
          workingTreeReads.push(source)
          return Promise.resolve({ ok: true as const, value: workingTreeAnswer })
        },
        openFile: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: changedDocument },
        }),
        diff: () => Promise.resolve({
          ok: true as const,
          value: {
            ok: true as const,
            kind: 'source-unavailable' as const,
            detail: 'not needed by this test',
          },
        }),
      },
      fileViewer: {
        restore: (source: FileViewerDocumentSource) => {
          restoredSources.push(source)
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: TerminalPanelFixtures.document(
                source.path,
                `restored-${restoredSources.length}`,
                source,
              ),
            },
          })
        },
        text: () => Promise.resolve({
          ok: true as const,
          value: {
            ok: true as const,
            kind: 'text' as const,
            text: 'restored body',
            contentVersion: '10:1',
          },
        }),
        // Every open document is polled by useFileViewerFreshness on a timer, so a mock that leaves
        // this out is not merely incomplete: once a test in this file runs longer than one poll
        // interval, the timer calls a method that is not there, the TypeError becomes an unhandled
        // rejection, and the test that happened to be running fails for a reason that has nothing
        // to do with it. That is what turned the eight-file split case red on the push gate.
        version: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, kind: 'unchanged' as const },
        }),
        release: (documentId: string) => {
          releasedDocuments.push(documentId)
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        rootDirectory: (sessionId: string) => {
          rootDirectoryReads.push(sessionId)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: directory },
          })
        },
        openEntry: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: changedDocument },
        }),
        relativeResource: () => Promise.resolve({
          ok: true as const,
          value: { ok: false as const, code: 'invalid-reference' as const, detail: 'not needed' },
        }),
        openExternal: () => Promise.resolve({ ok: true as const, value: undefined }),
      },
      terminalMenu: {
        detect: () => {
          detectCalls += 1
          return Promise.resolve({
            ok: true as const,
            value: { requestId: `request-${detectCalls}`, detections: detections.shift() ?? [] },
          })
        },
        openFile: (requestId: string, detectionId: string) => {
          terminalFileOpens.push({ requestId, detectionId })
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: changedDocument },
          })
        },
      },
      onTerminalFrame: (callback: (id: string, frame: TerminalFrame) => void) => {
        listeners.push(callback)
        serve = callback
        return () => {
          listeners = listeners.filter((listener) => listener !== callback)
          serve = listeners.at(-1) ?? null
        }
      },
      onRemoteTerminalFrame: (callback: (
        endpointId: string,
        id: string,
        frame: TerminalFrame,
      ) => void) => {
        remoteListeners.push(callback)
        return () => {
          remoteListeners = remoteListeners.filter((listener) => listener !== callback)
        }
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  }

  let refresh: SessionRefreshRegistry
  let inputs: TerminalInputRegistry
  let drafts: TerminalDraftRegistry
  let panelFocus: PanelFocusRegistry
  let sessions: SnapshotStore<SessionsSnapshot>
  let remoteSessions: SnapshotStore<RemoteConnectionsSnapshot>
  let sessionModel: SessionModelStore
  let settings: AgentSettingsStore
  let compact: SessionCompact
  let marks: SessionsMarksStore
  let stopSessions: (() => void) | null = null

  /**
   * A sessions document this panel can read its own mark out of. The default store below is never
   * started, so it answers "no record" - which is what every test that is only about the attachment
   * wants, and it is the same state a tab is in before the first snapshot lands.
   */
  async function withSessions(snapshot: SessionsSnapshot): Promise<void> {
    sessions = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', {
      read: () => Promise.resolve({ ok: true as const, value: snapshot }),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    marks = new SessionsMarksStore(sessions)
    marks.start()
    stopSessions = sessions.start()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function withContext(sessionId: string): Promise<void> {
    sessionModel = new SessionModelStore({
      read: () => Promise.resolve({
        ok: true as const,
        value: {
          kind: 'ok' as const,
          info: {
            model: 'claude-sonnet-4-5-20260101',
            modelLabel: 'Sonnet 4.5',
            effortLevel: 'high',
            contextTokens: 160_000,
            contextWindow: 200_000,
          },
        },
      }),
      reportError: () => undefined,
    })
    settings.start()
    await sessionModel.readNow(sessionId)
    await act(async () => { await Promise.resolve() })
  }

  function mount(
    api: PanelApiFake,
    sessionId = 'session-1',
    options: {
      params?: Record<string, unknown>
      openFile?: TerminalPanelProps['openFile']
      commitOpen?: CommitOpenStore
    } = {},
  ): RenderResult {
    return render(
      <TabDecorationsProvider store={store}>
        <TerminalPanel
          {...api.props({ sessionId, ...options.params })}
          refresh={refresh}
          inputs={inputs}
          drafts={drafts}
          panelFocus={panelFocus}
          sessions={sessions}
          remoteSessions={remoteSessions}
          sessionModel={sessionModel}
          settings={settings}
          compact={compact}
          compaction={{ inspect: () => Promise.resolve({ reason: 'Test session', nextCheckAt: null, cooldown: null }) }}
          marks={marks}
          commitOpen={options.commitOpen ?? new CommitOpenStore({ read: async () => ({ ok: true, value: { revision: 0, sessionIds: [] } }), subscribe: () => () => undefined, reportError: vi.fn() })}
          fileTools={new PanelFileToolsRegistry()}
          openFile={options.openFile ?? (() => Promise.resolve({
            kind: 'opened', panelId: 'file:default',
          }))}
          openDirectoryAt={() => undefined}
        />
      </TabDecorationsProvider>,
    )
  }

  function mountRemote(
    api: PanelApiFake,
    endpointId = 'remote-pc::default::stable',
    sessionId = 'remote-session',
    params: Record<string, unknown> = {},
  ): RenderResult {
    return render(
      <TabDecorationsProvider store={store}>
        <TerminalPanel
          {...api.props({ target: { kind: 'remote', remoteEndpointId: endpointId, sessionId }, ...params })}
          refresh={refresh}
          inputs={inputs}
          drafts={drafts}
          panelFocus={panelFocus}
          sessions={sessions}
          remoteSessions={remoteSessions}
          sessionModel={sessionModel}
          settings={settings}
          compact={compact}
          compaction={{ inspect: () => Promise.resolve({ reason: 'Test session', nextCheckAt: null, cooldown: null }) }}
          marks={marks}
          commitOpen={new CommitOpenStore({ read: async () => ({ ok: true, value: { revision: 0, sessionIds: [] } }), subscribe: () => () => undefined, reportError: vi.fn() })}
          fileTools={new PanelFileToolsRegistry()}
          openFile={() => Promise.resolve({ kind: 'opened', panelId: 'file:remote' })}
          openDirectoryAt={() => undefined}
        />
      </TabDecorationsProvider>,
    )
  }

  function push(frame: TerminalFrame): void {
    if (serve === null || attachId === null) throw new Error('nothing has attached yet')
    act(() => serve?.(attachId ?? '', frame))
  }

  function noteOf(view: RenderResult): string | null {
    return view.container.querySelector('.jamat-terminal__note')?.textContent ?? null
  }

  beforeEach(() => {
    xtermMock.focuses = 0
    serve = null
    listeners = []
    remoteListeners = []
    attachId = null
    attachIds = []
    remoteAttachCalls = []
    inputCalls = []
    inputs = new TerminalInputRegistry()
    drafts = new TerminalDraftRegistry()
    panelFocus = new PanelFocusRegistry()
    sessionModel = new SessionModelStore({
      read: () => Promise.resolve({
        ok: true as const,
        value: { kind: 'none' as const, reason: 'nothing was written' },
      }),
      reportError: () => undefined,
    })
    settings = new AgentSettingsStore({
      read: () => Promise.resolve({
        ok: true as const,
        value: { claude: { yolo: false }, codex: { yolo: false } },
      }),
      subscribe: () => () => undefined,
      setAutoCompact: () => Promise.resolve({ ok: true, value: { ok: true } }),
      reportError: () => undefined,
    })
    compact = new SessionCompact(inputs, {
      claimAutomatic: () => Promise.resolve({ ok: true, value: true }),
      cooldown: () => Promise.resolve({ ok: true, value: null }),
      noteManual: () => Promise.resolve({ ok: true, value: undefined }),
      reportError: () => undefined,
    })
    attachAnswer = { ok: true }
    reopenAnswer = { ok: true, value: undefined }
    reopenRejects = null
    reopened = []
    remoteReopened = []
    remoteAttachAnswer = {
      ok: true,
      value: { attachId: 'filled by bridge', sessionId: 'filled by bridge' },
    }
    fileChangesReads = 0
    workingTreeReads = []
    workingTreeAnswer = { ok: false as const, code: 'invalid-context', detail: 'no repository here' }
    changedDocument = TerminalPanelFixtures.document('C:/work/report.ts', 'changed-document')
    restoredSources = []
    releasedDocuments = []
    rootDirectoryReads = []
    directory = TerminalPanelFixtures.directory()
    detections = []
    terminalFileOpens = []
    detectCalls = 0
    transcriptReads = []
    transcriptAnswer = {
      kind: 'none',
      code: 'transcript-not-found',
      reason: 'nothing was written',
    }
    fileChangesAnswer = { ok: false as const, code: 'invalid-context', detail: 'no repository here' }
    store = new TabDecorationsStore()
    refresh = new SessionRefreshRegistry()
    sessions = new SnapshotStore<SessionsSnapshot>('The sessions snapshot', {
      read: () => Promise.reject(new Error('no test asked for the sessions document')),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    remoteSessions = new SnapshotStore<RemoteConnectionsSnapshot>('The remote sessions snapshot', {
      read: () => Promise.reject(new Error('no test asked for the remote sessions document')),
      subscribe: () => () => undefined,
      reportError: () => undefined,
    })
    marks = new SessionsMarksStore(sessions)
    stopSessions = null
    installBridge()
  })

  afterEach(async () => {
    vi.useRealTimers()
    cleanup()
    stopSessions?.()
    stopSessions = null
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('draws a screen and says what it is waiting for until it is attached', () => {
    const view = mount(new PanelApiFake('terminal:1'))
    expect(view.container.querySelector('.jamat-terminal__screen')).toBeTruthy()
    expect(noteOf(view)).toBe('Connecting.')
    expect(store.get('terminal:1').primary).toMatchObject({ glyph: '·', tone: 'muted' })
  })

  it('draws the context warning over a local agent terminal', async () => {
    await withSessions(SessionsFixtures.mixed())
    await withContext('s-working')

    const view = mount(new PanelApiFake('terminal:working'), 's-working')

    expect(view.container.querySelector('[aria-label="Context usage warning"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Context is at 80%')
  })

  it('does not draw the context warning for shell or remote terminals', async () => {
    const mixed = SessionsFixtures.mixed()
    const shell = mixed.sessions.find((candidate) => candidate.kind === 'shell')
    if (shell === undefined) throw new Error('The fixture has no shell session')
    await withSessions({ ...mixed, sessions: [shell] })
    await withContext(shell.sessionId)

    const local = mount(new PanelApiFake('terminal:shell'), shell.sessionId)
    const remote = mountRemote(new PanelApiFake('terminal:remote'))

    expect(local.container.querySelector('[aria-label="Context usage warning"]')).toBeNull()
    expect(remote.container.querySelector('[aria-label="Context usage warning"]')).toBeNull()
  })

  /**
   * Three of the four arms that read a remote refusal were reached by no test, and one of them is
   * what decides whether a restart is offered at all: `not-found` is the peer saying there is no
   * record left, so the button would answer its own refusal on every click.
   */
  it('offers no restart for a remote session the peer no longer knows', async () => {
    remoteAttachAnswer = {
      ok: false,
      error: { code: 'not-found', detail: 'no session remote-session' },
    }
    const view = mountRemote(new PanelApiFake('terminal:remote'))
    await act(async () => { await Promise.resolve() })

    expect(view.container.querySelector('.jamat-terminal__restart')).toBeNull()
  })

  // Merely not reachable right now is not a fact about the session, so nothing is said about it.
  it('says only that it is connecting while the peer is unavailable', async () => {
    remoteAttachAnswer = {
      ok: false,
      error: { code: 'unavailable', detail: 'the peer is offline' },
    }
    const view = mountRemote(new PanelApiFake('terminal:remote'))
    await act(async () => { await Promise.resolve() })

    expect(noteOf(view)).toBe('Connecting.')
    expect(view.container.querySelector('.jamat-terminal__restart')).toBeNull()
  })

  it('restarts a remote target through its endpoint without registering local session tools', async () => {
    const endpointId = 'remote-pc::default::stable'
    remoteAttachAnswer = {
      ok: false,
      error: { code: 'operation-failed', detail: 'the remote runtime was interrupted' },
    }
    const view = mountRemote(new PanelApiFake('terminal:remote'), endpointId, 'remote-session')
    await waitFor(() => expect(
      view.container.querySelector('.jamat-terminal__restart'),
    ).toBeTruthy())

    expect(view.getByLabelText(
      `Remote terminal ${endpointId} for session remote-session`,
    )).toBeTruthy()
    expect(inputs.submit('remote-session', '/compact')).toBe(false)
    expect(attachIds).toEqual([])
    expect(remoteAttachCalls).toHaveLength(1)
    remoteAttachAnswer = {
      ok: true,
      value: { attachId: 'filled by bridge', sessionId: 'filled by bridge' },
    }

    await act(async () => {
      const button = view.container.querySelector('.jamat-terminal__restart')
      if (!(button instanceof HTMLButtonElement)) throw new Error('no remote restart button')
      button.click()
    })

    expect(remoteReopened).toEqual([{ endpointId, sessionId: 'remote-session' }])
    expect(reopened).toEqual([])
    expect(remoteAttachCalls).toHaveLength(2)
    expect(fileChangesReads).toBe(0)
    expect(transcriptReads).toEqual([])
    expect(detectCalls).toBe(0)
  })

  describe('the file split', () => {
    const visibleFileChanges = {
      visible: true,
      width: 440,
      activeView: 'workingTree',
    }

    it('reads no file model for a live terminal with a closed sidebar and empty split', async () => {
      const view = mount(new PanelApiFake('terminal:no-file-tools'))
      push({
        type: 'terminal.attached',
        writer: true,
        session: {
          runtimeSessionId: 'session-1',
          generation: 1,
          alive: true,
          cols: 80,
          rows: 24,
          outputSeq: 0,
          outputEpoch: 1,
          lastOutputAt: null,
          startedAt: 1,
        },
      })
      await act(async () => { await Promise.resolve() })

      expect(view.container.querySelector('.jamat-panel-split__pane')).toBeNull()
      expect(fileChangesReads).toBe(0)
      expect(workingTreeReads).toEqual([])
      expect(restoredSources).toEqual([])
    })

    it('opens a File Changes row beside the terminal and releases the incoming grant', async () => {
      workingTreeAnswer = { ok: true as const, value: TerminalPanelFixtures.workingTree() }
      const openFile: TerminalPanelProps['openFile'] = vi.fn(async () => ({
        kind: 'opened' as const,
        panelId: 'file:full',
      }))
      const api = new PanelApiFake('terminal:split')
      const view = mount(api, 'session-1', {
        params: { sidebar: visibleFileChanges },
        openFile,
      })
      const terminalScreen = view.container.querySelector('.jamat-terminal__screen')

      fireEvent.click(await view.findByRole('button', { name: 'report.ts, modified' }))

      await waitFor(() => expect(
        view.container.querySelector('.jamat-panel-split__pane'),
      ).not.toBeNull())
      expect(view.container.querySelector('.jamat-panel-split__tab')?.textContent)
        .toContain('report.ts')
      const previewTab = view.container.querySelector('.jamat-panel-split__tab')
      expect(previewTab?.classList.contains('is-preview')).toBe(true)
      expect(view.container.querySelector('.jamat-terminal__screen')).toBe(terminalScreen)
      expect(openFile).not.toHaveBeenCalled()
      expect(releasedDocuments).toContain('changed-document')
      expect(PanelSplitParams.of(api.paramsValue()).items).toEqual([{
        kind: 'file',
        key: 'key:C:/work/report.ts',
        title: 'report.ts',
        source: changedDocument.source,
        baselineHint: {
          kind: 'git-head',
          revision: 'HEAD',
          workingTreeSource: 'checkpoint',
        },
      }])
      expect(PanelSplitParams.of(api.paramsValue()).preview).toBe('key:C:/work/report.ts')
      if (!(previewTab instanceof HTMLElement)) throw new Error('the preview tab is not drawn')
      fireEvent.doubleClick(previewTab)
      expect(previewTab.classList.contains('is-preview')).toBe(false)
      expect(PanelSplitParams.of(api.paramsValue()).preview).toBe(null)
      fireEvent.click(view.getByRole('button', { name: 'Close report.ts' }))
      expect(view.container.querySelector('.jamat-panel-split__pane')).toBeNull()
      expect(view.container.querySelector('.jamat-terminal__screen')).toBe(terminalScreen)
    })

    it('opens an Explorer file beside the terminal instead of a full tab', async () => {
      const openFile: TerminalPanelProps['openFile'] = vi.fn(async () => ({
        kind: 'opened' as const,
        panelId: 'file:full',
      }))
      const api = new PanelApiFake('terminal:explorer-split')
      const view = mount(api, 'session-1', {
        params: {
          sidebar: { ...visibleFileChanges, activeView: 'directoryExplorer' },
        },
        openFile,
      })

      fireEvent.click(await view.findByTitle('C:/work/report.ts'))

      await waitFor(() => expect(PanelSplitParams.of(api.paramsValue()).items).toHaveLength(1))
      expect(rootDirectoryReads).toEqual(['session-1'])
      expect(openFile).not.toHaveBeenCalled()
      expect(releasedDocuments).toContain('changed-document')
    })

    it('reports a ninth sidebar file and keeps the eight existing items', async () => {
      workingTreeAnswer = { ok: true as const, value: TerminalPanelFixtures.workingTree() }
      const items = Array.from({ length: PanelSplitParams.itemsMaxConst }, (_, index) =>
        TerminalPanelFixtures.splitItem(index + 1))
      const api = new PanelApiFake('terminal:full-split')
      const view = mount(api, 'session-1', {
        params: {
          sidebar: visibleFileChanges,
          split: { ratio: 0.5, active: items[0].key, items },
        },
      })

      fireEvent.click(await view.findByRole('button', { name: 'report.ts, modified' }))

      expect(await view.findByText(
        'The split already holds 8 files. Close one before opening another.',
      ))
        .toBeInTheDocument()
      expect(PanelSplitParams.of(api.paramsValue()).items).toHaveLength(8)
      expect(releasedDocuments).toContain('changed-document')
    })

    it('detaches into a full tab only after that tab opens', async () => {
      const item = {
        ...TerminalPanelFixtures.splitItem(1, { kind: 'git-head', revision: 'HEAD' }),
        location: { line: 1571 },
      }
      const openFile: TerminalPanelProps['openFile'] = vi.fn(async () => ({
        kind: 'opened' as const,
        panelId: 'file:detached',
      }))
      const api = new PanelApiFake('terminal:detach')
      const view = mount(api, 'session-1', {
        params: { split: { ratio: 0.61, active: item.key, items: [item] } },
        openFile,
      })

      const tab = view.container.querySelector('.jamat-panel-split__tab')
      if (!(tab instanceof HTMLElement)) throw new Error('the split tab is not drawn')
      fireEvent.contextMenu(tab, { clientX: 20, clientY: 30 })
      fireEvent.click(await view.findByRole('menuitem', { name: 'Detach from split' }))

      await waitFor(() => expect(
        view.container.querySelector('.jamat-panel-split__pane'),
      ).toBeNull())
      expect(openFile).toHaveBeenCalledWith(
        item.source,
        item.key,
        item.baselineHint,
        item.location,
      )
      expect(PanelSplitParams.of(api.paramsValue())).toMatchObject({
        ratio: 0.61,
        active: null,
        items: [],
      })
    })

    it('keeps a reopened incarnation when an older detach finishes', async () => {
      const item = TerminalPanelFixtures.splitItem(1)
      let settle: ((outcome: PanelOpenOutcome) => void) | null = null
      const openFile: TerminalPanelProps['openFile'] = vi.fn(() => new Promise<PanelOpenOutcome>((resolve) => {
        settle = resolve
      }))
      const api = new PanelApiFake('terminal:detach-aba')
      const view = mount(api, 'session-1', {
        params: { split: { ratio: 0.61, active: item.key, items: [item] } },
        openFile,
      })
      const tab = view.container.querySelector('.jamat-panel-split__tab')
      if (!(tab instanceof HTMLElement)) throw new Error('the split tab is not drawn')
      fireEvent.contextMenu(tab, { clientX: 20, clientY: 30 })
      fireEvent.click(await view.findByRole('menuitem', { name: 'Detach from split' }))
      await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1))

      api.writeParameters(PanelSplitParams.merged(api.paramsValue(), {
        ...PanelSplitParams.default(),
        ratio: 0.61,
        active: null,
        preview: null,
        items: [],
      }))
      api.writeParameters(PanelSplitParams.merged(api.paramsValue(), {
        ...PanelSplitParams.default(),
        ratio: 0.61,
        active: item.key,
        preview: null,
        items: [item],
      }))
      if (settle === null) throw new Error('the full-tab open did not start')
      await act(async () => {
        settle?.({ kind: 'opened', panelId: 'file:detached' })
        await Promise.resolve()
      })

      expect(PanelSplitParams.of(api.paramsValue()).items).toEqual([item])
      expect(await view.findByText(
        'The split changed while the full tab was opening, so its item was kept.',
      )).toBeInTheDocument()
    })

    it('finishes a pending detach after only the sidebar changes', async () => {
      const item = TerminalPanelFixtures.splitItem(1)
      let settle: ((outcome: PanelOpenOutcome) => void) | null = null
      const openFile: TerminalPanelProps['openFile'] = vi.fn(() => new Promise<PanelOpenOutcome>((resolve) => {
        settle = resolve
      }))
      const api = new PanelApiFake('terminal:detach-sidebar')
      const view = mount(api, 'session-1', {
        params: {
          sidebar: { visible: false, width: 440, activeView: null },
          split: { ratio: 0.61, active: item.key, items: [item] },
        },
        openFile,
      })
      const tab = view.container.querySelector('.jamat-panel-split__tab')
      if (!(tab instanceof HTMLElement)) throw new Error('the split tab is not drawn')
      fireEvent.contextMenu(tab, { clientX: 20, clientY: 30 })
      fireEvent.click(await view.findByRole('menuitem', { name: 'Detach from split' }))
      await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1))

      act(() => api.writeParameters({
        ...api.paramsValue(),
        sidebar: { visible: true, width: 320, activeView: 'workingTree' },
      }))
      if (settle === null) throw new Error('the full-tab open did not start')
      await act(async () => {
        settle?.({ kind: 'opened', panelId: 'file:detached' })
        await Promise.resolve()
      })

      expect(PanelSplitParams.of(api.paramsValue()).items).toEqual([])
      expect(view.queryByText(
        'The split changed while the full tab was opening, so its item was kept.',
      )).toBeNull()
    })

    it('keeps a split item when detaching its full tab fails', async () => {
      const item = TerminalPanelFixtures.splitItem(1)
      const openFile: TerminalPanelProps['openFile'] = vi.fn(async () => ({
        kind: 'failed' as const,
        detail: 'The full tab could not be opened.',
      }))
      const api = new PanelApiFake('terminal:detach-refused')
      const view = mount(api, 'session-1', {
        params: { split: { ratio: 0.5, active: item.key, items: [item] } },
        openFile,
      })

      const tab = view.container.querySelector('.jamat-panel-split__tab')
      if (!(tab instanceof HTMLElement)) throw new Error('the split tab is not drawn')
      fireEvent.contextMenu(tab, { clientX: 20, clientY: 30 })
      fireEvent.click(await view.findByRole('menuitem', { name: 'Detach from split' }))

      expect(await view.findByText('The full tab could not be opened.')).toBeInTheDocument()
      expect(PanelSplitParams.of(api.paramsValue()).items).toEqual([item])
      expect(view.container.querySelector('.jamat-panel-split__pane')).not.toBeNull()
    })

    it('hides the last closed item without forgetting the ratio', async () => {
      const item = TerminalPanelFixtures.splitItem(1)
      const api = new PanelApiFake('terminal:close-split')
      const view = mount(api, 'session-1', {
        params: { split: { ratio: 0.73, active: item.key, items: [item] } },
      })

      fireEvent.click(await view.findByRole('button', { name: 'Close file-1.ts' }))

      expect(view.container.querySelector('.jamat-panel-split__pane')).toBeNull()
      expect(PanelSplitParams.of(api.paramsValue())).toMatchObject({
        ratio: 0.73,
        active: null,
        items: [],
      })
    })

    it('restores an active pane and keeps both its Changelog and required working source alive', async () => {
      const item = TerminalPanelFixtures.splitItem(1, {
        kind: 'git-head',
        revision: 'HEAD',
        workingTreeSource: 'checkpoint',
      })
      workingTreeAnswer = { ok: true as const, value: TerminalPanelFixtures.workingTree() }
      const view = mount(new PanelApiFake('terminal:restored-split'), 'session-1', {
        params: { split: { ratio: 0.5, active: item.key, items: [item] } },
      })

      await waitFor(() => expect(restoredSources).toEqual([item.source]))
      await waitFor(() => expect(fileChangesReads).toBe(1))
      expect(workingTreeReads).toEqual(['checkpoint'])
      expect(view.container.querySelector('.jamat-panel-split__pane')).not.toBeNull()
    })

    it('does not draw or read local split state for a remote panel', async () => {
      const item = TerminalPanelFixtures.splitItem(1, {
        kind: 'git-head',
        revision: 'HEAD',
        workingTreeSource: 'checkpoint',
      })
      const view = mountRemote(
        new PanelApiFake('terminal:remote-split'),
        undefined,
        undefined,
        { split: { ratio: 0.5, active: item.key, items: [item] } },
      )
      await act(async () => { await Promise.resolve() })

      expect(view.container.querySelector('.jamat-panel-split')).toBeNull()
      expect(fileChangesReads).toBe(0)
      expect(workingTreeReads).toEqual([])
      expect(restoredSources).toEqual([])
      expect(rootDirectoryReads).toEqual([])
    })
  })

  it('says nothing at all once it is simply working', () => {
    const view = mount(new PanelApiFake('terminal:1'))
    push({
      type: 'terminal.attached',
      writer: true,
      session: {
        runtimeSessionId: 'session-1',
        generation: 1,
        alive: true,
        cols: 80,
        rows: 24,
        outputSeq: 0,
        outputEpoch: 1,
        lastOutputAt: null,
        startedAt: 1,
      },
    })
    expect(noteOf(view)).toBeNull()
    expect(store.get('terminal:1')).toEqual({ primary: null, secondary: null, badges: [] })
  })

  it('attaches again when the document refresh registry announces its session', async () => {
    mount(new PanelApiFake('terminal:1'))
    const before = [...attachIds]

    act(() => refresh.restarted('session-1'))
    await act(async () => { await Promise.resolve() })

    expect(attachIds).toHaveLength(before.length + 1)
    expect(attachIds.at(-1)).not.toBe(before.at(-1))
  })

  it('carries the library\'s own words into the note and a mark onto the tab', () => {
    const view = mount(new PanelApiFake('terminal:1'))
    push({ type: 'terminal.status', status: 'read-only', detail: 'another controller holds the Host' })
    expect(noteOf(view))
      .toBe('Read-only: what you type is not being sent. another controller holds the Host')
    expect(store.get('terminal:1').primary).toMatchObject({ tone: 'attention' })

    push({ type: 'terminal.status', status: 'lost', detail: null })
    expect(noteOf(view)).toBe('This terminal is gone.')
    expect(store.get('terminal:1').primary).toMatchObject({ tone: 'danger' })
  })

  // A session that finished on its own is not one a restart interrupted: the exit code is what
  // the panel is for reading there, and there is nothing to offer beside it.
  it('reports an exit and offers nothing beyond it', () => {
    const view = mount(new PanelApiFake('terminal:1'))
    push({ type: 'terminal.exit', runtimeSessionId: 'session-1', generation: 1, exitCode: 7 })
    expect(noteOf(view)).toBe('The session ended with exit code 7.')
    expect(view.container.querySelectorAll('.jamat-terminal button')).toHaveLength(0)
    expect(store.get('terminal:1').primary).toMatchObject({ glyph: '✕' })
  })

  /**
   * The complaint this answers: a row two inches away went green and the tab beside it stayed blank.
   * The mark is the tree's own character, taken from the same document, so the two cannot drift.
   */
  describe('the session mark', () => {
    it('draws what the sessions document says this session is doing', async () => {
      await withSessions(SessionsFixtures.mixed())
      mount(new PanelApiFake('terminal:1'), 's-working')

      expect(store.get('terminal:1').primary)
        .toEqual({ glyph: '●', tone: 'ok', title: 'working' })
    })

    it('distinguishes background work without losing the green tone', async () => {
      const mixed = SessionsFixtures.mixed()
      await withSessions({
        ...mixed,
        sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
          ? { ...session, activityDetail: 'background' as const }
          : session),
      })
      mount(new PanelApiFake('terminal:1'), 's-working')

      expect(store.get('terminal:1').primary)
        .toEqual({ glyph: '◉', tone: 'ok', title: 'background work' })
    })

    it('keeps the attachment in the second slot while the record says the session runs', async () => {
      await withSessions(SessionsFixtures.mixed())
      mount(new PanelApiFake('terminal:1'), 's-waiting')

      expect(store.get('terminal:1').primary)
        .toEqual({ glyph: '◆', tone: 'attention', title: 'waiting' })
      expect(store.get('terminal:1').secondary).toMatchObject({ glyph: '·', tone: 'muted' })
    })

    /**
     * The first badge a session tab has ever carried. It names the VCS because "commit this" is a
     * different command under git than under svn.
     */
    it('carries the uncommitted-work mark, naming the VCS that measured it', async () => {
      await withSessions(SessionsFixtures.stoppedWorktree())
      mount(new PanelApiFake('terminal:1'), 's-dirty')

      expect(store.get('terminal:1').badges).toEqual([
        { key: 'vcs', text: '*', tone: 'muted', title: 'Uncommitted changes (git)' },
      ])
    })

    it('carries no mark where the working copy was measured clean', async () => {
      await withSessions(SessionsFixtures.stoppedWorktree())
      mount(new PanelApiFake('terminal:1'), 's-clean')

      expect(store.get('terminal:1').badges).toEqual([])
    })

    it('marks a clean session red while its commit dialog remains open', async () => {
      await withSessions(SessionsFixtures.stoppedWorktree())
      const commitOpen = new CommitOpenStore({ read: async () => ({ ok: true, value: { revision: 1, sessionIds: ['s-clean'] } }), subscribe: () => () => undefined, reportError: vi.fn() })
      const stop = commitOpen.start()
      try {
        mount(new PanelApiFake('terminal:1'), 's-clean', { commitOpen })
        await waitFor(() => expect(store.get('terminal:1').badges).toEqual([
          { key: 'vcs', text: '*', tone: 'danger', title: 'Commit dialog open' },
        ]))
        expect(store.get('terminal:1').primary).toEqual({ glyph: '!', tone: 'danger', title: 'Commit review required' })
      } finally { stop() }
    })

    // Two crosses beside each other read as a bug, not as two facts.
    it('says a session is over once, not twice', async () => {
      await withSessions(SessionsFixtures.mixed())
      const view = mount(new PanelApiFake('terminal:1'), 's-ended')
      push({ type: 'terminal.exit', runtimeSessionId: 's-ended', generation: 1, exitCode: 1 })

      expect(noteOf(view)).toBe('The session ended with exit code 1.')
      expect(store.get('terminal:1').primary).toEqual({ glyph: '×', tone: 'muted', title: 'ended' })
      expect(store.get('terminal:1').secondary).toBeNull()
    })

    /**
     * The colour comes from the same document the mark does, so a session drawn on a tab and on a
     * row cannot end up two different colours.
     */
    it('publishes the colour the document gives this session, and none where it gives one', async () => {
      const mixed = SessionsFixtures.mixed()
      await withSessions({
        ...mixed,
        sessions: mixed.sessions.map((session) =>
          session.sessionId === 's-working' ? { ...session, color: 'teal' as const } : session),
      })
      mount(new PanelApiFake('terminal:1'), 's-working')
      mount(new PanelApiFake('terminal:2'), 's-waiting')

      expect(store.get('terminal:1').color).toBe('teal')
      expect(store.get('terminal:2').color).toBeUndefined()
    })

    /**
     * The panel knows an exit code and nothing else, and the code is the one thing that cannot
     * answer how it ended: a session somebody finished is killed to end it, so Windows leaves
     * `0xC000013A` behind. Saying that number back to the person who pressed Finish reads as their
     * own action having gone wrong.
     */
    it('says a session finished rather than reciting the code the kill left behind', async () => {
      await withSessions(SessionsFixtures.stoppedWorktree())
      const view = mount(new PanelApiFake('terminal:1'), 's-dirty')
      push({
        type: 'terminal.exit',
        runtimeSessionId: 's-dirty',
        generation: 1,
        exitCode: -1073741510,
      })

      expect(noteOf(view)).toBe('The session finished.')
    })

    it('keeps the code where the ending was not asked for', async () => {
      await withSessions(SessionsFixtures.mixed())
      const view = mount(new PanelApiFake('terminal:1'), 's-ended')
      push({ type: 'terminal.exit', runtimeSessionId: 's-ended', generation: 1, exitCode: 1 })

      expect(noteOf(view)).toBe('The session ended with exit code 1.')
    })

    // The record is gone but the screen is still open: the mark the panel had is better than none.
    it('falls back to the attachment when there is no record to read', async () => {
      await withSessions(SessionsFixtures.mixed())
      mount(new PanelApiFake('terminal:1'), 'session-nobody-has')

      expect(store.get('terminal:1').primary).toMatchObject({ glyph: '·', tone: 'muted' })
      expect(store.get('terminal:1').secondary).toBeNull()
    })
  })

  it('focuses the terminal when its tab becomes active, and not when it stops being', () => {
    const api = new PanelApiFake('terminal:1')
    mount(api)

    api.emitActive(false)
    expect(xtermMock.focuses).toBe(0)
    api.emitActive(true)
    expect(xtermMock.focuses).toBe(1)
  })

  /**
   * A tab that OPENS active never fires that event: it was active before this panel mounted. That is
   * every session created from the launcher, and it is the one somebody is about to type into.
   */
  it('focuses a terminal that opens already active', () => {
    mount(new PanelApiFake('terminal:1', true))

    expect(xtermMock.focuses).toBe(1)
  })

  /**
   * The two clicks dockview reports nothing for: a tab, or a tree row, of the session ALREADY in
   * front. Nothing becomes active, and the click has just taken the focus for the element under it.
   */
  it('offers its caret under its panel id, for a click that activates nothing', () => {
    mount(new PanelApiFake('terminal:1', true))
    expect(xtermMock.focuses).toBe(1)

    expect(panelFocus.focus('terminal:1')).toBe(true)

    expect(xtermMock.focuses).toBe(2)
  })

  it('takes its caret away with it when the tab goes', () => {
    const view = mount(new PanelApiFake('terminal:1', true))

    view.unmount()

    expect(panelFocus.focus('terminal:1')).toBe(false)
  })

  /** The menu is the panel's, not the hook's: the hook hands over one right click and this draws it. */
  describe('the menu a right click opens', () => {
    function labels(): string[] {
      return [...document.querySelectorAll('.jamat-context-menu__label')]
        .map((label) => label.textContent ?? '')
    }

    function rightClick(view: RenderResult): void {
      const screen = view.container.querySelector('.jamat-terminal__screen')
      if (screen === null) throw new Error('the terminal drew no screen')
      act(() => {
        screen.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
        )
      })
    }

    it('draws it where the click was, and closes it on Escape', async () => {
      const view = mount(new PanelApiFake('terminal:1'))

      rightClick(view)

      expect(document.querySelector('.jamat-context-menu')).toBeTruthy()
      expect(labels()).toEqual(['Loading…'])
      await act(async () => { await Promise.resolve() })
      expect(labels()).toEqual(['Open project in VS Code', 'Paste as text', 'Paste'])

      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
      expect(document.querySelector('.jamat-context-menu')).toBeNull()
    })

    it('takes the menu with it when the tab closes', () => {
      const view = mount(new PanelApiFake('terminal:1'))
      rightClick(view)

      view.unmount()

      expect(document.querySelector('.jamat-context-menu')).toBeNull()
    })

    /**
     * A second right click is a second menu, not the first one moved: what the first click found
     * would otherwise still be drawn - and still be clickable - over a place nobody pointed at,
     * where opening it silently succeeds for as long as the request is good for.
     */
    it('draws a second click with nothing of the first click\'s findings', async () => {
      detections = [[{
        kind: 'file',
        detectionId: 'detection-file',
        path: 'D:\\notes\\report.md',
        name: 'report.md',
        line: 12,
        column: null,
        via: 'direct',
        opensExternally: false,
      }]]
      const view = mount(new PanelApiFake('terminal:1'))

      rightClick(view)
      await act(async () => { await Promise.resolve() })
      expect(labels()).toContain('Open report.md:12')

      rightClick(view)

      expect(labels()).toEqual(['Loading…'])
      await act(async () => { await Promise.resolve() })
      expect(labels()).toEqual(['Open project in VS Code', 'Paste as text', 'Paste'])
    })

    it('opens a detected file in this panel split, never through the full-tab callback', async () => {
      detections = [[{
        kind: 'file',
        detectionId: 'detection-file',
        path: 'C:/work/report.ts',
        name: 'report.ts',
        line: 12,
        column: null,
        via: 'direct',
        opensExternally: false,
      }]]
      const api = new PanelApiFake('terminal:1')
      const openFile: TerminalPanelProps['openFile'] = vi.fn(async () => ({
        kind: 'opened' as const,
        panelId: 'full-file-tab',
      }))
      const view = mount(api, 'session-1', { openFile })

      rightClick(view)
      await act(async () => { await Promise.resolve() })
      fireEvent.click(view.getByRole('menuitem', { name: 'Open report.ts:12' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(terminalFileOpens).toEqual([
        { requestId: 'request-1', detectionId: 'detection-file' },
      ])
      expect(openFile).not.toHaveBeenCalled()
      expect(releasedDocuments).toContain('changed-document')
      expect(PanelSplitParams.of(api.paramsValue())).toMatchObject({
        active: changedDocument.documentKey,
        items: [{
          key: changedDocument.documentKey,
          title: changedDocument.name,
          source: changedDocument.source,
        }],
      })
    })

    // Every item is bound to the attach the click happened on, so an attach that has been replaced
    // leaves a menu that can only fail.
    it('takes the menu back when its session is attached again', () => {
      const view = mount(new PanelApiFake('terminal:1'))
      rightClick(view)
      expect(document.querySelector('.jamat-context-menu')).toBeTruthy()

      act(() => refresh.restarted('session-1'))

      expect(document.querySelector('.jamat-context-menu')).toBeNull()
    })
  })

  it('lets go of the dockview subscription and its decorations when it unmounts', () => {
    const api = new PanelApiFake('terminal:1')
    const view = mount(api)
    expect(api.listenerCount()).toBe(1)

    view.unmount()
    expect(api.listenerCount()).toBe(0)
    expect(store.get('terminal:1')).toEqual({ primary: null, secondary: null, badges: [] })
  })

  /**
   * A restart the person asks for, in the tab they are already looking at. The panel still holds no
   * standing opinion about liveness: it acts on a click and learns the outcome from its own attach.
   */
  describe('a session that was interrupted', () => {
    function block(view: RenderResult): HTMLElement | null {
      return view.container.querySelector('.jamat-terminal__interrupted')
    }

    function restartButton(view: RenderResult): HTMLButtonElement {
      const button = view.container.querySelector('.jamat-terminal__restart')
      if (!(button instanceof HTMLButtonElement)) throw new Error('no restart button is drawn')
      return button
    }

    async function mountRefused(
      code: string,
      detail = 'session session-1 has no live runtime',
    ): Promise<RenderResult> {
      attachAnswer = { ok: false, code, detail }
      const view = mount(new PanelApiFake('terminal:1'))
      // The refusal travels back on the attach's own promise.
      await act(async () => { await Promise.resolve() })
      return view
    }

    it('offers to start the session again when there is no live runtime', async () => {
      const view = await mountRefused('not-live')
      expect(block(view)?.textContent).toContain('This session was forcibly interrupted.')
      expect(restartButton(view)).toBeTruthy()
    })

    it('offers it when the Host could not be reached either', async () => {
      const view = await mountRefused('host-unreachable', 'no Host descriptor is published')
      expect(restartButton(view)).toBeTruthy()
    })

    // There is no record left to reopen, so the button would answer `not-found` every time.
    it('offers nothing when the session is not known any more', async () => {
      const view = await mountRefused('unknown-session', 'no session session-1')
      expect(block(view)).toBeNull()
      expect(noteOf(view)).toContain('This terminal is gone')
    })

    /**
     * What a restarted Host leaves behind. It keeps no runtimes across its own start, so the screen
     * the session exited on is gone and an attach can only be refused; until now the panel was empty
     * with an exit code under it. Both of the things that DO survive are read here.
     */
    describe('the post-mortem of a session whose runtime is gone', () => {
      function postMortem(view: RenderResult): HTMLElement | null {
        return view.container.querySelector('.jamat-postmortem')
      }

      function entryOf(fileId: string, path: string): unknown {
        return {
          fileId,
          path,
          displayPath: path,
          nodeKind: 'file',
          location: 'worktree',
          status: 'modified',
          previousPath: null,
          previousDisplayPath: null,
          modifiedAt: 1,
          size: 10,
        }
      }

      async function mountEnded(sessionId: string): Promise<RenderResult> {
        await withSessions(SessionsFixtures.stoppedWorktree())
        attachAnswer = { ok: false, code: 'not-live', detail: `session ${sessionId} is not live` }
        const view = mount(new PanelApiFake('terminal:1'), sessionId)
        await act(async () => { await Promise.resolve() })
        return view
      }

      it('says how the session ended and what it last said', async () => {
        transcriptAnswer = {
          kind: 'messages',
          messages: [{
            role: 'assistant',
            text: 'the merge is clean',
            at: 1754400001000,
            textTruncated: false,
          }],
          bounds: { maxMessages: 10, maxCharactersPerMessage: 2_000, scannedBytes: 200 },
          earlierContentOmitted: false,
        }
        const view = await mountEnded('s-dirty')
        await act(async () => { await Promise.resolve() })

        expect(postMortem(view)?.textContent).toContain('Finished')
        expect(postMortem(view)?.textContent).toContain('the merge is clean')
        expect(transcriptReads).toEqual(['s-dirty'])
      })

      /**
       * The other half of what outlives the Host: what the session changed on disk. It is the panel's
       * own read handed down, so a dead session costs one list call rather than two.
       */
      it('says how many files the session changed', async () => {
        fileChangesAnswer = {
          ok: true as const,
          value: {
            snapshotId: 'snap-1',
            sessionId: 's-dirty',
            createdAt: 1,
            vcs: { id: 'git', available: ['git'] },
            defaultBaseline: null,
            entries: [entryOf('f1', 'src/one.ts'), entryOf('f2', 'src/two.ts')],
            history: { groups: [], nextCursor: null },
            warnings: [],
          },
        }
        const view = await mountEnded('s-dirty')
        await act(async () => { await Promise.resolve() })

        await waitFor(() => expect(postMortem(view)?.textContent).toContain('2 files changed'))
      })

      // A block with the verdict is still worth having: a missing transcript says so in one line
      // rather than replacing what the panel could say with an error.
      it('keeps the verdict when there is no transcript to read', async () => {
        transcriptAnswer = {
          kind: 'none',
          code: 'transcript-not-found',
          reason: 'no transcript for this session',
        }
        const view = await mountEnded('s-dirty')
        await act(async () => { await Promise.resolve() })

        expect(postMortem(view)?.textContent).toContain('Finished')
        expect(postMortem(view)?.textContent).toContain('No transcript')
      })

      /**
       * While the Host still holds the dead runtime the screen it exited on is the better answer.
       * The session is one the snapshot DOES know, so the verdict is there and it is the attachment
       * state alone that keeps the block off - which is the guard this is about.
       */
      it('draws nothing while the screen of the exited runtime is still there', async () => {
        await withSessions(SessionsFixtures.stoppedWorktree())
        const view = mount(new PanelApiFake('terminal:1'), 's-dirty')
        push({ type: 'terminal.exit', runtimeSessionId: 's-dirty', generation: 1, exitCode: 7 })

        expect(noteOf(view)).toBe('The session finished.')
        expect(postMortem(view)).toBeNull()
        expect(transcriptReads).toEqual([])
      })

      // No record behind the panel is no verdict, and a block with nothing to say is not drawn.
      it('draws nothing for a session the snapshot knows nothing about', async () => {
        const view = await mountRefused('not-live')

        expect(postMortem(view)).toBeNull()
        expect(transcriptReads).toEqual([])
      })
    })

    /**
     * The whole point of attaching to a runtime that already exited: the screen it died on is on
     * screen, and the panel says it ended rather than offering to start what is already over.
     */
    it('shows the screen of a runtime that had already exited, and says it ended', () => {
      const view = mount(new PanelApiFake('terminal:1'))
      push({
        type: 'terminal.attached',
        writer: false,
        session: {
          runtimeSessionId: 'session-1',
          generation: 1,
          alive: false,
          cols: 80,
          rows: 24,
          outputSeq: 3,
          outputEpoch: 1,
          lastOutputAt: 2,
          startedAt: 1,
          exitCode: 1,
        },
      })

      expect(noteOf(view)).toBe('The session ended with exit code 1.')
      expect(block(view)).toBeNull()
      expect(store.get('terminal:1').primary).toMatchObject({ glyph: '✕' })
    })

    // A signalled process leaves no code behind, and "read-only" would read as somebody else holding
    // the lease rather than as a terminal there is nothing left to type at.
    it('says a runtime that exited without a code has ended', () => {
      const view = mount(new PanelApiFake('terminal:1'))
      push({
        type: 'terminal.attached',
        writer: false,
        session: {
          runtimeSessionId: 'session-1',
          generation: 1,
          alive: false,
          cols: 80,
          rows: 24,
          outputSeq: 3,
          outputEpoch: 1,
          lastOutputAt: 2,
          startedAt: 1,
        },
      })

      expect(noteOf(view)).toBe('The session has ended.')
      expect(block(view)).toBeNull()
    })

    it('offers nothing once the session has simply ended', () => {
      const view = mount(new PanelApiFake('terminal:1'))
      push({
        type: 'terminal.exit',
        runtimeSessionId: 'session-1',
        generation: 1,
        exitCode: 0,
      })
      expect(block(view)).toBeNull()
    })

    it('attaches again after a reopen it accepted, into the same panel', async () => {
      const view = await mountRefused('not-live')
      const first = [...attachIds]
      attachAnswer = { ok: true }

      await act(async () => { restartButton(view).click() })

      expect(reopened).toEqual(['session-1'])
      expect(attachIds).toHaveLength(first.length + 1)
      expect(attachIds.at(-1)).not.toBe(first.at(-1))
      expect(block(view)).toBeNull()
      expect(noteOf(view)).toBe('Connecting.')
    })

    it('says why a refused reopen was refused, and attaches nothing', async () => {
      const view = await mountRefused('not-live')
      const before = attachIds.length
      reopenAnswer = { ok: false, code: 'launch-pending', detail: 'a launch is waiting' }

      await act(async () => { restartButton(view).click() })

      expect(attachIds).toHaveLength(before)
      expect(block(view)?.textContent).toContain('launch-pending: a launch is waiting')
      expect(restartButton(view)).toBeTruthy()
    })

    /**
     * A rejected invoke is not a refusal the handler wrote: a handler that is not there, a frame
     * torn down mid-call. The latch that stops a second click while one is in flight was released
     * only on the returned path, so one rejection left the button live-looking, silent and dead for
     * the rest of the panel's life.
     */
    it('says why a thrown reopen failed, and can be clicked again', async () => {
      const view = await mountRefused('not-live')
      reopenRejects = 'the frame was torn down'

      await act(async () => { restartButton(view).click() })

      expect(block(view)?.textContent).toContain('the frame was torn down')
      expect(reopened).toEqual(['session-1'])

      reopenRejects = null
      attachAnswer = { ok: true }
      await act(async () => { restartButton(view).click() })

      expect(reopened).toEqual(['session-1', 'session-1'])
      expect(block(view)).toBeNull()
    })

    /**
     * Whether a session can come back is the library's answer and it rides on `admits`. The sessions
     * tree already asks it; this surface decided alone out of three fields of attach state, so one
     * operation had two answers and the losing one drew a button whose only reply is a refusal.
     */
    it('offers nothing where the record does not admit a restart', async () => {
      await withSessions(SessionsFixtures.mixed())
      attachAnswer = { ok: false, code: 'not-live', detail: 'session s-home has no live runtime' }
      const view = mount(new PanelApiFake('terminal:1'), 's-home')
      await act(async () => { await Promise.resolve() })

      expect(block(view)).toBeNull()
    })

    /**
     * The screen can be lost while the session is not, and that is what a paste past the wire's size
     * did: the Host refused the frame, the attach ended, and the record went on saying `live`. The
     * button offered there was Restart, whose only possible answer is `live-refused` - so the way
     * back is another attach, and nobody is asked to start what never stopped.
     */
    describe('a screen lost from under a session that is still running', () => {
      async function mountLive(): Promise<RenderResult> {
        await withSessions(SessionsFixtures.mixed())
        const view = mount(new PanelApiFake('terminal:1'), 's-working')
        await act(async () => { await Promise.resolve() })
        push({ type: 'terminal.status', status: 'lost', detail: 'the Host refused a terminal frame' })
        return view
      }

      it('offers a reconnect rather than a restart', async () => {
        const view = await mountLive()

        expect(restartButton(view).textContent).toBe('Reconnect')
        expect(block(view)?.textContent).toContain('The session is still running.')
      })

      it('attaches again on the click, and asks the library for nothing', async () => {
        const view = await mountLive()
        const first = [...attachIds]

        await act(async () => { restartButton(view).click() })

        expect(reopened).toEqual([])
        expect(attachIds).toHaveLength(first.length + 1)
        expect(attachIds.at(-1)).not.toBe(first.at(-1))
        expect(block(view)).toBeNull()
      })

      // The same loss on a record that is NOT running keeps the offer it always had.
      it('still offers a restart where the record has ended', async () => {
        await withSessions(SessionsFixtures.mixed())
        attachAnswer = { ok: false, code: 'not-live', detail: 'session s-lost has no live runtime' }
        const view = mount(new PanelApiFake('terminal:1'), 's-lost')
        await act(async () => { await Promise.resolve() })

        expect(restartButton(view).textContent).toBe('Restart session')

        await act(async () => { restartButton(view).click() })

        expect(reopened).toEqual(['s-lost'])
      })
    })

    /**
     * The bumped epoch disposes one terminal and builds another. Nothing else in the focus effect's
     * list moves with it and the tab was already active, so no activation event fires: the panel was
     * left holding a live terminal that owned no focus, and typing went nowhere until it was clicked.
     */
    it('focuses the terminal the restart built, without a click', async () => {
      mount(new PanelApiFake('terminal:1', true))
      expect(xtermMock.focuses).toBe(1)

      await act(async () => { refresh.restarted('session-1') })

      expect(xtermMock.focuses).toBe(2)
    })
  })

  /**
   * The second of the three things that stop a command reaching the wrong session. The bar knows a
   * session id; what it finds under it is the very panel holding that session's attach, and the
   * bytes leave through that attach and no other. The main process's ownership check on
   * `terminal:input` sits under all of this, untouched.
   */
  describe('the way into this session the bar writes through', () => {
    function live(sessionId: string, ownAttachId: string): void {
      act(() => {
        for (const listener of [...listeners])
          listener(ownAttachId, {
            type: 'terminal.attached',
            writer: true,
            session: {
              runtimeSessionId: sessionId,
              generation: 1,
              alive: true,
              cols: 80,
              rows: 24,
              outputSeq: 0,
              outputEpoch: 1,
              lastOutputAt: null,
              startedAt: 1,
            },
          })
      })
    }

    it('registers its session while it is mounted, and writes through its own attach', () => {
      mount(new PanelApiFake('terminal:1'), 'session-1')
      const own = attachIds.at(-1) ?? ''
      live('session-1', own)
      vi.useFakeTimers()

      expect(inputs.submit('session-1', '/compact')).toBe(true)
      expect(xtermMock.focuses).toBe(1)
      expect(inputCalls).toEqual([{ attachId: own, data: '/compact' }])

      act(() => vi.advanceTimersByTime(100))
      expect(inputCalls).toEqual([
        { attachId: own, data: '/compact' },
        { attachId: own, data: '\r' },
      ])
    })

    it('refuses while its own surface is not live, and writes nothing', () => {
      mount(new PanelApiFake('terminal:1'), 'session-1')

      expect(inputs.submit('session-1', '/compact')).toBe(false)
      expect(xtermMock.focuses).toBe(1)
      expect(inputCalls).toEqual([])
    })

    it('gives each session beside it an entry of its own', () => {
      mount(new PanelApiFake('terminal:1'), 'session-1')
      const first = attachIds.at(-1) ?? ''
      mount(new PanelApiFake('terminal:2'), 'session-2')
      const second = attachIds.at(-1) ?? ''
      live('session-1', first)
      live('session-2', second)
      vi.useFakeTimers()

      expect(inputs.submit('session-2', '/compact')).toBe(true)
      expect(xtermMock.focuses).toBe(1)
      expect(inputCalls).toEqual([{ attachId: second, data: '/compact' }])

      act(() => vi.advanceTimersByTime(100))
      expect(inputCalls).toEqual([
        { attachId: second, data: '/compact' },
        { attachId: second, data: '\r' },
      ])
    })

    it('takes its registration back when the tab is closed', () => {
      const view = mount(new PanelApiFake('terminal:1'), 'session-1')
      live('session-1', attachIds.at(-1) ?? '')

      view.unmount()

      expect(inputs.submit('session-1', '/compact')).toBe(false)
      expect(inputCalls).toEqual([])
    })
  })

  // The panel id is derived from the params, so a panel opened without one would look like a
  // terminal and attach to nothing.
  it('refuses to be opened without a session', () => {
    const api = new PanelApiFake('terminal:1')
    expect(() => render(
      <TabDecorationsProvider store={store}>
        <TerminalPanel
          {...api.props({})}
          refresh={refresh}
          inputs={inputs}
          drafts={drafts}
          panelFocus={panelFocus}
          sessions={sessions}
          remoteSessions={remoteSessions}
          sessionModel={sessionModel}
          settings={settings}
          compact={compact}
          compaction={{ inspect: () => Promise.resolve({ reason: 'Test session', nextCheckAt: null, cooldown: null }) }}
          marks={marks}
          commitOpen={new CommitOpenStore({ read: async () => ({ ok: true, value: { revision: 0, sessionIds: [] } }), subscribe: () => () => undefined, reportError: vi.fn() })}
          fileTools={new PanelFileToolsRegistry()}
          openFile={() => Promise.resolve({ kind: 'opened', panelId: 'file:invalid' })}
          openDirectoryAt={() => undefined}
        />
      </TabDecorationsProvider>,
    )).toThrow(/without a session/)
  })
})
