export type SidebarSide = 'left' | 'right'

export interface SidebarSideState {
  visible: boolean
  width: number
  /** A view key from the registry. Serialized, so renaming a key is a state migration. */
  activeView: string | null
}

export interface SidebarsStateValue {
  left: SidebarSideState
  right: SidebarSideState
}

/**
 * The rules of the sidebars, with no React and no DOM: what the default is, what an unknown
 * document coerces to, and what a width is allowed to be. It lives in `shared/` because both
 * processes need it - the renderer to apply it and the main process to validate what it is asked
 * to store - and it is pure so the widget can be tested without mounting anything.
 */
export class SidebarsState {
  static readonly minWidthConst = 160
  static readonly maxWidthConst = 640
  private static readonly defaultWidthConst = 260
  private static readonly sidesConst: readonly SidebarSide[] = ['left', 'right']

  /** Left open, right closed: the same first-run answer VSCode gives, and one surface is enough. */
  static default(): SidebarsStateValue {
    return {
      left: { visible: true, width: SidebarsState.defaultWidthConst, activeView: null },
      right: { visible: false, width: SidebarsState.defaultWidthConst, activeView: null },
    }
  }

  /**
   * Shape only. The view key survives whatever it is, because this runs in the main process too and
   * only the renderer's registry knows which keys exist; `withKnownViews` is where a stale key dies.
   */
  static coerce(value: unknown): SidebarsStateValue {
    if (!value || typeof value !== 'object')
      return SidebarsState.default()
    const document = value as Partial<Record<SidebarSide, unknown>>
    const fallback = SidebarsState.default()
    return {
      left: SidebarsState.coerceSide(document.left, fallback.left),
      right: SidebarsState.coerceSide(document.right, fallback.right),
    }
  }

  /**
   * A key nobody registered is dropped rather than thrown on: losing which view was open costs the
   * user one click, and failing the restore costs them the window.
   */
  static withKnownViews(
    state: SidebarsStateValue,
    knownOf: (side: SidebarSide) => readonly string[],
  ): SidebarsStateValue {
    const next = { ...state }
    for (const side of SidebarsState.sidesConst) {
      const known = knownOf(side)
      const active = state[side].activeView
      if (active !== null && known.includes(active))
        continue
      next[side] = { ...state[side], activeView: known[0] ?? null }
    }
    return next
  }

  static withWidth(
    state: SidebarsStateValue,
    side: SidebarSide,
    width: number,
  ): SidebarsStateValue {
    return { ...state, [side]: { ...state[side], width: SidebarsState.clamp(width) } }
  }

  static toggled(state: SidebarsStateValue, side: SidebarSide): SidebarsStateValue {
    return { ...state, [side]: { ...state[side], visible: !state[side].visible } }
  }

  /**
   * Shape and bounds, field by field. The store used to compare `JSON.stringify` of the coerced and
   * the raw value, which is a TEXT comparison: the same data with its keys in another order would
   * have been refused as damaged.
   */
  static isValid(value: unknown): value is SidebarsStateValue {
    if (!value || typeof value !== 'object')
      return false
    const document = value as Partial<Record<SidebarSide, unknown>>
    return SidebarsState.sidesConst.every((side) => SidebarsState.isValidSide(document[side]))
  }

  private static isValidSide(value: unknown): boolean {
    if (!value || typeof value !== 'object')
      return false
    const side = value as Partial<SidebarSideState>
    if (typeof side.visible !== 'boolean')
      return false
    if (typeof side.width !== 'number' || !Number.isFinite(side.width))
      return false
    if (side.width < SidebarsState.minWidthConst || side.width > SidebarsState.maxWidthConst)
      return false
    return side.activeView === null || typeof side.activeView === 'string'
  }

  static clamp(width: number): number {
    if (!Number.isFinite(width))
      return SidebarsState.defaultWidthConst
    return Math.min(SidebarsState.maxWidthConst, Math.max(SidebarsState.minWidthConst, Math.round(width)))
  }

  private static coerceSide(value: unknown, fallback: SidebarSideState): SidebarSideState {
    if (!value || typeof value !== 'object')
      return fallback
    const side = value as Partial<SidebarSideState>
    return {
      visible: typeof side.visible === 'boolean' ? side.visible : fallback.visible,
      width: typeof side.width === 'number' ? SidebarsState.clamp(side.width) : fallback.width,
      activeView: typeof side.activeView === 'string' ? side.activeView : null,
    }
  }
}
