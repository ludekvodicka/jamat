import type { IDockviewPanelProps } from 'dockview'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { FileChangesVcsId } from '../../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type {
  FileViewerDocument,
  FileViewerDocumentSource,
  FileViewerLocation,
} from '../../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type {
  SessionColorName,
  SessionInfo,
  SessionOutcome,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  RemoteConnectionsSnapshot,
} from '../../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import { ErrorText } from '../../../shared/errorText'
import {
  type TerminalPanelReading,
  TerminalTargetCodec,
} from '../../../shared/terminalTarget'
import { FileToolsSidebar } from '../../fileViewer/fileToolsSidebar'
import { CommitPane } from '../../versioning/commitPane'
import { IpcFailure } from '../../ipc/ipcFailure'
import { type CommitOpenStore, useCommitOpen } from '../../versioning/commitOpenStore'
import { FileViewerPane } from '../../fileViewer/fileViewerPane'
import type { AgentSettingsStore } from '../../contextCompaction/agentSettingsStore'
import { ContextCompactionPanel } from '../../contextCompaction/contextCompactionPanel'
import type { SessionCompact } from '../../contextCompaction/sessionCompact'
import type { ContextCompactionController } from '../../contextCompaction/contextCompactionController'
import type { FileViewerBaselineHint } from '../../fileViewer/fileViewerPanel.types'
import { PanelFileToolsRegistry } from '../../fileViewer/panelFileToolsRegistry'
import { useFileChanges } from '../../fileViewer/useFileChanges'
import { useWorkingTreeChanges } from '../../fileViewer/useWorkingTreeChanges'
import type { SnapshotStore } from '../../ipc/snapshotStore'
import type { SessionModelStore } from '../../sessionModel/sessionModelStore'
import type { PanelFocusRegistry } from '../../shell/panelFocusRegistry'
import type { PanelOpenOutcome } from '../../shell/appShell.types'
import type { SessionRefreshRegistry } from '../../shell/sessionRefreshRegistry'
import type { TerminalDraftRegistry } from '../../shell/terminalDraftRegistry'
import type { TerminalInputRegistry } from '../../shell/terminalInputRegistry'
import type { SessionsMarksStore } from '../../sessions/sessionsMarksStore'
import { useSessionMarked } from '../../sessions/useSessionMarked'
import { type SessionGlyph, SessionNodeState } from '../../views/sessionsTree/sessionNodeState'
import type { TabDecorations, TabSignal } from '../../widgets/tabs/tabDecorations'
import { useTabDecorationsPublisher } from '../../widgets/tabs/tabDecorationsContext'
import { SidebarDock } from '../../widgets/sidebar/sidebarDock'
import { ContextMenu } from '../../widgets/contextMenu'
import { PanelSidebarLayout, usePanelSidebar } from '../../widgets/tabs/panelSidebar'
import {
  type PanelSplitItem,
  PanelSplitLayout,
  PanelSplitParams,
  PanelSplitStrip,
  usePanelSplit,
} from '../../widgets/tabs/panelSplit'
import './terminalPanel.css'
import { TerminalContextMenu } from './menu/terminalContextMenu'
import { TerminalPostMortem } from './view/terminalPostMortem'
import { TerminalTransports } from './attach/terminalTransport'
import { useTerminalSessionInfo } from './attach/useTerminalSessionInfo'
import {
  type TerminalMenuContext,
  type TerminalSurfaceState,
  useTerminalAttachment,
} from './attach/useTerminalAttachment'

/**
 * What a lost screen offers: another attach to a session that is still running, a fresh start for one
 * that is not, or nothing at all where neither would work.
 */
type TerminalRecovery = 'reconnect' | 'restart' | null

