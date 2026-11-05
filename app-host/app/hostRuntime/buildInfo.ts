import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostWireConst, type BuildInfo } from '../wire/hostWire.js'

export interface HostPerfBuild { version: string; inputHash: string; builtAt: string }
declare const __JAMAT_V3_HOST_PERF_BUILD__: HostPerfBuild

export class BuildInfoSource {
  private static readonly unreadableVersionConst = '0.0.0'
  /** `app/hostRuntime` -> `app` -> `app-host`: as far as this file's own package can ever be. */
  private static readonly packageSearchDepthConst = 2
  private static configured: BuildInfo | null = null
  private static perf: HostPerfBuild | null = null

  static perfBuild(packageRoot?: string): HostPerfBuild {
    if (packageRoot === undefined && typeof __JAMAT_V3_HOST_PERF_BUILD__ !== 'undefined')
      return { ...__JAMAT_V3_HOST_PERF_BUILD__ }
    if (packageRoot === undefined && BuildInfoSource.perf !== null) return { ...BuildInfoSource.perf }
    const root = packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const files: string[] = []
    const walk = (relative: string): void => {
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) files.push(path)
      }
    }
    walk('app')
    files.push('start.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json')
    const hash = createHash('sha256').update(`host-input-v1\0${process.platform}\0${process.arch}\0`)
    for (const path of files.sort()) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0')
    const version = BuildInfoSource.versionIn(join(root, 'package.json')) ?? BuildInfoSource.unreadableVersionConst
    const build = { version, inputHash: hash.digest('hex'), builtAt: new Date().toISOString() }
    if (packageRoot === undefined) BuildInfoSource.perf = build
    return build
  }

  static current(): BuildInfo {
    if (BuildInfoSource.configured)
      return structuredClone(BuildInfoSource.configured)
    const buildVersion = process.env.JAMAT_V3_BUILD_VERSION
      ?? BuildInfoSource.packageVersion()
    const sourceRevision = process.env.JAMAT_V3_SOURCE_REVISION ?? 'source-tree'
    const capabilities = [...HostWireConst.capabilities]
    const payloadHash = process.env.JAMAT_V3_PAYLOAD_HASH
      ?? createHash('sha256')
        .update(JSON.stringify({
          buildVersion,
          sourceRevision,
          platform: process.platform,
          arch: process.arch,
          capabilities,
        }))
        .digest('hex')
    return {
      buildVersion,
      ...(process.env.JAMAT_V3_RELEASE_VERSION
        ? { releaseVersion: process.env.JAMAT_V3_RELEASE_VERSION }
        : {}),
      sourceRevision,
      platform: process.platform,
      arch: process.arch,
      hostWire: {
        major: HostWireConst.protocolMajor,
        minor: HostWireConst.protocolMinor,
      },
      capabilities,
      payloadHash,
    }
  }

  static configure(buildInfo: BuildInfo): void {
    if (!buildInfo.buildVersion
      || !buildInfo.sourceRevision
      || !buildInfo.payloadHash
      || !Array.isArray(buildInfo.capabilities))
      throw new Error('Invalid configured BuildInfo')
    BuildInfoSource.configured = structuredClone(buildInfo)
  }

  static configureFromFile(file: string): BuildInfo {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(
        `Could not read BuildInfo ${file}: ${
          error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!value || typeof value !== 'object')
      throw new Error(`Invalid BuildInfo document: ${file}`)
    BuildInfoSource.configure(value as BuildInfo)
    return BuildInfoSource.current()
  }

  static exactMatch(left: BuildInfo, right: BuildInfo): boolean {
    return left.buildVersion === right.buildVersion
      && left.sourceRevision === right.sourceRevision
      && left.platform === right.platform
      && left.arch === right.arch
  }

  /**
   * `0.0.0` is the answer to "this host could not read its own package.json", and nothing else -
   * the package itself carries a real version, so a descriptor showing 0.0.0 means the file was
   * unreadable rather than that the build is unversioned.
   *
   * The nearest `package.json` at or above this file, rather than a fixed `../..`: in the source
   * tree that is `app-host/`, two directories up, and in the release bundle the whole package has
   * collapsed into one file with its `package.json` written beside it. Counting levels was right in
   * exactly one of the two, and the wrong one answered 0.0.0 - which is the sentence above, said
   * about a build that is perfectly versioned.
   */
  private static packageVersion(): string {
    let directory = dirname(fileURLToPath(import.meta.url))
    for (let level = 0; level <= BuildInfoSource.packageSearchDepthConst; level += 1) {
      const version = BuildInfoSource.versionIn(join(directory, 'package.json'))
      if (version !== null) return version
      directory = dirname(directory)
    }
    return BuildInfoSource.unreadableVersionConst
  }

  private static versionIn(file: string): string | null {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }
}
