import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  FileChangeGroup,
  FileChangesSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { FileChangesViewModel } from './fileViewerPanel.types'
import { useFileChanges } from './useFileChanges'

/**
 * The read behind the File Changes sidebar, which is slow by nature: a listing runs two VCS
 * detections, a status and a hundred commits. Everything here is about what happens when a second
 * ask overtakes the first, because that is what a Refresh button and a Load-older button next to
 * each other produce.
 */
describe('app-client-ui/renderer/fileViewer/useFileChanges', () => {
  interface Pending<T> {
    promise: Promise<T>
    settle(value: T): void
  }

  let lists: Pending<unknown>[]
  let histories: Pending<unknown>[]
  let model: FileChangesViewModel | null

  function pending<T>(): Pending<T> {
    let settle: (value: T) => void = () => undefined
    const promise = new Promise<T>((resolve) => { settle = resolve })
    return { promise, settle: (value) => settle(value) }
  }

  function snapshotOf(snapshotId: string, groupId: string, cursor: string | null): FileChangesSnapshot {
    return {
      snapshotId,
      cwd: 'C:/work',
      vcs: { selected: 'git', detected: ['git'] },
      entries: [],
      defaultBaseline: null,
      history: { groups: [groupOf(groupId)], nextCursor: cursor },
      warnings: [],
    } as unknown as FileChangesSnapshot
  }

  function groupOf(groupId: string): FileChangeGroup {
    return { groupId, label: groupId, createdAt: 1, entries: [] } as unknown as FileChangeGroup
  }

  function Harness(props: { enabled?: boolean }): React.JSX.Element {
    model = useFileChanges('session-1', props.enabled ?? true)
    return <div />
  }

  beforeEach(() => {
    lists = []
    histories = []
    model = null
    const bridge = {
      fileChanges: {
        list: () => {
          const next = pending<unknown>()
          lists.push(next)
          return next.promise
        },
        history: () => {
          const next = pending<unknown>()
          histories.push(next)
          return next.promise
        },
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function read(): FileChangesViewModel {
    if (model === null) throw new Error('the hook has not run')
    return model
  }

  async function settle(pendingCall: Pending<unknown>, value: unknown): Promise<void> {
    await act(async () => {
      pendingCall.settle(value)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function listAnswer(snapshot: FileChangesSnapshot): unknown {
    return { ok: true, value: { ok: true, value: snapshot } }
  }

  it('reads once on mount and keeps what it was given', async () => {
    render(<Harness />)
    expect(lists).toHaveLength(1)

    await settle(lists[0], listAnswer(snapshotOf('snapshot-1', 'group-1', 'cursor-1')))

    expect(read().snapshot?.snapshotId).to.equal('snapshot-1')
    expect(read().nextCursor).to.equal('cursor-1')
    expect(read().loading).to.equal(false)
  })

  /**
   * A cursor belongs to the snapshot it was minted for. A page that lands after a reload used to be
   * appended anyway, mixing two snapshots' groups into one list and installing the old cursor - and
   * the next Load older changes then answered `invalid-cursor`, which killed paging until the next
   * reload.
   */
  it('drops a page that belongs to a snapshot the reload replaced', async () => {
    render(<Harness />)
    await settle(lists[0], listAnswer(snapshotOf('snapshot-1', 'group-1', 'cursor-1')))

    await act(async () => { void read().loadMore() })
    expect(histories).toHaveLength(1)

    await act(async () => { void read().reload() })
    await settle(lists[1], listAnswer(snapshotOf('snapshot-2', 'group-2', 'cursor-2')))

    await settle(histories[0], {
      ok: true,
      value: { ok: true, value: { groups: [groupOf('stale-group')], nextCursor: 'cursor-stale' } },
    })

    expect(read().groups.map((group) => group.groupId)).to.deep.equal(['group-2'])
    expect(read().nextCursor).to.equal('cursor-2')
  })

  it('appends a page that still belongs to the snapshot on screen', async () => {
    render(<Harness />)
    await settle(lists[0], listAnswer(snapshotOf('snapshot-1', 'group-1', 'cursor-1')))

    await act(async () => { void read().loadMore() })
    await settle(histories[0], {
      ok: true,
      value: { ok: true, value: { groups: [groupOf('group-2')], nextCursor: null } },
    })

    expect(read().groups.map((group) => group.groupId)).to.deep.equal(['group-1', 'group-2'])
    expect(read().nextCursor).to.equal(null)
  })

  /**
   * A listing outlives the surface that asked for it. Closing the sidebar and opening it again asks
   * a second time, and the first answer - measured before whatever the person just did - must not
   * overwrite the second. What enforces that is `reload`'s own generation, not the teardown beside
   * it: removing the teardown leaves this green, and it is kept as the belt to that brace.
   */
  it('drops the answer to an ask the surface has already abandoned', async () => {
    const view = render(<Harness enabled />)
    expect(lists).toHaveLength(1)

    view.rerender(<Harness enabled={false} />)
    view.rerender(<Harness enabled />)
    expect(lists).toHaveLength(2)

    await settle(lists[0], listAnswer(snapshotOf('abandoned', 'group-1', 'cursor-1')))
    expect(read().snapshot).to.equal(null)

    await settle(lists[1], listAnswer(snapshotOf('current', 'group-2', 'cursor-2')))
    expect(read().snapshot?.snapshotId).to.equal('current')
  })
})
