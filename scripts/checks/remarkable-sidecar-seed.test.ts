import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test } from 'node:test'

// app-client-ui is CommonJS under tsx, and Node 22 finds no named exports in its transpiled modules.
const requireUi = createRequire(import.meta.url)
const { RemarkableSidecarManifest } = requireUi('../../app-client-ui/app/remarkable/sidecar/remarkableSidecarManifest.ts') as typeof import('../../app-client-ui/app/remarkable/sidecar/remarkableSidecarManifest.js')
const { RemarkableSidecarSource } = requireUi('../../app-client-ui/app/remarkable/sidecar/remarkableSidecarSource.ts') as typeof import('../../app-client-ui/app/remarkable/sidecar/remarkableSidecarSource.js')

const repositoryRoot = resolve(import.meta.dirname, '..', '..')
const seed = RemarkableSidecarSource.resolve(false, repositoryRoot, '')
const runtimePlatform = `${process.platform}-${process.arch}`

test('the application accepts the real prepared seed manifest', () => {
  const text = readFileSync(resolve(seed, 'manifest.json'), 'utf8')
  const manifest = RemarkableSidecarManifest.parse(text, runtimePlatform)
  assert.equal(manifest.cli.entry, 'start.cjs')
  assert.ok(readFileSync(resolve(seed, manifest.cli.entry)).length > 0)
})

for (const changed of [{ version: '0.0.0' }, { archiveSha256: '0'.repeat(64) }])
  test(`the application rejects a prepared seed with a mismatched ${Object.keys(changed)[0]}`, () => {
    const manifest = RemarkableSidecarManifest.parse(
      readFileSync(resolve(seed, 'manifest.json'), 'utf8'),
      runtimePlatform,
    )
    assert.throws(() => RemarkableSidecarManifest.parse(JSON.stringify({
      ...manifest,
      node: { ...manifest.node, ...changed },
    }), runtimePlatform), /Node fields are invalid/)
  })
