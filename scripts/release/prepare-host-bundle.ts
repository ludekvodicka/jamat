/**
 * Seeds `out/host-bundle/current/`, the Host an INSTALLED client starts. `app-client-ui`'s
 * `build.extraResources` copies that directory to `resources/host`, and `HostLaunchLocator` runs
 * `start.cjs` there when no source entry point stands beside the client.
 *
 * Two files decide the shape of the bundle. `start.cjs` is the whole of `app-host` collapsed by
 * esbuild into one CommonJS file, because a packaged client ships no `tsx` and no `node_modules` of
 * the Host's. `node-pty` is the exception and stays external: it is a native module, and a bundler
 * can only inline JavaScript. It is copied beside the bundle instead, so node-pty's own loader finds
 * its binding on the relative paths it looks at (`../build/Release`, `../prebuilds/<platform>-<arch>`).
 *
 * The bundle is a Node script, not an Electron one. It is started as `process.execPath` under
 * `ELECTRON_RUN_AS_NODE`, so the runtime is Electron's own Node - which is what makes the prebuilt
 * node-pty binding the thing to prove rather than assume; `scripts/smoke/packaged-host.ts` runs the
 * packaged executable against this bundle and spawns a real PTY through it.
 *
 * **There is deliberately no `electron-rebuild` step, here or in the packaging script.** node-pty
 * 1.2.0-beta.12 ships N-API prebuilds, and an N-API binding is ABI-stable across Node versions and
 * across Electron alike, so the prebuild the package already carries loads under Electron's Node
 * unchanged - the packaged smoke spawns a real PTY through exactly that binding. Rebuilding it would
 * also break the source tree it was rebuilt in: `pnpm host` and `scripts/smoke/host.ts` run
 * `app-host` under plain Node, and a binding recompiled for one runtime cannot serve both if node-pty
 * ever stops being N-API. If that day comes, the rebuild belongs to a copy of the module, never to
 * `app-host/node_modules`.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { build } from 'esbuild'

interface HostBundleManifest {
  schemaVersion: 1
  entry: string
  host: { name: string; version: string }
  nodePty: { version: string }
  /** Which platform's node-pty prebuild survived the prune, and therefore who can run this bundle. */
  runtime: { platform: string; arch: string }
  tree: { files: number; sha256: string }
}

class PrepareHostBundle {
  private static readonly labelConst = '[release:host-bundle]'
  private static readonly repoRootConst = resolve(import.meta.dirname, '..', '..')
  private static readonly hostPackageConst = join(PrepareHostBundle.repoRootConst, 'app-host')
  private static readonly entryFileNameConst = 'start.ts'
  private static readonly bundleFileNameConst = 'start.cjs'
  private static readonly manifestFileNameConst = 'manifest.json'
  private static readonly nativeModuleConst = 'node-pty'
  /**
   * The repository's Node floor, which is also what Electron 43 carries. Both runtimes have to be
   * able to read what this emits, and they are the same major.
   */
  private static readonly nodeTargetConst = 'node22'
  /**
   * `import.meta.url` is empty in CommonJS output, and `BuildInfoSource` reads it to find the
   * package version it reports in every descriptor. Defined here rather than left to go undefined:
   * the read is inside a `try`, so without this the packaged Host would report itself unversioned
   * and nothing would say why.
   */
  private static readonly moduleUrlIdentifierConst = '__jamatHostModuleUrl'

  static async run(): Promise<void> {
    const host = PrepareHostBundle.hostPackage()
    const outputRoot = join(PrepareHostBundle.repoRootConst, 'out', 'host-bundle')
    mkdirSync(outputRoot, { recursive: true })
    const staging = mkdtempSync(join(outputRoot, '.prepare-'))
    try {
      await PrepareHostBundle.bundle(staging)
      const nodePtyVersion = PrepareHostBundle.copyNativeModule(staging)
      PrepareHostBundle.writePackageDocument(staging, host)
      const manifest = PrepareHostBundle.writeManifest(staging, host, nodePtyVersion)
      PrepareHostBundle.publish(staging, join(outputRoot, 'current'))
      const size = PrepareHostBundle.sizeOf(join(outputRoot, 'current'))
      console.log(`${PrepareHostBundle.labelConst} ${host.name} ${host.version}, `
        + `${PrepareHostBundle.nativeModuleConst} ${nodePtyVersion}, `
        + `${manifest.runtime.platform}-${manifest.runtime.arch}`)
      console.log(`${PrepareHostBundle.labelConst} ${size.files} files, ${size.bytes} bytes`)
    } finally {
      PrepareHostBundle.discard(staging)
    }
  }

  private static async bundle(staging: string): Promise<void> {
    const entryFile = join(PrepareHostBundle.hostPackageConst, PrepareHostBundle.entryFileNameConst)
    if (!existsSync(entryFile)) throw new Error(`no Host entry point at ${entryFile}`)
    const result = await build({
      entryPoints: [entryFile],
      outfile: join(staging, PrepareHostBundle.bundleFileNameConst),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: PrepareHostBundle.nodeTargetConst,
      external: [PrepareHostBundle.nativeModuleConst],
      banner: {
        js: `const ${PrepareHostBundle.moduleUrlIdentifierConst} = `
          + "require('node:url').pathToFileURL(__filename).href;",
      },
      define: { 'import.meta.url': PrepareHostBundle.moduleUrlIdentifierConst },
      legalComments: 'none',
      logLevel: 'warning',
    })
    // A warning here is something esbuild could not resolve the way the source meant it - an
    // `import.meta` it had to empty, a require it could not follow - and every one of them shows up
    // at runtime instead, inside the detached Host where nobody is reading stderr.
    if (result.warnings.length > 0)
      throw new Error(`esbuild reported ${result.warnings.length} warning(s): `
        + result.warnings.map((warning) => warning.text).join('; '))
  }

