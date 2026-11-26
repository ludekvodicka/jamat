import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, extname, join } from 'node:path'

import { OrchestratorPaths } from '../shared/orchestratorPaths'

export interface SvnExecutableResolution {
  command: string
  /** Directory of the original `svn.exe` to prepend to `PATH` so its bundled DLLs resolve when running a cached copy. */
  dllDirectory: string | null
  /** True when the resolved executable is guaranteed to process arguments, `--targets` and output as UTF-8. */
  utf8: boolean
}

export interface SvnExecutableOptions {
  platform?: NodeJS.Platform
  cacheDir?: string
  osRelease?: string
}

export interface PeManifestStripResult {
  validPe: boolean
  hasUtf8: boolean
  originalManifest: string | null
  removedEmbedded: boolean
  buffer: Buffer
}

interface CacheEntry {
  sourcePath: string
  size: number
  mtimeMs: number
  cacheDir: string
  resolution: SvnExecutableResolution
}

/**
 * Resolves `svn` and, on Windows 10 1903+, ensures `svn.exe` runs with an `activeCodePage: UTF-8`
 * manifest. Standard Windows builds of Subversion 1.14 (including TortoiseSVN) convert wide-char
 * arguments and read `--targets` through `CP_ACP` (`GetACP()`), so characters outside the machine's
 * ANSI code page (such as Czech `Č`, `ř`, `ě`, `ť` on CP1252) are best-fit mapped or rejected.
 *
 * Removing `RT_MANIFEST` from a cached copy of `svn.exe` under the machine-local tools directory
 * and placing an external `<exe>.manifest` with `activeCodePage: UTF-8` beside it makes `GetACP()`
 * return 65001 (`CP_UTF8`) for that process without modifying Program Files or the system locale.
 */
export class SvnExecutable {
  private static readonly cacheVersionConst = 'v1'
  private static readonly rtManifestConst = 24
  private static readonly imageExtensionsConst = new Set(['.exe', '.com'])
  private static readonly defaultPathextConst = '.COM;.EXE;.BAT;.CMD'
  private static readonly activeCodePageElementConst = '<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>'
  private static readonly applicationBlockConst = '<application xmlns="urn:schemas-microsoft-com:asm.v3">'
    + `<windowsSettings>${SvnExecutable.activeCodePageElementConst}</windowsSettings></application>`
  private static readonly windowsCache = new Map<string, CacheEntry>()

  static clearCache(): void {
    SvnExecutable.windowsCache.clear()
  }

  static resolve(environment: NodeJS.ProcessEnv = process.env, options?: SvnExecutableOptions): SvnExecutableResolution {
    const platform = options?.platform ?? process.platform
    if (platform !== 'win32') return { command: 'svn', dllDirectory: null, utf8: false }
    const image = SvnExecutable.findWindowsImage(environment)
    if (image === null) return { command: 'svn', dllDirectory: null, utf8: false }
    return SvnExecutable.prepareWindows(image, options)
  }

  static supportsUtf8Arguments(environment: NodeJS.ProcessEnv = process.env, options?: SvnExecutableOptions): boolean {
    return SvnExecutable.resolve(environment, options).utf8
  }

