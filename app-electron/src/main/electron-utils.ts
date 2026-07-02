import { BrowserWindow } from 'electron'

export function getWebContents(webContentsId: number) {
  return BrowserWindow.getAllWindows()
    .map((w) => w.webContents)
    .find((wc) => wc.id === webContentsId)
}

const ALLOWED_SHELLS = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'wsl.exe']

export function isAllowedShell(command: string): boolean {
  const base = command.replace(/^.*[/\\]/, '').toLowerCase()
  return ALLOWED_SHELLS.includes(base)
}
