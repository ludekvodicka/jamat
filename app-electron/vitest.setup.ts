/**
 * Per-test setup for the Vitest + Testing Library pipeline.
 *
 * - `cleanup` after each test tears down any mounted React trees so
 *   subsequent tests don't see ghost DOM from prior `render` calls.
 *   Required for React Testing Library v13+ (auto-cleanup is no
 *   longer the default with Vitest).
 * - `@testing-library/jest-dom` extends Vitest's `expect` with
 *   DOM-friendly matchers (`toBeInTheDocument`, etc.).
 */

import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

// ResizeObserver is used by DiffView's minimap. jsdom does not ship it,
// so a stub keeps the empty/loaded transition tests from crashing.
// Other browser APIs (IntersectionObserver, matchMedia, scrollIntoView)
// are NOT polyfilled — add them only when a real test demands it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)
