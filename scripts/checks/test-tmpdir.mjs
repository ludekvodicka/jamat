// Every test runner imports this before any test code runs. When AX_TEST_TMPDIR names a test
// directory, os.tmpdir() of this process and of every child it starts resolves to its Jamat
// folder, so fixture writes leave the user TEMP. Without the variable nothing changes.
// AX_TEST_ORIGINAL_TMPDIR keeps the temp directory the redirect replaced, for the tests that need
// a drive other than the repository's; a nested runner keeps the first value.
// Contract and reasons: docs/architecture/test-tmpdir.md.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.env.AX_TEST_TMPDIR
if (root) {
  const folder = join(root, 'Jamat')
  mkdirSync(folder, { recursive: true })
  process.env.AX_TEST_ORIGINAL_TMPDIR ||= tmpdir()
  process.env.TEMP = folder
  process.env.TMP = folder
  process.env.TMPDIR = folder
}
