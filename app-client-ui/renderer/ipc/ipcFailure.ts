import type { IpcResult } from '../../shared/appClientUiIpc'

/**
 * Every library answer that can refuse, seen from here. The subsystems disagree about what rides on
 * the success arm - `SessionsOpResult` carries a value, `TerminalAttachResult` carries none - and
 * they disagree about the refusal arm in exactly one way: a LOCAL answer puts the code and the
 * sentence on itself, a REMOTE one puts them behind `error`, because a remote answer is somebody
 * else's envelope forwarded whole.
 *
 * Both are read here. The header used to say the refusal arm was the one thing they agreed on, and
 * three hand-written copies of the remote shape had appeared beside it while it said so.
 */
type LibraryRefusal<TCode extends string> =
  | { ok: false; code: TCode; detail: string }
  | { ok: false; error: { code: TCode; detail: string } }

type LibraryAnswer<TCode extends string = string> =
  { ok: true; value?: unknown } | LibraryRefusal<TCode>

export class IpcFailure {
  /**
   * Two unwraps in order: the channel first, and only then what the library decided.
   *
   * They are two separate refusals and they fail differently. A call that never reached the main
   * process has an `error` and no code, because nothing on the other side ever formed an opinion;
   * a call that arrived and was refused has both. A surface that reads only one of them goes silent
   * on the other, which is the shape the bug this was extracted from had: three copies of these six
   * lines, one per surface, each written the day that surface was.
   *
   * Null means it worked. `label` names the operation, for a surface that can have more than one in
   * flight and would otherwise report a reason without saying what it is about; a surface whose
   * whole job is one operation leaves it out.
   */
  static of(answer: IpcResult<LibraryAnswer>, label?: string): string | null {
    const reason = IpcFailure.reasonOf(answer)
    if (reason === null) return null
    return label === undefined ? reason : `${label} failed: ${reason}`
  }

  /**
   * The channel's own answer, for a caller with nowhere to report a refusal and no way to carry on
   * without the value: the shell's tab operations, which run under `started` and are reported by
   * whoever catches the rejection.
   *
   * Not interchangeable with `of` above. That one asks what the library DECIDED and hands back a
   * sentence; this one asks whether the call reached the main process at all, and throws when it
   * did not. A surface reading only one of them goes silent on the other.
   */
  static unwrap<T>(result: IpcResult<T>): T {
    if (!result.ok)
      throw new Error(result.error)
    return result.value
  }

  /**
   * The refusal's CODE, for a surface that branches on it rather than reporting it - a terminal
   * offering Restart reads it, and a terminal that was refused for a reason it can ignore reads it
   * too. Null when nothing was refused, and null for a call that never reached the main process:
   * there is no code, for the reason `of` gives above.
   */
  static codeOf<TCode extends string>(answer: IpcResult<LibraryAnswer<TCode>>): TCode | null {
    if (!answer.ok || answer.value.ok) return null
    return 'error' in answer.value ? answer.value.error.code : answer.value.code
  }

  private static reasonOf(answer: IpcResult<LibraryAnswer>): string | null {
    if (!answer.ok) return answer.error
    if (answer.value.ok) return null
    const refusal = 'error' in answer.value ? answer.value.error : answer.value
    return `${refusal.code}: ${refusal.detail}`
  }
}