export type TerminalPanelProps = IDockviewPanelProps & {
  /** How the shell tells this panel that it started the session again. */
  refresh: SessionRefreshRegistry
  /** Where this panel offers its session's terminal to synthetic terminal commands. */
  inputs: TerminalInputRegistry
  /** And where it reports the keys, so a synthetic command never lands in a half-written prompt. */
  drafts: TerminalDraftRegistry
  /** And where it offers the caret, for the clicks dockview reports no activation for. */
  panelFocus: PanelFocusRegistry
  /** Read for the tab's mark alone. What is on the screen still comes from the attach. */
  sessions: SnapshotStore<SessionsSnapshot>
  remoteSessions: SnapshotStore<RemoteConnectionsSnapshot>
  sessionModel: SessionModelStore
  settings: AgentSettingsStore
  compact: SessionCompact
  compaction: Pick<ContextCompactionController, 'inspect'>
  /** What this window has seen. A tab draws the same mark a tree row does, off the same answer. */
  marks: SessionsMarksStore
  commitOpen: CommitOpenStore
  fileTools: PanelFileToolsRegistry
  openFile(
    source: FileViewerDocumentSource,
    documentKey: string,
    baselineHint?: FileViewerBaselineHint,
    location?: FileViewerLocation,
  ): Promise<PanelOpenOutcome>
  /** A directory tab at a path the main process proved, opened from the terminal's menu. */
  openDirectoryAt(sessionId: string, path: string, directoryKey: string): void
}

/**
 * A session, on screen at last.
 *
 * The SCREEN draws what the attach sends and asks nothing else: the panel holds no standing opinion
 * about whether a session is alive, and nothing below the tab is decided by the sessions document.
 * The TAB is the one exception, and it is not the screen: its first mark is the session's own work
 * state, read from the same document the tree reads, because a tab that stays blank while a row two
 * inches away turns green is one session drawn two ways.
 *
 * What has moved is that a dead panel is no longer a FINAL state. A session a restart interrupted
 * can be started again from here, on a click, and the only thing the panel learns from that is the
 * answer to its own next attach - which is where every other thing it knows comes from too.
 *
 * The panel is never remounted by hiding, revealing, dragging or splitting a tab; the lifecycle
 * probe panel beside this one is the proof, and it is what lets an attach live as long as the tab.
 */
