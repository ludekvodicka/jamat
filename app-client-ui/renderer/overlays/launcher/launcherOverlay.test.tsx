import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectListResult,
  ProjectSessionsResult,
  ProviderSessionSummary,
} from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionCreateSpec,
  SessionHistoryOpenSpec,
  SessionHistoryReference,
  SessionsOpErrorCode,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge } from '../../../shared/appClientUiIpc'
import { LauncherFixtures } from './fixtures/launcherFixtures'
import { LauncherIntentStore } from './launcherIntentStore'
import { LauncherOverlay } from './launcherOverlay'

describe('app-client-ui/renderer/overlays/launcher/launcherOverlay', () => {
  /**
   * The three surfaces this overlay speaks to, and all of each: `satisfies` means a channel added to
   * the bridge shows up here as a compile error rather than as an overlay that throws on mount.
   */
  class ProjectsStub {
    readonly created: { categoryId: string; name: string; prefix: string | null }[] = []
    readonly listed: string[] = []
    readonly asked: string[] = []
    readonly renamed: string[] = []
    readonly moved: string[] = []
    readonly deleted: string[] = []
    readonly started: SessionCreateSpec[] = []
    readonly openedHistory: SessionHistoryOpenSpec[] = []
    readonly closedPlain: string[] = []
    readonly peeked: string[] = []
    readonly allocated: string[] = []
    readonly savedNewSessionAgents: SessionAgentId[] = []
    /** What a peek shows, and what a claim hands back. Different on purpose in one test. */
    private nextToken: string | null = '015'
    private allocatedToken: string | null = '015'
    private categoriesFail = false
    private pickedPath: string | null = null
    private createRefusal: { code: SessionsOpErrorCode; detail: string } | null = null
    /** What the first category answers with, when the fixture holds no row a test needs. */
    private nodejsListing: ProjectListResult | null = null
    private sessionsResult: ProjectSessionsResult | null = null
    private localHistory: SessionHistoryReference[] = []
    private newSessionAgent: SessionAgentId = 'claude'
    /** The computers the snapshot reports connected, and what each was asked for. */
    private connected: readonly { remoteEndpointId: string; displayName: string }[] = []
    readonly remoteListed: string[] = []
    readonly remoteDescribed: string[] = []

    private static readonly reportConst = {
      operationId: 'op-1',
      directoryRenamed: true,
      providers: { claude: 'done' as const, codex: 'done' as const },
      leftoverCount: 0,
    }

    install(): void {
      const projects = {
        getConfig: ProjectsStub.unused('getConfig'),
        saveConfig: ProjectsStub.unused('saveConfig'),
        categories: () => Promise.resolve(this.categoriesFail
          ? { ok: false as const, error: 'main process is gone' }
          : { ok: true as const, value: [...LauncherFixtures.categories()] }),
        list: (categoryId: string) => {
          this.listed.push(categoryId)
          return Promise.resolve({ ok: true as const, value: this.listingOf(categoryId) })
        },
        sessions: (categoryId: string, projectName: string) => {
          this.asked.push(`${categoryId}/${projectName}`)
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: this.sessionsResult ?? ProjectsStub.sessionsOf(projectName),
            },
          })
        },
        create: (categoryId: string, name: string, virtualFolderPrefix: string | null) => {
          this.created.push({ categoryId, name, prefix: virtualFolderPrefix })
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: { name, path: `Q:/${name}`, lastActivity: null },
            },
          })
        },
        rename: (categoryId: string, oldName: string, newName: string) => {
          this.renamed.push(`${categoryId}/${oldName}->${newName}`)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: ProjectsStub.reportConst },
          })
        },
        movePrefix: (categoryId: string, name: string, targetPrefix: string | null) => {
          this.moved.push(`${categoryId}/${name}->${targetPrefix ?? '(root)'}`)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: ProjectsStub.reportConst },
          })
        },
        archive: ProjectsStub.unused('archive'),
        deletePreview: (categoryId: string, name: string) => Promise.resolve({
          ok: true as const,
          value: {
            ok: true as const,
            value: {
              token: `token-for-${categoryId}/${name}`,
              expiresAt: Date.now() + 300_000,
              projectPath: `Q:/${name}`,
              projectFileCount: 12,
              claude: { encodedDirectory: null, transcriptFiles: ['a'] },
              codex: { rolloutFiles: [] },
            },
          },
        }),
        deleteProject: (token: string) => {
          this.deleted.push(token)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: { deletedPaths: 13, leftoverCount: 0 } },
          })
        },
      } satisfies AppClientUiBridge['projects']
      const sessions = {
        snapshot: ProjectsStub.unused('snapshot'),
        create: (spec: SessionCreateSpec) => {
          this.started.push(spec)
          if (this.createRefusal)
            return Promise.resolve({ ok: true as const, value: { ok: false as const, ...this.createRefusal } })
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: { sessionId: 'session-1', tabTitle: 'AppJamat - 015' },
            },
          })
        },
        historyReferences: () => Promise.resolve({
          ok: true as const,
          value: { ok: true as const, value: { references: this.localHistory } },
        }),
        openHistory: (spec: SessionHistoryOpenSpec) => {
          this.openedHistory.push(spec)
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: { sessionId: 'history-1', tabTitle: 'AppJamat - continued' },
            },
          })
        },
        reopen: ProjectsStub.unused('reopen'),
        finalize: ProjectsStub.unused('finalize'),
        remove: ProjectsStub.unused('remove'),
        closePlain: (sessionId: string) => {
          this.closedPlain.push(sessionId)
          return Promise.resolve({
            ok: true as const,
            value: { ok: true as const, value: undefined },
          })
        },
        promotePlain: ProjectsStub.unused('promotePlain'),
        discardWorktree: ProjectsStub.unused('discardWorktree'),
        retrySetup: ProjectsStub.unused('retrySetup'),
        fork: ProjectsStub.unused('fork'),
        restart: ProjectsStub.unused('restart'),
        setColor: ProjectsStub.unused('setColor'),
        setDetails: ProjectsStub.unused('setDetails'),
        adoptOrphan: ProjectsStub.unused('adoptOrphan'),
        nextNumber: (projectPath: string) => {
          this.peeked.push(projectPath)
          return ProjectsStub.number(this.nextToken)
        },
        allocateNumber: (projectPath: string) => {
          this.allocated.push(projectPath)
          return ProjectsStub.number(this.allocatedToken)
        },
        startHost: ProjectsStub.unused('startHost'),
        reference: ProjectsStub.unused('reference'),
      } satisfies AppClientUiBridge['sessions']
      const dialog = {
        pickDirectory: () => Promise.resolve({
          ok: true as const,
          value: this.pickedPath === null ? null : { path: this.pickedPath },
        }),
        confirm: ProjectsStub.unused('confirm'),
      } satisfies AppClientUiBridge['dialog']
      const state = {
        loadNewSessionAgent: () => Promise.resolve({
          ok: true as const,
          value: this.newSessionAgent,
        }),
        saveNewSessionAgent: (agentId: SessionAgentId) => {
          this.newSessionAgent = agentId
          this.savedNewSessionAgents.push(agentId)
          return Promise.resolve({ ok: true as const, value: true })
        },
      } satisfies Pick<
        AppClientUiBridge['state'],
        'loadNewSessionAgent' | 'saveNewSessionAgent'
      >
      const remote = {
        // Nothing is dialled until something asks, and the computers screen is one of the things
        // that ask. The stub answers rather than counting: what a hold DOES is the connector's own
        // test, and this one is about the card.
        connect: () => Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } }),
        selectSession: () => Promise.resolve({ ok: true as const, value: { ok: true as const, value: undefined } }),
        release: () => Promise.resolve({ ok: true as const, value: undefined }),
        snapshot: () => Promise.resolve({
          ok: true as const,
          value: {
            revision: 1,
            inbound: [],
            outbound: this.connected.map((computer) => ({
              profileId: `profile-${computer.remoteEndpointId}`,
              remoteComputerId: `computer-${computer.remoteEndpointId}`,
              remoteEndpointId: computer.remoteEndpointId,
              configIdentity: 'identity',
              runtimeChannel: 'development' as const,
              displayName: computer.displayName,
              endpoint: { host: '203.0.113.10', port: 47_150 },
              status: 'connected' as const,
              error: null,
              lastConnectedAt: null,
              nextRetryAt: null,
              applicationVersion: null,
              optionalOperations: null,
              connectionId: 'connection',
              sessions: null,
            })),
          },
        }),
        /* The remote create card asks this the moment it opens; no test here picks a model. */
        describeAgents: (remoteEndpointId: string) => {
          this.remoteDescribed.push(remoteEndpointId)
          return Promise.resolve({
            ok: true as const,
            value: {
              protocol: 'appjamat-v3-control.v1' as const,
              requestId: 'request',
              operation: 'agents.describe' as const,
              operationId: 'operation',
              ok: true as const,
              value: { agents: [] },
            },
          })
        },
        listProjects: (remoteEndpointId: string) => {
          this.remoteListed.push(remoteEndpointId)
          return Promise.resolve({
            ok: true as const,
            value: {
              protocol: 'appjamat-v3-control.v1' as const,
              requestId: 'request',
              operation: 'projects.list' as const,
              operationId: 'operation',
              ok: true as const,
              value: {
                categories: LauncherFixtures.categories().slice(0, 1).map((category) => ({
                  category,
                  listing: { ok: true as const, value: LauncherFixtures.nodejs() },
                })),
              },
            },
          })
        },
      } satisfies Pick<AppClientUiBridge['remote'],
        'snapshot' | 'connect' | 'selectSession' | 'release' | 'describeAgents' | 'listProjects'>
      ;(window as unknown as {
        appClient:
          Pick<AppClientUiBridge, 'projects' | 'sessions' | 'dialog'>
          & { state: typeof state; remote: typeof remote; onRemoteChanged: () => () => void }
      }).appClient = {
        projects,
        sessions,
        dialog,
        state,
        remote,
        onRemoteChanged: () => () => undefined,
      }
    }

    computers(...connected: readonly { remoteEndpointId: string; displayName: string }[]): this {
      this.connected = connected
      return this
    }

    failCategories(): this {
      this.categoriesFail = true
      return this
    }

    picks(path: string): this {
      this.pickedPath = path
      return this
    }

    lists(listing: ProjectListResult): this {
      this.nodejsListing = listing
      return this
    }

    hasSessions(summaries: readonly ProviderSessionSummary[]): this {
      this.sessionsResult = {
        claude: summaries.filter((summary) => summary.agentId === 'claude'),
        codex: summaries.filter((summary) => summary.agentId === 'codex'),
        merged: [...summaries],
      }
      return this
    }

    hasLocalHistory(references: readonly SessionHistoryReference[]): this {
      this.localHistory = [...references]
      return this
    }

    refusesCreate(code: SessionsOpErrorCode, detail: string): this {
      this.createRefusal = { code, detail }
      return this
    }

    numbers(next: string | null, allocated: string | null = next): this {
      this.nextToken = next
      this.allocatedToken = allocated
      return this
    }

    remembersNewSessionAgent(agentId: SessionAgentId): this {
      this.newSessionAgent = agentId
      return this
    }

    private static number(token: string | null) {
      if (token === null)
        return Promise.resolve({
          ok: true as const,
          value: {
            ok: false as const,
            code: 'numbers-unavailable' as const,
            detail: 'the session numbers could not be read',
          },
        })
      return Promise.resolve({ ok: true as const, value: { ok: true as const, value: { token } } })
    }

    private listingOf(categoryId: string) {
      if (categoryId === 'web')
        return { ok: true as const, value: LauncherFixtures.web() }
      return { ok: true as const, value: this.nodejsListing ?? LauncherFixtures.nodejs() }
    }

    /** One Claude session per letter of the name, so each row's count is its own. */
    private static sessionsOf(projectName: string): ProjectSessionsResult {
      const merged: ProviderSessionSummary[] = [...projectName.slice(0, 3)].map((_, index) => ({
        agentId: 'claude' as const,
        nativeSessionId: `${projectName}-${index}`,
        title: null,
        firstUserMessage: null,
        createdAt: 0,
        lastActivity: 100 - index,
        active: false,
      }))
      return { claude: merged, codex: [], merged }
    }

    private static unused(name: string) {
      return () => {
        throw new Error(`The launcher called projects.${name}, which this slice does not use`)
      }
    }
  }

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  async function mount(stub = new ProjectsStub(), intents = new LauncherIntentStore()) {
    stub.install()
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn().mockResolvedValue({ kind: 'opened', panelId: 'terminal' })
    const onOpenRemoteSettings = vi.fn()
    const view = render(
      <LauncherOverlay
        intents={intents}
        onOpenTerminal={onOpenTerminal}
        onOpenRemoteSettings={onOpenRemoteSettings}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(view.container.querySelector('[role="tab"]')).toBeTruthy())
    return { stub, view, onClose, onOpenTerminal, onOpenRemoteSettings }
  }

  /** Ctrl+T: the card starts on its project screen, and every screen of it starts a plain tab. */
  async function mountForTabCard(stub = new ProjectsStub()) {
    stub.install()
    const intents = new LauncherIntentStore()
    intents.set({ purpose: 'tabProfile' })
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn().mockResolvedValue({ kind: 'opened', panelId: 'terminal' })
    const onOpenRemoteSettings = vi.fn()
    const view = render(
      <LauncherOverlay
        intents={intents}
        onOpenTerminal={onOpenTerminal}
        onOpenRemoteSettings={onOpenRemoteSettings}
        onClose={onClose}
      />,
    )
    await waitFor(() => expect(view.container.querySelector('[role="tab"]')).toBeTruthy())
    return { stub, view, onClose, onOpenTerminal, onOpenRemoteSettings }
  }

  /** Opened straight on the second screen, the way a project node in the tree opens it. */
  async function mountOnCreate(stub = new ProjectsStub()) {
    stub.install()
    const intents = new LauncherIntentStore()
    intents.set({
      prefill: {
        binding: {
          mode: 'project',
          categoryId: 'nodejs',
          projectName: 'AppJamatV3',
          projectPath: 'C:/Projects/NodeJs/AppJamatV3',
        },
      },
    })
    const onClose = vi.fn()
    const onOpenTerminal = vi.fn().mockResolvedValue({ kind: 'opened', panelId: 'terminal' })
    const onOpenRemoteSettings = vi.fn()
    const view = render(
      <LauncherOverlay
        intents={intents}
        onOpenTerminal={onOpenTerminal}
        onOpenRemoteSettings={onOpenRemoteSettings}
        onClose={onClose}
      />,
    )
    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    return { stub, view, onClose, onOpenTerminal, onOpenRemoteSettings }
  }

  /**
   * The overlay under something that can take it away. `onClose` is a spy everywhere else, which
   * never unmounts the card - and the focus it gives back is decided in its unmount.
   */
  function hosted(intents: LauncherIntentStore) {
    function Hosted(): React.JSX.Element | null {
      const [open, setOpen] = useState(true)
      if (!open)
        return null
      return (
        <LauncherOverlay
          intents={intents}
          onOpenTerminal={() => Promise.resolve({ kind: 'opened', panelId: 'terminal' })}
          onOpenRemoteSettings={() => undefined}
          onClose={() => setOpen(false)}
        />
      )
    }
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    return { opener, view: render(<Hosted />) }
  }

  /** The category tab the card is standing in, which is what an intent's category decides. */
  function selectedTab(container: HTMLElement): string {
    const found = container.querySelector('[role="tab"][aria-selected="true"]')
    if (!(found instanceof HTMLElement))
      throw new Error('The projects screen shows no selected category')
    return found.textContent?.replace(/^\d+/, '') ?? ''
  }

  function card(container: HTMLElement): HTMLElement {
    const found = container.querySelector('.jamat-launcher__card')
    if (!(found instanceof HTMLElement))
      throw new Error('The overlay drew no card')
    return found
  }

  function foot(container: HTMLElement): string {
    const found = container.querySelector('.jamat-launcher__foot')
    if (!found)
      throw new Error('The card drew no footer')
    return found.textContent ?? ''
  }

  /** The keys alone, in the order they are drawn - the labels are what `foot` is for. */
  function footKeys(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.jamat-launcher__foot .jamat-launcher__key')]
      .map((node) => node.textContent ?? '')
  }

  function activeTab(container: HTMLElement): string {
    const tab = container.querySelector('[role="tab"][aria-selected="true"]')
    if (!tab)
      throw new Error('No category is active')
    return tab.textContent ?? ''
  }

  function rowNames(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.jamat-launcher__name')]
      .map((node) => node.textContent ?? '')
  }

  function selected(container: HTMLElement): string {
    const row = container.querySelector('.jamat-launcher__row--selected')
    if (!row)
      throw new Error('No row is selected')
    return row.textContent ?? ''
  }

  /**
   * Walks the cursor down to the row that reads `label`. By what the row says rather than by a
   * count of ArrowDowns: a row added to the tail used to renumber every test that reached one
   * further down.
   */
  function moveTo(container: HTMLElement, label: string): void {
    // Up clamps at the first row, so this is "go to the top" without a key the card does not have.
    for (let step = 0; step < 40; step += 1)
      fireEvent.keyDown(card(container), { key: 'ArrowUp' })
    for (let step = 0; step < 40; step += 1) {
      if (selected(container).includes(label))
        return
      fireEvent.keyDown(card(container), { key: 'ArrowDown' })
    }
    throw new Error(`No row reads ${JSON.stringify(label)}; the cursor stopped on ${
      JSON.stringify(selected(container))}`)
  }

  it('focuses the search when the Ctrl+T card opens', async () => {
    const { view } = await mountForTabCard()

    expect(document.activeElement).toBe(view.getByRole('textbox', { name: 'Filter projects' }))
  })

  it('returns focus to whatever held it before', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()

    const { view } = await mount()
    view.unmount()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('closes on Escape, on the backdrop and on the close button', async () => {
    const escape = await mount()
    fireEvent.keyDown(escape.view.getByRole('textbox', { name: 'Filter projects' }), { key: 'Escape' })
    expect(escape.onClose).toHaveBeenCalledOnce()

    cleanup()
    const backdrop = await mount()
    const scrim = backdrop.view.container.querySelector('.jamat-launcher')
    if (!(scrim instanceof HTMLElement))
      throw new Error('The overlay drew no backdrop')
    fireEvent.mouseDown(scrim)
    expect(backdrop.onClose).toHaveBeenCalledOnce()

    cleanup()
    const button = await mount()
    const close = button.view.container.querySelector('.jamat-launcher__close')
    if (!(close instanceof HTMLElement))
      throw new Error('The overlay drew no close button')
    fireEvent.click(close)
    expect(button.onClose).toHaveBeenCalledOnce()
  })

  it('stays open on a press inside the card', async () => {
    const { view, onClose } = await mount()

    fireEvent.mouseDown(card(view.container))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('steps the category with Tab instead of moving focus', async () => {
    const { view } = await mount()
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter projects' }), { key: 'ArrowDown' })

    fireEvent.keyDown(card(view.container), { key: 'Tab' })

    expect(activeTab(view.container)).toBe('2Web')
    // Nothing inside the card is tabbed to, so no control ever wears a focus ring.
    expect(document.activeElement).toBe(card(view.container))

    fireEvent.keyDown(card(view.container), { key: 'Tab', shiftKey: true })

    expect(activeTab(view.container)).toBe('1NodeJs')
  })

  it('holds Tab at the ends, exactly as the arrows do', async () => {
    const { view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'Tab', shiftKey: true })

    expect(activeTab(view.container)).toBe('1NodeJs')
  })

  it('draws the categories and the first one’s projects', async () => {
    const { view } = await mount()

    expect([...view.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent))
      .toEqual(['1NodeJs', '2Web', '3Ai!'])
    expect(rowNames(view.container))
      .toEqual([
        'AppJamat',
        'AppJamatV3',
        '▸ archive',
        'Pick folder…',
        'Root project (NodeJs)',
      ])
  })

  it('moves the cursor with the arrows', async () => {
    const { view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })

    expect(selected(view.container)).toContain('AppJamatV3')
  })

  it('uses H for type-to-jump and offers no History action', async () => {
    const app = { name: 'App', path: 'Q:/App', lastActivity: null }
    const historyHub = { name: 'HistoryHub', path: 'Q:/HistoryHub', lastActivity: null }
    const { view } = await mount(new ProjectsStub().lists({
      entries: [
        { kind: 'project', project: app },
        { kind: 'project', project: historyHub },
      ],
      projects: [app, historyHub],
      virtualFolders: [],
      truncated: false,
      available: true,
    }))

    fireEvent.keyDown(card(view.container), { key: 'h' })

    expect(selected(view.container)).toContain('HistoryHub')
    expect(view.container.querySelector('.jamat-launcher__title')?.textContent).toBe('Projects')
    expect(foot(view.container)).not.toContain('History')
  })

  it('switches category by click and by number, and asks for its projects', async () => {
    const { stub, view } = await mount()

    fireEvent.click(view.container.querySelectorAll('[role="tab"]')[1])
    await waitFor(() => expect(rowNames(view.container)).toContain('WebJamatAdmin'))

    fireEvent.keyDown(card(view.container), { key: '1' })
    await waitFor(() => expect(rowNames(view.container)).toContain('AppJamat'))

    expect(stub.listed).toEqual(['nodejs', 'web', 'ai', 'web', 'nodejs'])
  })

  /**
   * Up opens the filter, Down goes back to the list, and Up has to open it AGAIN. It did not: the
   * arrow out moved the caret without telling the model, so the state that opens the field was
   * already set, the second Up changed nothing, and the effect that focuses it never fired again.
   */
  it('opens the filter with Up as often as it is left', async () => {
    const { view } = await mount()
    const search = view.container.querySelector('.jamat-launcher__search')
    if (!(search instanceof HTMLInputElement))
      throw new Error('The screen drew no search field')

    fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(card(view.container))

    fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search)
  })

  it('filters as the search field is typed into', async () => {
    const { view } = await mount()
    const search = view.container.querySelector('.jamat-launcher__search')
    if (!(search instanceof HTMLInputElement))
      throw new Error('The screen drew no search field')

    fireEvent.change(search, { target: { value: 'v3' } })

    expect(rowNames(view.container))
      .toEqual(['AppJamatV3', 'AppJamatV3', 'Pick folder…', 'Root project (NodeJs)'])
  })

  it('loads each foreign root once when F1 focus follows', async () => {
    const { stub, view } = await mount()
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai']))

    fireEvent.keyDown(card(view.container), { key: 'F1' })
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai']))

    const search = view.container.querySelector('.jamat-launcher__search')
    if (!(search instanceof HTMLInputElement))
      throw new Error('The screen drew no search field')
    fireEvent.focus(search)

    expect(stub.listed).toEqual(['nodejs', 'web', 'ai'])
  })

  it('creates a project through the library and reads the listing again', async () => {
    const { stub, view } = await mount()

    // A key of the screen, so it answers with the manage mode off, which is where the user is.
    fireEvent.keyDown(card(view.container), { key: 'F7' })
    const edit = view.container.querySelector('.jamat-launcher-manage__edit')
    if (!(edit instanceof HTMLInputElement))
      throw new Error('F7 opened no edit')

    fireEvent.change(edit, { target: { value: 'AppNew' } })
    fireEvent.keyDown(card(view.container), { key: 'Enter' })

    await waitFor(() => expect(stub.created)
      .toEqual([{ categoryId: 'nodejs', name: 'AppNew', prefix: null }]))
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai', 'nodejs']))
  })

  /**
   * One strip at a time, and the key line under it names that strip's keys. So the key that would
   * open the other one is not live: pressing it while a name is half typed would replace what is on
   * screen with something else, and the line would have been lying about what was pressable.
   */
  it('keeps the two strips off each other', async () => {
    const { view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'F7' })
    fireEvent.keyDown(card(view.container), { key: 'F6' })
    expect(view.container.textContent).toContain('Create project in NodeJs')
    expect(view.container.textContent).not.toContain('Rename AppJamat to')

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    fireEvent.keyDown(card(view.container), { key: 'F6' })
    fireEvent.keyDown(card(view.container), { key: 'F7' })
    expect(view.container.textContent).toContain('Rename AppJamat to')
    expect(view.container.textContent).not.toContain('Create project in')
  })

  /**
   * The card draws the strip rather than the screen, because the body scrolls: at the end of a long
   * list it would open below the fold and F7 would look like it did nothing. Directly above the key
   * line, which at that moment IS its legend - the footer drops the screen's keys for this edit's own
   * two, so the strip carries no hint of its own.
   */
  it('puts the strip between the scrolling body and the key line', async () => {
    const { view } = await mount()
    fireEvent.keyDown(card(view.container), { key: 'F7' })

    const strip = view.container.querySelector('.jamat-launcher-manage')
    const body = view.container.querySelector('.jamat-launcher__body')
    const line = view.container.querySelector('.jamat-launcher__foot')
    if (!strip || !body || !line)
      throw new Error('The card drew no strip, body or key line')

    expect(body.contains(strip)).toBe(false)
    expect(body.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(foot(view.container)).toContain('Enter Create project')
    expect(foot(view.container)).toContain('Esc Cancel the edit')
  })

  /**
   * The strip says where the directory lands, because both things that would otherwise say it - the
   * tab row and the breadcrumb - are at the far end of the card from it.
   */
  it('names the place the project would be made in', async () => {
    const { view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'F7' })
    expect(view.container.querySelector('.jamat-launcher-manage__ask')?.textContent)
      .toBe('Create project in NodeJs')

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    fireEvent.keyDown(card(view.container), { key: 'Enter' })
    expect(rowNames(view.container)).toContain('AppOld')

    fireEvent.keyDown(card(view.container), { key: 'F7' })
    expect(view.container.querySelector('.jamat-launcher-manage__ask')?.textContent)
      .toBe('Create project in archive')
  })

  /**
   * The case the manage panel could never answer: a root holding nothing has no project to point the
   * mode at, and it is exactly the root somebody wants the first project in. F7 is the screen's, so
   * it answers there like anywhere else.
   */
  it('opens the strip in a category holding nothing at all', async () => {
    const { view } = await mount(new ProjectsStub().lists({
      entries: [],
      projects: [],
      virtualFolders: [],
      truncated: false,
      available: true,
    }))

    fireEvent.keyDown(card(view.container), { key: 'F7' })

    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeTruthy()
  })

  // The channel failing and the library refusing are two different sentences, and both are shown
  // rather than swallowed into a console nobody has open.
  it('shows a transport failure without emptying the surface', async () => {
    const stub = new ProjectsStub().failCategories()
    stub.install()
    const view = render(
      <LauncherOverlay
        intents={new LauncherIntentStore()}
        onOpenTerminal={() => Promise.resolve({ kind: 'opened', panelId: 'terminal' })}
        onOpenRemoteSettings={() => undefined}
        onClose={() => undefined}
      />,
    )

    await waitFor(() => expect(view.container.querySelector('.jamat-launcher__error')
      ?.textContent).toBe('main process is gone'))
    expect(view.container.querySelector('.jamat-launcher__card')).toBeTruthy()
  })

  // The two columns the listing itself cannot answer, filled in after it is already on screen.
  it('fills the session count and the agent in behind the listing', async () => {
    const { stub, view } = await mount()

    await waitFor(() => expect(view.container.textContent).toContain('3 sessions'))
    expect([...view.container.querySelectorAll('.jamat-launcher__agent')]
      .map((node) => node.textContent)).toEqual(['C', 'C'])
    expect(stub.asked).toEqual(['nodejs/AppJamat', 'nodejs/AppJamatV3'])
  })

  /**
   * No mode in front of them: the four keys act on whatever the cursor stands on, and the line names
   * them only there. On a folder row and on the two tail rows they answer nothing, so nothing offers
   * them - the card would otherwise name a key that reaches a model which throws.
   */
  it('offers the four actions on a project row and nowhere else', async () => {
    const { view } = await mount()

    expect(selected(view.container)).toContain('AppJamat')
    expect(foot(view.container)).toContain('F6 Rename')
    expect(foot(view.container)).toContain('⇧F8 Delete…')

    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    expect(selected(view.container)).toContain('archive')
    expect(foot(view.container)).not.toContain('F6 Rename')
    expect(foot(view.container)).not.toContain('⇧F8 Delete…')
  })

  /**
   * The function keys read in numeric order, with a shifted one directly after the key it shares.
   * They were grouped by what they act on before, which put `F6` first and `F4` fifth, so the eye
   * had to hunt for a key it knew the number of.
   */
  it('names the function keys in their own order', async () => {
    const { view } = await mount()

    expect(footKeys(view.container))
      .toEqual(['Esc', 'F1', 'F3', 'F4', 'F6', '⇧F6', 'F7', 'F8', '⇧F8'])

    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })
    expect(footKeys(view.container)).toEqual(['Esc', 'F1', 'F3', 'F4', 'F7'])
  })

  /** The keys act straight from the list, and each pair is one thing with two ends. */
  it('opens each of the four from its own key', async () => {
    const { view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'F6' })
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeTruthy()

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    fireEvent.keyDown(card(view.container), { key: 'F6', shiftKey: true })
    expect(view.container.textContent).toContain('Move AppJamat to')

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    fireEvent.keyDown(card(view.container), { key: 'F8' })
    expect(view.container.textContent).toContain('Archive AppJamat?')

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    fireEvent.keyDown(card(view.container), { key: 'F8', shiftKey: true })
    await waitFor(() => expect(view.container.textContent).toContain('12 project files'))
  })

  /** The cursor is what aims them, so moving it abandons whatever was half-started on the row left. */
  it('drops an open operation when the cursor moves off its row', async () => {
    const { view } = await mount()
    fireEvent.keyDown(card(view.container), { key: 'F6' })
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeTruthy()

    fireEvent.keyDown(card(view.container), { key: 'ArrowDown' })

    expect(selected(view.container)).toContain('AppJamatV3')
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeNull()
  })

  /** Every letter is a jump again, which is the whole reason the four are function keys. */
  it('leaves r m a d as jumps into the list', async () => {
    const { view } = await mount()

    for (const letter of ['r', 'm', 'a', 'd'])
      fireEvent.keyDown(card(view.container), { key: letter })

    expect(view.container.querySelector('.jamat-launcher-manage')).toBeNull()
  })

  /**
   * `c` is a letter again in both modes. It was the make while the mode was on, which took one of
   * the twenty-six jumps away there - silently, because a jump that does not happen looks like a
   * jump that found nothing. Moving the make to F7 is what gave it back.
   */
  it('jumps to a project on c in either mode, instead of opening an edit', async () => {
    const listing = LauncherFixtures.nodejs()
    const cli = {
      name: 'CliJamat',
      path: 'C:\\Projects\\NodeJs\\CliJamat',
      lastActivity: Date.UTC(2026, 7, 5, 11, 0),
    }
    const { view } = await mount(new ProjectsStub().lists({
      ...listing,
      entries: [...listing.entries, { kind: 'project', project: cli }],
      projects: [...listing.projects, cli],
    }))
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter projects' }), { key: 'ArrowDown' })

    fireEvent.keyDown(card(view.container), { key: 'c' })
    expect(selected(view.container)).toContain('CliJamat')
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeNull()

    fireEvent.keyDown(card(view.container), { key: 'F2' })
    fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
    fireEvent.keyDown(card(view.container), { key: 'c' })
    expect(selected(view.container)).toContain('CliJamat')
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeNull()
  })

  // The archive asks first, so its letter has to stay live while the question is on screen.
  it('asks before it archives', async () => {
    const { view } = await mount()
    fireEvent.keyDown(card(view.container), { key: 'F2' })

    fireEvent.keyDown(card(view.container), { key: 'F8' })

    expect(view.container.textContent).toContain('Archive AppJamat?')
    expect(foot(view.container)).toContain('F8 Confirm the archive')
  })

  it('names in the footer the keys that are live at that moment', async () => {
    const { view } = await mount()
    expect(foot(view.container)).toContain('F6 Rename')

    // An open operation owns the line: it names that operation's keys and nothing else, or it names
    // a key that types a letter into the edit instead of doing what the line says.
    fireEvent.keyDown(card(view.container), { key: 'F6' })
    expect(foot(view.container)).toContain('Enter Confirm')
    expect(foot(view.container)).not.toContain('F6 Rename')
    expect(foot(view.container)).not.toContain('F7 Create project')
  })

  /** The click sends the input the key sends, so the line is the mouse's half of these four keys. */
  it('renames through the library from the key line, and reads the listing again', async () => {
    const { stub, view } = await mount()

    const rename = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent === 'F6 Rename')
    if (!rename)
      throw new Error('The key line offers no rename')
    fireEvent.click(rename)
    const edit = view.container.querySelector('.jamat-launcher-manage__edit')
    if (!(edit instanceof HTMLInputElement))
      throw new Error('The rename drew no edit')
    fireEvent.change(edit, { target: { value: 'AppJamatRenamed' } })
    fireEvent.keyDown(card(view.container), { key: 'Enter' })

    await waitFor(() => expect(stub.renamed).toEqual(['nodejs/AppJamat->AppJamatRenamed']))
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai', 'nodejs']))
  })

  /**
   * End to end over the seam that was broken: the fixture's `temporary` folder holds nothing, so it
   * is absent from the drawn rows and present in the listing's `virtualFolders`. A target list read
   * off the rows offered every folder except the one somebody had just created.
   */
  it('moves into a folder that the listing draws no row for', async () => {
    const { stub, view } = await mount()

    const move = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent === '⇧F6 Move')
    if (!move)
      throw new Error('The key line offers no move')
    fireEvent.click(move)
    const target = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent === 'Temporary projects')
    if (!target)
      throw new Error('The move offers no empty folder to move into')
    fireEvent.click(target)

    await waitFor(() => expect(stub.moved).toEqual(['nodejs/AppJamat->temporary']))
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai', 'nodejs']))
  })

  /**
   * Enter and a double click mean the same thing again. They meant two while the manage mode existed
   * - in the mode Enter pointed the actions at the row and only the mouse still opened it - and the
   * effect carried which device had asked. The actions have their own keys now, so nothing branches.
   */
  it('opens a project on a double click', async () => {
    const { view } = await mount()

    const rows = [...view.container.querySelectorAll('.jamat-launcher__row')]
    fireEvent.doubleClick(rows[1])

    await waitFor(() => expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    expect(view.container.querySelector('.jamat-launcher-create__path')?.textContent)
      .toBe('C:\\Projects\\NodeJs\\AppJamatV3')
  })

  it('enters a virtual folder on a double click', async () => {
    const { view } = await mount()

    const rows = [...view.container.querySelectorAll('.jamat-launcher__row')]
    fireEvent.doubleClick(rows[2])

    expect(view.container.querySelector('.jamat-launcher-projects__breadcrumb')?.textContent)
      .toContain('archive')
  })

  // The delete call carries the token the preview handed out, never a name and never a boolean.
  it('deletes with the token of the preview it showed', async () => {
    const { stub, view } = await mount()

    const start = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent === '⇧F8 Delete…')
    if (!start)
      throw new Error('The key line offers no delete')
    fireEvent.click(start)

    await waitFor(() => expect(view.container.textContent).toContain('12 project files'))
    const confirm = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent?.startsWith('Delete 13 files'))
    if (!confirm)
      throw new Error('The preview offers no confirmation')
    fireEvent.click(confirm)

    await waitFor(() => expect(stub.deleted).toEqual(['token-for-nodejs/AppJamat']))
  })

  it('gives focus back to whatever opened it', async () => {
    new ProjectsStub().install()
    const { opener, view } = hosted(new LauncherIntentStore())
    await waitFor(() => expect(view.container.querySelector('[role="tab"]')).toBeTruthy())

    fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter projects' }), { key: 'Escape' })

    expect(view.container.querySelector('.jamat-launcher')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  /**
   * Except when it handed focus on. The tab it just opened is where somebody is about to type, and
   * a caret returning to the button that opened the card makes them click into the terminal first.
   */
  it('leaves focus with the tab it opened rather than taking it back', async () => {
    new ProjectsStub().install()
    const intents = new LauncherIntentStore()
    intents.set({
      prefill: {
        binding: {
          mode: 'project',
          categoryId: 'nodejs',
          projectName: 'AppJamat',
          projectPath: 'C:/Projects/NodeJs/AppJamat',
        },
      },
    })
    const { opener, view } = hosted(intents)
    await waitFor(() =>
      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())

    fireEvent.keyDown(card(view.container), { key: 'Enter' })

    await waitFor(() => expect(view.container.querySelector('.jamat-launcher')).toBeNull())
    expect(document.activeElement).not.toBe(opener)
    opener.remove()
  })

  /**
   * Clicking a hint focuses it, and a hint is one step from being taken away: an open operation
   * replaces the whole line with its own keys. Focus then sat on the document body, where the card's
   * keydown - the only listener this surface has - reached nothing, so Escape did nothing at all
   * until something was clicked that happened to survive.
   */
  it('takes focus back when the hint that was clicked is taken away', async () => {
    const { view } = await mount()
    const start = [...view.container.querySelectorAll('button')]
      .find((node) => node.textContent === '⇧F8 Delete…')
    if (!start)
      throw new Error('The key line offers no delete')

    // As a real click does: the button takes focus, and the click takes the button away.
    start.focus()
    fireEvent.click(start)

    expect(document.activeElement).toBe(card(view.container))
    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    expect(view.container.textContent).not.toContain('would take')
  })

  // Escape peels one layer at a time; the card is the last thing it reaches.
  it('leaves the operation first and closes only after it', async () => {
    const { view, onClose } = await mount()
    fireEvent.keyDown(card(view.container), { key: 'F6' })
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeTruthy()

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    expect(view.container.querySelector('.jamat-launcher-manage__edit')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(card(view.container), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  describe('the create screen', () => {
    async function openCreate(stub = new ProjectsStub()) {
      const mounted = await mount(stub)
      fireEvent.keyDown(card(mounted.view.container), { key: 'Enter' })
      await waitFor(() =>
        expect(mounted.view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
      return mounted
    }

    function cardTitles(container: HTMLElement): string[] {
      return [...container.querySelectorAll('.jamat-choice__card-title')]
        .map((node) => node.textContent ?? '')
    }

    function chosen(container: HTMLElement): string[] {
      return [...container.querySelectorAll('.jamat-choice__card--chosen')]
        .map((node) => node.querySelector('.jamat-choice__card-title')?.textContent ?? '')
    }

    /**
     * To a flow's own form. The card opens on its name row with the caret in the field, so the way
     * to the type row is Down first - the arrows that choose belong to the row the cursor is on.
     */
    function openFlow(container: HTMLElement): void {
      fireEvent.keyDown(card(container), { key: 'ArrowDown' })
      fireEvent.keyDown(card(container), { key: 'ArrowRight' })
      fireEvent.keyDown(card(container), { key: 'Enter' })
    }

    /** The card as a session's own menu opens it: on that session, under one of two words. */
    async function openOnSession(mode: 'fork' | 'resume') {
      new ProjectsStub().install()
      const intents = new LauncherIntentStore()
      intents.set({
        prefill: {
          binding: {
            mode: 'project',
            categoryId: 'nodejs',
            projectName: 'AppJamatV3',
            projectPath: 'C:/Projects/NodeJs/AppJamatV3',
          },
          name: 'the wire',
          agentId: 'claude',
          session: {
            mode,
            sessionId: 's-parent',
            agentId: 'claude',
            nativeSessionId: 'claude-1',
            number: '014',
            title: '014 - the wire',
            tabTitle: 'AppJamatV3 - the wire',
          },
        },
      })
      const hostedView = hosted(intents)
      await waitFor(() => expect(hostedView.view.container
        .querySelector('.jamat-launcher-create')).toBeTruthy())
      return hostedView
    }

    /*
     * Continue/Fork says both its words, so the footer names the one Enter actually does - and only
     * the fork half has a name to type, because only it founds a session still to be called
     * something.
     */
    it('names what Enter does on the session the card was opened on', async () => {
      const forking = await openOnSession('fork')

      // `All` because the Agent row is that list's provider FILTER, and the session's own row is
      // not filtered by it: the row is what the card is about, not one of the rows it looks through.
      expect(chosen(forking.view.container)).toEqual(['Continue/Fork', 'All'])
      expect(foot(forking.view.container)).toContain('Enter Fork')
      expect(footKeys(forking.view.container)).toEqual(['Esc', '↑↓', '←→', 'Enter', 'N', 'Tab'])
      forking.opener.remove()

      const resuming = await openOnSession('resume')

      expect(foot(resuming.view.container)).toContain('Enter Resume')
      expect(footKeys(resuming.view.container)).toEqual(['Esc', '↑↓', '←→', 'Enter', 'Tab'])
      resuming.opener.remove()
    })

    function chooseCard(container: HTMLElement, title: string): void {
      const button = [...container.querySelectorAll<HTMLButtonElement>(
        '.jamat-choice__card',
      )].find((candidate) => candidate
        .querySelector('.jamat-choice__card-title')?.textContent === title)
      if (!button) throw new Error(`The create screen drew no ${title} card`)
      fireEvent.click(button)
    }

    it('opens on Enter over a project, and peeks that project number', async () => {
      const { stub, view } = await openCreate()

      expect(view.container.querySelector('.jamat-launcher__title')?.textContent).toBe('New session')
      expect(cardTitles(view.container))
        .toEqual([
          'Raw',
          'Feature request',
          'Continue/Fork',
          'Shell',
          'None',
          'Worktree',
          'Claude',
          'Codex',
        ])
      expect(stub.peeked).toEqual(['C:\\Projects\\NodeJs\\AppJamat'])
      // Peeking must not take it: a card that is opened and abandoned costs the project nothing.
      expect(stub.allocated).toEqual([])
      expect(foot(view.container)).toContain('Enter Start')
    })

    it('remembers only Claude versus Codex for the next New Session card', async () => {
      const stub = new ProjectsStub().remembersNewSessionAgent('codex')
      const first = await openCreate(stub)

      expect(chosen(first.view.container)).toEqual(['Raw', 'None', 'Codex'])
      chooseCard(first.view.container, 'Claude')
      await waitFor(() => expect(stub.savedNewSessionAgents).toEqual(['claude']))

      cleanup()
      const second = await openCreate(stub)
      expect(chosen(second.view.container)).toEqual(['Raw', 'None', 'Claude'])
      expect(nameField(second.view.container).value).toBe('')
    })

    function nameField(container: HTMLElement): HTMLInputElement {
      const field = container.querySelector('input[aria-label="Session name"]')
      if (!(field instanceof HTMLInputElement))
        throw new Error('The create screen drew no name field')
      return field
    }

    /**
     * The whole card in two keystrokes: it opens with the caret in the name, so the name is typed
     * into it as it appears and Enter starts what was typed. Nothing is pressed to get there.
     */
    it('opens with the caret in the name field, and starts what was typed on Enter', async () => {
      const { stub, view } = await openCreate()
      const name = nameField(view.container)
      expect(document.activeElement).toBe(name)

      fireEvent.change(name, { target: { value: 'session wizard' } })
      fireEvent.keyDown(name, { key: 'Enter' })

      await waitFor(() => expect(stub.started[0]?.title).toBe('015 - session wizard'))
    })

    /**
     * And out of it again. A caret that stays in the field is a card whose own keys are letters:
     * `w` would be a w and the arrows would belong to the text, so Down has to hand the keys back
     * AND move the cursor with them - the two are one fact, not two.
     */
    it('leaves the name field on Down and comes back to it on Up', async () => {
      const { view } = await openCreate()
      const name = nameField(view.container)

      fireEvent.keyDown(name, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(card(view.container))
      fireEvent.keyDown(card(view.container), { key: 'ArrowRight' })
      expect(chosen(view.container)).toContain('Feature request')

      fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
      expect(document.activeElement).toBe(nameField(view.container))
    })

    it('claims the number at submit and builds the title out of what it claimed', async () => {
      const { stub, view, onClose, onOpenTerminal } = await openCreate()

      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(stub.allocated).toEqual(['C:\\Projects\\NodeJs\\AppJamat']))
      await waitFor(() => expect(stub.started).toEqual([{
        kind: 'agent',
        directory: {
          mode: 'project',
          categoryId: 'nodejs',
          projectPath: 'C:\\Projects\\NodeJs\\AppJamat',
        },
        title: '015',
        agent: { agentId: 'claude', mode: 'new' },
        worktree: undefined,
        acknowledgeSetup: undefined,
      }]))
      // The session is called `015`; the TAB says where those fifteen sessions were, because a row
      // of tabs reading 015, 007, 015 names nothing a person picks a tab by. The fixture path is
      // backslashed, so this fails again the moment the leaf is split on the forward slash alone.
      await waitFor(() =>
        expect(onOpenTerminal.mock.calls).toEqual([[{ kind: 'local', sessionId: 'session-1' }, 'AppJamat - 015', undefined]]))
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    })

    it('keeps the card open when the created session could not get a panel', async () => {
      const context = await openCreate()
      context.onOpenTerminal.mockResolvedValueOnce({
        kind: 'failed',
        detail: 'the workspace is closing',
      })

      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })

      await waitFor(() => expect(context.view.container
        .querySelector('.jamat-launcher__error')?.textContent)
        .toBe('panel-open the workspace is closing'))
      expect(context.onClose).not.toHaveBeenCalled()
      expect(context.stub.closedPlain).toEqual([])
    })

    /**
     * The whole reason the peek and the claim are two channels. The title and the branch must come
     * from the number that was actually taken, never from the one the form happened to be showing.
     */
    it('titles the session with the claimed number, not the peeked one', async () => {
      const { stub, view } = await openCreate(new ProjectsStub().numbers('015', '019'))

      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(stub.started[0]?.title).toBe('019'))
    })

    it('starts a session with no number at all rather than not starting one', async () => {
      const { stub, view } = await openCreate(new ProjectsStub().numbers(null))

      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(stub.started).toHaveLength(1))
      expect(stub.started[0]?.title).toBeUndefined()
    })

    /**
     * A letter shortcut acts on its row AND moves the cursor there, so the arrows carry on from
     * where the shortcut left off rather than from wherever they were before it.
     */
    it('cycles the agent on Tab, leaving the cursor on the row it changed', async () => {
      const { view } = await openCreate()

      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      expect(chosen(view.container)).toContain('Codex')

      // Back up two rows from Agent to Type, then step it past the flow and Continue/Fork to Shell.
      fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
      fireEvent.keyDown(card(view.container), { key: 'ArrowUp' })
      fireEvent.keyDown(card(view.container), { key: 'ArrowRight' })
      expect(chosen(view.container)).toContain('Feature request')
      fireEvent.keyDown(card(view.container), { key: 'ArrowRight' })
      expect(chosen(view.container)).toContain('Continue/Fork')
      fireEvent.keyDown(card(view.container), { key: 'ArrowRight' })
      expect(chosen(view.container)).toContain('Shell')
      // And the shell has no agent, so the pair that was chosen is drawn refused rather than gone.
      expect(view.container.querySelector('.jamat-launcher-create__refusal')?.textContent)
        .toBe('a shell runs no agent')
    })

    it('filters and opens existing sessions without allocating a number', async () => {
      const stub = new ProjectsStub()
        .hasSessions(LauncherFixtures.history())
        .hasLocalHistory([{
          sessionId: 'tree-codex-1',
          agentId: 'codex',
          nativeSessionId: 'sess-codex-1',
          title: '014 - Worktree cleanup',
          titleParts: { number: '014', name: 'Worktree cleanup' },
          life: 'ended',
        }])
      const { view, onOpenTerminal, onClose } = await openCreate(stub)

      chooseCard(view.container, 'Continue/Fork')
      await waitFor(() => expect(rowNames(view.container)).toContain('014 - Worktree cleanup'))

      expect(card(view.container).classList.contains('jamat-launcher__card--wide')).toBe(true)
      expect(chosen(view.container)).toContain('All')
      expect([...view.container.querySelectorAll('.jamat-choice__label')]
        .map((node) => node.textContent))
        .toEqual(['Project', 'Type', 'Agent', 'Existing sessions'])

      chooseCard(view.container, 'Codex')
      expect(rowNames(view.container)).toEqual(['014 - Worktree cleanup'])
      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(stub.openedHistory).toEqual([{
        directory: {
          mode: 'project',
          categoryId: 'nodejs',
          projectPath: 'C:\\Projects\\NodeJs\\AppJamat',
        },
        agentId: 'codex',
        nativeSessionId: 'sess-codex-1',
        providerName: 'Worktree cleanup',
        providerActive: false,
      }]))
      expect(stub.started).toEqual([])
      expect(stub.allocated).toEqual([])
      await waitFor(() => expect(onOpenTerminal.mock.calls)
        .toEqual([[{ kind: 'local', sessionId: 'history-1' }, 'AppJamat - continued', undefined]]))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('removes All and restores the previous agent when Continue/Fork is left', async () => {
      const { view } = await openCreate(new ProjectsStub().hasSessions(LauncherFixtures.history()))
      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      expect(chosen(view.container)).toContain('Codex')

      chooseCard(view.container, 'Continue/Fork')
      await waitFor(() => expect(chosen(view.container)).toContain('All'))
      chooseCard(view.container, 'Raw')

      expect(cardTitles(view.container)).not.toContain('All')
      expect(chosen(view.container)).toContain('Codex')
      expect(card(view.container).classList.contains('jamat-launcher__card--wide')).toBe(false)
    })

    it('keeps a refused create on the screen, in the library own words', async () => {
      const stub = new ProjectsStub().refusesCreate('not-a-repo', 'Q:/AppJamat is not a git repository')
      const { view, onClose } = await openCreate(stub)

      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(view.container.querySelector('.jamat-launcher__error')
        ?.textContent).toBe('not-a-repo Q:/AppJamat is not a git repository'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it('turns the worktree on from its key and names what it would land on', async () => {
      const { view } = await openCreate()

      fireEvent.keyDown(card(view.container), { key: 'w' })
      expect(chosen(view.container)).toContain('Worktree')
      expect(view.container.querySelector('.jamat-launcher-create__note')?.textContent)
        .toContain('jamat/015')

      fireEvent.keyDown(card(view.container), { key: 'w' })
      expect(chosen(view.container)).toContain('None')
    })

    it('goes back to the projects on Escape without closing the card', async () => {
      const { view, onClose } = await openCreate()

      fireEvent.keyDown(card(view.container), { key: 'Escape' })

      expect(view.container.querySelector('[role="tab"]')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    })

    // The read is already in flight when the screen goes away, and its answer has nowhere to land.
    it('survives a number that arrives after the screen was left', async () => {
      const { view } = await mount()
      fireEvent.keyDown(card(view.container), { key: 'Enter' })
      fireEvent.keyDown(card(view.container), { key: 'Escape' })

      await waitFor(() => expect(view.container.querySelector('[role="tab"]')).toBeTruthy())
      expect(view.container.querySelector('.jamat-launcher-create')).toBeNull()
    })

    it('skips the projects when the opener already knew one', async () => {
      const { stub, view } = await mountOnCreate()

      expect(view.container.querySelector('[role="tab"]')).toBeNull()
      expect(stub.peeked).toEqual(['C:/Projects/NodeJs/AppJamatV3'])
    })

    /**
     * Half of what the create intent carries. A right-click on a category row of the sessions tree
     * knows where but not which, so the card stays on its project screen with that category open -
     * and asks for that category first, then the other roots for the focused search.
     */
    it('opens in the category the opener knew, and picks the project there', async () => {
      const intents = new LauncherIntentStore()
      intents.set({ category: 'web' })
      const { stub, view } = await mount(new ProjectsStub(), intents)

      expect(selectedTab(view.container)).toBe('Web')
      expect(view.container.querySelector('.jamat-launcher-create')).toBeNull()
      expect(stub.listed).toEqual(['web', 'nodejs', 'ai'])
    })

    /** The edit has one opener, its own key: nothing an opener carries may start it for the user. */
    it('leaves the new-project edit closed whatever the opener asked for', async () => {
      const intents = new LauncherIntentStore()
      intents.set({ category: 'web' })
      const { view } = await mount(new ProjectsStub(), intents)

      expect(view.container.querySelector('[aria-label="New project name"]')).toBeNull()
      expect(view.container.textContent).not.toContain('Create project in')
    })

    it('binds the folder the OS dialog answered with', async () => {
      const { view } = await mount(new ProjectsStub().picks('Q:/tmp/scratch'))

      moveTo(view.container, 'Pick folder…')
      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(view.container.querySelector('.jamat-launcher-create__path')
        ?.textContent).toBe('Q:/tmp/scratch'))
    })

    /** The whole flow path: pick the row, fill the form, and one session comes out carrying it. */
    it('configures a flow before starting it, and starts what the form composed', async () => {
      const { stub, view } = await openCreate()

      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())
      expect(view.container.querySelector('.jamat-launcher__title')?.textContent)
        .toBe('Feature request')
      // Configuring is not creating: nothing has been started and no number has been taken.
      expect(stub.started).toEqual([])
      expect(stub.allocated).toEqual([])

      const summary = view.container.querySelector('[aria-label="Summary"]')
      if (!(summary instanceof HTMLInputElement))
        throw new Error('The flow drew no summary field')
      fireEvent.change(summary, { target: { value: 'Merge a worktree back' } })
      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(stub.started).toHaveLength(1))
      const spec = stub.started[0]
      expect(spec?.flowId).toBe('feature-request')
      expect(spec?.title).toBe('015 - Merge a worktree back')
      expect(spec?.agent?.initialPrompt).toBe('# Merge a worktree back')
      // The flow asks for its own branch, and the branch carries the number the title does.
      expect(spec?.worktree).toEqual({ slug: '015 - Merge a worktree back' })
    })

    /*
     * Tab was taken by the card and swallowed on this screen, which was harmless while every screen
     * was a list. A flow is a FORM - a summary and two textareas - so a keyboard user could fill the
     * first field and reach none of the others, in an overlay whose whole premise is that every
     * action names its key.
     *
     * It moves WITHIN the card and wraps, rather than being let through: the reason Tab was taken in
     * the first place still holds, and focus leaving a dialog the user cannot see they have left is
     * worse than a form they cannot fill.
     */
    it('steps focus through the flow form with Tab, and wraps at the end', async () => {
      const { view } = await openCreate()
      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())

      const stops = [...card(view.container).querySelectorAll<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), button:not([disabled])',
      )]
      expect(stops.length).toBeGreaterThan(2)

      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      const first = document.activeElement
      expect(stops).toContain(first)

      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      expect(document.activeElement).not.toBe(first)
      expect(stops).toContain(document.activeElement)

      // Every stop and one more: the last Tab comes back rather than leaving the dialog.
      for (let step = 2; step <= stops.length; step += 1)
        fireEvent.keyDown(card(view.container), { key: 'Tab' })
      expect(document.activeElement).toBe(first)
    })

    // Asserted as a round trip rather than against a list of stops built here: the card decides
    // what a stop is, and a second copy of that rule in the test would only test the copy.
    it('steps the other way with Shift and Tab', async () => {
      const { view } = await openCreate()
      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())

      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      const first = document.activeElement

      fireEvent.keyDown(card(view.container), { key: 'Tab', shiftKey: true })
      expect(document.activeElement).not.toBe(first)
      expect(card(view.container).contains(document.activeElement)).toBe(true)

      fireEvent.keyDown(card(view.container), { key: 'Tab' })
      expect(document.activeElement).toBe(first)
    })

    /*
     * Escape goes back to the create card, and the create card's own answers are carried back with
     * it. The flow's were not: a paragraph of description and acceptance criteria went with one
     * keystroke, and there was no way back to it.
     */
    it('gives back what was typed when the flow is opened again', async () => {
      const { view } = await openCreate()
      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())
      const summary = view.container.querySelector('[aria-label="Summary"]')
      if (!(summary instanceof HTMLInputElement))
        throw new Error('The flow drew no summary field')
      fireEvent.change(summary, { target: { value: 'Merge a worktree back' } })

      fireEvent.keyDown(card(view.container), { key: 'Escape' })
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
      fireEvent.keyDown(card(view.container), { key: 'Enter' })
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())

      const reopened = view.container.querySelector('[aria-label="Summary"]')
      expect(reopened instanceof HTMLInputElement && reopened.value)
        .toBe('Merge a worktree back')
    })

    it('reports an unfinished flow at its field instead of refusing the key', async () => {
      const { stub, view } = await openCreate()

      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())
      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      expect(view.container.querySelector('.jamat-launcher-flows__problem')?.textContent)
        .toBe('a summary is what the session gets as its first instruction')
      expect(stub.started).toEqual([])
    })

    /**
     * The flow screen names two keys and must answer for every other one itself. A letter that
     * fell through reached the projects screen underneath, where `F2` then `a` twice archives a
     * project the user cannot even see - a move on disk, from a form.
     */
    it('keeps every other key to itself instead of handing it to the projects screen', async () => {
      const { view } = await openCreate()

      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())

      for (const key of ['F2', 'a', 'a', 'h', 'F1', 'F3', '1', 'ArrowDown'])
        fireEvent.keyDown(card(view.container), { key })

      expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy()
      expect(view.container.textContent).not.toContain('Archive')
    })

    it('goes back from a flow to the create screen, not to the projects', async () => {
      const { view } = await openCreate()

      openFlow(view.container)
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-flows')).toBeTruthy())
      fireEvent.keyDown(card(view.container), { key: 'Escape' })

      expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy()
      expect(view.container.querySelector('[role="tab"]')).toBeNull()
    })

    it('offers no worktree on a root that is no catalog project, and says why', async () => {
      const { stub, view } = await mount()

      moveTo(view.container, 'Root project (NodeJs)')
      fireEvent.keyDown(card(view.container), { key: 'Enter' })

      await waitFor(() => expect(view.container.querySelector('.jamat-launcher-create__path')
        ?.textContent).toBe('C:\\Projects\\NodeJs'))
      expect(view.container.querySelector('.jamat-launcher-create__refusal')?.textContent)
        .toBe('a worktree needs a catalog project')
      // Nothing is counted outside a catalog project, so nothing was asked for either.
      expect(stub.peeked).toEqual([])
    })
  })

  /**
   * What a tab is called is the library's answer, not this card's: the create comes back with the
   * name and the card hands it to the tab unchanged. Where that name comes from - the project, an
   * ad-hoc leaf, a session with no directory at all - is asserted where it is composed,
   * `lib-orchestrator/sessionManager/sessionManager.test.ts`.
   */
  describe('the tab a created session is drawn in', () => {
    async function startedFrom(stub: ProjectsStub, row: string) {
      const { view, onOpenTerminal } = await mount(stub)
      moveTo(view.container, row)
      fireEvent.keyDown(card(view.container), { key: 'Enter' })
      await waitFor(() =>
        expect(view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
      fireEvent.keyDown(card(view.container), { key: 'Enter' })
      await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledOnce())
      return onOpenTerminal
    }

    it('opens the tab under the name the create answered with', async () => {
      const opened = await startedFrom(new ProjectsStub(), 'AppJamat')

      expect(opened.mock.calls).toEqual([[{ kind: 'local', sessionId: 'session-1' }, 'AppJamat - 015', undefined]])
    })

    // The same name whatever the card was filled in with: this screen composes none of it.
    it('does not rename the tab for a directory that belongs to no project', async () => {
      const opened = await startedFrom(new ProjectsStub().picks('Q:/tmp/scratch'), 'Pick folder…')

      expect(opened.mock.calls).toEqual([[{ kind: 'local', sessionId: 'session-1' }, 'AppJamat - 015', undefined]])
    })
  })

  it('turns F3 and F4 into the view and the sort the footer names', async () => {
    const { stub, view } = await mount()

    fireEvent.keyDown(card(view.container), { key: 'F3' })
    expect(view.container.querySelector('.jamat-launcher__foot')?.textContent).toContain('Flat')

    fireEvent.keyDown(card(view.container), { key: 'F4' })
    await waitFor(() => expect(stub.listed).toEqual(['nodejs', 'web', 'ai', 'nodejs', 'web', 'ai']))
    expect(view.container.querySelector('.jamat-launcher__foot')?.textContent).toContain('alpha')
  })

  /**
   * The card the New Tab key opens. It is the same two screens, asking a shorter question on the
   * second one, and the purpose belongs to the card rather than to one screen.
   */
  describe('a card opened on the tab profile', () => {
    async function toCreateScreen(context: Awaited<ReturnType<typeof mountForTabCard>>) {
      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })
      await waitFor(() =>
        expect(context.view.container.querySelector('.jamat-launcher-create')).toBeTruthy())
    }

    it('asks for a name, a short type list and an agent, and starts a tab', async () => {
      const context = await mountForTabCard()
      expect(foot(context.view.container)).not.toContain('History')
      await toCreateScreen(context)

      expect(context.view.container.querySelector('.jamat-launcher__title')?.textContent)
        .toBe('New tab')
      // Isolation is the one row this card has no use for, so it is not drawn at all.
      const labels = [...context.view.container.querySelectorAll('.jamat-choice__label')]
        .map((element) => element.textContent)
      expect(labels).toEqual(['Project', 'Name', 'Type', 'Agent'])
      // The types it offers, and the one it does not: a flow composes work the tree keeps.
      expect(context.view.container.textContent).toContain('Continue/Fork')
      expect(context.view.container.textContent).toContain('Shell')
      expect(context.view.container.textContent).not.toContain('Feature request')
      // `W` belongs to a row this card does not draw.
      expect(foot(context.view.container)).not.toContain('Worktree')

      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })
      await waitFor(() => expect(context.stub.started).toHaveLength(1))

      expect(context.stub.started[0]).toMatchObject({
        kind: 'agent',
        agent: { agentId: 'claude', mode: 'new' },
        presentation: 'tab',
      })
      expect(context.stub.started[0]?.worktree).toBeUndefined()
      // A tab is not counted against its project, so no number was peeked or claimed.
      expect(context.stub.peeked).toEqual([])
      expect(context.stub.allocated).toEqual([])
      await waitFor(() => expect(context.onOpenTerminal.mock.calls)
        .toEqual([[{ kind: 'local', sessionId: 'session-1' }, 'AppJamat - 015', { plain: true }]]))
    })

    it('closes a fresh plain runtime when its panel handoff fails', async () => {
      const context = await mountForTabCard()
      context.onOpenTerminal.mockResolvedValueOnce({
        kind: 'failed',
        detail: 'the workspace is closing',
      })
      await toCreateScreen(context)

      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })

      await waitFor(() => expect(context.stub.closedPlain).toEqual(['session-1']))
      expect(context.onClose).not.toHaveBeenCalled()
      expect(context.view.container.querySelector('.jamat-launcher__error')?.textContent)
        .toBe('panel-open the workspace is closing')
    })

    // The purpose belongs to the card: going back a screen does not turn it into a session.
    it('is still a plain tab after Escape back to the projects', async () => {
      const context = await mountForTabCard()
      await toCreateScreen(context)

      fireEvent.keyDown(card(context.view.container), { key: 'Escape' })
      await waitFor(() =>
        expect(context.view.container.querySelector('.jamat-launcher-projects')).toBeTruthy())
      await toCreateScreen(context)

      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })
      await waitFor(() => expect(context.stub.started).toHaveLength(1))
      expect(context.stub.started[0]?.presentation).toBe('tab')
    })
  })

  /*
   * The third profile: the same card, asked of another computer. Ctrl+N knows no computer and asks
   * for one; the tree's action on a connected computer already knows and skips that screen.
   */
  describe('a card opened on the remote profile', () => {
    const studioConst = { remoteEndpointId: 'endpoint-a', displayName: 'Studio' }

    async function mountRemote(stub: ProjectsStub, target?: typeof studioConst) {
      stub.install()
      const intents = new LauncherIntentStore()
      intents.set(target === undefined
        ? { purpose: 'remote' }
        : { purpose: 'remote', remote: target })
      const onClose = vi.fn()
      const onOpenRemoteSettings = vi.fn()
      const view = render(
        <LauncherOverlay
          intents={intents}
          onOpenTerminal={() => Promise.resolve({ kind: 'opened', panelId: 'terminal' })}
          onOpenRemoteSettings={onOpenRemoteSettings}
          onClose={onClose}
        />,
      )
      return { stub, view, onClose, onOpenRemoteSettings }
    }

    function heading(container: HTMLElement): string {
      return container.querySelector('.jamat-launcher__title')?.textContent ?? ''
    }

    /*
     * The one place a computer that is paired but unreachable is explained is the settings card, so
     * the empty state carries the way to it rather than leaving a short list to speak for itself.
     */
    it('asks which computer, and sends an empty list to the settings that explain it', async () => {
      const context = await mountRemote(new ProjectsStub())

      await waitFor(() => expect(context.view.container
        .querySelector('.jamat-launcher-computers__empty')).toBeTruthy())
      expect(heading(context.view.container)).toBe('Remote computers')
      expect(context.view.container.textContent)
        .toContain('No saved computers. Add a computer in Remote Control settings.')

      const button = context.view.container.querySelector('.jamat-launcher__start-button')
      if (!(button instanceof HTMLElement)) throw new Error('The empty state offers no way on')
      fireEvent.click(button)

      expect(context.onOpenRemoteSettings).toHaveBeenCalledOnce()
      expect(context.onClose).toHaveBeenCalledOnce()
    })

    it('lists the chosen computer catalog and never this machine own tail rows', async () => {
      const context = await mountRemote(new ProjectsStub().computers(studioConst))
      await waitFor(() => expect(context.view.container.textContent).toContain('Studio'))

      fireEvent.click(context.view.getByRole('tab', { name: 'New session' }))

      await waitFor(() => expect(heading(context.view.container)).toBe('Projects on Studio'))
      expect(context.stub.remoteListed).toEqual(['endpoint-a'])
      expect(rowNames(context.view.container)).toContain('AppJamat')
      expect(rowNames(context.view.container)).not.toContain('Pick folder…')
      expect(context.stub.listed).toEqual([])
      expect(foot(context.view.container)).not.toContain('Create project')
      expect(foot(context.view.container)).toContain('Computers')
    })

    it('goes back to the computer list rather than closing the card', async () => {
      const context = await mountRemote(new ProjectsStub().computers(studioConst))
      await waitFor(() => expect(context.view.container.textContent).toContain('Studio'))
      fireEvent.click(context.view.getByRole('tab', { name: 'New session' }))
      await waitFor(() => expect(heading(context.view.container)).toBe('Projects on Studio'))

      fireEvent.keyDown(card(context.view.container), { key: 'Escape' })

      await waitFor(() => expect(heading(context.view.container)).toBe('Remote computers'))
      expect(context.onClose).not.toHaveBeenCalled()
    })

    it('keeps the computer selector through creation and switches back to sessions', async () => {
      const bench = { remoteEndpointId: 'endpoint-b', displayName: 'Bench' }
      const context = await mountRemote(new ProjectsStub().computers(studioConst, bench), studioConst)
      await waitFor(() => expect(rowNames(context.view.container)).toContain('AppJamat'))
      expect(context.view.getByRole('option', { name: /Studio/ })).toHaveAttribute('aria-selected', 'true')
      moveTo(context.view.container, 'AppJamat')
      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })
      await waitFor(() => expect(heading(context.view.container)).toBe('New session on Studio'))
      fireEvent.click(context.view.getByRole('button', { name: '1. Project' }))
      await waitFor(() => expect(heading(context.view.container)).toBe('Projects on Studio'))
      fireEvent.click(context.view.getByRole('option', { name: /Bench/ }))
      expect(heading(context.view.container)).toBe('Remote computers')
      expect(context.view.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(context.view.getByRole('tab', { name: 'New session' }))
      await waitFor(() => expect(context.stub.remoteListed).toContain('endpoint-b'))
      expect(heading(context.view.container)).toBe('Projects on Bench')
      fireEvent.click(context.view.getByRole('tab', { name: 'Sessions' }))
      expect(heading(context.view.container)).toBe('Remote computers')
      expect(context.onClose).not.toHaveBeenCalled()
    })

    // The tree already knows which computer, so there is nothing left for the card to ask.
    it('opens straight on the projects when the opener named the computer', async () => {
      const context = await mountRemote(new ProjectsStub().computers(studioConst), studioConst)

      await waitFor(() => expect(heading(context.view.container)).toBe('Projects on Studio'))
      expect(context.stub.remoteListed).toEqual(['endpoint-a'])
    })

    it('carries the computer into the create card and asks it no number', async () => {
      const context = await mountRemote(new ProjectsStub().computers(studioConst), studioConst)
      await waitFor(() => expect(rowNames(context.view.container)).toContain('AppJamat'))
      moveTo(context.view.container, 'AppJamat')

      fireEvent.keyDown(card(context.view.container), { key: 'Enter' })

      await waitFor(() => expect(heading(context.view.container)).toBe('New session on Studio'))
      expect(context.view.getByRole('listbox', { name: 'Saved computers' })).toBeTruthy()
      expect(context.view.getByRole('tab', { name: 'New session' })).toHaveAttribute('aria-selected', 'true')
      expect(context.view.getByRole('button', { name: '1. Project' })).toBeEnabled()
      expect(context.stub.peeked).toEqual([])
      expect(context.view.container.querySelector('.jamat-launcher-create__refusals')?.textContent)
        .toContain('Flows run where they were defined')
    })
  })
})
