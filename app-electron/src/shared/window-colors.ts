export interface WindowColor {
  name: string
  value: string
}

export const WINDOW_COLORS: WindowColor[] = [
  { name: 'None', value: '' },
  // Warm
  { name: 'Red', value: '#c0392b' },
  { name: 'Crimson', value: '#922b21' },
  { name: 'Maroon', value: '#7b241c' },
  { name: 'Orange', value: '#d35400' },
  { name: 'Amber', value: '#b9770e' },
  { name: 'Yellow', value: '#c9a70b' },
  { name: 'Olive', value: '#7d6608' },
  // Greens
  { name: 'Lime', value: '#5e8c1f' },
  { name: 'Green', value: '#27ae60' },
  { name: 'Emerald', value: '#1e8449' },
  { name: 'Forest', value: '#14633a' },
  { name: 'Teal', value: '#16a085' },
  // Blues
  { name: 'Cyan', value: '#1289a7' },
  { name: 'Sky', value: '#2e86c1' },
  { name: 'Blue', value: '#2980b9' },
  { name: 'Navy', value: '#1b4f72' },
  { name: 'Indigo', value: '#2c3e9b' },
  // Purples / pinks
  { name: 'Violet', value: '#6c3483' },
  { name: 'Purple', value: '#8e44ad' },
  { name: 'Magenta', value: '#a13b8f' },
  { name: 'Pink', value: '#c0397b' },
  { name: 'Rose', value: '#c0567a' },
  // Neutrals
  { name: 'Brown', value: '#6d4c2a' },
  { name: 'Slate', value: '#4a6572' },
  { name: 'Steel', value: '#34495e' },
  { name: 'Charcoal', value: '#566573' },
]

export const DEFAULT_STATUS_BAR_COLOR = '#007acc'
