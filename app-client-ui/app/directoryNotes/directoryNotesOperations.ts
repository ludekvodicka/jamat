import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { ConfigOpRefusal } from '../../../lib-orchestrator/configStore/configStore.types'
import type {
  RemoteControlTerminal,
  RemoteControlTerminalKeep,
  RemoteControlTerminalTakeRefusal,
  RemoteControlTerminalTakeResult,
} from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { AppOperationMap } from '../../shared/appOperationMap'
import {
  DirectoryNotes,
  type DirectoryNote,
  type DirectoryNotesGetResult,
  type DirectoryNotesImportRefusal,
  type DirectoryNotesImportResult,
  type DirectoryNotesSaveResult,
} from '../../shared/directoryNotes'
import { DirectoryNotesSection } from './directoryNotesSection'

interface KeptImport {
  notes: readonly DirectoryNote[]
  index: number
}

/**
 * The one owner of the Notes data. A window names a session and main resolves its working
 * directory, so a renderer never chooses which key of `config.json` it writes.
 */
export class DirectoryNotesOperations {
  private readonly configStore: ConfigStore
  private readonly sessions: Pick<SessionManager, 'workingContext'>
  private readonly terminal: Pick<RemoteControlTerminal, 'take'>
  private readonly onChanged: (directory: string) => void

