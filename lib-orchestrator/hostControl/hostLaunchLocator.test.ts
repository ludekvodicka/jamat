import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { RuntimeChannel } from '../shared/configIdentity.types'
import {
  type HostLaunchCommand,
  type HostLaunchRoots,
  HostLaunchLocator,
} from './hostLaunchLocator'

describe('lib-orchestrator/hostControl/hostLaunchLocator', () => {
  /** Where `app-host` really stands, which is what the client hands in at runtime. */
  const treeRootConst = join(import.meta.dirname, '..', '..')
  /**
   * A tree of its own, deliberately nowhere near this file: a measured root and a handed-in one look
   * alike otherwise. It holds the entry point, so it is a root a Host can be launched from.
   */
  const foreignRootConst = mkdtempSync(join(tmpdir(), 'jamat-v3-launch-locator-'))
  /** What a packaged client's `resources` is: a directory that exists and holds no `app-host`. */
  const packagedRootConst = mkdtempSync(join(tmpdir(), 'jamat-v3-launch-locator-packaged-'))
  /** The same, with the Host bundle `build.extraResources` puts under `host/` actually there. */
  const bundledResourcesConst = mkdtempSync(join(tmpdir(), 'jamat-v3-launch-locator-bundle-'))
  const bundleEntryConst = join(bundledResourcesConst, 'host', 'start.cjs')

  mkdirSync(join(foreignRootConst, 'app-host'), { recursive: true })
  writeFileSync(join(foreignRootConst, 'app-host', 'start.ts'), '')
  mkdirSync(join(bundledResourcesConst, 'host'), { recursive: true })
  writeFileSync(bundleEntryConst, '')

  afterAll(() => {
    rmSync(foreignRootConst, { recursive: true, force: true })
    rmSync(packagedRootConst, { recursive: true, force: true })
    rmSync(bundledResourcesConst, { recursive: true, force: true })
  })

  function sourceRoots(applicationRoot: string): HostLaunchRoots {
    return { applicationRoot, resourcesRoot: null }
  }

  function launchOf(
    roots: HostLaunchRoots,
    configDir: string,
    channel: RuntimeChannel,
    environment?: NodeJS.ProcessEnv,
  ): HostLaunchCommand {
    const located = environment === undefined
      ? HostLaunchLocator.launch(roots, configDir, channel)
      : HostLaunchLocator.launch(roots, configDir, channel, environment)
    if (!located.ok) throw new Error(`the launch was refused: ${located.reason}`)
    return located.launch
  }

  it('starts the Host with this Node under tsx, from the application root it was given', () => {
    const configDir = join('C:', 'tmp', 'config')
    const launch = launchOf(sourceRoots(foreignRootConst), configDir, 'development')
    expect(launch.command).toBe(process.execPath)
    expect(launch.args.slice(0, 2)).toEqual(['--import', 'tsx'])
    expect(launch.args[2]).toBe(join(foreignRootConst, 'app-host', 'start.ts'))
    expect(launch.cwd).toBe(foreignRootConst)
  })

  it('resolves an entry point that exists when it is given this tree', () => {
    expect(existsSync(launchOf(sourceRoots(treeRootConst), 'anywhere', 'production').args[2]))
      .toBe(true)
  })

  /**
   * The installed client: no source entry anywhere under `resources`, and the bundle
   * `scripts/release/prepare-host-bundle.ts` produced sitting where `build.extraResources` put it.
   * It is plain CommonJS, so the tsx loader is exactly what must NOT be there - an installed client
   * ships no `tsx` and the spawn would fail on a module it cannot resolve.
   */
  it('starts the packaged bundle without the loader when there is no source entry', () => {
    const configDir = join('C:', 'tmp', 'config-packaged')
    const launch = launchOf(
      { applicationRoot: packagedRootConst, resourcesRoot: bundledResourcesConst },
      configDir,
      'production',
    )
    expect(launch.command).toBe(process.execPath)
    expect(launch.args[0]).toBe(bundleEntryConst)
    expect(launch.args).not.toContain('tsx')
    expect(launch.args[launch.args.indexOf('--config-dir') + 1]).toBe(configDir)
    expect(launch.args[launch.args.indexOf('--channel') + 1]).toBe('production')
    // `node-pty` stays external and unpacked beside the bundle, so its `node_modules` is only
    // resolvable from the bundle's own directory.
    expect(launch.cwd).toBe(join(bundledResourcesConst, 'host'))
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  /**
   * The ordering that is a decision rather than a detail. A developer's tree collects an
   * `out/host-bundle` the moment they package once, and a client that preferred it would serve
   * yesterday's Host to someone editing today's - silently, because both launches look identical
   * from the outside.
   */
  it('runs the source entry even when a packaged bundle is standing beside it', () => {
    const launch = launchOf(
      { applicationRoot: foreignRootConst, resourcesRoot: bundledResourcesConst },
      'anywhere',
      'development',
    )
    expect(launch.args[2]).toBe(join(foreignRootConst, 'app-host', 'start.ts'))
    expect(launch.args).not.toContain(bundleEntryConst)
  })

  /**
   * Both places named, because a refusal that names one leaves the reader guessing which of the two
   * was even looked at. A spawn of a script that is not there still succeeds, so the caller would
   * otherwise have nothing but an exit code after its boot deadline.
   */
  it('refuses a packaged client with no bundle, and names both places it looked', () => {
    const located = HostLaunchLocator.launch(
      { applicationRoot: packagedRootConst, resourcesRoot: packagedRootConst },
      'anywhere',
      'production',
    )
    expect(located.ok).toBe(false)
    const reason = located.ok ? '' : located.reason
    expect(reason).toContain(join(packagedRootConst, 'app-host', 'start.ts'))
    expect(reason).toContain(join(packagedRootConst, 'host', 'start.cjs'))
    expect(reason).toContain('pnpm host')
  })

  /** A client that is not packaged has no second place to name, and says so instead of inventing one. */
  it('refuses a source tree with no entry point, and says there is no bundle to fall back on', () => {
    const located = HostLaunchLocator.launch(sourceRoots(packagedRootConst), 'anywhere', 'production')
    expect(located.ok).toBe(false)
    const reason = located.ok ? '' : located.reason
    expect(reason).toContain(join(packagedRootConst, 'app-host', 'start.ts'))
    expect(reason).toContain('not a packaged install')
    expect(reason).toContain('pnpm host')
  })

  // app-host reads both as a flag followed by its value; a joined "--channel=production" is a value
  // it never finds.
  it('passes the config directory and the channel the way app-host reads them', () => {
    const configDir = join('C:', 'tmp', 'config-a')
    const launch = launchOf(sourceRoots(treeRootConst), configDir, 'production')
    expect(launch.args[launch.args.indexOf('--config-dir') + 1]).toBe(configDir)
    expect(launch.args[launch.args.indexOf('--channel') + 1]).toBe('production')
  })

  it('keeps the two channels apart', () => {
    expect(launchOf(sourceRoots(treeRootConst), 'c', 'development').args)
      .not.toEqual(launchOf(sourceRoots(treeRootConst), 'c', 'production').args)
  })

  /**
   * `process.execPath` in the client is `electron.exe`. Without this variable it boots a second
   * Electron application and the Host never starts, which no assertion about the argument list can
   * see. The rest of the environment is inherited whole, because that is how the Host is told which
   * state root it serves.
   */
  it('runs an Electron execPath as Node, and carries the state root over untouched', () => {
    const previous = process.env.JAMAT_V3_LOCAL_STATE_DIR
    const stateRoot = join('C:', 'tmp', 'state-a')
    process.env.JAMAT_V3_LOCAL_STATE_DIR = stateRoot
    try {
      const launch = launchOf(sourceRoots(treeRootConst), 'anywhere', 'development')
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(launch.env.JAMAT_V3_LOCAL_STATE_DIR).toBe(stateRoot)
    } finally {
      if (previous === undefined) delete process.env.JAMAT_V3_LOCAL_STATE_DIR
      else process.env.JAMAT_V3_LOCAL_STATE_DIR = previous
    }
  })

  /**
   * The regression this exists to catch is silent in both directions. `ELECTRON_` is a denied prefix,
   * so a switch spread in BEFORE the filter is removed again and the Host launch boots a second
   * Electron application; and a Host that inherits the client's `NODE_PATH` resolves `tsx` and every
   * module after it out of electron-vite's dependency tree.
   */
  it('adds the Node switch after the filter that would otherwise remove it', () => {
    const launch = launchOf(sourceRoots(treeRootConst), 'anywhere', 'development', {
      JAMAT_V3_LOCAL_STATE_DIR: 'C:\\state',
      NODE_ENV: 'development',
      NODE_PATH: 'Q:\\...\\electron-vite\\node_modules',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      npm_package_name: 'jamat-v3-client-ui',
      PATH: '/usr/bin',
    })
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(launch.env.JAMAT_V3_LOCAL_STATE_DIR).toBe('C:\\state')
    expect(launch.env.PATH).toBe('/usr/bin')
    expect(launch.env.NODE_ENV).toBeUndefined()
    expect(launch.env.NODE_PATH).toBeUndefined()
    expect(launch.env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(launch.env.npm_package_name).toBeUndefined()
  })
})
