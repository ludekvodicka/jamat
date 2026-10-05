import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { prepareSkills } from './prepare-skills.js'

test('distributed skills run outside the checkout with no tsx or node_modules', async () => {
  const root = resolve(import.meta.dirname, '../..')
  const output = mkdtempSync(join(tmpdir(), 'jamat skills package '))
  try {
    await prepareSkills(root, output)
    for (const agent of ['claude', 'codex']) {
      const cli = spawnSync(process.execPath, [join(output, 'skills', agent, 'appjamat-v3/scripts/jamat-v3.mjs'), '--help'],
        { encoding: 'utf8', windowsHide: true, cwd: output })
      assert.equal(cli.status, 2, cli.stderr + cli.stdout)
      assert.equal(JSON.parse(cli.stdout).error.detail, 'Unknown argument --help')
      const helper = spawnSync(process.execPath, [join(output, 'skills', agent,
        'session-automation-groups/scripts/session-automation-groups.mjs'), 'describe', '--state', 'completed'],
      { encoding: 'utf8', windowsHide: true, cwd: output })
      assert.equal(helper.status, 0, helper.stderr)
      assert.deepEqual(JSON.parse(helper.stdout), { ok: true, value: { group: 'completed', color: 'green' } })
    }
  } finally { rmSync(output, { recursive: true, force: true }) }
})
