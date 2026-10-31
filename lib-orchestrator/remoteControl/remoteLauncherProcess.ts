import { stat } from 'node:fs/promises'

export interface RemoteLauncherProcess {
  command: string
  args: string[]
  cwd: string
  windowsVerbatimArguments: boolean
  completion: 'spawn' | 'exit-zero'
  readinessTimeoutMs: number
  requiredFiles: string[]
  requireRunning: boolean
}

export type RemoteLauncherAvailability =
  | { state: 'available' }
  | { state: 'missing' | 'invalid' | 'unverifiable'; path: string }

export async function inspectLauncherProcess(process: RemoteLauncherProcess): Promise<RemoteLauncherAvailability> {
  const paths = [{ path: process.cwd, directory: true },
    ...[process.command, ...process.requiredFiles].map(path => ({ path, directory: false }))]
  for (const { path, directory } of paths)
    try {
      const info = await stat(path)
      if (directory ? !info.isDirectory() : !info.isFile()) return { state: 'invalid', path }
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        return { state: 'missing', path }
      return { state: 'unverifiable', path }
    }
  return { state: 'available' }
}
