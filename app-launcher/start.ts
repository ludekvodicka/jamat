import { App } from './app/app'
import { NodeTlsTrust } from '../lib-orchestrator/shared/nodeTlsTrust'

NodeTlsTrust.install()
void App.run(process.argv.slice(2)).catch(() => {
  console.error('Jamat launcher could not start. Check its configuration and local log.')
  process.exitCode = 1
})
