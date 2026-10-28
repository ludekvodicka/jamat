import { AppClientCli } from './app/app'
import { CliProcess } from './app/cliProcess'
import { NodeTlsTrust } from '../lib-orchestrator/shared/nodeTlsTrust'

class AppClientCliEntry {
  static async run(): Promise<number> {
    CliProcess.installBrokenPipeHandlers()
    NodeTlsTrust.install()
    const abort = new AbortController()
    process.once('SIGINT', () => abort.abort())
    process.once('SIGTERM', () => abort.abort())
    return new AppClientCli(process.argv.slice(2), { signal: abort.signal }).run()
  }
}

void AppClientCliEntry.run().then(code => { process.exitCode = code })
