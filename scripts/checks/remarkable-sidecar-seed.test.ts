import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { RemarkableSidecarManifest } from '../../app-client-ui/app/remarkable/sidecar/remarkableSidecarManifest.js'
import { RemarkableSidecarSource } from '../../app-client-ui/app/remarkable/sidecar/remarkableSidecarSource.js'

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
