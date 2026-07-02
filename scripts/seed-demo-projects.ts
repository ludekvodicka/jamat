/**
 * Scaffolds the demo project tree under Q:\Demo so the project selector and an opened
 * Claude tab look like real work. Idempotent — re-running refreshes files in place and
 * never deletes anything you added. Pure filesystem; touches no real project and no
 * Claude data.
 *
 *   npm run demo:projects
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStatsPath, loadStats, saveStats } from '../core/menu-core/stats.js'
import { DEMO_ROOT, DEMO_CONFIG_DIR, DEMO_CATEGORIES, type Stack, type DemoProject } from './demo-manifest.js'

function write(path: string, content: string) {
  writeFileSync(path, content.replace(/\n+$/, '') + '\n')
}

function gitignore(): string {
  return ['node_modules/', 'dist/', '.next/', '__pycache__/', '*.log', '.env'].join('\n')
}

function scaffoldWeb(dir: string, p: DemoProject) {
  mkdirSync(join(dir, 'src', 'app'), { recursive: true })
  mkdirSync(join(dir, 'src', 'components'), { recursive: true })
  write(join(dir, 'package.json'), JSON.stringify({
    name: p.name.toLowerCase(),
    version: '0.3.0',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
    dependencies: { next: '15.1.0', react: '19.0.0', 'react-dom': '19.0.0' },
    devDependencies: { typescript: '^5.7.0', '@types/react': '^19.0.0' },
  }, null, 2))
  write(join(dir, 'README.md'),
`# ${p.name}

${p.desc}

A Next.js 15 + React 19 application (App Router, TypeScript).

## Getting started

\`\`\`bash
npm install
npm run dev
\`\`\`

Open http://localhost:3000 to view it.

## Structure

- \`src/app\` — routes and layouts
- \`src/components\` — shared UI components
`)
  write(join(dir, 'next.config.js'), `/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true }`)
  write(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['dom', 'es2022'], jsx: 'preserve', strict: true, moduleResolution: 'bundler', module: 'esnext', noEmit: true },
    include: ['src'],
  }, null, 2))
  write(join(dir, 'src', 'app', 'layout.tsx'),
`export const metadata = { title: '${p.name}', description: ${JSON.stringify(p.desc)} }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`)
  write(join(dir, 'src', 'app', 'page.tsx'),
`import { Hero } from '../components/Hero'

export default function Home() {
  return (
    <main>
      <Hero title="${p.name}" subtitle=${JSON.stringify(p.desc)} />
    </main>
  )
}
`)
  write(join(dir, 'src', 'components', 'Hero.tsx'),
`export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="hero">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </section>
  )
}
`)
}

function scaffoldBackend(dir: string, p: DemoProject) {
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true })
  write(join(dir, 'package.json'), JSON.stringify({
    name: p.name.toLowerCase(),
    version: '1.2.0',
    private: true,
    type: 'module',
    scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js', test: 'vitest' },
    dependencies: { express: '^4.21.0', zod: '^3.24.0', pino: '^9.5.0' },
    devDependencies: { typescript: '^5.7.0', tsx: '^4.19.0', '@types/express': '^4.17.0' },
  }, null, 2))
  write(join(dir, 'README.md'),
`# ${p.name}

${p.desc}

Node.js + Express service written in TypeScript.

## Run

\`\`\`bash
npm install
npm run dev   # http://localhost:4000
\`\`\`

## Endpoints

- \`GET  /health\` — liveness probe
- \`POST /v1/...\`  — see \`src/routes\`
`)
  write(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', strict: true, esModuleInterop: true },
    include: ['src'],
  }, null, 2))
  write(join(dir, 'src', 'index.ts'),
`import express from 'express'
import { health } from './routes/health.js'

const app = express()
app.use(express.json())
app.use('/health', health)

const port = Number(process.env.PORT ?? 4000)
app.listen(port, () => console.log('${p.name} listening on :' + port))
`)
  write(join(dir, 'src', 'routes', 'health.ts'),
`import { Router } from 'express'

export const health = Router()
health.get('/', (_req, res) => res.json({ status: 'ok', service: '${p.name}' }))
`)
}

function scaffoldAi(dir: string, p: DemoProject) {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  write(join(dir, 'pyproject.toml'),
`[project]
name = "${p.name.toLowerCase()}"
version = "0.4.0"
description = ${JSON.stringify(p.desc)}
requires-python = ">=3.11"
dependencies = ["anthropic>=0.40", "pydantic>=2.9", "httpx>=0.27"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`)
  write(join(dir, 'README.md'),
`# ${p.name}

${p.desc}

Python 3.11+ project using the Anthropic SDK.

## Setup

\`\`\`bash
python -m venv .venv && . .venv/bin/activate
pip install -e .
python -m src.main
\`\`\`
`)
  write(join(dir, 'requirements.txt'), 'anthropic>=0.40\npydantic>=2.9\nhttpx>=0.27')
  write(join(dir, 'src', '__init__.py'), '')
  write(join(dir, 'src', 'main.py'),
`"""Entry point for ${p.name}."""
from .pipeline import run


def main() -> None:
    result = run(prompt="Hello from ${p.name}")
    print(result)


if __name__ == "__main__":
    main()
`)
  write(join(dir, 'src', 'pipeline.py'),
`"""${p.desc}"""
from dataclasses import dataclass


@dataclass
class Result:
    prompt: str
    answer: str


def run(prompt: str) -> Result:
    # Placeholder pipeline — wired to the Anthropic SDK in the real project.
    return Result(prompt=prompt, answer="(demo response)")
`)
  write(join(dir, 'tests', 'test_pipeline.py'),
`from src.pipeline import run


def test_run_returns_result():
    r = run("ping")
    assert r.prompt == "ping"
    assert r.answer
`)
}

function scaffold(stack: Stack, dir: string, p: DemoProject) {
  if (stack === 'web') return scaffoldWeb(dir, p)
  if (stack === 'backend') return scaffoldBackend(dir, p)
  return scaffoldAi(dir, p)
}

/**
 * Seed the menu launch-stats (usage-stats.json) so the project selector shows the
 * "N× | <relative date>" suffix on each demo project. Written into the demo profile's OWN
 * config-dir (DEMO_CONFIG_DIR/usage-stats.json) — the file the demo Electron instance reads —
 * so it never touches a real profile. Values are deterministic by index → stable across reruns.
 * Remove them anytime with `npm run demo:projects -- --clean-stats`.
 */
