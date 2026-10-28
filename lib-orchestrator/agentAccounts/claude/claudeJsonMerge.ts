import { AccountProblem } from '../accountProblem'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AtomicJsonFile } from '../../shared/atomicJsonFile'
import { ErrnoCode } from '../../shared/errnoCode'
import { JsonShape } from '../../shared/jsonShape'

const onboardingKeys = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'installMethod', 'autoUpdates', 'mcpServers']
const projectKeys = ['hasTrustDialogAccepted', 'allowedTools', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpServers']

function readObject(file: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) {
    if (ErrnoCode.of(error) === 'ENOENT') return {}
    throw new AccountProblem(`Claude settings could not be read: ${file}`, { cause: error })
  }
  if (!JsonShape.isRecord(value)) throw new AccountProblem(`Claude settings must be an object: ${file}`)
  return value
}

export function mergeClaudeJson(profileHome: string, mainJsonPath: string): void {
  const file = join(profileHome, '.claude.json')
  try {
    if (lstatSync(file).isSymbolicLink()) throw new AccountProblem('Account .claude.json must not be a link')
  } catch (error) { if (ErrnoCode.of(error) !== 'ENOENT') throw error }
  const main = readObject(mainJsonPath)
  const account = readObject(file)
  const merged = { ...account }
  for (const key of onboardingKeys)
    if (Object.hasOwn(main, key)) merged[key] = main[key]
  if (JsonShape.isRecord(main.projects)) {
    const projects = { ...JsonShape.record(account.projects) }
    for (const [path, source] of Object.entries(main.projects)) {
      if (!JsonShape.isRecord(source)) continue
      const target = { ...JsonShape.record(projects[path]) }
      for (const key of projectKeys)
        if (Object.hasOwn(source, key)) target[key] = source[key]
      projects[path] = target
    }
    merged.projects = projects
  }
  AtomicJsonFile.write(file, merged)
}
