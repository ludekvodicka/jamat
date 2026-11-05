import { join } from 'node:path'

export class RemarkableSidecarSource {
  /** electron-builder's `${os}`, so a seed directory is named the way the build FileSet reads it. */
  private static readonly buildOsConst: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  }

  static resolve(isPackaged: boolean, applicationRoot: string, resourcesPath: string): string {
    if (isPackaged) return join(resourcesPath, 'remarkable-sidecar')
    const os = RemarkableSidecarSource.buildOsConst[process.platform]
    if (os === undefined)
      throw new Error(`the reMarkable sidecar has no seed for ${process.platform}-${process.arch}`)
    return join(applicationRoot, 'out', 'remarkable-sidecar', `${os}-${process.arch}`, 'current')
  }
}
