import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalPackageInputs } from './localPackageInputs'

export function clientBuildInfo(root: string): { version: string; inputHash: string; builtAt: string } {
  const pkg = JSON.parse(readFileSync(join(root, 'app-client-ui/package.json'), 'utf8')) as { version: string }
  return { version: pkg.version, inputHash: LocalPackageInputs.read(root).hash, builtAt: new Date().toISOString() }
}
