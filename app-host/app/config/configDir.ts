import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export class ConfigDir {
  /** Separate from V2's `.jamat` on purpose: one config directory belongs to one generation. */
  private static readonly defaultNameConst = '.jamat-v3'

  /** Resolve the portable config directory: explicit (`--config-dir` / env) wins, else the default. */
  static resolve(explicit?: string | null): string {
    const trimmed = explicit?.trim()
    if (trimmed) return resolve(trimmed)
    return join(homedir(), ConfigDir.defaultNameConst)
  }

  static defaultName(): string {
    return ConfigDir.defaultNameConst
  }
}
