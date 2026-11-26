import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { SvnProps } from './svnProps'

/**
 * Which unversioned names `svn status` leaves out: the runtime config's `global-ignores`,
 * `svn:ignore` of the parent directory and `svn:global-ignores` of it, its versioned ancestors and
 * what the working-copy root inherited. Matching is APR `fnmatch` without flags: case-sensitive,
 * `*` also matches a leading dot.
 */
export class SvnIgnoreRules {
  /** svn 1.14's built-in list, used when the runtime config does not set `global-ignores`. */
  static readonly defaultGlobalIgnoresConst = '*.o *.lo *.la *.al .libs *.so *.so.[0-9]* *.a *.pyc *.pyo __pycache__ *.rej *~ #*# .#* .*.swp .DS_Store [Tt]humbs.db'
  private static readonly configs = new Map<string, { stamp: string; rules: SvnIgnoreRules }>()
  private static readonly patterns = new Map<string, RegExp>()

  private readonly globalIgnores: readonly string[]

  constructor(globalIgnores: readonly string[]) {
    this.globalIgnores = globalIgnores
  }

  /** `<appData>/Subversion/config`, read again only when its time or size changed. */
  static fromRuntimeConfig(appData: string): SvnIgnoreRules {
    const file = join(appData, 'Subversion', 'config')
    let stamp = 'missing'
    try {
      const stats = statSync(file)
      stamp = `${stats.mtimeMs}:${stats.size}`
    }
    catch { /* no runtime config: the built-in list */ }
    const known = SvnIgnoreRules.configs.get(file)
    if (known?.stamp === stamp) return known.rules
    const value = stamp === 'missing' ? null : SvnIgnoreRules.globalIgnoresOf(readFileSync(file, 'utf8'))
    const rules = new SvnIgnoreRules(SvnIgnoreRules.split(value ?? SvnIgnoreRules.defaultGlobalIgnoresConst))
    SvnIgnoreRules.configs.set(file, { stamp, rules })
    return rules
  }

  /** `[miscellany] global-ignores` of an svn config file, with its continuation lines; null when it is not set. */
  static globalIgnoresOf(ini: string): string | null {
    let section = '', value: string | null = null, inValue = false
    for (const line of ini.split(/\r?\n/)) {
      if (inValue && /^[ \t]/.test(line) && line.trim().length > 0) {
        value = `${value} ${line.trim()}`
        continue
      }
      inValue = false
      if (line.startsWith('#') || line.trim().length === 0) continue
      const header = /^\[([^\]]*)\]/.exec(line)
      if (header !== null) {
        section = header[1]!.trim().toLowerCase()
        continue
      }
      const option = /^([^:=\s][^:=]*?)\s*[:=]\s*(.*)$/.exec(line)
      if (option === null || section !== 'miscellany' || option[1]!.toLowerCase() !== 'global-ignores') continue
      value = option[2]!.trim()
      inValue = true
    }
    return value
  }

  /** Whitespace-separated patterns, the way svn splits `global-ignores` and `svn:global-ignores`. */
  static split(value: string): string[] {
    return value.split(/[\s]+/).filter((pattern) => pattern.length > 0)
  }

  /** `segment` is the first unversioned name below the nearest versioned directory, whose properties are `parentProps`. */
  ignored(segment: string, parentProps: SvnProps, ancestorGlobalIgnores: readonly string[]): boolean {
    const local = (parentProps.get('svn:ignore') ?? '').split(/[\r\n]+/).filter((pattern) => pattern.length > 0)
    return [...this.globalIgnores, ...ancestorGlobalIgnores, ...local].some((pattern) => SvnIgnoreRules.matches(pattern, segment))
  }

  static matches(pattern: string, name: string): boolean {
    let regex = SvnIgnoreRules.patterns.get(pattern)
    if (regex === undefined) {
      regex = SvnIgnoreRules.regexOf(pattern)
      SvnIgnoreRules.patterns.set(pattern, regex)
    }
    return regex.test(name)
  }

  private static regexOf(pattern: string): RegExp {
    const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')
    let source = ''
    for (let at = 0; at < pattern.length; at++) {
      const char = pattern[at]!
      if (char === '*') source += '[\\s\\S]*'
      else if (char === '?') source += '[\\s\\S]'
      else if (char === '\\' && at + 1 < pattern.length) source += escape(pattern[++at]!)
      else if (char === '[') {
        const close = pattern.indexOf(']', at + 2)
        if (close === -1) {
          source += escape(char)
          continue
        }
        let body = pattern.slice(at + 1, close), negate = false
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = true
          body = body.slice(1)
        }
        source += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
        at = close
      }
      else source += escape(char)
    }
    return new RegExp(`^${source}$`)
  }
}
