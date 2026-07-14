// Smoke test: core/update — the channel resolver, the scheme-guarded comparator, the log store.
// Usage: node --import tsx scripts/smoke-update-core.ts
//
// The resolution matrix is the point: the channel must follow the RUNTIME, and a config carrying the
// dead `provider`/`vcs` keys must NOT be able to change it — `provider:'vcs'` on an installed build
// used to disable GitHub updates entirely (silently), which is the bug this file guards against.

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { resolveUpdateChannel } from '../core/update/update-channel.js'
import { compareVersions, isNewerVersion, parseVersion, readPackageVersion } from '../core/update/update-versions.js'
import { appendUpdateLog, readUpdateLogTail } from '../core/update/update-log-store.js'

let failed = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`)
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
function throws(name: string, fn: () => unknown): void {
  try { fn(); failed++; console.log(`  ✗ ${name} — did not throw`) }
  catch { console.log(`  ✓ ${name}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'jamat-smoke-update-'))
const base = { platform: 'win32' as NodeJS.Platform, monorepoRoot: 'C:/app/resources', selfUpdate: undefined }

console.log('\n=== Smoke: update core (channel resolution + versions + log store)\n')

try {
  console.log('[1] channel resolution follows the runtime')
  const installed = resolveUpdateChannel({ ...base, packaged: true, jamatRoot: undefined })
  check('installed win32 → github', installed.channel === 'github')
  check('resolution always carries a reason', installed.reason.length > 0)

  const mac = resolveUpdateChannel({ ...base, platform: 'darwin', packaged: true, jamatRoot: undefined })
  check('installed darwin → none (unsigned) with a reason', mac.channel === 'none' && mac.reason.length > 0)

  check('packaged repo-in-place (JAMAT_ROOT) → source',
    resolveUpdateChannel({ ...base, packaged: true, jamatRoot: 'Q:/AppJamat' }).channel === 'source')
  check('dev run → source',
    resolveUpdateChannel({ ...base, packaged: false, jamatRoot: undefined }).channel === 'source')

  console.log('\n[2] config cannot pick (or break) the channel')
  const legacy = resolveUpdateChannel({
    ...base, packaged: true, jamatRoot: undefined,
    selfUpdate: { provider: 'vcs', vcs: 'svn', repoPath: 'Q:/AppJamat' },
  })
  check('legacy {provider:vcs,vcs:svn} on installed → still github', legacy.channel === 'github')
  check('… and warns about every dead key',
    legacy.warnings.length === 3 && legacy.warnings.some((w) => w.includes('provider')),
    JSON.stringify(legacy.warnings))
  check('no selfUpdate → no warnings', installed.warnings.length === 0)

  console.log('\n[3] knobs')
  check('autoCheck defaults true', installed.autoCheck === true)
  const off = resolveUpdateChannel({ ...base, packaged: true, jamatRoot: undefined, selfUpdate: { autoCheck: false } })
  check('autoCheck:false does not change the channel', off.channel === 'github' && off.autoCheck === false)
  check('github default interval 120', installed.checkIntervalMinutes === 120)
  check('source default interval 15',
    resolveUpdateChannel({ ...base, packaged: false, jamatRoot: undefined }).checkIntervalMinutes === 15)
  check('config interval overrides the default',
    resolveUpdateChannel({ ...base, packaged: false, jamatRoot: undefined, selfUpdate: { checkIntervalMinutes: 5 } })
      .checkIntervalMinutes === 5)

  console.log('\n[4] versions — the scheme guard')
  check('datestamp classified', parseVersion('2026.07.14.12.50').scheme === 'datestamp')
  check('semver classified', parseVersion('0.2.0').scheme === 'semver')
  throws('datestamp vs semver compare throws (the "always newer" bug)',
    () => compareVersions(parseVersion('2026.07.14.12.50'), parseVersion('0.2.0')))
  check('datestamp ordering', isNewerVersion('2026.07.14.12.50', '2026.07.14.10.00'))
  check('datestamp equal → not newer', !isNewerVersion('2026.07.14.12.50', '2026.07.14.12.50'))
  check('semver ordering', isNewerVersion('0.2.0', '0.1.3'))
  check('semver ordering (patch)', isNewerVersion('0.1.10', '0.1.9'))
  throws('unparseable version throws', () => parseVersion('not-a-version'))

  console.log('\n[5] readPackageVersion')
  const pkg = join(tmp, 'package.json')
  writeFileSync(pkg, JSON.stringify({ version: '2026.07.14.12.50' }))
  check('reads the version', readPackageVersion(pkg) === '2026.07.14.12.50')
  check('missing file → null', readPackageVersion(join(tmp, 'nope.json')) === null)
  writeFileSync(join(tmp, 'broken.json'), '{ not json')
  check('corrupt file → null', readPackageVersion(join(tmp, 'broken.json')) === null)
  writeFileSync(join(tmp, 'noversion.json'), '{}')
  check('no version field → null', readPackageVersion(join(tmp, 'noversion.json')) === null)

  console.log('\n[6] update log store')
  const log = join(tmp, 'update-log.jsonl')
  check('missing log → empty tail', readUpdateLogTail(log).length === 0)
  appendUpdateLog(log, { event: 'boot-resolution', channel: 'source', reason: 'dev run', running: '2026.07.14.12.50' })
  appendUpdateLog(log, { event: 'prompt-suppressed', channel: 'github', reason: 'idle-gate: 2 busy tabs' })
  const tail = readUpdateLogTail(log)
  check('append + read round-trip', tail.length === 2 && tail[0].event === 'boot-resolution')
  check('entries are timestamped', typeof tail[0].ts === 'number' && tail[0].ts > 0)
  check('suppression reason survives', tail[1].reason === 'idle-gate: 2 busy tabs')
  check('maxEntries returns the NEWEST', readUpdateLogTail(log, 1)[0].event === 'prompt-suppressed')

  // Oversize: > 512 KB must shrink, keep whole lines, and stay parseable.
  for (let i = 0; i < 4000; i++)
    appendUpdateLog(log, { event: 'check', channel: 'github', detail: `x`.repeat(200), found: `0.0.${i}` })
  const trimmed = readUpdateLogTail(log, 10_000)
  check('oversize log trimmed', trimmed.length < 4002 && trimmed.length > 0, `kept ${trimmed.length}`)
  check('trimmed log keeps whole, parseable lines', trimmed.every((e) => typeof e.event === 'string'))
  check('newest entry survives the trim', trimmed[trimmed.length - 1].found === '0.0.3999')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n✓ PASS\n' : `\n✗ FAIL (${failed})\n`)
process.exit(failed === 0 ? 0 : 1)
