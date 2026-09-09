import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChoiceCard, ChoiceRow } from './choiceCards'

describe('app-client-ui/renderer/widgets/choiceCards', () => {
  afterEach(cleanup)

  it('marks the current row and draws its label and content', () => {
    const view = render(
      <ChoiceRow className="custom-row" label="Isolation" current={true}>
        Worktree choices
      </ChoiceRow>,
    )

    expect(view.container.querySelector('.jamat-choice__row'))
      .toHaveClass('jamat-choice__row--current', 'custom-row')
    expect(screen.getByText('Isolation')).toHaveClass('jamat-choice__label')
    expect(screen.getByText('Worktree choices')).toHaveClass('jamat-choice__content')
  })

  it('disables a refused chosen card and exposes both states', () => {
    render(
      <ChoiceCard
        title="Worktree"
        note="runs in its own worktree and branch"
        glyph="◆"
        chosen={true}
        refusal="worktrees are unavailable"
        onChoose={vi.fn()}
      />,
    )

    const card = screen.getByRole('button', { name: /Worktree/ })
    expect(card).toBeDisabled()
    expect(card).toHaveAttribute('title', 'worktrees are unavailable')
    expect(card).toHaveAttribute('aria-pressed', 'true')
  })

  it('adds the danger modifier only when requested', () => {
    render(
      <>
        <ChoiceCard title="Keep worktree" note={null} glyph="—" chosen={true}
          refusal={null} onChoose={vi.fn()} />
        <ChoiceCard title="Discard worktree" note={null} glyph="✕" chosen={false}
          refusal={null} danger={true} onChoose={vi.fn()} />
      </>,
    )

    expect(screen.getByRole('button', { name: /Keep worktree/ }))
      .not.toHaveClass('jamat-choice__card--danger')
    expect(screen.getByRole('button', { name: /Discard worktree/ }))
      .toHaveClass('jamat-choice__card--danger')
  })
})
