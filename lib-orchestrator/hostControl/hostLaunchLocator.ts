import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ChildEnvironment } from '../shared/childEnvironment'
import type { RuntimeChannel } from '../shared/configIdentity.types'

export interface HostLaunchCommand {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * The two places a Host can be started from, both named by the client. Neither is measured here: this
 * library is bundled into whatever imports it, so `import.meta.url` names the bundle and any
 * arithmetic on it lands in the importing package.
 */
export interface HostLaunchRoots {
  /** The directory `app-host` stands in, in a development tree. */
  applicationRoot: string
  /** Electron's `process.resourcesPath` in a packaged client, `null` in every other caller. */
  resourcesRoot: string | null
}

/**
 * Either a command that can start a Host from the tree it was asked about, or the reason that tree
 * cannot start one. There is no third answer and no throw: which tree the client stands in is an
 * ordinary fact about the installation, not a fault.
 */
export type HostLaunchResult =
  | { ok: true; launch: HostLaunchCommand }
  | { ok: false; reason: string }

/**
 * Where the Host is and how it is started. There are two places it can come from and they are tried
 * in one fixed order: the **source entry point** `app-host/start.ts` under the application root,
 * then the **packaged bundle** `host/start.cjs` under a packaged client's `resources`.
 *
 * The source entry wins deliberately. A development tree that happens to have a stale
 * `out/host-bundle` beside it must still run its own source - the alternative is a client that
 * silently serves yesterday's Host to a developer editing today's, which no error message would ever
 * reveal.
 *
 * Both commands are `process.execPath` with `ELECTRON_RUN_AS_NODE`; they differ only in what that
 * Node runs. The source entry needs the tsx loader because it is TypeScript; the bundle is plain
 * CommonJS produced by `scripts/release/prepare-host-bundle.ts` and needs nothing.
 */
export class HostLaunchLocator {
  private static readonly packageNameConst = 'app-host'
  private static readonly entryFileNameConst = 'start.ts'
  private static readonly loaderArgsConst = ['--import', 'tsx']
  /** Where `app-client-ui/package.json` `build.extraResources` puts the bundle, and its entry. */
  private static readonly bundleDirectoryNameConst = 'host'
  private static readonly bundleEntryFileNameConst = 'start.cjs'

  /**
   * The entry point is read off the disk before a command is composed at all. A spawn of a script
   * that is not there succeeds - the failure is the child's, a tick later - so without this the
   * caller has nothing to go on until its boot deadline runs out. It is also what decides between
   * the two branches: the roots are handed in, but which of them actually holds a Host is a fact
   * about the disk.
   */
  static launch(
    roots: HostLaunchRoots,
    configDir: string,
    channel: RuntimeChannel,
    environment: NodeJS.ProcessEnv = process.env,
  ): HostLaunchResult {
    const sourceEntry = join(
      roots.applicationRoot,
      HostLaunchLocator.packageNameConst,
      HostLaunchLocator.entryFileNameConst,
    )
    if (existsSync(sourceEntry))
      return {
        ok: true,
        launch: {
          command: process.execPath,
          args: [
            ...HostLaunchLocator.loaderArgsConst,
            sourceEntry,
            ...HostLaunchLocator.hostArgs(configDir, channel),
          ],
          cwd: roots.applicationRoot,
          env: HostLaunchLocator.childEnv(environment),
        },
      }

    const bundleEntry = roots.resourcesRoot === null
      ? null
      : join(
        roots.resourcesRoot,
        HostLaunchLocator.bundleDirectoryNameConst,
        HostLaunchLocator.bundleEntryFileNameConst,
      )
    if (bundleEntry !== null && existsSync(bundleEntry))
      return {
        ok: true,
        launch: {
          command: process.execPath,
          args: [bundleEntry, ...HostLaunchLocator.hostArgs(configDir, channel)],
          // The bundle keeps `node-pty` external and unpacked beside itself, so the working
          // directory is the bundle's own: that is where its `node_modules` stands.
          cwd: dirname(bundleEntry),
          env: HostLaunchLocator.childEnv(environment),
        },
      }

    return { ok: false, reason: HostLaunchLocator.refusal(sourceEntry, bundleEntry) }
  }

  /** app-host reads each as a flag followed by its value; a joined `--channel=x` it never finds. */
  private static hostArgs(configDir: string, channel: RuntimeChannel): string[] {
    return ['--config-dir', configDir, '--channel', channel]
  }

  /**
   * Both places are named, because which one the reader should have expected depends on where they
   * are standing and the message cannot know. A client that is not packaged has no second place to
   * name at all, and says so rather than inventing a path it never looked at.
   */
  private static refusal(sourceEntry: string, bundleEntry: string | null): string {
    const places = bundleEntry === null
      ? `no Host entry point at ${sourceEntry}, and this client is not a packaged install, so it `
        + 'carries no Host bundle of its own either'
      : `no Host entry point at ${sourceEntry} and no packaged Host bundle at ${bundleEntry}`
    return `${places}. Start one by hand with \`pnpm host\` in a source tree.`
  }

  /**
   * Every Jamat variable is inherited, which is what carries a JAMAT_V3_* override of the state root
   * into the Host that is meant to serve it. What is NOT inherited is the client's own dev runtime:
   * a development client is started by electron-vite under pnpm, and the Host is a Node process that
   * would otherwise resolve its modules through electron-vite's `NODE_PATH`.
   *
   * The single addition is what makes `process.execPath` run a Node script at all: in the client that
   * path is `electron.exe`, and without this switch it boots a second Electron application instead of
   * the entry point. Plain Node ignores the variable, so one command serves both callers. It is
   * spread in AFTER the filter and must stay there - `ELECTRON_` is a denied prefix, so a switch
   * added before it would be filtered straight back out.
   */
  private static childEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...ChildEnvironment.keepingJamat(environment), ELECTRON_RUN_AS_NODE: '1' }
  }
}
