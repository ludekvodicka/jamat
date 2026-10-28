import { type TerminalTarget, TerminalTargetCodec } from '../../shared/terminalTarget'

/**
 * A session row carried by drag and drop, from the sessions tree to a terminal that pastes its reference.
 *
 * Only the custom type is written, never `text/plain`: the tabs controller accepts any drag that carries
 * plain text as a possible tab transfer, so dockview would draw its split overlay over the terminal and
 * take the drop for itself.
 */
export class SessionDrag {
  private static readonly mimeConst = 'application/x-jamat-session'

  static write(dataTransfer: Pick<DataTransfer, 'setData'>, target: TerminalTarget): void {
    dataTransfer.setData(SessionDrag.mimeConst, JSON.stringify(TerminalTargetCodec.params(target)))
  }

  /** During dragover only the types are readable; the payload waits for the drop. */
  static carries(dataTransfer: Pick<DataTransfer, 'types'> | null): boolean {
    return dataTransfer !== null && dataTransfer.types.includes(SessionDrag.mimeConst)
  }

  static targetOf(dataTransfer: Pick<DataTransfer, 'getData'> | null): TerminalTarget | null {
    if (dataTransfer === null) return null
    const data = dataTransfer.getData(SessionDrag.mimeConst)
    if (data.length === 0) return null
    try {
      return TerminalTargetCodec.read(JSON.parse(data))?.target ?? null
    } catch {
      return null
    }
  }
}
