/**
 * Regression test for the hooks-order crash fixed today: `useRef` was
 * declared AFTER an `if (segments.length === 0) return ...` early
 * return. React's strict hook ordering required the same hook count
 * across renders — first render with empty segments returned 2 hooks
 * (useMemo + useState); subsequent renders with content returned 3
 * (added useRef). React threw "Rendered more hooks than during the
 * previous render."
 *
 * Verified: this test fails ("Rendered more hooks than during the
 * previous render") when the `useRef(scrollerRef)` declaration in
 * DiffView.tsx is moved below the `segments.length === 0` early
 * return.
 */

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DiffView } from './DiffView'

describe('DiffView hooks-order regression', () => {
  it('transitions empty → non-empty without crashing', () => {
    // First render: identical before/after → no segments → empty branch.
    const { rerender, container } = render(
      <DiffView beforeText="same" afterText="same" />,
    )
    expect(container.querySelector('.diff-empty')).not.toBeNull()

    // Second render: different content → segments → main branch.
    // Pre-fix this threw "Rendered more hooks than during the previous render."
    rerender(<DiffView beforeText="a" afterText="b" />)
    expect(container.querySelector('.diff-empty')).toBeNull()
    expect(container.querySelector('.diff-view')).not.toBeNull()
  })

  it('renders empty placeholder when no changes', () => {
    const { container, getByText } = render(
      <DiffView beforeText="" afterText="" />,
    )
    expect(container.querySelector('.diff-empty')).not.toBeNull()
    expect(getByText('no changes')).toBeTruthy()
  })

  it('renders unified diff lines when content differs', () => {
    const { container } = render(
      <DiffView beforeText="line1\nline2" afterText="line1\nNEW" />,
    )
    expect(container.querySelectorAll('.diff-line').length).toBeGreaterThan(0)
  })
})