  /** Prepares a UTF-8-manifested executable for an already-located Windows `svn.exe` image. */
  static prepareWindows(sourcePath: string, options?: Pick<SvnExecutableOptions, 'cacheDir' | 'osRelease'>): SvnExecutableResolution {
    const fallback: SvnExecutableResolution = { command: sourcePath, dllDirectory: null, utf8: false }
    if (!SvnExecutable.supportsActiveCodePage(options?.osRelease ?? release())) return fallback
    let stat: { size: number; mtimeMs: number }
    try { stat = statSync(sourcePath) }
    catch { return fallback }
    const cacheDir = options?.cacheDir ?? OrchestratorPaths.svnUtf8Directory()
    const key = `${sourcePath.toLowerCase()}\0${cacheDir.toLowerCase()}`
    const cached = SvnExecutable.windowsCache.get(key)
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
      && (cached.resolution.command === sourcePath
        || (existsSync(cached.resolution.command) && existsSync(`${cached.resolution.command}.manifest`))))
      return cached.resolution
    const resolution = SvnExecutable.buildWindowsUtf8(sourcePath, stat, cacheDir) ?? fallback
    SvnExecutable.windowsCache.set(key, { sourcePath, size: stat.size, mtimeMs: stat.mtimeMs, cacheDir, resolution })
    return resolution
  }

  static applyDllDirectory(environment: NodeJS.ProcessEnv, dllDirectory: string | null): NodeJS.ProcessEnv {
    if (dllDirectory === null) return environment
    return { ...environment, ...SvnExecutable.dllPathOverride(environment, dllDirectory) }
  }

  static dllPathOverride(environment: NodeJS.ProcessEnv, dllDirectory: string | null): Record<string, string> {
    if (dllDirectory === null) return {}
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const current = environment[pathKey] ?? ''
    const first = current.split(';')[0]?.trim().replace(/^"(.*)"$/, '$1') ?? ''
    if (first.toLowerCase() === dllDirectory.toLowerCase()) return {}
    return { [pathKey]: current.length > 0 ? `${dllDirectory};${current}` : dllDirectory }
  }

  /** Windows 10 version 1903 (build 18362) introduced `<activeCodePage>UTF-8</activeCodePage>`. */
  static supportsActiveCodePage(osRelease: string): boolean {
    const parts = osRelease.split('.').map((part) => Number(part))
    const major = parts[0] ?? 0
    const build = parts[2] ?? 0
    return major > 10 || (major === 10 && build >= 18362)
  }

  static hasUtf8ActiveCodePage(manifest: string): boolean {
    return /<(?:[a-zA-Z0-9_-]+:)?activeCodePage\b[^>]*>\s*UTF-8\s*<\/(?:[a-zA-Z0-9_-]+:)?activeCodePage>/i.test(manifest)
  }

  static mergeUtf8Manifest(original: string | null): string {
    const cleaned = original?.replace(/^\uFEFF/, '') ?? ''
    if (cleaned.length > 0) {
      if (SvnExecutable.hasUtf8ActiveCodePage(cleaned)) return cleaned
      const settingsEnd = /<\/(?:[a-zA-Z0-9_-]+:)?windowsSettings>/i.exec(cleaned)
      if (settingsEnd !== null)
        return `${cleaned.slice(0, settingsEnd.index)}${SvnExecutable.activeCodePageElementConst}${cleaned.slice(settingsEnd.index)}`
      const assemblyEnd = /<\/(?:[a-zA-Z0-9_-]+:)?assembly>/i.exec(cleaned)
      if (assemblyEnd !== null)
        return `${cleaned.slice(0, assemblyEnd.index)}${SvnExecutable.applicationBlockConst}${cleaned.slice(assemblyEnd.index)}`
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">${SvnExecutable.applicationBlockConst}</assembly>`
  }

  /**
   * Inspects a PE32/PE32+ image for an embedded `RT_MANIFEST` resource and removes its root
   * resource directory entry (plus the invalidated Authenticode certificate table) so Windows SxS
   * loads an external `<exe>.manifest` beside the cached copy.
   */
  static stripEmbeddedManifest(source: Buffer): PeManifestStripResult {
    const invalid: PeManifestStripResult = { validPe: false, hasUtf8: false, originalManifest: null, removedEmbedded: false, buffer: source }
    if (source.length < 64 || source.readUInt16LE(0) !== 0x5a4d) return invalid
    const peOffset = source.readUInt32LE(0x3c)
    if (peOffset + 24 > source.length || source.readUInt32LE(peOffset) !== 0x00004550) return invalid
    const numSections = source.readUInt16LE(peOffset + 6)
    const optHeaderSize = source.readUInt16LE(peOffset + 20)
    const optHeaderOffset = peOffset + 24
    const secTableOffset = optHeaderOffset + optHeaderSize
    if (optHeaderSize < 96 || secTableOffset + numSections * 40 > source.length) return invalid
    const magic = source.readUInt16LE(optHeaderOffset)
    let ddRelative: number
    if (magic === 0x20b) ddRelative = 112
    else if (magic === 0x10b) ddRelative = 96
    else return invalid
    const ddOffset = optHeaderOffset + ddRelative
    if (ddRelative > optHeaderSize) return invalid
    const numDataDirs = source.readUInt32LE(ddOffset - 4)

    const sections: { vsize: number; rva: number; rawSize: number; rawPtr: number }[] = []
    for (let index = 0; index < numSections; index++) {
      const offset = secTableOffset + index * 40
      sections.push({
        vsize: source.readUInt32LE(offset + 8),
        rva: source.readUInt32LE(offset + 12),
        rawSize: source.readUInt32LE(offset + 16),
        rawPtr: source.readUInt32LE(offset + 20),
      })
    }
    const rvaToFile = (rva: number): number => {
      for (const section of sections) {
        const span = Math.max(section.vsize, section.rawSize)
        if (rva >= section.rva && rva < section.rva + span) return section.rawPtr + (rva - section.rva)
      }
      return -1
    }

    let buffer = Buffer.from(source)
    let originalManifest: string | null = null
    let removedEmbedded = false

    const hasRsrc = numDataDirs > 2 && ddOffset + 3 * 8 <= secTableOffset
    const rsrcRva = hasRsrc ? buffer.readUInt32LE(ddOffset + 2 * 8) : 0
    const rsrcSize = hasRsrc ? buffer.readUInt32LE(ddOffset + 2 * 8 + 4) : 0
    if (rsrcRva !== 0 && rsrcSize !== 0) {
      const rsrcBase = rvaToFile(rsrcRva)
      if (rsrcBase >= 0 && rsrcBase + 16 <= buffer.length) {
        const numNamed = buffer.readUInt16LE(rsrcBase + 12)
        const numId = buffer.readUInt16LE(rsrcBase + 14)
        const idStart = rsrcBase + 16 + numNamed * 8
        if (idStart + numId * 8 <= buffer.length) {
          for (let index = 0; index < numId; index++) {
            const entryOffset = idStart + index * 8
            if (buffer.readUInt32LE(entryOffset) !== SvnExecutable.rtManifestConst) continue
            const ref = buffer.readUInt32LE(entryOffset + 4)
            if ((ref & 0x80000000) !== 0)
              originalManifest = SvnExecutable.readFirstResourceLeaf(buffer, rsrcBase, rsrcBase + (ref & 0x7fffffff), rvaToFile, 0)
            if (originalManifest !== null && SvnExecutable.hasUtf8ActiveCodePage(originalManifest))
              return { validPe: true, hasUtf8: true, originalManifest, removedEmbedded: false, buffer: source }
            const remaining = (numId - 1 - index) * 8
            if (remaining > 0) buffer.copy(buffer, entryOffset, entryOffset + 8, entryOffset + 8 + remaining)
            buffer.fill(0, idStart + (numId - 1) * 8, idStart + numId * 8)
            buffer.writeUInt16LE(numId - 1, rsrcBase + 14)
            removedEmbedded = true
            break
          }
        }
      }
    }

    if (removedEmbedded) {
      if (numDataDirs > 4 && ddOffset + 5 * 8 <= secTableOffset) {
        const secOff = buffer.readUInt32LE(ddOffset + 4 * 8)
        const secSize = buffer.readUInt32LE(ddOffset + 4 * 8 + 4)
        buffer.writeUInt32LE(0, ddOffset + 4 * 8)
        buffer.writeUInt32LE(0, ddOffset + 4 * 8 + 4)
        if (secOff > 0 && secSize > 0 && secOff + secSize === buffer.length) buffer = buffer.subarray(0, secOff)
      }
      if (optHeaderOffset + 68 <= buffer.length) buffer.writeUInt32LE(0, optHeaderOffset + 64)
    }

    return { validPe: true, hasUtf8: false, originalManifest, removedEmbedded, buffer }
  }

  private static readFirstResourceLeaf(
    buffer: Buffer,
    rsrcBase: number,
    dirOffset: number,
    rvaToFile: (rva: number) => number,
    depth: number,
  ): string | null {
    if (depth > 4 || dirOffset < 0 || dirOffset + 24 > buffer.length) return null
    const count = buffer.readUInt16LE(dirOffset + 12) + buffer.readUInt16LE(dirOffset + 14)
    if (count === 0) return null
    const childRef = buffer.readUInt32LE(dirOffset + 16 + 4)
    if ((childRef & 0x80000000) !== 0)
      return SvnExecutable.readFirstResourceLeaf(buffer, rsrcBase, rsrcBase + (childRef & 0x7fffffff), rvaToFile, depth + 1)
    const dataEntry = rsrcBase + childRef
    if (dataEntry < 0 || dataEntry + 8 > buffer.length) return null
    const dataRva = buffer.readUInt32LE(dataEntry)
    const dataSize = buffer.readUInt32LE(dataEntry + 4)
    const dataOffset = rvaToFile(dataRva)
    if (dataOffset < 0 || dataOffset + dataSize > buffer.length) return null
    return buffer.subarray(dataOffset, dataOffset + dataSize).toString('utf8')
  }

  private static buildWindowsUtf8(
    sourcePath: string,
    stat: { size: number; mtimeMs: number },
    cacheDir: string,
  ): SvnExecutableResolution | null {
    let sourceBytes: Buffer
    try { sourceBytes = readFileSync(sourcePath) }
    catch { return null }
    const stripped = SvnExecutable.stripEmbeddedManifest(sourceBytes)
    if (!stripped.validPe) return null
    if (stripped.hasUtf8) return { command: sourcePath, dllDirectory: null, utf8: true }
    if (!stripped.removedEmbedded && existsSync(`${sourcePath}.manifest`)) {
      try {
        if (SvnExecutable.hasUtf8ActiveCodePage(readFileSync(`${sourcePath}.manifest`, 'utf8')))
          return { command: sourcePath, dllDirectory: null, utf8: true }
      } catch { /* fall through to cached copy */ }
    }

    const hash = createHash('sha256')
      .update(`${SvnExecutable.cacheVersionConst}\0${sourcePath.toLowerCase()}\0${stat.size}\0${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 16)
    const exeName = `svn-${hash}.exe`
    const exePath = join(cacheDir, exeName)
    const manifestPath = `${exePath}.manifest`
    const dllDirectory = dirname(sourcePath)

    if (SvnExecutable.cachedReady(exePath, manifestPath)) return { command: exePath, dllDirectory, utf8: true }

    try {
      mkdirSync(cacheDir, { recursive: true })
      const manifestXml = SvnExecutable.mergeUtf8Manifest(stripped.originalManifest)
      // Write the manifest before the executable becomes visible so no racing caller can launch the
      // executable before Windows SxS sees its external manifest.
      SvnExecutable.atomicWrite(manifestPath, Buffer.from(manifestXml, 'utf8'))
      SvnExecutable.atomicWrite(exePath, stripped.buffer)
      if (!SvnExecutable.cachedReady(exePath, manifestPath)) return null
      SvnExecutable.sweepStale(cacheDir, exeName)
      return { command: exePath, dllDirectory, utf8: true }
    } catch { return null }
  }

  private static cachedReady(exePath: string, manifestPath: string): boolean {
    try {
      return statSync(exePath).size > 0 && SvnExecutable.hasUtf8ActiveCodePage(readFileSync(manifestPath, 'utf8'))
    } catch { return false }
  }

  private static atomicWrite(targetPath: string, data: Buffer): void {
    const temporary = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temporary, data)
    try {
      renameSync(temporary, targetPath)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* ignore */ }
      if (!existsSync(targetPath)) throw error
    }
  }

  private static sweepStale(cacheDir: string, keepExeName: string): void {
    const keepManifest = `${keepExeName}.manifest`
    try {
      for (const name of readdirSync(cacheDir)) {
        if (name === keepExeName || name === keepManifest) continue
        if (!/^svn-[0-9a-f]{16}\.exe(?:\.manifest)?$/i.test(name)) continue
        try { unlinkSync(join(cacheDir, name)) } catch { /* ignore locked or concurrent binary */ }
      }
    } catch { /* ignore */ }
  }

  private static findWindowsImage(environment: NodeJS.ProcessEnv): string | null {
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path')
    const rawPath = pathKey === undefined ? '' : (environment[pathKey] ?? '')
    const directories = rawPath.split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter((entry) => entry.length > 0)
    const extensions = (environment.PATHEXT ?? SvnExecutable.defaultPathextConst)
      .split(';').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.startsWith('.'))
    for (const directory of directories)
      for (const extension of extensions) {
        const candidate = join(directory, `svn${extension}`)
        if (existsSync(candidate))
          return SvnExecutable.imageExtensionsConst.has(extname(candidate).toLowerCase()) ? candidate : null
      }
    return null
  }
}
