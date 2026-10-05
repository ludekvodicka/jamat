import { readFileSync } from 'node:fs'
import { App } from './app/app'

async function main(): Promise<void> {
  const app = new App(App.launchOf(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
  // Ctrl+C belongs to the native terminal, including its normal interrupt/exit distinction.
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => app.stop(1))
  process.exitCode = await app.run()
}

void main().catch(error => {
  console.error(`Jamat Codex bridge: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
