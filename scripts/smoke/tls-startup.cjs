const tls = require('node:tls')
const { resolve } = require('node:path')
const { run } = require('./tls-runtime.cjs')

// Observe the real bundle's bootstrap without injecting a trust policy. Help-only entry points
// may exit while network probes are pending, so defer that exit until the probe has completed.
const [entry, output] = process.argv.slice(2)
if (!entry || !output) throw new Error('Usage: node tls-startup.cjs <bundle> <report.json>')
const originalSet = tls.setDefaultCACertificates
const originalExit = process.exit
let installed = false
tls.setDefaultCACertificates = certificates => {
  originalSet(certificates)
  installed = true
}
process.exit = () => {}
process.argv = [process.execPath, resolve(entry), '--help']
require(resolve(entry))
setImmediate(async () => {
  try {
    if (!installed) throw new Error(`TLS policy was not installed by ${entry}`)
    const report = await run({ output, entry: resolve(entry) })
    originalExit(report.passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    originalExit(2)
  }
})
