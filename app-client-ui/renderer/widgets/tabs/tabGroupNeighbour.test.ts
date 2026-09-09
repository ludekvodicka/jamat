import { describe, expect, it } from 'vitest'

import { type TabGroupBox, TabGroupNeighbour } from './tabGroupNeighbour'

describe('app-client-ui/renderer/widgets/tabs/tabGroupNeighbour', () => {
  const box = (id: string, left: number, top: number, width = 100, height = 100): TabGroupBox =>
    ({ id, left, top, width, height })

  it('answers with the group that lies that way and with nothing where none does', () => {
    const left = box('left', 0, 0)
    const right = box('right', 100, 0)

    expect(TabGroupNeighbour.nearest(left, 'right', [left, right])?.id).to.equal('right')
    expect(TabGroupNeighbour.nearest(right, 'left', [left, right])?.id).to.equal('left')
    expect(TabGroupNeighbour.nearest(left, 'left', [left, right])).to.equal(null)
    expect(TabGroupNeighbour.nearest(left, 'above', [left, right])).to.equal(null)
  })

  /** A cousin three branches away is as much "over there" as a sibling; the boxes cannot tell. */
  it('takes the nearest of several that way, whatever the grid calls them', () => {
    const current = box('current', 0, 0)
    const near = box('near', 100, 0)
    const far = box('far', 400, 0)
    const offAxis = box('off-axis', 120, 300)

    expect(TabGroupNeighbour.nearest(current, 'right', [current, far, offAxis, near])?.id)
      .to.equal('near')
  })

  /**
   * The dead zone is what makes a tall neighbour beside a short one answer to one direction rather
   * than to whichever of two the rounding favours: a centre within it lies nowhere at all.
   */
  it('ignores a group whose centre has barely moved', () => {
    const current = box('current', 0, 0)
    const barely = box('barely', 10, 0)

    expect(TabGroupNeighbour.nearest(current, 'right', [current, barely])).to.equal(null)
    expect(TabGroupNeighbour.nearest(current, 'right', [current, box('past', 60, 0)])?.id)
      .to.equal('past')
  })

  it('refuses a direction it does not know', () => {
    const current = box('current', 0, 0)

    expect(() => TabGroupNeighbour.nearest(
      current,
      'sideways' as unknown as 'left',
      [current, box('other', 100, 0)],
    )).to.throw(/Unknown move direction/)
  })
})
