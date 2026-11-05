
export type WindowRole = 'main' | 'holder'

export interface WindowAppearance {
  name: string | null
  color: string | null
}

export interface WindowInfo extends WindowAppearance {
  windowId: string
  role: WindowRole
}