function seedMenuStats(clean: boolean) {
  const file = getStatsPath(DEMO_CONFIG_DIR)
  const stats = loadStats(file)
  const now = Date.now()
  let idx = 0
  let touched = 0
  for (const cat of DEMO_CATEGORIES) {
    for (const p of cat.projects) {
      const key = `${cat.label}:${p.name}`
      if (clean) {
        if (key in stats) { delete stats[key]; touched++ }
      } else {
        const count = 4 + ((idx * 9 + 3) % 52)            // 4..55 launches, varied
        const hoursAgo = (idx * 11 + 1) % 216             // up to ~9 days ago
        stats[key] = { count, lastUsed: new Date(now - hoursAgo * 3_600_000).toISOString() }
        touched++
      }
      idx++
    }
  }
  saveStats(file, stats)
  console.log(`${clean ? 'Removed' : 'Seeded'} menu launch-stats for ${touched} demo projects → ${file}`)
}

function main() {
  const cleanStats = process.argv.includes('--clean-stats')
  if (cleanStats) { seedMenuStats(true); return }

  let created = 0
  for (const cat of DEMO_CATEGORIES) {
    const catDir = join(DEMO_ROOT, cat.label)
    mkdirSync(catDir, { recursive: true })
    for (const p of cat.projects) {
      const dir = join(catDir, p.name)
      const fresh = !existsSync(dir)
      mkdirSync(dir, { recursive: true })
      write(join(dir, '.gitignore'), gitignore())
      scaffold(cat.stack, dir, p)
      if (fresh) created++
      console.log(`  ${fresh ? '+' : '·'} ${cat.label}\\${p.name}`)
    }
  }
  console.log(`\nDemo tree ready at ${DEMO_ROOT} (${created} new, ${DEMO_CATEGORIES.reduce((n, c) => n + c.projects.length, 0)} total).`)
  seedMenuStats(false)
}

main()
