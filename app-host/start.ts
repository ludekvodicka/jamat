import { AppHost } from './app/app.js'
import { AppConfig } from './app/appConfig.js'

void AppHost.run(AppConfig.load()).catch((error) => {
  console.error(`[app-host] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