  constructor(
    configStore: ConfigStore,
    sessions: Pick<SessionManager, 'workingContext'>,
    terminal: Pick<RemoteControlTerminal, 'take'>,
    onChanged: (directory: string) => void,
  ) {
    this.configStore = configStore
    this.sessions = sessions
    this.terminal = terminal
    this.onChanged = onChanged
  }

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    const sessionId = RemoteControlZod.text()
    op('directoryNotes.get', {
      kind: 'read',
      description: "The notes of the session's working directory, and that directory.",
      input: z.strictObject({ sessionId }),
      run: async (body) => RemoteControlOutcome.of(await this.get(body.sessionId)),
    })
    op('directoryNotes.save', {
      kind: 'write',
      description: "Replace the notes of the session's working directory; the limits are checked here.",
      input: z.strictObject({
        sessionId,
        notes: z.array(RemoteControlZod.ownedObject<DirectoryNote>(), { error: 'notes must be a list' }),
      }),
      run: async (body) => RemoteControlOutcome.of(await this.save(body.sessionId, body.notes)),
    })
    op('directoryNotes.importPrompt', {
      kind: 'write',
      description: "Store the agent's unsent prompt as a note, then erase it from the prompt; never presses Enter.",
      input: z.strictObject({ sessionId }),
      run: async (body) => ({ ok: true, value: await this.importPrompt(body.sessionId) }),
    })
  }

  /** A damaged section is a refusal, not an empty editor that a later save would write over it. */
  private async get(sessionId: string): Promise<DirectoryNotesGetResult> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, code: context.code, detail: context.detail }
    const damage = this.configStore.sectionDamage(DirectoryNotesSection.spec)
    if (damage !== null) return { ok: false, code: DirectoryNotesOperations.damageCodeOf(damage), detail: damage.detail }
    const value = this.configStore.readSection(DirectoryNotesSection.spec)
    return { ok: true, value: { directory: context.value.cwd, notes: DirectoryNotes.at(value, context.value.cwd) } }
  }

  private async save(sessionId: string, notes: readonly DirectoryNote[]): Promise<DirectoryNotesSaveResult> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, code: context.code, detail: context.detail }
    const problem = DirectoryNotes.problemOf(notes)
    if (problem !== null) return { ok: false, code: 'invalid-section', detail: problem }
    // No await from here on: one turn of the main process owns the read-modify-write.
    const current = this.configStore.readSection(DirectoryNotesSection.spec)
    const saved = this.configStore.saveSection(
      DirectoryNotesSection.spec,
      DirectoryNotes.withDirectory(current, context.value.cwd, notes),
    )
    if (saved.ok) {
      this.onChanged(context.value.cwd)
      return saved
    } else if (saved.code === 'config-latched' || saved.code === 'section-damaged' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected directoryNotes save result: ${JSON.stringify(saved)}`)
  }

  /**
   * The keep runs inside `take` between the read and the first DEL, synchronously: the prompt is
   * stored before a byte of the erase leaves, and a refused store means no byte leaves at all.
   */
  private async importPrompt(sessionId: string): Promise<DirectoryNotesImportResult> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok) return { kind: 'refused', reason: 'unknown-session', detail: context.detail }
    const directory = context.value.cwd
    const damage = this.configStore.sectionDamage(DirectoryNotesSection.spec)
    if (damage !== null) return { kind: 'refused', reason: 'storage', detail: damage.detail }
    const kept: { current: KeptImport | null } = { current: null }
    const keep: RemoteControlTerminalKeep = (text) => {
      const imported = DirectoryNotes.withImported(
        this.configStore.readSection(DirectoryNotesSection.spec), directory, text)
      const notes = DirectoryNotes.at(imported.value, directory)
      const problem = DirectoryNotes.problemOf(notes)
      if (problem !== null) return { ok: false, detail: problem }
      const saved = this.configStore.saveSection(DirectoryNotesSection.spec, imported.value)
      if (!saved.ok) return { ok: false, detail: saved.detail }
      kept.current = { notes, index: imported.index }
      return { ok: true }
    }
    const taken = await this.terminal.take(sessionId, keep)
    if (kept.current !== null) this.onChanged(directory)
    return DirectoryNotesOperations.importResultOf(taken, kept.current)
  }

  private static importResultOf(
    taken: RemoteControlTerminalTakeResult,
    kept: KeptImport | null,
  ): DirectoryNotesImportResult {
    if (taken.kind === 'taken') {
      if (kept === null) throw new Error('A take answered taken without a stored note')
      return { kind: 'taken', notes: kept.notes, index: kept.index }
    } else if (taken.kind === 'partial') {
      if (kept === null) throw new Error('A take answered partial without a stored note')
      return { kind: 'partial', notes: kept.notes, index: kept.index, reason: taken.reason, detail: taken.detail }
    } else if (taken.kind === 'empty') return { kind: 'empty' }
    else if (taken.kind === 'refused')
      return { kind: 'refused', reason: DirectoryNotesOperations.refusalOf(taken.reason), detail: taken.detail }
    else
      throw new Error(`Unknown take result: ${JSON.stringify(taken)}`)
  }

  private static refusalOf(reason: RemoteControlTerminalTakeRefusal): DirectoryNotesImportRefusal {
    if (reason === 'unknown-session') return 'unknown-session'
    else if (reason === 'not-live') return 'not-live'
    else if (reason === 'not-agent') return 'not-agent'
    else if (reason === 'unreadable') return 'unreadable'
    else if (reason === 'dialog') return 'dialog'
    else if (reason === 'no-prompt') return 'no-prompt'
    else if (reason === 'too-tall') return 'too-tall'
    else if (reason === 'placeholder') return 'placeholder'
    else if (reason === 'in-flight') return 'in-flight'
    else if (reason === 'read-only') return 'read-only'
    else if (reason === 'keep-refused') return 'storage'
    else if (reason === 'unavailable') return 'unavailable'
    else if (reason === 'failed') return 'failed'
    else
      throw new Error(`Unknown take refusal: ${JSON.stringify(reason)}`)
  }

  /** `sectionDamage` answers only these two; the offered value is not judged by a read. */
  private static damageCodeOf(damage: ConfigOpRefusal): 'config-latched' | 'section-damaged' {
    if (damage.code === 'config-latched' || damage.code === 'section-damaged') return damage.code
    else if (damage.code === 'invalid-section')
      throw new Error(`A section read answered a save refusal: ${JSON.stringify(damage)}`)
    else
      throw new Error(`Unknown section damage: ${JSON.stringify(damage)}`)
  }
}
