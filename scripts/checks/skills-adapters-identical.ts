/**
 * The Claude and Codex adapters for the `appjamat-v3` skill each carry their own copy of the
 * reference and the CLI wrapper, because an agent reaches a skill through a junction to ONE
 * directory and cannot follow a path out of it. Two copies is the price; this gate is what keeps
 * them from drifting, the same bargain `shared/errorText` takes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

class SkillsAdaptersIdentical {
  private static readonly repositoryRootConst =
    join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  private static readonly skillConst = 'appjamat-v3'
  private static readonly agentsConst = ['claude', 'codex'] as const
  /** Everything that is duplicated. A file only one adapter needs does not belong on this list. */
  private static readonly sharedFilesConst = ['REFERENCE.md', 'scripts/jamat-v3.mjs'] as const

  static findings(): string[] {
    const findings: string[] = []
    for (const file of SkillsAdaptersIdentical.sharedFilesConst) {
      const paths = SkillsAdaptersIdentical.agentsConst
        .map(agent => SkillsAdaptersIdentical.pathOf(agent, file))
      const missing = paths.filter(path => !existsSync(path))
      if (missing.length > 0) {
        findings.push(`${file}: missing in ${missing.join(', ')}`)
        continue
      }
      const [claude, codex] = paths.map(path => readFileSync(path))
      if (claude === undefined || codex === undefined || !claude.equals(codex))
        findings.push(`${file}: the claude and codex copies differ`)
    }
    return findings
  }

  private static pathOf(agent: string, file: string): string {
    return join(
      SkillsAdaptersIdentical.repositoryRootConst,
      'skills',
      agent,
      SkillsAdaptersIdentical.skillConst,
      ...file.split('/'),
    )
  }

  static run(): number {
    const findings = SkillsAdaptersIdentical.findings()
    if (findings.length === 0) {
      console.log(`[skills] ${SkillsAdaptersIdentical.skillConst}: both adapters carry the same `
        + `${SkillsAdaptersIdentical.sharedFilesConst.length} files`)
      return 0
    }
    console.error('[skills] the two adapter copies are not identical:')
    for (const finding of findings) console.error(`   - ${finding}`)
    console.error('Edit one copy and copy it over the other; both ship, and an agent reads only '
      + 'the one its own junction points at.')
    return 1
  }
}

process.exitCode = SkillsAdaptersIdentical.run()
