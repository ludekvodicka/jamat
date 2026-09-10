import { describe, expect, it } from 'vitest'

import {
  AppCommands,
  type CommandDescriptor,
  type CommandId,
  type CommandSurface,
  type ValueCarryingCommandId,
} from './commands'

describe('app-client-ui/shared/commands', () => {
  /** The three surfaces `CommandMenuEntries` draws, and therefore the ones that have blocks. */
  const drawnMenuSurfacesConst: readonly CommandSurface[] =
    ['contextMenu', 'sessionsTree', 'sessionsTreeGroup']

  function descriptorsOf(...ids: readonly CommandId[]): CommandDescriptor[] {
    return AppCommands.all().filter((descriptor) => ids.includes(descriptor.id))
  }

  // The design-time verification of D7: a shortcut the shell takes is a shortcut the terminal loses.
  it('takes no accelerator that belongs to the terminal', () => {
    const reserved: readonly string[] = AppCommands.reservedTerminalKeysConst
    for (const descriptor of AppCommands.all())
      expect(reserved, `${descriptor.id} took a reserved key`)
        .not.toContain(descriptor.accelerator)
  })

  /*
   * A role item is Electron's own: the menu hands it `{ role, label }` and Electron binds the key
   * itself. The key still has to be DECLARED here, because this catalog is the single list of what
   * claims one and `TerminalKeyGate` builds its map from exactly that list - a role whose key is
   * absent is a key the gate has never heard of, and the terminal turns it into bytes beside
   * whatever the role did.
   *
   * Nothing was doubled before these two were declared, and the reason was luck rather than design:
   * this xterm encodes nothing for `Ctrl+Shift+<letter>`, so the byte that would have arrived was
   * empty. The invariant was survived, not held.
   */
  it('gives every role command a key the terminal gate can see', () => {
    const roles = AppCommands.all().filter((command) => command.role !== undefined)

    expect(roles.length).toBeGreaterThan(0)
    for (const command of roles)
      expect(command.accelerator, command.id).toBeDefined()
  })

  it('holds exactly the commands of the catalog with their accelerators', () => {
    const accelerators = AppCommands.all().map(({ id, accelerator }) => [id, accelerator ?? null])
    expect(accelerators).toEqual([
      ['session.new', 'Ctrl+T'],
      ['session.newRemote', 'Ctrl+N'],
      ['settings.open', 'Ctrl+,'],
      ['app.quit', 'Ctrl+Q'],
      ['tab.new', 'Ctrl+Shift+T'],
      ['session.setColor', null],
      ['session.details', 'F2'],
      ['session.newHere', null],
      ['session.newBeside', null],
      ['session.newInClaude', null],
      ['session.newInCodex', null],
      ['session.fork', null],
      ['session.resume', null],
      ['session.restart', null],
      ['session.compact', null],
      ['session.commitSvn', null],
      ['session.commitGit', null],
      ['tab.openProjectFolder', null],
      ['tab.copyProjectFolder', null],
      ['session.copyReference', null],
      ['project.openFolder', null],
      ['project.copyFolderPath', null],
      ['project.worktreeSetup', null],
      ['tab.promote', null],
      ['tab.keepOpen', null],
      ['tab.close', 'Ctrl+W'],
      ['tab.closeOthers', null],
      ['tab.splitRight', 'Ctrl+Shift+Right'],
      ['tab.splitDown', 'Ctrl+Shift+Down'],
      ['tab.moveToNewWindow', null],
      // A chord is not an accelerator; the four of them are checked as chords below.
      ['tab.moveRight', null],
      ['tab.moveLeft', null],
      ['tab.moveUp', null],
      ['tab.moveDown', null],
      ['tab.resetLayout', null],
      ['view.toggleLeftSidebar', 'Ctrl+B'],
      ['view.toggleRightSidebar', 'Ctrl+Alt+B'],
      ['view.toggleTabSidebar', 'Ctrl+G'],
      ['view.fileChanges', 'Ctrl+H'],
      ['view.fileBack', null],
      ['view.maximizeToggle', 'F11'],
      ['app.toggleDevTools', 'Ctrl+Shift+I'],
      ['tools.remarkable', null],
      ['app.checkForUpdates', null],
      ['window.new', 'Ctrl+Shift+N'],
      ['window.settings', null],
      ['debug.open', 'Ctrl+Shift+D'],
      ['debug.newProbe', null],
      ['app.reload', null],
      ['app.restart', null],
    ])
  })

  it('gives every accelerator to exactly one command', () => {
    const accelerators = AppCommands.all()
      .map((descriptor) => descriptor.accelerator)
      .filter((accelerator): accelerator is string => accelerator !== undefined)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  /*
   * The launcher pair. What is checked here is not that the two swap - the next test is - but that
   * the swap changes nothing else about keys: the same set is claimed under both answers, which is
   * what lets the reserved-key rule, the uniqueness rule above and `TerminalKeyGate`'s map keep
   * reading the catalog alone.
   */
  it('claims the same keys under both launcher preferences', () => {
    const claimedUnder = (preference: 'session-first' | 'tab-first'): Set<string> =>
      new Set(AppCommands.all()
        .map((descriptor) => AppCommands.acceleratorOf(descriptor, preference))
        .filter((accelerator): accelerator is string => accelerator !== undefined))

    expect(claimedUnder('tab-first')).toEqual(claimedUnder('session-first'))
  })

  /**
   * The key the pair freed, and the one command outside it that a preference must not move: the
   * network card is the third profile of the same launcher, and a swap that reached it would make
   * Ctrl+N mean two things depending on a setting about the other two cards.
   */
  it('gives Ctrl+N to session.newRemote under both launcher preferences', () => {
    for (const preference of ['session-first', 'tab-first'] as const)
      expect(AppCommands.acceleratorOf(AppCommands.byId('session.newRemote'), preference))
        .toBe('Ctrl+N')
    expect(AppCommands.acceleratorOf(AppCommands.byId('session.newRemote'))).toBe('Ctrl+N')
  })

  it('swaps only the two launcher commands, and only when asked', () => {
    const keyOf = (id: 'session.new' | 'tab.new', preference: 'session-first' | 'tab-first') =>
      AppCommands.acceleratorOf(AppCommands.byId(id), preference)

    expect(keyOf('session.new', 'session-first')).toBe('Ctrl+T')
    expect(keyOf('tab.new', 'session-first')).toBe('Ctrl+Shift+T')
    expect(keyOf('session.new', 'tab-first')).toBe('Ctrl+Shift+T')
    expect(keyOf('tab.new', 'tab-first')).toBe('Ctrl+T')
    // Any other command answers with its own key under either value, and the default is the
    // catalog's own reading of itself.
    for (const preference of ['session-first', 'tab-first'] as const)
      for (const descriptor of AppCommands.all())
        if (descriptor.id !== 'session.new' && descriptor.id !== 'tab.new')
          expect(AppCommands.acceleratorOf(descriptor, preference), descriptor.id)
            .toBe(descriptor.accelerator)
    expect(AppCommands.acceleratorOf(AppCommands.byId('tab.new'))).toBe('Ctrl+Shift+T')
  })

  it('throws on a launcher preference it does not know', () => {
    expect(() => AppCommands.acceleratorOf(AppCommands.byId('tab.new'), 'ctrl-p' as never))
      .toThrow(/Unknown launcher key preference/)
  })

  it('has a unique id per command', () => {
    const ids = AppCommands.all().map((descriptor) => descriptor.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every command exactly one target', () => {
    for (const descriptor of AppCommands.all())
      expect(['main', 'renderer'], descriptor.id).toContain(descriptor.target)
  })

  it('routes sidebar commands to main and every other renderer command to the focused workspace', () => {
    for (const descriptor of AppCommands.all()) {
      if (descriptor.target === 'main')
        expect(descriptor.windowScope, descriptor.id).toBeUndefined()
      else if (
        descriptor.id === 'view.toggleLeftSidebar'
        || descriptor.id === 'view.toggleRightSidebar'
      )
        expect(descriptor.windowScope, descriptor.id).toBe('main')
      else
        expect(descriptor.windowScope, descriptor.id).toBe('any')
    }
  })

  it('runs every role command in the main process', () => {
    for (const descriptor of AppCommands.all().filter((candidate) => candidate.role))
      expect(descriptor.target, descriptor.id).toBe('main')
  })

  // The role would register Ctrl+R, which is the shell's reverse-search.
  it('leaves app.reload without an accelerator and without a role', () => {
    const [reload] = descriptorsOf('app.reload')
    expect(reload.accelerator).toBeUndefined()
    expect(reload.role).toBeUndefined()
  })

  it('exposes Remarkable only as a bare focused-workspace Tools command', () => {
    const [remarkable] = descriptorsOf('tools.remarkable')
    expect(remarkable).toMatchObject({
      title: 'Remarkable',
      target: 'renderer',
      windowScope: 'any',
      menu: { section: 'tools', group: 0 },
      surfaces: ['menu'],
      terminalSafe: true,
    })
    expect(remarkable.accelerator).toBeUndefined()
    expect(remarkable.registerAccelerator).toBeUndefined()
  })

  /**
   * The update check runs in the main process because the updater does, and it takes no key: it is
   * asked for by hand once in a while, and a key claimed here is a key the terminal loses for ever.
   * Its own group is what draws the separator between a panel and a question about the application.
   */
  it('exposes the update check as a bare main-process Tools command', () => {
    const [check] = descriptorsOf('app.checkForUpdates')
    expect(check).toMatchObject({
      title: 'Check for Updates…',
      target: 'main',
      menu: { section: 'tools', group: 1 },
      surfaces: ['menu'],
      terminalSafe: true,
    })
    expect(check.accelerator).toBeUndefined()
    expect(check.windowScope).toBeUndefined()
  })

  it('gives every menu command a menu section', () => {
    for (const descriptor of AppCommands.forSurface('menu'))
      expect(descriptor.menu, descriptor.id).toBeDefined()
  })

  it('returns only the descriptors declaring the asked surface', () => {
    const contextMenu = AppCommands.forSurface('contextMenu').map((descriptor) => descriptor.id)
    expect(contextMenu)
      .toEqual([
        'session.setColor',
        'session.details',
        'session.newBeside',
        'session.newInClaude',
        'session.newInCodex',
        'session.fork',
        'session.resume',
        'session.restart',
        'session.compact',
        'session.commitSvn',
        'session.commitGit',
        'tab.openProjectFolder',
        'tab.copyProjectFolder',
        'session.copyReference',
        'tab.promote',
        'tab.keepOpen',
        'tab.close',
        'tab.closeOthers',
        'tab.splitRight',
        'tab.splitDown',
        'tab.moveToNewWindow',
      ])
  })

  /**
   * Three surfaces since 2026-08-19. The native menu is the only one that can register a key, so the
   * item in the Tab section is what makes F2 - V1's key for this dialog - work at all, and it is
   * legal there because the command carries no value, only an optional target. It stays terminal-safe
   * so a focused terminal loses the key rather than receiving the bytes as well, which also means it
   * must NOT set `registerAccelerator: false`.
   *
   * Where it SITS is two different answers since 2026-09-09: in the native Tab section it is still
   * the first group, beside the two other things done to the tab in front, while in both context
   * menus the colour now stands above it - the row a person reaches for again and again, over the
   * card they open once.
   */
  it('gives session.details F2 through the Tab menu, under the colour in a context menu', () => {
    const [details] = descriptorsOf('session.details')
    expect(details.surfaces).toEqual(['menu', 'contextMenu', 'sessionsTree'])
    expect(details.accelerator).toBe('F2')
    expect(details.menu).toEqual({ section: 'tab', group: 0 })
    expect(details.terminalSafe).toBe(true)
    expect(details.registerAccelerator).toBeUndefined()
    const contextMenu = AppCommands.forSurface('contextMenu').map((descriptor) => descriptor.id)
    expect(contextMenu.indexOf('session.setColor'))
      .toBeLessThan(contextMenu.indexOf('session.details'))
  })

  /**
   * The four moves are the only commands with a key the native menu cannot fire, so the rules that
   * keep a key deliverable are checked here rather than left to the window that reads them: one
   * leader for all of them, two strokes each, no accelerator beside the chord, and nothing that
   * needs a value - a keystroke carries none.
   */
  it('keeps every chord deliverable by the one window that delivers them', () => {
    const chords = AppCommands.all().filter((descriptor) => descriptor.chord !== undefined)

    expect(chords.map((descriptor) => [descriptor.id, descriptor.chord])).toEqual([
      ['tab.moveRight', 'Alt+T Alt+N'],
      ['tab.moveLeft', 'Alt+T Alt+P'],
      ['tab.moveUp', 'Alt+T Alt+U'],
      ['tab.moveDown', 'Alt+T Alt+D'],
    ])
    for (const descriptor of chords) {
      const strokes = (descriptor.chord ?? '').split(' ')
      expect(strokes, descriptor.id).toHaveLength(2)
      expect(strokes[0], descriptor.id).toBe('Alt+T')
      expect(descriptor.accelerator, descriptor.id).toBeUndefined()
      expect(descriptor.carriesValue, descriptor.id).toBeUndefined()
      // The window consumes both strokes before xterm sees them, so the gate has nothing to do -
      // but a chord command still runs while a terminal has the focus, which is what this says.
      expect(descriptor.terminalSafe, descriptor.id).toBe(true)
    }
  })

  /**
   * The catalog order is the menu order within a section too, and the groups of a section have to
   * run in order for the separator rule to draw the blocks somebody meant. The properties card
   * landing between the two other things done to the tab in front is what that order gives.
   */
  it('keeps the groups of every menu section in catalog order', () => {
    const bySection = new Map<string, number[]>()
    for (const descriptor of AppCommands.forSurface('menu')) {
      const placement = descriptor.menu
      if (placement === undefined)
        throw new Error(`Menu command without a placement: ${descriptor.id}`)
      bySection.set(placement.section, [...bySection.get(placement.section) ?? [], placement.group])
    }
    for (const [section, groups] of bySection)
      expect(groups, section).toEqual([...groups].sort((one, other) => one - other))
    expect(AppCommands.forSurface('menu')
      .filter((descriptor) => descriptor.menu?.section === 'tab')
      .map((descriptor) => descriptor.id))
      .toEqual([
        'tab.new',
        'session.details',
        'tab.close',
        'tab.splitRight',
        'tab.splitDown',
        'tab.moveToNewWindow',
        'tab.moveRight',
        'tab.moveLeft',
        'tab.moveUp',
        'tab.moveDown',
        'tab.resetLayout',
      ])
  })

  // The catalog part of the tree menu is the session block plus the folder pair and promote. A live
  // row uses Restart from here; an ended row substitutes Rerun from its current operations.
  it('gives the sessions tree exactly its catalog commands', () => {
    expect(AppCommands.forSurface('sessionsTree').map((descriptor) => descriptor.id))
      .toEqual([
        'session.setColor',
        'session.details',
        'session.newBeside',
        'session.newInClaude',
        'session.newInCodex',
        'session.fork',
        'session.resume',
        'session.restart',
        'session.compact',
        'session.commitSvn',
        'session.commitGit',
        'tab.openProjectFolder',
        'tab.copyProjectFolder',
        'session.copyReference',
        'tab.promote',
      ])
  })

  // The tree's session rows offer nothing of their own: that surface is a second place for the tab
  // menu's commands, which is also what keeps the two menus acting on one catalog order.
  it('gives every sessions-tree command the context menu too', () => {
    for (const descriptor of AppCommands.forSurface('sessionsTree'))
      expect(descriptor.surfaces, descriptor.id).toContain('contextMenu')
  })

  /**
   * The rows ABOVE a session, which is the one surface with commands of its own: a category and a
   * project are places rather than sessions, so nothing that acts on a session can appear there.
   */
  it('gives the group rows the place commands and nothing session-scoped', () => {
    expect(AppCommands.forSurface('sessionsTreeGroup').map((descriptor) => descriptor.id))
      .toEqual([
        'session.newHere',
        'project.openFolder',
        'project.copyFolderPath',
        'project.worktreeSetup',
      ])
  })

  /**
   * The flag is what the RUNTIME reads - `AppCommands.carriesValue`, for the two callers holding a
   * plain id - and `ValueCarryingCommandId` is what the COMPILER refuses. One fact, written twice,
   * and this is the only place the two meet: `Record` demands every member of the type and the
   * excess-property check refuses anything outside it, so the literal below cannot disagree with
   * `CommandArgById`; the comparison then holds the catalog to the same list. Make an argument
   * optional and forget the flag, or flag a command whose argument is optional, and this goes red.
   */
  it('flags exactly the commands whose argument is required', () => {
    const requiredConst = {
      'session.newHere': true,
      'session.setColor': true,
      'project.openFolder': true,
      'project.copyFolderPath': true,
      'project.worktreeSetup': true,
    } satisfies Record<ValueCarryingCommandId, true>

    const flagged = AppCommands.all().filter((one) => one.carriesValue).map((one) => one.id)
    expect([...flagged].sort()).toEqual(Object.keys(requiredConst).sort())
  })

  /**
   * The native menu sends an id and nothing else, so a command that only means something with a
   * value cannot live there. This is the rule that keeps the overload in `CommandRegistry` honest.
   */
  it('keeps a command that carries a value out of the native menu', () => {
    for (const descriptor of AppCommands.all().filter((one) => one.carriesValue))
      expect(descriptor.surfaces, descriptor.id).not.toContain('menu')
  })

  // Reaching one by keyboard would send it with no value, which is the same fault by another route.
  it('gives a command that carries a value no accelerator', () => {
    for (const descriptor of AppCommands.all().filter((one) => one.carriesValue))
      expect(descriptor.accelerator, descriptor.id).toBeUndefined()
  })

  /**
   * A block is what `CommandMenuEntries` draws separators from, so the rule is about every surface
   * that builder serves - the tab menu and both row menus of the tree - and about no other. The
   * native menu has sections of its own and knows nothing of blocks.
   */
  it('puts every drawn-menu command in a block, and nothing else in one', () => {
    for (const descriptor of AppCommands.all()) {
      const drawn = drawnMenuSurfacesConst
        .some((surface) => descriptor.surfaces.includes(surface))
      if (drawn)
        expect(descriptor.contextMenuGroup, descriptor.id).toBeDefined()
      else
        expect(descriptor.contextMenuGroup, descriptor.id).toBeUndefined()
    }
  })

  /**
   * The catalog order IS the menu order, so the blocks have to run in order too. Sorting in the menu
   * would hide a catalog whose blocks are interleaved; this says the catalog itself is the answer.
   * Per surface, because each draws its own subset of the one catalog.
   */
  it('keeps the blocks of every drawn menu in catalog order', () => {
    for (const surface of drawnMenuSurfacesConst) {
      const groups = AppCommands.forSurface(surface)
        .map((descriptor) => descriptor.contextMenuGroup ?? 0)
      expect(groups, surface).toEqual([...groups].sort((one, other) => one - other))
    }
  })

  it('gives main every renderer command and keeps main-scoped commands out of holders', () => {
    const rendererIds = AppCommands.all()
      .filter((descriptor) => descriptor.target === 'renderer')
      .map((descriptor) => descriptor.id)
    expect(AppCommands.rendererFor('main').map((descriptor) => descriptor.id))
      .toEqual(rendererIds)
    expect(AppCommands.rendererFor('holder').map((descriptor) => descriptor.id))
      .toEqual(rendererIds.filter((id) =>
        id !== 'view.toggleLeftSidebar' && id !== 'view.toggleRightSidebar'))
  })

  it('rejects an unknown renderer role', () => {
    expect(() => AppCommands.rendererFor('detached' as never)).toThrow(/Unknown workspace role/)
  })

  // The catalog answers by filtering, so an id outside it is an empty answer, never a stale one.
  it('knows nothing of an id that is not in the catalog', () => {
    expect(descriptorsOf('tab.teleport' as CommandId)).toEqual([])
  })
})
