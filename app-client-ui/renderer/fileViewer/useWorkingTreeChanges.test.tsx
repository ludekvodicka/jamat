import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSource,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import type { FileChangesWorkingTreeViewModel } from './fileViewerPanel.types'
import { useWorkingTreeChanges } from './useWorkingTreeChanges'

describe('app-client-ui/renderer/fileViewer/useWorkingTreeChanges', () => {
  interface Pending {
    sessionId: string
    source: FileChangesWorkingTreeSource | null
    settle(value: unknown): void
  }

  let calls: Pending[]
  let model: FileChangesWorkingTreeViewModel | null

  function snapshot(
    source: FileChangesWorkingTreeSource,
    id: string,
    sessionId = 'session-1',
  ): FileChangesWorkingTreeSnapshot {
    return {
      snapshotId: id,
      sessionId,
      createdAt: 1,
      source: { requested: source, selected: source, available: [source], fallbackReason: null },
      defaultBaseline: null,
      entries: [],
      warnings: [],
    }
  }

  function Harness(props: {
    sessionId?: string
    enabled: boolean
    required?: FileChangesWorkingTreeSource
  }): React.JSX.Element {
    model = useWorkingTreeChanges(props.sessionId ?? 'session-1', props.enabled, props.required)
    return <div />
  }

  beforeEach(() => {
    calls = []
    model = null
    const bridge = {
      fileChanges: {
        workingTree: (sessionId: string, source: FileChangesWorkingTreeSource | null) =>
          new Promise((resolve) => calls.push({ sessionId, source, settle: resolve })),
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge }).appClient
      = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  function read(): FileChangesWorkingTreeViewModel {
    if (model === null) throw new Error('the hook has not run')
    return model
  }

  async function settle(index: number, value: unknown): Promise<void> {
    await act(async () => {
      calls[index].settle(value)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function answer(value: FileChangesWorkingTreeSnapshot): unknown {
    return { ok: true, value: { ok: true, value } }
  }

  it('loads the contextual default only while the sidebar needs it', async () => {
    const view = render(<Harness enabled />)
    expect(calls.map((call) => call.source)).toEqual([null])
    await settle(0, answer(snapshot('checkpoint', 'default')))
    expect(read().snapshot?.snapshotId).toBe('default')

    view.rerender(<Harness enabled={false} />)
    expect(read().snapshots).toEqual([])
    expect(read().loading).toBe(false)
  })

  it('keeps only the later selected source when an older answer arrives last', async () => {
    render(<Harness enabled />)
    act(() => read().select('svn'))
    expect(calls.map((call) => call.source)).toEqual([null, 'svn'])

    await settle(1, answer(snapshot('svn', 'svn-current')))
    await settle(0, answer(snapshot('checkpoint', 'stale-default')))

    expect(read().snapshot?.snapshotId).toBe('svn-current')
    expect(read().snapshots.map((item) => item.snapshotId)).toEqual(['svn-current'])
  })

  it('holds the visible source and one different active diff source', async () => {
    render(<Harness enabled required="worktree-base" />)
    expect(calls.map((call) => call.source)).toEqual([null, 'worktree-base'])
    expect(read().requiredLoading).toBe(true)
    await settle(0, answer(snapshot('checkpoint', 'sidebar')))
    await settle(1, answer(snapshot('worktree-base', 'diff')))

    expect(read().snapshots.map((item) => item.snapshotId).sort()).toEqual(['diff', 'sidebar'])
    expect(read().snapshotFor('worktree-base')?.snapshotId).toBe('diff')
    expect(read().requiredLoading).toBe(false)
    expect(read().requiredError).toBeNull()
  })

  it('keeps the active diff snapshot while its sidebar tab is switched', async () => {
    const view = render(<Harness enabled={false} required="checkpoint" />)
    expect(calls.map((call) => call.source)).toEqual(['checkpoint'])
    await settle(0, answer(snapshot('checkpoint', 'diff')))

    view.rerender(<Harness enabled required="checkpoint" />)
    expect(calls.map((call) => call.source)).toEqual(['checkpoint', null])
    expect(read().snapshotFor('checkpoint')?.snapshotId).toBe('diff')
    await settle(1, answer(snapshot('checkpoint', 'sidebar')))
    expect(read().snapshots.map((item) => item.snapshotId)).toEqual(['diff'])

    view.rerender(<Harness enabled={false} required="checkpoint" />)
    expect(calls).toHaveLength(2)
    expect(read().snapshots.map((item) => item.snapshotId)).toEqual(['diff'])
  })

  it('keeps a required-source fallback separate from the sidebar selection', async () => {
    render(<Harness enabled required="worktree-base" />)
    const fallback = snapshot('checkpoint', 'fallback')
    fallback.source = {
      requested: 'worktree-base',
      selected: 'checkpoint',
      available: ['checkpoint'],
      fallbackReason: 'Worktree base is not available; using Checkpoint',
    }

    await settle(1, answer(fallback))

    expect(calls).toHaveLength(2)
    expect(read().selectedSource).toBeNull()
    expect(read().requiredLoading).toBe(false)
    expect(read().requiredError).toBe('Worktree base is not available; using Checkpoint')
  })

  it('does not retain a snapshot while a different session loads', async () => {
    const view = render(<Harness enabled />)
    await settle(0, answer(snapshot('checkpoint', 'first')))

    view.rerender(<Harness sessionId="session-2" enabled />)

    expect(calls.at(-1)).toMatchObject({ sessionId: 'session-2', source: null })
    expect(read().snapshot).toBeNull()
    expect(read().snapshots).toEqual([])
  })
})
