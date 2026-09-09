import { AppClientCli } from './app/app'
import { CliProcess } from './app/cliProcess'

class AppClientCliEntry {
  static async run(): Promise<number> {
    CliProcess.installBrokenPipeHandlers()
    const abort = new AbortController()
    process.once('SIGINT', () => abort.abort())
    process.once('SIGTERM', () => abort.abort())
    return new AppClientCli(process.argv.slice(2), { signal: abort.signal }).run()
  }
}

process.exitCode = await AppClientCliEntry.run()
