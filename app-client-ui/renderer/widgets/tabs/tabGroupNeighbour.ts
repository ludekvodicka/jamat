/** A laid-out group, as the search below reads one: an id and the box it occupies on screen. */
export interface TabGroupBox {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export type MoveDirection = 'left' | 'right' | 'above' | 'below'

/**
 * Which group lies that way, decided from the boxes alone.
 *
 * The grid is a tree and a direction is not one of its axes: a group to the right may be a sibling,
 * a cousin three branches away, or nothing at all. Comparing laid-out boxes answers all three the
 * same way, and it is the answer a person means when they say "right" - what they can SEE over
 * there, not what the tree calls a neighbour.
 *
 * Pure on purpose: the geometry is the part worth testing and it needs no dockview to run.
 */
export class TabGroupNeighbour {
  /**
   * How far a centre must lie past the current one to count as being that way at all. Without it a
   * group of nearly the same centre - a tall neighbour beside a short one - answers to `above` and
   * `below` alike, and the move becomes a coin toss.
   */
  private static readonly deadZonePixelsConst = 20

  /** The nearest group in that direction, or null where nothing lies that way. */
  static nearest(
    current: TabGroupBox,
    direction: MoveDirection,
    others: readonly TabGroupBox[],
  ): TabGroupBox | null {
    const centre = TabGroupNeighbour.centreOf(current)
    let best: TabGroupBox | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const other of others) {
      if (other.id === current.id) continue
      const point = TabGroupNeighbour.centreOf(other)
      if (!TabGroupNeighbour.lies(point, centre, direction)) continue
      // Manhattan rather than euclidean: the grid is rectangles, so the group that is least far in
      // the direction asked for AND least far off the line wins by the same number.
      const distance = Math.abs(point.x - centre.x) + Math.abs(point.y - centre.y)
      if (distance >= bestDistance) continue
      bestDistance = distance
      best = other
    }
    return best
  }

  private static lies(
    point: { x: number; y: number },
    centre: { x: number; y: number },
    direction: MoveDirection,
  ): boolean {
    const zone = TabGroupNeighbour.deadZonePixelsConst
    if (direction === 'left') return point.x < centre.x - zone
    else if (direction === 'right') return point.x > centre.x + zone
    else if (direction === 'above') return point.y < centre.y - zone
    else if (direction === 'below') return point.y > centre.y + zone
    else throw new Error(`Unknown move direction: ${JSON.stringify(direction)}`)
  }

  private static centreOf(box: TabGroupBox): { x: number; y: number } {
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }
}
