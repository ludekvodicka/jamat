import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { PathExtractors } from './pathExtractors'
import { TerminalPathExtractor, type PathCandidate } from './terminalPathExtractor'

describe('lib-orchestrator/terminalDetector/extract/terminalPathExtractor', () => {
  const projectDir = 'Q:\\Proj'
  const base = PathExtractors.of(null)
  const codex = PathExtractors.of('codex')

  function directOf(candidates: readonly PathCandidate[]): string | null {
    const hit = candidates.find((candidate) => candidate.kind === 'direct')
    return hit?.kind === 'direct' ? hit.path : null
  }

  function searchOf(candidates: readonly PathCandidate[]): string | null {
    const hit = candidates.find((candidate) => candidate.kind === 'search')
    return hit?.kind === 'search' ? hit.partial : null
  }

  function lineOf(candidates: readonly PathCandidate[], kind: 'direct' | 'search'): number | null | undefined {
    return candidates.find((candidate) => candidate.kind === kind)?.line
  }

  describe('registry', () => {
    it('gives a shell session and Claude the base extractor', () => {
      expect(PathExtractors.of(null)).to.equal(PathExtractors.of('claude'))
    })

    it('gives Codex its own extractor', () => {
      expect(PathExtractors.of('codex')).to.not.equal(base)
    })

    it('throws on an unknown agent id', () => {
      expect(() => PathExtractors.of('gpt' as 'claude')).to.throw('Unknown agent id')
    })
  })

  describe('direct candidates', () => {
    it('keeps a drive-absolute path', () => {
      expect(directOf(base.resolve('C:\\foo\\bar.ts', { projectDir }))).to.equal('C:\\foo\\bar.ts')
    })

    it('normalises forward slashes to backslashes', () => {
      expect(directOf(base.resolve('C:/foo/bar.ts', { projectDir }))).to.equal('C:\\foo\\bar.ts')
    })

    it('turns a slash-prefixed Windows Markdown link target into a drive-absolute path', () => {
      const token = '/C:/Projects/NodeJs/AppBackendV2/.aidocs/research.md'
      expect(directOf(base.resolve(token, { projectDir })))
        .to.equal('C:\\Projects\\NodeJs\\AppBackendV2\\.aidocs\\research.md')
    })

    it('expands ~ to the home directory', () => {
      expect(directOf(base.resolve('~/notes.md', { projectDir }))).to.equal(`${homedir()}\\notes.md`)
    })

    it('expands a bare ~', () => {
      expect(directOf(base.resolve('~', { projectDir }))).to.equal(homedir())
    })

    it('keeps a UNC path', () => {
      expect(directOf(base.resolve('\\\\server\\share\\x.txt', { projectDir: null })))
        .to.equal('\\\\server\\share\\x.txt')
    })

    it('joins a relative token under the project directory', () => {
      expect(directOf(base.resolve('src/foo.ts', { projectDir }))).to.equal('Q:\\Proj\\src\\foo.ts')
    })

    it('has no direct candidate for a relative token without a project directory', () => {
      expect(directOf(base.resolve('src/foo.ts', { projectDir: null }))).to.equal(null)
    })

    it('strips a trailing :line:col', () => {
      expect(directOf(base.resolve('C:\\foo\\bar.ts:12:5', { projectDir }))).to.equal('C:\\foo\\bar.ts')
    })

    it('strips surrounding quotes', () => {
      expect(directOf(base.resolve('"C:\\a\\b.ts"', { projectDir }))).to.equal('C:\\a\\b.ts')
    })
  })

  describe('file:// URIs', () => {
    it('turns a drive URI into a native path and decodes escapes', () => {
      expect(directOf(base.resolve('file:///C:/a%20b.md', { projectDir }))).to.equal('C:\\a b.md')
    })

    it('turns an authority URI into a UNC path', () => {
      expect(directOf(base.resolve('file://host/share/x.txt', { projectDir })))
        .to.equal('\\\\host\\share\\x.txt')
    })

    it('keeps a line reference after the URI', () => {
      const candidates = base.resolve('file:///C:/a%20b.md:42', { projectDir })
      expect(directOf(candidates)).to.equal('C:\\a b.md')
      expect(lineOf(candidates, 'direct')).to.equal(42)
    })

    it('leaves a malformed escape alone instead of throwing', () => {
      expect(directOf(base.resolve('file:///C:/a%zz.md', { projectDir }))).to.equal('C:\\a%zz.md')
    })

    it('passes a non-file URI through untouched', () => {
      expect(base.parse('https://example.com/a.md').path).to.equal('https://example.com/a.md')
    })
  })

  describe('parse', () => {
    it('keeps a bare path', () => {
      expect(base.parse('C:\\foo\\bar.ts').line).to.equal(null)
    })

    it('splits a line reference', () => {
      expect(base.parse('foo.md:2188')).to.deep.equal({ path: 'foo.md', line: 2188, column: null })
    })

    it('splits a line and column reference', () => {
      expect(base.parse('C:\\foo\\bar.ts:12:5'))
        .to.deep.equal({ path: 'C:\\foo\\bar.ts', line: 12, column: 5 })
    })

    it('handles a reference that ends a sentence', () => {
      const reference = base.parse('foo.md:2188.')
      expect(reference.path).to.equal('foo.md')
      expect(reference.line).to.equal(2188)
    })

    it('does not read a bare drive letter as a line reference', () => {
      expect(base.parse('C:12').path).to.equal('C:12')
    })

    it('strips quotes around a token carrying a reference', () => {
      expect(base.parse('"src/a.ts:7"').path).to.equal('src/a.ts')
    })

    it('keeps an apostrophe that belongs to the name', () => {
      expect(base.parse("C:\\Users\\bob's docs\\a.ts").path).to.equal("C:\\Users\\bob's docs\\a.ts")
    })
  })

  describe('truncated names', () => {
    it('emits a search candidate that keeps the ellipsis', () => {
      expect(searchOf(base.resolve('2026-07-10-001-…-plan.md', { projectDir })))
        .to.equal('2026-07-10-001-…-plan.md')
    })

    it('lets a search candidate inherit the line of its token', () => {
      const candidates = base.resolve('2026-07-10-001-…-plan.md:42', { projectDir })
      expect(lineOf(candidates, 'search')).to.equal(42)
      expect(searchOf(candidates)).to.equal('2026-07-10-001-…-plan.md')
    })
  })

  describe('suffix matcher', () => {
    const planFile = ['.aidocs', 'plans', '2026-07-10-001-refactor-universal-agent-codex-plan.md']

    it('matches a truncated plan file through an ellipsis pattern', () => {
      expect(TerminalPathExtractor.matchesSuffix(planFile, ['2026-07-10-001-…-plan.md'])).to.equal(true)
    })

    it('rejects a file the ellipsis pattern does not cover', () => {
      expect(TerminalPathExtractor.matchesSuffix(['x', '2026-07-11-999-other-doc.md'],
        ['2026-07-10-001-…-plan.md'])).to.equal(false)
    })

    it('treats a literal ... as a wildcard', () => {
      expect(TerminalPathExtractor.segTester('2026-...-plan.md')('2026-abc-plan.md')).to.equal(true)
    })

    it('treats * as a wildcard', () => {
      expect(TerminalPathExtractor.segTester('foo*bar')('fooXYZbar')).to.equal(true)
      expect(TerminalPathExtractor.segTester('foo*bar')('fooXYZbaz')).to.equal(false)
    })

    it('compares a plain segment exactly', () => {
      expect(TerminalPathExtractor.segTester('c.ts')('c.ts')).to.equal(true)
      expect(TerminalPathExtractor.segTester('c.ts')('x.ts')).to.equal(false)
    })

    it('matches a multi-segment suffix and rejects a wrong parent', () => {
      expect(TerminalPathExtractor.matchesSuffix(['proj', 'src', 'foo.ts'], ['src', 'foo.ts'])).to.equal(true)
      expect(TerminalPathExtractor.matchesSuffix(['proj', 'lib', 'foo.ts'], ['src', 'foo.ts'])).to.equal(false)
    })

    it('rejects a pattern longer than the file path', () => {
      expect(TerminalPathExtractor.matchesSuffix(['foo.ts'], ['src', 'foo.ts'])).to.equal(false)
    })

    it('matches wildcards that have to overlap', () => {
      expect(TerminalPathExtractor.segTester('a*a')('aa')).to.equal(true)
      expect(TerminalPathExtractor.segTester('a*a')('a')).to.equal(false)
    })

    it('matches a leading and a trailing wildcard', () => {
      expect(TerminalPathExtractor.segTester('*bar')('foobar')).to.equal(true)
      expect(TerminalPathExtractor.segTester('foo*')('foobar')).to.equal(true)
      expect(TerminalPathExtractor.segTester('*bar')('barfoo')).to.equal(false)
    })

    it('answers a pattern of many wildcards without hanging', () => {
      // The regex this replaced took 160 seconds on one call at this size, on the main process.
      const pattern = `${'*'.repeat(22)}x.md`
      const name = '2026-08-17-006e-feat-terminal-context-menu-plan.md'
      const started = process.hrtime.bigint()

      expect(TerminalPathExtractor.segTester(pattern)(name)).to.equal(false)

      expect(Number(process.hrtime.bigint() - started) / 1e6).to.be.lessThan(50)
    })
  })

  describe('looksSearchable gate', () => {
    it('accepts a truncated dotted name and a dotted relative path', () => {
      expect(TerminalPathExtractor.looksSearchable('2026-07-10-001-…-plan.md')).to.equal(true)
      expect(TerminalPathExtractor.looksSearchable('src/foo.ts')).to.equal(true)
    })

    it('rejects a bare word and a lone ellipsis', () => {
      expect(TerminalPathExtractor.looksSearchable('README')).to.equal(false)
      expect(TerminalPathExtractor.looksSearchable('…')).to.equal(false)
    })

    it('rejects a name elided so often it would match half the tree', () => {
      expect(TerminalPathExtractor.looksSearchable('a…b…c…d…e.md')).to.equal(true)
      expect(TerminalPathExtractor.looksSearchable('a…b…c…d…e…f.md')).to.equal(false)
      expect(TerminalPathExtractor.looksSearchable(`${'*'.repeat(22)}x.md`)).to.equal(false)
    })
  })

  describe('codex driveless rewrite', () => {
    const rollout = '\\Users\\jane.doe\\.codex\\sessions\\2026\\04\\24\\rollout-2026-04-24T08-43-47.jsonl'
    const rewritten = `${homedir()}\\.codex\\sessions\\2026\\04\\24\\rollout-2026-04-24T08-43-47.jsonl`

    it('rewrites a driveless rollout path to a single home-rooted candidate', () => {
      const candidates = codex.resolve(rollout, { projectDir: null })
      expect(candidates).to.have.length(1)
      expect(directOf(candidates)).to.equal(rewritten)
    })

    it('rewrites the forward-slashed spelling too', () => {
      expect(directOf(codex.resolve(rollout.replace(/\\/g, '/'), { projectDir: null }))).to.equal(rewritten)
    })

    it('keeps the line reference through the rewrite', () => {
      const candidates = codex.resolve(`${rollout}:99`, { projectDir: null })
      expect(directOf(candidates)).to.equal(rewritten)
      expect(lineOf(candidates, 'direct')).to.equal(99)
    })

    it('leaves a drive-absolute .codex path to the base', () => {
      expect(directOf(codex.resolve('C:\\Users\\x\\.codex\\sessions\\a\\rollout-y.jsonl', { projectDir: null })))
        .to.equal('C:\\Users\\x\\.codex\\sessions\\a\\rollout-y.jsonl')
    })

    it('passes a driveless path outside .codex through to the base', () => {
      expect(directOf(codex.resolve('\\Foo\\bar.txt', { projectDir: null }))).to.equal('\\Foo\\bar.txt')
    })

    it('is the per-agent difference: the base does not rewrite it', () => {
      expect(directOf(base.resolve(rollout, { projectDir: null }))).to.equal(rollout)
    })
  })
})
