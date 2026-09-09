import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './errorBoundary'

describe('app-client-ui/renderer/widgets/errorBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  /**
   * React writes the caught error to the console itself, on top of handing it to the boundary. The
   * test would otherwise print a stack for every case here and read as a failing run.
   */
  function quiet(): void {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  function Throws(props: { when: boolean }): React.JSX.Element {
    if (props.when) throw new Error('Unknown session life: "zombie"')
    return <p>the tree</p>
  }

  it('draws its children while nothing throws', () => {
    const view = render(
      <ErrorBoundary what="The sessions tree"><Throws when={false} /></ErrorBoundary>,
    )

    expect(view.container.textContent).toContain('the tree')
    expect(view.container.querySelector('.jamat-boundary')).toBeNull()
  })

  /*
   * The whole point of it. Every exhaustive branch in this tree closes with a throwing `default`,
   * which is right, and until this existed React answered that by unmounting the entire root: one
   * unrecognised value out of one record left a blank window with no way back but a restart.
   */
  it('keeps the throw inside itself, and says what could not be drawn', () => {
    quiet()
    const onError = vi.fn()

    const view = render(
      <ErrorBoundary what="The sessions tree" onError={onError}>
        <Throws when={true} />
      </ErrorBoundary>,
    )

    expect(view.container.querySelector('.jamat-boundary__message')?.textContent)
      .toBe('The sessions tree could not be drawn: Unknown session life: "zombie"')
    // Reported as well as drawn: a surface nobody is looking at still reaches the error channel.
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toContain('Unknown session life: "zombie"')
  })

  /** Most of what lands here is one bad snapshot, so the way back is a button and not a restart. */
  it('draws its children again after Retry', () => {
    quiet()
    let throwing = true
    function Subject(): React.JSX.Element {
      return <Throws when={throwing} />
    }

    const view = render(<ErrorBoundary what="The sessions tree"><Subject /></ErrorBoundary>)
    expect(view.container.querySelector('.jamat-boundary')).not.toBeNull()

    throwing = false
    fireEvent.click(view.getByText('Retry'))

    expect(view.container.textContent).toContain('the tree')
    expect(view.container.querySelector('.jamat-boundary')).toBeNull()
  })

  /** A thrown string is not an Error, and a boundary that only understood Errors would rethrow. */
  it('carries a thrown value that is not an Error', () => {
    quiet()
    function ThrowsString(): React.JSX.Element {
      throw 'no records'
    }

    const view = render(<ErrorBoundary what="The sessions tree"><ThrowsString /></ErrorBoundary>)

    expect(view.container.querySelector('.jamat-boundary__message')?.textContent)
      .toBe('The sessions tree could not be drawn: no records')
  })
})
