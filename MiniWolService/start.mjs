import { readFileSync } from 'node:fs'
import { createWolServer, parseConfig } from './server.mjs'

const source = process.env.JAMAT_V3_WOL_CONFIG ?? readFileSync(process.argv[2] ?? 'config.json', 'utf8')
const config = parseConfig(source)
const url = new URL(config.publicUrl)
const server = createWolServer(config, process.env.JAMAT_V3_WOL_BUILD_TIME)
server.listen(Number(url.port || 80), url.hostname, () => console.log(`MiniWolService: ${url.origin}`))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.close())