  /**
   * The whole package, minus the prebuilds of every platform this bundle will never run on: they are
   * the bulk of it, and a Windows installer carrying the arm64 Windows binding is 12 MB of nothing.
   * The one directory that is kept is the one node-pty's own loader looks for,
   * `prebuilds/<platform>-<arch>`, so each release runner produces a bundle for itself.
   */
  private static copyNativeModule(staging: string): string {
    const source = realpathSync(join(
      PrepareHostBundle.hostPackageConst,
      'node_modules',
      PrepareHostBundle.nativeModuleConst,
    ))
    const target = join(staging, 'node_modules', PrepareHostBundle.nativeModuleConst)
    const keptPrebuild = join('prebuilds', `${process.platform}-${process.arch}`)
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: (from) => {
        const path = relative(source, from)
        if (!path.startsWith(`prebuilds${sep}`)) return true
        return path.split(sep).slice(0, 2).join(sep) === keptPrebuild
      },
    })
    if (!existsSync(join(target, keptPrebuild)) && !existsSync(join(target, 'build', 'Release')))
      throw new Error(`${PrepareHostBundle.nativeModuleConst} carries no binding for `
        + `${process.platform}-${process.arch}; build it in app-host first`)
    return PrepareHostBundle.versionOf(join(source, 'package.json'))
  }

  /**
   * The bundle's identity as a package. `type: commonjs` states what the `.cjs` extension already
   * forces, and the version is what `BuildInfoSource` finds beside the bundle and reports as the
   * Host's own - the file the source tree reads two directories up has collapsed into this one.
   */
  private static writePackageDocument(staging: string, host: { name: string; version: string }): void {
    writeFileSync(
      join(staging, 'package.json'),
      `${JSON.stringify({
        name: host.name,
        version: host.version,
        private: true,
        type: 'commonjs',
        main: `./${PrepareHostBundle.bundleFileNameConst}`,
      }, null, 2)}\n`,
      'utf8',
    )
  }

  private static writeManifest(
    staging: string,
    host: { name: string; version: string },
    nodePtyVersion: string,
  ): HostBundleManifest {
    const manifest: HostBundleManifest = {
      schemaVersion: 1,
      entry: PrepareHostBundle.bundleFileNameConst,
      host,
      nodePty: { version: nodePtyVersion },
      runtime: { platform: process.platform, arch: process.arch },
      tree: PrepareHostBundle.treeOf(staging),
    }
    writeFileSync(
      join(staging, PrepareHostBundle.manifestFileNameConst),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    return manifest
  }

  private static hostPackage(): { name: string; version: string } {
    const file = join(PrepareHostBundle.hostPackageConst, 'package.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string')
      throw new Error(`${file} carries no name and version`)
    return { name: parsed.name, version: parsed.version }
  }

  private static versionOf(file: string): string {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
    if (typeof parsed.version !== 'string') throw new Error(`${file} carries no version`)
    return parsed.version
  }

  private static treeOf(root: string): HostBundleManifest['tree'] {
    const entries = PrepareHostBundle.filesUnder(root)
      .map((file) => ({
        path: PrepareHostBundle.relativePath(root, file),
        sha256: PrepareHostBundle.hashOf(file),
      }))
      .filter((entry) => entry.path !== PrepareHostBundle.manifestFileNameConst)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
    const hash = createHash('sha256')
    for (const entry of entries)
      hash.update(entry.path, 'utf8').update('\0').update(entry.sha256, 'ascii').update('\n')
    return { files: entries.length, sha256: hash.digest('hex') }
  }

  private static publish(staging: string, current: string): void {
    const backup = `${current}.previous-${process.pid}-${randomUUID()}`
    let previousMoved = false
    if (existsSync(current)) {
      renameSync(current, backup)
      previousMoved = true
    }
    try {
      renameSync(staging, current)
    } catch (error) {
      if (previousMoved) renameSync(backup, current)
      throw error
    }
    if (previousMoved) {
      try { rmSync(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
      catch (error) {
        console.warn(`${PrepareHostBundle.labelConst} old bundle remains at ${backup}: `
          + PrepareHostBundle.errorOf(error))
      }
    }
  }

  private static filesUnder(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) files.push(...PrepareHostBundle.filesUnder(path))
      else if (entry.isFile()) files.push(path)
      else throw new Error(`the bundle tree contains an unsupported entry: ${path}`)
    }
    return files
  }

  private static sizeOf(directory: string): { files: number; bytes: number } {
    const files = PrepareHostBundle.filesUnder(directory)
    let bytes = 0
    for (const file of files) bytes += statSync(file).size
    return { files: files.length, bytes }
  }

  private static relativePath(root: string, file: string): string {
    const child = relative(resolve(root), resolve(file))
    if (child.length === 0 || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      throw new Error(`a bundle file escapes its root: ${file}`)
    return child.split(sep).join('/')
  }

  private static hashOf(file: string): string {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }

  private static discard(directory: string): void {
    if (!existsSync(directory)) return
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  private static errorOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

void PrepareHostBundle.run().catch((error: unknown) => {
  console.error(`[release:host-bundle] ${
    error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