export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const reading = TerminalPanelState.readingOf(props.params)
  const target = reading.target
  const targetKey = TerminalTargetCodec.key(target)
  const sessionId = target.sessionId
  /*
    * Local or remote, decided once. What the panel asks of it is not what the attachment asks -
    * there is no attach here - but it is the same fact, and it used to be re-decided at six sites
    * in this file beside the eleven in the hook.
    */
  const transport = useMemo(() => TerminalTransports.of(target), [targetKey])
  const localTools = transport.localTools
  const [attachEpoch, setAttachEpoch] = useState(0)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  const [menu, setMenu] = useState<TerminalMenuContext | null>(null)
  /**
   * What the terminal menu refused, said where the person who clicked is looking. It reached
   * `console.error` alone before, and the sentence it carries has an instruction in it: a detection
   * has a time to live, so the answer to "nothing opened" is usually "right-click it again".
   */
  const [menuNote, setMenuNote] = useState<string | null>(null)
  const restarting = useRef(false)
  const info = useTerminalSessionInfo(props.sessions, props.remoteSessions, target)
  const readAgent = useCallback(() => info?.agent?.agentId ?? null, [info])
  const openMenu = useCallback((context: TerminalMenuContext | null) => {
    // A new right click is a new question, so the last refusal stops being the answer to it.
    setMenuNote(null)
    setMenu(context)
  }, [])
  // Local only, like the registry beside it: what reads this types into a local session's prompt,
  // and a remote screen's keys are that machine's business.
  const { drafts } = props
  const onTyped = useCallback(
    (data: string) => { if (localTools) drafts.typed(sessionId, data) },
    [drafts, localTools, sessionId],
  )
  const { state, focus, sendCommand, setActive } = useTerminalAttachment(
    target,
    holder,
    attachEpoch,
    readAgent,
    openMenu,
    onTyped,
  )
  const publish = useTabDecorationsPublisher(props.api.id)
  const glyph = info === null
    ? null
    : SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail)
  const outcome = info?.outcome ?? null
  const endedAt = info?.endedAt ?? null
  const color = info?.color ?? null
  const marked = useSessionMarked(props.marks, targetKey)
  const dirtyVcs = info?.vcs?.dirty === true ? info.vcs.vcsId : null
  const openCommits = useCommitOpen(props.commitOpen)
  const commitOpen = localTools && openCommits.has(sessionId)
  const sidebar = usePanelSidebar(props, 'workingTree')
  const split = usePanelSplit(props)
  const splitRef = useRef(split)
  const commitPanes = useRef<HTMLDivElement>(null)
  const focusPanel = useCallback(() => {
    const pane = commitPanes.current?.querySelector<HTMLElement>('.commit-pane-slot:not([hidden]) .commit-pane')
    if (pane) pane.focus()
    else focus()
  }, [focus])
  useLayoutEffect(() => { splitRef.current = split }, [split])
  const toolsTab = PanelFileToolsRegistry.tab(sidebar.state.activeView)
  const activeItem = split.state.items.find((item) => item.key === split.state.active) ?? null
  const requiredWorkingTreeSource = localTools && activeItem?.kind === 'file'
    ? activeItem?.baselineHint?.workingTreeSource
    : undefined
  // One read for all readers. Every visible pane gets the full Changelog target set; a working-tree
  // hint asks its exact source from the second model below without creating another model.
  const changes = useFileChanges(
    sessionId,
    localTools && (
      (sidebar.state.visible && toolsTab === 'fileChanges')
      || TerminalPanelState.showsPostMortem(state)
      || split.state.items.length > 0
    ),
  )
  const workingTree = useWorkingTreeChanges(
    sessionId,
    localTools && sidebar.state.visible && toolsTab === 'workingTree',
    requiredWorkingTreeSource,
  )

  const openSplitItem = useCallback((item: PanelSplitItem): string | null =>
    splitRef.current.open(item), [])
  const openInSplit = useCallback((
    document: FileViewerDocument,
    baselineHint?: FileViewerBaselineHint,
    location?: FileViewerLocation,
  ): string | null => openSplitItem({
    kind: 'file',
    key: document.documentKey,
    title: document.name,
    source: document.source,
    baselineHint,
    location,
  }), [openSplitItem])

  const openCommitItem = useCallback((vcs: FileChangesVcsId, scopeRoot = '.'): void => {
    void window.appClient.versioning.openCommitTab(sessionId, vcs, scopeRoot).then((answer) => setMenuNote(IpcFailure.of(answer)))
  }, [sessionId])

  const detach = useCallback(async (key: string): Promise<void> => {
    const capture = splitRef.current.capture(key)
    if (capture === null || capture.item.kind === 'commit') return
    let detached: PanelOpenOutcome
    try {
      detached = await props.openFile(
        capture.item.source,
        capture.item.key,
        capture.item.baselineHint,
        capture.item.location,
      )
    }
    catch (error) {
      setMenuNote(ErrorText.of(error))
      return
    }
    if (detached.kind === 'failed')
      setMenuNote(detached.detail)
    else if (detached.kind === 'opened' || detached.kind === 'focusedExisting') {
      setMenuNote(splitRef.current.closeCaptured(capture)
        ? null
        : 'The split changed while the full tab was opening, so its item was kept.')
    }
    else
      throw new Error(`Unknown panel open outcome: ${JSON.stringify(detached)}`)
  }, [props.openFile])

  // The chain restarts sessions with no tab as well; a panel that IS open says so, and is told to
  // attach again once its own session came back. What that produced is still its own attach's answer.
  const { refresh } = props
  useEffect(
    () => refresh.registerRefresh(targetKey, () => setAttachEpoch((epoch) => epoch + 1)),
    [refresh, targetKey],
  )

  // The panel that HOLDS the attach is the one that offers the way into it, so a command can reach
  // this session without knowing an attach id or owning one. What it registers refuses
  // by itself while the surface is not live, and the unregister retires this entry alone.
  const { inputs } = props
  useEffect(() => {
    if (!localTools) return
    return inputs.register(sessionId, {
      writable: () => state.status === 'live',
      write: sendCommand,
      focus,
    })
  }, [focus, inputs, localTools, sessionId, sendCommand, state.status])

  // The same way in, for the caret alone, and for every terminal rather than the local ones: a
  // remote screen is typed into too. What reads it is a tab or a tree row that was clicked while
  // this panel was ALREADY in front - dockview reports no activation for that, and the click has
  // just taken the focus for the element under it.
  const { panelFocus } = props
  useEffect(
    () => panelFocus.register(props.api.id, focusPanel),
    [focusPanel, panelFocus, props.api.id],
  )

  /**
   * Start the session again, into this same tab. The panel id is derived from the session id, so
   * nothing about the layout moves; what the reopen produced is learnt from the fresh attach the
   * bumped epoch mints, and a refusal is a sentence under the button rather than a state of its own.
   */
  const restart = useCallback(async (): Promise<void> => {
    if (restarting.current) return
    restarting.current = true
    let refusal: string | null
    // The latch is released whatever happened. Only a returned refusal used to release it, so a
    // rejected invoke - a handler that is not there, a frame torn down mid-call - left the ref true
    // and every later click a no-op, on a button that still looked live and said nothing.
    try {
      refusal = await transport.reopen()
    }
    catch (error) {
      setRestartNote(ErrorText.of(error))
      return
    }
    finally {
      restarting.current = false
    }
    if (refusal !== null) {
      setRestartNote(refusal)
      return
    }
    setRestartNote(null)
    setAttachEpoch((epoch) => epoch + 1)
  }, [transport])

  /**
   * The session never stopped, so nothing is started: the screen is asked for again. One bumped
   * epoch is the whole of it, which is what the reopen above does once its own operation returned.
   */
  const reconnect = useCallback((): void => {
    setRestartNote(null)
    setAttachEpoch((epoch) => epoch + 1)
  }, [])

  useEffect(
    () => publish(TerminalPanelState.decorationsOf(state, glyph, color, marked, dirtyVcs, commitOpen)),
    [publish, state, glyph, color, marked, dirtyVcs, commitOpen],
  )

  useEffect(() => {
    if (!localTools) return
    return props.fileTools.register(props.api.id, {
      toggle: sidebar.toggle,
      open: sidebar.open,
    })
  }, [localTools, props.api.id, props.fileTools, sidebar.open, sidebar.toggle])

  // Activating a tab is what puts the caret back where someone is about to type. `terminal.focus()`
  // is what reaches the hidden textarea xterm actually listens on. A tab that OPENS active never
  // fires that event - it was already active before this subscribed - so the state is read once as
  // well: a session created from the launcher is one somebody is about to type into.
  useEffect(() => {
    if (props.api.isActive) {
      setActive(true)
      focusPanel()
    }
    const disposable = props.api.onDidActiveChange((event) => {
      setActive(event.isActive)
      if (event.isActive) focusPanel()
    })
    return () => {
      setActive(false)
      disposable.dispose()
    }
    // attachEpoch is in here because the bump disposes one terminal and builds another. Nothing else
    // in the list moves with it, and the tab was already active, so no activation event fires: the
    // panel was left holding a live terminal that owned no focus and typing went nowhere.
  }, [props.api, focusPanel, setActive, attachEpoch])

  const note = TerminalPanelState.noteOf(state, outcome)
  const recovery = TerminalPanelState.recoveryOf(state, info)
  const terminal = (
    <section className="jamat-terminal" aria-label={transport.label}>
      <div className="jamat-terminal__screen" ref={holder} />
      {localTools && (
        <ContextCompactionPanel
          session={info}
          sessionModel={props.sessionModel}
          settings={props.settings}
          compact={props.compact}
          controller={props.compaction}
        />
      )}
      {recovery !== null && (
        <div className="jamat-terminal__interrupted">
          <p className="jamat-terminal__interrupted-text">
            {recovery === 'reconnect'
              ? 'This terminal lost its screen. The session is still running.'
              : 'This session was forcibly interrupted.'}
          </p>
          <button
            className="jamat-terminal__restart"
            type="button"
            onClick={() => { if (recovery === 'reconnect') reconnect(); else void restart() }}
          >
            {recovery === 'reconnect' ? 'Reconnect' : 'Restart session'}
          </button>
          {restartNote !== null && <p className="jamat-terminal__note">{restartNote}</p>}
        </div>
      )}
      {note !== null && <p className="jamat-terminal__note">{note}</p>}
      {menuNote !== null && <p className="jamat-terminal__note">{menuNote}</p>}
      {localTools && outcome !== null && TerminalPanelState.showsPostMortem(state) && (
        <TerminalPostMortem
          sessionId={sessionId}
          outcome={outcome}
          endedAt={endedAt}
          changes={changes}
        />
      )}
      {menu?.kind === 'local' && (
        <TerminalContextMenu
          key={menu.clickId}
          context={menu}
          sessionId={sessionId}
          openInSplit={(document, location) => openInSplit(document, undefined, location)}
          openDirectoryAt={props.openDirectoryAt}
          onRefused={setMenuNote}
          onClose={() => setMenu(null)}
        />
      )}
      {menu?.kind === 'remote' && (
        <ContextMenu
          key={menu.clickId}
          position={menu.position}
          ariaLabel="Remote terminal actions"
          // A remote menu is only ever opened over a selection, so Copy is the whole of it. The
          // empty arm this used to carry could not happen and said it could.
          items={[{ key: 'copy', label: 'Copy', onSelect: menu.copySelection }]}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
  if (!localTools) return terminal
  const content = (
    <PanelSplitLayout
      ratio={split.state.ratio}
      strip={(
        <PanelSplitStrip
          items={split.state.items}
          active={split.state.active}
          preview={split.state.preview}
          onActivate={(key) => { split.activate(key); requestAnimationFrame(focusPanel) }}
          onKeepOpen={split.keepOpen}
          onClose={split.close}
          onDetach={(key) => { void detach(key) }}
        />
      )}
      pane={activeItem === null
        ? null
        : (<>
          {activeItem.kind === 'file' && <FileViewerPane
            key={activeItem.key}
            item={activeItem}
            changes={changes}
            workingTree={workingTree}
            backPath={PanelSplitParams.backTargetOf(split.state)?.source.path ?? null}
            onBack={() => setMenuNote(splitRef.current.back())}
            onOpenItem={openSplitItem}
            onRefused={setMenuNote}
          />}
          <div ref={commitPanes} className="commit-pane-slots">{split.state.items.map((item) => {
            if (item.kind === 'file') return null
            else if (item.kind === 'commit') return <div key={item.key} className="commit-pane-slot" hidden={item.key !== activeItem.key}>
              <CommitPane sessionId={sessionId} item={item} onClose={() => split.close(item.key)}
                onOpenChanged={(value) => openInSplit(value.document, value.baselineHint ?? undefined)}
                onOpenSeparately={(root) => openCommitItem(item.vcs, root)} />
            </div>
            else throw new Error(`Unknown split item: ${JSON.stringify(item)}`)
          })}</div>
        </>)}
      onResize={split.resize}
    >
      {terminal}
    </PanelSplitLayout>
  )
  return (
    <PanelSidebarLayout
      side="right"
      sidebar={(
        <SidebarDock
          side="right"
          title="File tools"
          width={sidebar.state.width}
          hidden={!sidebar.state.visible}
          onResize={sidebar.resize}
          onClose={sidebar.toggle}
        >
          <FileToolsSidebar
            sessionId={sessionId}
            documentId={null}
            selected={toolsTab}
            changes={changes}
            workingTree={workingTree}
            onSelect={sidebar.open}
            onOpenCommit={localTools && info?.life === 'live' ? openCommitItem : undefined}
            onOpenChanged={(value) => {
              setMenuNote(openInSplit(value.document, value.baselineHint ?? undefined))
              void window.appClient.fileViewer.release(value.document.documentId)
            }}
            onOpenDocument={(document) => {
              setMenuNote(openInSplit(document))
              void window.appClient.fileViewer.release(document.documentId)
            }}
          />
        </SidebarDock>
      )}
    >
      {content}
    </PanelSidebarLayout>
  )
}

class TerminalPanelState {
  /**
   * The panel id is derived from these params, so a missing one would open a second tab that looks
   * like the first and attaches to nothing. It is a wiring mistake and it says so.
   */
  static readingOf(params: Record<string, unknown>): TerminalPanelReading {
    const reading = TerminalTargetCodec.read(params)
    if (reading === null)
      throw new Error(`A terminal panel was opened without a session target: ${JSON.stringify(params)}`)
    return reading
  }

  /**
   * Whether starting the session again is worth offering. An `unknown-session` has no record left
   * to reopen, so the reopen would answer `not-found` every time; an exit code is the session
   * finishing rather than being interrupted, and there the code is what the panel is for reading.
   */
  /**
   * The way back from a lost screen, and there are two of them.
   *
   * A screen can be lost while the SESSION is not: a frame the Host refused, a socket that will not
   * come back on its own. Reopening such a session is refused - `live-refused`, in those words, under
   * a button labelled Restart - and what it actually wants is another attach, which this panel mints
   * by itself. So a running session is offered a reconnect and nothing is asked of the library.
   *
   * Whether a session that is NOT running can come back is the library's answer, and `admits` is
   * where it is written. Deciding it here alone made this surface and the sessions tree answer
   * differently about one operation, and a button whose only answer is a refusal is worse than no
   * button. A session whose snapshot has not arrived keeps the old answer rather than losing the
   * offer to a missing read.
   */
  static recoveryOf(state: TerminalSurfaceState, info: SessionInfo | null): TerminalRecovery {
    if (state.ended || state.status !== 'lost' || state.refusalCode === 'unknown-session')
      return null
    // `live` alone, not `starting`: a starting record belongs to the reconciler, which is the same
    // reason the library admits no restart under one.
    if (info?.life === 'live') return 'reconnect'
    if (info === null || info.admits.includes('restart')) return 'restart'
    return null
  }

  /**
   * Nothing while it simply works: a line under every terminal is a line nobody reads.
   *
   * The verdict comes first where there is one. A session somebody finished is killed to end it, so
   * the code it left behind is whatever the platform gives a killed process, and reporting that
   * number tells the reader their own Finish went wrong. Where the library has nothing to say - a
   * panel with no record behind it - the code is still the best the panel has.
   */
  static noteOf(state: TerminalSurfaceState, outcome: SessionOutcome | null): string | null {
    if (outcome === 'finished' && state.ended) return 'The session finished.'
    if (state.exitCode !== null) return `The session ended with exit code ${state.exitCode}.`
    // It is over and the Host had no code to give for it, which a signalled process leaves behind.
    if (state.ended) return TerminalPanelState.withDetail('The session has ended', state.detail)
    if (state.status === 'live') return null
    if (state.status === 'connecting') return TerminalPanelState.withDetail('Connecting', state.detail)
    if (state.status === 'read-only')
      return TerminalPanelState.withDetail('Read-only: what you type is not being sent', state.detail)
    if (state.status === 'lost') return TerminalPanelState.withDetail('This terminal is gone', state.detail)
    throw new Error(`Unknown terminal status: ${JSON.stringify(state.status)}`)
  }

  private static withDetail(text: string, detail: string | null): string {
    return detail === null ? `${text}.` : `${text}. ${detail}`
  }

  /**
   * The two marks a session tab carries. The tab has room for marks, not for the sentence: the note
   * under the screen carries that.
   *
   * The first says what the SESSION is doing and comes from the document the tree reads, so the two
   * cannot disagree. The second says what THIS attachment is doing, and only while the record still
   * claims the session runs: once the record itself says ended or lost, the attachment saying so
   * again is the same sentence twice, drawn as two crosses beside each other.
   *
   * With no record to read - a snapshot that has not arrived, a session removed from it - the first
   * mark falls back to the attachment, because a blank tab beside a dead screen says less than the
   * mark the panel already had.
   */
  static decorationsOf(
    state: TerminalSurfaceState,
    glyph: SessionGlyph | null,
    color: SessionColorName | null,
    marked: boolean,
    dirtyVcs: FileChangesVcsId | null,
    commitOpen: boolean,
  ): TabDecorations {
    const attachment = TerminalPanelState.attachmentSignalOf(state)
    // The first badge a session tab has ever published. Muted on purpose: it is worth noticing
    // while reading the strip, never worth looking at first.
    const badges = dirtyVcs === null && !commitOpen
      ? []
      : [{
        key: 'vcs',
        text: '*',
        tone: commitOpen ? 'danger' as const : 'muted' as const,
        title: commitOpen ? 'Commit dialog open' : `Uncommitted changes (${dirtyVcs})`,
      }]
    // Undefined rather than null where there is none: the tab puts it straight on an attribute, and
    // an attribute set to nothing is an attribute the CSS still matches.
    const painted = color === null ? {} : { color }
    if (commitOpen)
      return { primary: { glyph: '!', tone: 'danger', title: 'Commit review required' },
        secondary: glyph === null ? attachment : TerminalPanelState.sessionSignalOf(glyph, marked), badges, ...painted }
    if (glyph === null)
      return { primary: attachment, secondary: null, badges, ...painted }
    return {
      primary: TerminalPanelState.sessionSignalOf(glyph, marked),
      secondary: glyph === 'ended' || glyph === 'lost' ? null : attachment,
      badges,
      ...painted,
    }
  }

  /**
   * The session's own state, spelled with the tree's character, the tree's colour and the tree's
   * wording. There is no second derivation here on purpose: a paint IS a tone, so the tab reads
   * the same ladder the row does and the two cannot disagree about one session.
   *
   * This is also where a tab gained an unseen mark at all - it had none before the ladder.
   */
  private static sessionSignalOf(glyph: SessionGlyph, marked: boolean): TabSignal {
    return {
      glyph: SessionNodeState.characterOf(glyph, marked),
      tone: SessionNodeState.paintOf(glyph, marked),
      title: SessionNodeState.glyphTitleOf(glyph, marked),
    }
  }

  /**
   * Whether there is nothing left to look at, which is the one case the post-mortem is for.
   *
   * While the Host is up it still holds the dead runtime, so an attach replays the screen the session
   * exited on and that is better than anything a block can compose. `not-live` is the Host answering
   * that it has no such runtime at all, which is what its next start leaves behind - and until now
   * that was an empty panel with an exit code under it.
   */
  static showsPostMortem(state: TerminalSurfaceState): boolean {
    return state.status === 'lost' && state.refusalCode === 'not-live'
  }

  /** Nothing while the screen is simply attached and writable. */
  private static attachmentSignalOf(state: TerminalSurfaceState): TabSignal | null {
    if (state.ended)
      return {
        glyph: '✕',
        tone: 'muted',
        title: state.exitCode === null
          ? 'The session has ended'
          : `Ended with exit code ${state.exitCode}`,
      }
    if (state.status === 'read-only')
      return { glyph: '◌', tone: 'attention', title: 'Read-only: input is not being sent' }
    if (state.status === 'lost')
      return { glyph: '!', tone: 'danger', title: 'This terminal is gone' }
    if (state.status === 'connecting')
      return { glyph: '·', tone: 'muted', title: 'Connecting' }
    if (state.status === 'live')
      return null
    throw new Error(`Unknown terminal status: ${JSON.stringify(state.status)}`)
  }
}
