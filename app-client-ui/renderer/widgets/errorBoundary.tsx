import { Component, type ErrorInfo, type ReactNode } from 'react'

import './errorBoundary.css'

export interface ErrorBoundaryProps {
  /** What broke, in the words of the surface it wraps: "The sessions tree", "The terminal". */
  what: string
  /** Told once per catch, so a surface that is only drawing wrong still reaches the error channel. */
  onError?: (message: string) => void
  children: ReactNode
}

interface ErrorBoundaryState {
  message: string | null
}

/**
 * One panel's worth of blast radius.
 *
 * This tree branches exhaustively on every discriminant and closes with a `default` that THROWS,
 * which is the house rule and the right one: a value nobody planned for fails loudly at the line
 * that met it rather than being drawn wrong. What was missing is the other half of that bargain.
 * React unmounts the whole root when a render throws, so until 2026-08-21 one unrecognised
 * `merge.phase` - out of a hand-edited records file, or written by a later build - took the entire
 * window with it, leaving a blank screen with no way back except restarting the client.
 *
 * Deliberately a class: `getDerivedStateFromError` has no hook, and this is the one thing in the
 * renderer that cannot be written as a function.
 *
 * It renders the message rather than hiding it, and a Retry that clears the state: most of what
 * lands here is a bad value in ONE snapshot, so the next one usually draws.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null }

  static getDerivedStateFromError(thrown: unknown): ErrorBoundaryState {
    return { message: thrown instanceof Error ? thrown.message : String(thrown) }
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    // The component stack is what says WHICH row of a long tree threw, and it exists nowhere else.
    this.props.onError?.(`${this.props.what} could not be drawn: ${message}${info.componentStack ?? ''}`)
  }

  private readonly retry = (): void => {
    this.setState({ message: null })
  }

  override render(): ReactNode {
    const message = this.state.message
    if (message === null) return this.props.children
    return (
      <div className="jamat-boundary" role="alert">
        <p className="jamat-boundary__message">{`${this.props.what} could not be drawn: ${message}`}</p>
        <button className="jamat-boundary__retry" type="button" onClick={this.retry}>Retry</button>
      </div>
    )
  }
}
