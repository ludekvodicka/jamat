import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { prepareLauncher } from './prepare-launcher.js'

test('launcher preparation includes runtime, installer, documentation and licenses from paths with spaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jamat launcher package '))
  try {
    const platforms: Partial<Record<NodeJS.Platform, { directory: string; node: string }>> = {
      win32: { directory: 'win', node: 'node.exe' },
      darwin: { directory: 'mac', node: 'bin/node' },
      linux: { directory: 'linux', node: 'bin/node' },
    }
    const platform = platforms[process.platform]
    assert.ok(platform)
    const sidecar = `out/remarkable-sidecar/${platform.directory}-${process.arch}/current`
    const inputs = {
      'app-launcher/start.ts': "import { basename } from 'node:path'; console.log(basename('launcher-ready'))",
      'app-launcher/package.json': '{"name":"jamat-launcher","version":"1.1.0","type":"module"}',
      'app-launcher/README.md': 'launcher setup instructions',
      'scripts/setup/install-launcher.ps1': 'installer source',
      LICENSE: 'application license',
      'lib-orchestrator/node_modules/ws/LICENSE': 'ws copyright and permission notice',
      [`${sidecar}/${platform.node}`]: 'prepared plain Node runtime',
      [`${sidecar}/NODE-LICENSE.txt`]: 'Node license',
    }
    for (const [path, contents] of Object.entries(inputs)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), contents)
    }
    await prepareLauncher(root)
    const output = join(root, 'out/launcher')
    assert.deepEqual(readdirSync(output).sort(), [
      'LICENSE', 'NODE-LICENSE.txt', 'WS-LICENSE.txt', 'README.md', 'install-launcher.ps1', 'launcher.cjs',
      'package.json', platform.node.split('/')[0],
    ].sort())
    for (const [name, source] of Object.entries({
      'package.json': 'app-launcher/package.json', 'README.md': 'app-launcher/README.md',
      'install-launcher.ps1': 'scripts/setup/install-launcher.ps1', LICENSE: 'LICENSE',
      'WS-LICENSE.txt': 'lib-orchestrator/node_modules/ws/LICENSE',
      'NODE-LICENSE.txt': `${sidecar}/NODE-LICENSE.txt`, [platform.node]: `${sidecar}/${platform.node}`,
    }))
      assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(root, source)), name)
    const bundle = readFileSync(join(output, 'launcher.cjs'), 'utf8')
    assert.match(bundle, /launcher-ready/)
    assert.match(bundle, /require\("node:path"\)/)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
