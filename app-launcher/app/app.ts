import { AppConfig } from './appConfig'
import { AppContext } from './appContext'
import { AppHub } from './appHub'

export class App {
  static async run(args: string[]): Promise<void> {
    if (args.length === 2 && args[0] === '--check') {
      AppConfig.read(args[1]!)
      console.log('Launcher configuration matches the existing profile.')
      return
    }
    if (args.length !== 1) throw new Error('Usage: launcher <config.json>')
    const config = AppConfig.read(args[0]!)
    const context = new AppContext(config.logFile)
    const hub = new AppHub(config, context)
    await new Promise<void>((resolve, reject) => {
      hub.listener.server.once('error', reject)
      hub.listener.server.listen(Number(config.publicUrl.port || 80), config.publicUrl.hostname, resolve)
    })
    context.log('Launcher listening')
    const stop = (): void => { hub.listener.server.close(() => process.exit(0)) }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  }
}
