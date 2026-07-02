import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  name: string
  fontSize: number
  fontFamily: string
  theme: ITheme
}

export const themes: Record<string, TerminalTheme> = {
  'windows-terminal': {
    name: 'Windows Terminal',
    fontSize: 16,
    fontFamily: 'Cascadia Mono, Consolas, Courier New, monospace',
    theme: {
      background: '#0c0c0c',
      foreground: '#cccccc',
      cursor: '#ffffff',
      cursorAccent: '#0c0c0c',
      selectionBackground: '#264f78',
      black: '#0c0c0c',
      red: '#c50f1f',
      green: '#13a10e',
      yellow: '#c19c00',
      blue: '#0037da',
      magenta: '#881798',
      cyan: '#3a96dd',
      white: '#cccccc',
      brightBlack: '#767676',
      brightRed: '#e74856',
      brightGreen: '#16c60c',
      brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff',
      brightMagenta: '#b4009e',
      brightCyan: '#61d6d6',
      brightWhite: '#f2f2f2'
    }
  },
  'vscode-dark': {
    name: 'VS Code Dark',
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, Courier New, monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#ffffff',
      cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#e5e5e5'
    }
  },
  'powershell': {
    name: 'PowerShell Blue',
    fontSize: 14,
    fontFamily: 'Cascadia Mono, Consolas, Courier New, monospace',
    theme: {
      background: '#012456',
      foreground: '#eeedf0',
      cursor: '#ffffff',
      cursorAccent: '#012456',
      selectionBackground: '#264f78',
      black: '#0c0c0c',
      red: '#c50f1f',
      green: '#13a10e',
      yellow: '#c19c00',
      blue: '#0037da',
      magenta: '#881798',
      cyan: '#3a96dd',
      white: '#cccccc',
      brightBlack: '#767676',
      brightRed: '#e74856',
      brightGreen: '#16c60c',
      brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff',
      brightMagenta: '#b4009e',
      brightCyan: '#61d6d6',
      brightWhite: '#f2f2f2'
    }
  }
}

export type ThemeId = keyof typeof themes
export const DEFAULT_THEME: ThemeId = 'windows-terminal'
