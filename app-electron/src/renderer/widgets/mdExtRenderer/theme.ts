import { createContext, useContext } from 'react'
import type { MdExtTheme } from './types'

// The resolved theme is provided by MdExtRenderer so async leaves (diagrams) can recolor when the
// host toggles light/dark mid-view. Kept in its own module to avoid an import cycle between
// mdExtRenderer.tsx (provider) and the leaf renderers (consumers).
export const MdExtThemeContext = createContext<MdExtTheme>('auto')

export const useMdExtTheme = (): MdExtTheme => useContext(MdExtThemeContext)

/** Resolve 'auto' to a concrete light/dark using the OS preference (for engines that need a value). */
export function resolveTheme(t: MdExtTheme): 'light' | 'dark' {
  if (t === 'dark') return 'dark'
  if (t === 'light') return 'light'
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}
