import type { AttentionItemView, AttentionKind, AttentionSnapshot } from '../../shared/attention'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import { IpcFailure } from '../ipc/ipcFailure'
import type { SnapshotStorePorts } from '../ipc/snapshotStore'
import './attentionStatusItem.css'

export interface AttentionStatusPorts extends SnapshotStorePorts<AttentionSnapshot> {
  next(): Promise<IpcResult<void>>
}

/**
 * What waits for the person, and the way to it: a click brings the first waiting item forward. The
 * number counts every item; it is lit while one of them would come forward by itself.
 */
export function AttentionStatusItem(props: { items: readonly AttentionItemView[]; ports: AttentionStatusPorts }): React.JSX.Element {
  const automatic = props.items.some((item) => item.automatic)
  const next = async (): Promise<void> => {
    try { IpcFailure.unwrap(await props.ports.next()) }
    catch (error) { props.ports.reportError(`The next waiting item could not be shown: ${ErrorText.of(error)}`) }
  }
  return (
    <button type="button" className={`jamat-attention${automatic ? ' jamat-attention--automatic' : ''}`}
      title={AttentionStatusText.tooltipOf(props.items)} aria-label={`${props.items.length} waiting for you, show the next one`}
      onClick={() => void next()}>
      {`! ${props.items.length}`}
    </button>
  )
}

export class AttentionStatusText {
  static tooltipOf(items: readonly AttentionItemView[]): string {
    return ['Click to show the next one:', ...items.map((item) => `${AttentionStatusText.kindOf(item.kind)}: ${item.title}`)].join('\n')
  }

  static kindOf(kind: AttentionKind): string {
    if (kind === 'commit-review') return 'Commit review'
    else if (kind === 'finish-wait') return 'Finish waits'
    else if (kind === 'session-opened') return 'Opened by an agent'
    else if (kind === 'session-mark') return 'Needs a look'
    else throw new Error(`Unknown attention kind: ${JSON.stringify(kind satisfies never)}`)
  }
}
