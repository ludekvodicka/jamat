import type { PlatformSettingsValue } from '../../lib-orchestrator/projectSetup/projectSetup.types'
import { SetupFamilies } from '../../lib-orchestrator/projectSetup/setupFamilies'

/**
 * How this machine installs a worktree's dependencies: the middle of the three tiers, under whatever
 * a project declares in its own `.worktree.json` and over every family's built-in default.
 *
 * It lived in `<configDir>/platforms.json` until 2026-08-28, a file with a reader and no writer that
 * nothing ever created. The registered decision beside it said the fold into `config.json` waits for
 * that first writer, and this is it: `ConfigStore` already owns the latch, the snapshot ring and the
 * atomic write, so a second file with a second writer would buy only the race the section registry
 * exists to settle. Nothing was on disk, so nothing was migrated.
 *
 * The shape is the library's - `ProjectSetupManager` is what reads it - and only `coerce` and
 * `isValid` are the client's, the same split `versioningSettings` makes.
 */
export type WorktreeSettingsValue = PlatformSettingsValue

export type WorktreeSettingsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

export class WorktreeSettings {
  private static readonly sectionNameConst = 'worktrees'

  static defaultValue(): WorktreeSettingsValue {
    return SetupFamilies.defaultPlatformSettings()
  }

  /**
   * Reading is total: an absent section, a damaged one and an unusable flag all answer with the
   * default, because refusing to read would leave a session with no way to install anything. Keys
   * this build does not know are kept, so a newer version's option survives an older one saving.
   */
  static coerce(value: unknown, report: (message: string) => void): WorktreeSettingsValue {
    if (value === undefined) return WorktreeSettings.defaultValue()
    if (!WorktreeSettings.isObject(value)) {
      report(`The ${WorktreeSettings.sectionNameConst} section of config.json is not an object; `
        + 'installing with the plain command of every family')
      return WorktreeSettings.defaultValue()
    }
    return { ...value, node: WorktreeSettings.coerceNode(value.node, report) }
  }

  /** Writing is strict, which is what keeps the file readable by the next version that reads it. */
  static isValid(value: unknown): value is WorktreeSettingsValue {
    if (!WorktreeSettings.isObject(value)) return false
    if (!WorktreeSettings.isObject(value.node)) return false
    if (!WorktreeSettings.isObject(value.node.pnpm)) return false
    return typeof value.node.pnpm.globalVirtualStore === 'boolean'
  }

  private static coerceNode(
    value: unknown,
    report: (message: string) => void,
  ): WorktreeSettingsValue['node'] {
    if (value === undefined) return WorktreeSettings.defaultValue().node
    if (!WorktreeSettings.isObject(value)) {
      report(`The ${WorktreeSettings.sectionNameConst}.node section of config.json is not an `
        + 'object; installing with a plain pnpm install')
      return WorktreeSettings.defaultValue().node
    }
    return { ...value, pnpm: WorktreeSettings.coercePnpm(value.pnpm, report) }
  }

  private static coercePnpm(
    value: unknown,
    report: (message: string) => void,
  ): WorktreeSettingsValue['node']['pnpm'] {
    if (value === undefined) return WorktreeSettings.defaultValue().node.pnpm
    if (!WorktreeSettings.isObject(value)) {
      report(`The ${WorktreeSettings.sectionNameConst}.node.pnpm section of config.json is not an `
        + 'object; installing with a plain pnpm install')
      return WorktreeSettings.defaultValue().node.pnpm
    }
    const flag = value.globalVirtualStore
    if (typeof flag === 'boolean') return { ...value, globalVirtualStore: flag }
    if (flag !== undefined)
      report(`${WorktreeSettings.sectionNameConst}.node.pnpm.globalVirtualStore is not a boolean `
        + `(${JSON.stringify(flag)}); installing with a plain pnpm install`)
    return { ...value, globalVirtualStore: false }
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }
}

/**
 * A project's OWN tier, the `setup` array of its `.worktree.json`. `setup: null` is a project that
 * declares nothing and is not the same answer as `setup: []`, which is a project saying out loud
 * that it needs nothing installed.
 *
 * A damaged file answers with its problem and never with a value: `WorktreeConfig.save` refuses to
 * write over a document it could not parse, so an editor that offered one would offer a write the
 * writer is going to refuse.
 */
export type ProjectSetupRead =
  | { ok: true; setup: string[] | null }
  | { ok: false; problem: string }

export type ProjectSetupWrite = { ok: true } | { ok: false; problem: string }
