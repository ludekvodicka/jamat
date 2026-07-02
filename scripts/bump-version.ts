// Sets the root package.json "version" to the current date+time.
// Run via `npm run bump` after any code change (see CLAUDE.md → Versioning).
// Format: YYYY.MM.DD.HH.mm (no spaces, so npm tooling stays happy).
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const n = new Date()
const p = (x: number) => String(x).padStart(2, '0')
const version = `${n.getFullYear()}.${p(n.getMonth() + 1)}.${p(n.getDate())}.${p(n.getHours())}.${p(n.getMinutes())}`

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`version → ${version}`)
