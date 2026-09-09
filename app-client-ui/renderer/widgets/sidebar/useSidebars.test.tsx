import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SidebarsState, type SidebarsStateValue } from '../../../shared/sidebarsState'
import { SidebarRegistry } from './sidebarRegistry'
import { type SidebarsPorts, useSidebars } from './useSidebars'

describe('app-client-ui/renderer/widgets/sidebar/useSidebars', () => {
  afterEach(() => vi.useRealTimers())

  function registryFixture(): SidebarRegistry {
    const registry = new SidebarRegistry()
    registry.register({ key: 'probeLeft', side: 'left', title: 'Left', component: () => null })
    registry.register({ key: 'probeRight', side: 'right', title: 'Right', component: () => null })
    return registry
  }

  type Loaded = { sidebars: SidebarsStateValue | null; failed: boolean }

  function mount(
    loaded: Loaded | Promise<Loaded>,
    options: { accepts?: boolean; holdWrites?: boolean; rejectWrites?: boolean } = {},
  ) {
    const registry = registryFixture()
    const saved: SidebarsStateValue[] = []
    const errors: string[] = []
    const held: ((stored: boolean) => void)[] = []
    const ports: SidebarsPorts = {
      load: () => Promise.resolve(loaded),
      save: (state) => {
        saved.push(state)
        if (options.rejectWrites)
          return Promise.reject(new Error('main process is gone'))
        if (options.holdWrites)
          return new Promise<boolean>((resolve) => held.push(resolve))
        return Promise.resolve(options.accepts ?? true)
      },
      reportError: (message) => { errors.push(message) },
    }
    const view = renderHook(() => useSidebars(registry, ports))
    return { view, saved, errors, answerWrite: (stored: boolean) => held.shift()?.(stored) }
  }

  it('starts from the default, with each side showing its first registered view', async () => {
    const { view } = mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
    expect(view.result.current.state.right.activeView).toBe('probeRight')
    expect(view.result.current.state.left.visible).toBe(true)
    expect(view.result.current.state.right.visible).toBe(false)
  })

  it('restores what was stored', async () => {
    const stored = SidebarsState.coerce({
      left: { visible: true, width: 260, activeView: 'probeLeft' },
      right: { visible: true, width: 400, activeView: 'probeRight' },
    })
    const { view } = mount({ sidebars: stored, failed: false })
    await waitFor(() => expect(view.result.current.state.right.width).toBe(400))
    expect(view.result.current.state.right.visible).toBe(true)
  })

  // Every start would otherwise write back the state it had just read.
  it('does not write the state it restored', async () => {
    const stored = SidebarsState.withWidth(SidebarsState.default(), 'left', 300)
    const { view, saved } = mount({ sidebars: stored, failed: false })
    await waitFor(() => expect(view.result.current.state.left.width).toBe(300))
    // The debounce is 350 ms, and a real 400 ms sleep is 50 ms of margin: under load the production
    // timer slips past it and "nothing was written" passes over a guard that is broken. The
    // neighbours below already move the clock instead of waiting for it.
    vi.useFakeTimers()

    act(() => void vi.advanceTimersByTime(400))

    expect(saved).toEqual([])
  })

  // Rule 3 of the package, on the sidebars' side: a state we could not read is one we must not
  // replace with a default that looks fine.
  it('writes nothing for the rest of the session after a failed read', async () => {
    const { view, saved, errors } = mount({ sidebars: null, failed: true })
    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatch(/will not overwrite/)

    vi.useFakeTimers()
    act(() => view.result.current.resize('left', 320))
    act(() => void vi.advanceTimersByTime(400))

    expect(saved).toEqual([])
  })

  it('writes one state for a whole drag rather than one per pixel', async () => {
    const { view, saved } = mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
    vi.useFakeTimers()

    // One act per resize: inside a single act React renders once and the save effect runs once,
    // so a hook that saved straight from the effect with no timer passed this unchanged.
    for (let width = 200; width <= 300; width += 10)
      act(() => view.result.current.resize('left', width))
    expect(saved).toEqual([])

    act(() => void vi.advanceTimersByTime(400))
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].left.width).toBe(300)
  })

  it('flushes a pending write, because the last change before the window closes is a change', async () => {
    const { view, saved } = mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
    vi.useFakeTimers()

    act(() => view.result.current.resize('left', 333))
    act(() => view.result.current.flush())

    expect(saved).toHaveLength(1)
    expect(saved[0].left.width).toBe(333)
    // The armed timer must not fire a second write on top of the flushed one.
    act(() => void vi.advanceTimersByTime(400))
    expect(saved).toHaveLength(1)
  })

  // The armed timer used to hold the state it was armed WITH, so a change undone inside the
  // debounce window still reached the disk: screen open, file closed, and closed again after a
  // restart. The timer now reads the latest state when it fires.
  it('writes nothing when a change is undone inside the debounce window', async () => {
    const { view, saved } = mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
    vi.useFakeTimers()

    act(() => view.result.current.toggle('left'))
    act(() => void vi.advanceTimersByTime(100))
    act(() => view.result.current.toggle('left'))
    act(() => void vi.advanceTimersByTime(400))

    expect(saved).toEqual([])
    expect(view.result.current.state.left.visible).toBe(true)
  })

  // The latch was read only where the timer was armed, so a save already in flight ran anyway -
  // the exact case TabsController.persist re-checks at fire time.
  it('drops a save that was already armed when the read failed', async () => {
    let answer: (value: { sidebars: SidebarsStateValue | null; failed: boolean }) => void = () => {}
    const pending = new Promise<{ sidebars: SidebarsStateValue | null; failed: boolean }>(
      (resolve) => { answer = resolve },
    )
    const { view, saved, errors } = mount(pending)

    act(() => view.result.current.resize('left', 320))
    answer({ sidebars: null, failed: true })
    await waitFor(() => expect(errors).toHaveLength(1))
    vi.useFakeTimers()

    act(() => void vi.advanceTimersByTime(400))

    expect(saved).toEqual([])
  })

  // ipcRenderer.invoke rejects when the main process goes away mid-call; without a catch the hook
  // kept a fully writable default and the first toggle stored it over the file.
  it('treats a rejected read as a failed one', async () => {
    const { view, saved, errors } = mount(Promise.reject(new Error('main process is gone')))
    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatch(/will not overwrite/)

    vi.useFakeTimers()
    act(() => view.result.current.toggle('left'))
    act(() => void vi.advanceTimersByTime(400))

    expect(saved).toEqual([])
  })

  // The cursor used to move before the write, so a refused store was remembered as saved and the
  // same state was never offered again. Asking for the SAME width twice is what tells the two
  // apart: a cursor that moved on send would skip the second attempt as "no change".
  it('keeps a refused state pending instead of remembering it as stored', async () => {
    const { view, saved } = mount({ sidebars: null, failed: false }, { accepts: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))

    act(() => view.result.current.resize('left', 320))
    await vi.waitFor(() => expect(saved).toHaveLength(1))

    act(() => view.result.current.resize('left', 320))
    await vi.waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1].left.width).toBe(320)
  })

  // The debounce window was closed by reading the state at fire time; the WRITE window was not.
  // A toggle taken back while the IPC round trip is in flight arms nothing, because the cursor
  // still holds the old value - so the file kept the state the user had already undone.
  it('writes again when the state moved back while a write was in flight', async () => {
    const { view, saved, answerWrite } = mount({ sidebars: null, failed: false }, { holdWrites: true })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))

    act(() => view.result.current.toggle('left'))
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].left.visible).toBe(false)

    act(() => view.result.current.toggle('left'))
    act(() => answerWrite(true))

    await vi.waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1].left.visible).toBe(true)
  })

  // A write that rejects used to leave the in-flight guard set for the session, so the same state
  // could never be stored again and nothing said why.
  it('reports a rejected write and can store the same state afterwards', async () => {
    const { view, saved, errors } = mount({ sidebars: null, failed: false }, { rejectWrites: true })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))

    act(() => view.result.current.resize('left', 320))
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatch(/could not be stored/)

    act(() => view.result.current.resize('left', 320))
    await vi.waitFor(() => expect(saved).toHaveLength(2))
  })

  it('replaces a stored view key that no longer exists', async () => {
    const stored = SidebarsState.coerce({
      left: { visible: true, width: 260, activeView: 'goneInV2' },
      right: { visible: false, width: 260, activeView: null },
    })
    const { view } = mount({ sidebars: stored, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
  })

  it('toggles a side without touching the other', async () => {
    const { view } = mount({ sidebars: null, failed: false })
    await waitFor(() => expect(view.result.current.state.left.activeView).toBe('probeLeft'))
    act(() => view.result.current.toggle('left'))
    expect(view.result.current.state.left.visible).toBe(false)
    expect(view.result.current.state.right.visible).toBe(false)
    act(() => view.result.current.toggle('right'))
    expect(view.result.current.state.right.visible).toBe(true)
  })
})
