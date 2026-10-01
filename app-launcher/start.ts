import { App } from './app/app'

void App.run(process.argv.slice(2)).catch(() => {
  console.error('Jamat launcher could not start. Check its configuration and local log.')
  process.exitCode = 1
})
