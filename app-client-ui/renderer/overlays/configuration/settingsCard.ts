import { IpcFailure } from '../../ipc/ipcFailure'
import type { IpcResult } from '../../../shared/appClientUiIpc'

/**
 * What a settings card holds while it is open, whatever it is a card FOR.
 *
 * `loaded` is what the section held when it was last read or written - the yardstick for "modified".
 * `saving` is the value a write is carrying and null when none is, which is what `loaded` becomes
 * once it lands: a control moved while the write was in flight is not on disk, and a state that read
 * "saving" as a bare yes/no would clear the dirty mark over it.
 */
export interface SettingsCardState<TValue> {
  loaded: TValue | null
  buffer: TValue | null
  saving: TValue | null
  problem: string | null
}

/** The five inputs every card has. A card's own controls add to this union, they do not replace it. */
export type SettingsCardInput<TValue> =
  | { input: 'loaded'; value: TValue }
  /** A read or a save failed; the buffer survives both. */
  | { input: 'failed'; detail: string }
  | { input: 'reset' }
  | { input: 'save' }
  | { input: 'saved'; ok: boolean; detail?: string }

export type SettingsCardEffect<TValue> =
  | { effect: 'load' }
  | { effect: 'save'; value: TValue }

export interface SettingsCardStep<TValue, TEffect> {
  state: SettingsCardState<TValue>
  effects: readonly TEffect[]
}

/**
 * The machine three settings cards share, written once.
 *
 * All three carried the same state, the same `initial`, the same `failed` / `reset` / `save` /
 * `saved` arms and the same two-effect runner; what differed was the value type and, for one of
 * them, a single domain input - seven lines of a ninety-seven-line model. A change to the rule that
 * "a save in flight is not unsaved work" was three edits, and nothing failed if one was missed.
 *
 * What each card keeps is what is genuinely its own: which controls it offers, what its defaults
 * are, and how two of its values compare.
 */
export class SettingsCard {
  static initial<TValue, TEffect extends SettingsCardEffect<TValue>>():
  SettingsCardStep<TValue, TEffect> {
    return {
      state: { loaded: null, buffer: null, saving: null, problem: null },
      effects: [{ effect: 'load' } as TEffect],
    }
  }

  /**
   * The shared arms, or **null** where the input is the card's own - which is the whole shape of
   * this: a card asks first, and handles what is left with its own exhaustive chain and its own
   * throwing `else`, so an input nobody handles is still a defect nobody can miss.
   */
  static transition<TValue, TEffect extends SettingsCardEffect<TValue>>(
    state: SettingsCardState<TValue>,
    input: { input: string; value?: unknown; detail?: string; ok?: boolean },
    defaultsOf: (buffer: TValue) => TValue,
  ): SettingsCardStep<TValue, TEffect> | null {
    if (input.input === 'loaded')
      return SettingsCard.step({ ...state, loaded: input.value as TValue, buffer: input.value as TValue })
    else if (input.input === 'failed')
      return SettingsCard.step({ ...state, saving: null, problem: input.detail ?? 'Failed' })
    else if (input.input === 'reset')
      return state.buffer === null
        ? SettingsCard.step(state)
        : SettingsCard.step({ ...state, buffer: defaultsOf(state.buffer) })
    else if (input.input === 'save') {
      // A second save while the first is in flight would race two writers over one section.
      if (state.buffer === null || state.saving !== null) return SettingsCard.step(state)
      return SettingsCard.step<TValue, TEffect>(
        { ...state, saving: state.buffer, problem: null },
        { effect: 'save', value: state.buffer } as TEffect,
      )
    }
    else if (input.input === 'saved') {
      if (input.ok !== true)
        return SettingsCard.step({ ...state, saving: null, problem: input.detail ?? 'Save refused' })
      // `loaded` becomes what the WRITE carried, not the buffer: anything moved since is still work.
      return SettingsCard.step({ ...state, saving: null, loaded: state.saving, problem: null })
    }
    return null
  }

  static step<TValue, TEffect extends SettingsCardEffect<TValue>>(
    state: SettingsCardState<TValue>,
    ...effects: readonly TEffect[]
  ): SettingsCardStep<TValue, TEffect> {
    return { state, effects }
  }

  /**
   * Unsaved work, for a card that compares its value with `same`. A save in flight is NOT unsaved
   * work: what it carries is on its way to disk, and calling it dirty would offer a Save that writes
   * the same bytes again.
   */
  static isModified<TValue>(
    state: SettingsCardState<TValue>,
    same: (loaded: TValue, buffer: TValue) => boolean,
  ): boolean {
    if (state.saving !== null || state.loaded === null || state.buffer === null) return false
    return !same(state.loaded, state.buffer)
  }
}

/** What a card's effect runner is handed: the one way back into its model. */
export interface SettingsCardPorts<TInput> {
  dispatch(input: TInput): void
}

/**
 * The load and the save, which are the same two calls over every section: read it, or write it and
 * read back whether the store took it.
 *
 * The two answers are different questions and both are asked. `answer.ok` is the CHANNEL - a call
 * that never reached the main process - and `value.ok` is the store's own decision; a card that read
 * only one of them goes silent on the other.
 */
export class SettingsCardEffects {
  static async load<TValue, TInput>(
    read: () => Promise<IpcResult<TValue>>,
    ports: SettingsCardPorts<TInput>,
    input: {
      loaded: (value: TValue) => TInput
      failed: (detail: string) => TInput
    },
  ): Promise<void> {
    const answer = await read()
    if (!answer.ok)
      return ports.dispatch(input.failed(`The main process did not answer: ${answer.error}`))
    ports.dispatch(input.loaded(answer.value))
  }

  static async save<TValue, TInput>(
    value: TValue,
    write: (value: TValue) => Promise<IpcResult<{ ok: true } | { ok: false; code: string; detail: string }>>,
    ports: SettingsCardPorts<TInput>,
    input: {
      failed: (detail: string) => TInput
      saved: (ok: boolean, detail?: string) => TInput
    },
  ): Promise<void> {
    const answer = await write(value)
    if (!answer.ok)
      return ports.dispatch(input.failed(`The main process did not answer: ${answer.error}`))
    const refusal = IpcFailure.of(answer)
    if (refusal !== null) return ports.dispatch(input.saved(false, refusal))
    ports.dispatch(input.saved(true))
  }
}
