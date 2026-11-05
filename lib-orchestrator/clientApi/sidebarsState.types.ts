
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
