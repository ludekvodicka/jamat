import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SvnExternalDefinitions as Definitions } from './svnExternalDefinitions'

describe('SVN external definitions', () => {
  it('decodes SVN numeric XML entities in CRLF properties and preserves literal entity text', () => {
    const root = resolve('carrier')
    const properties = Definitions.properties('<properties><target path="."><property name="svn:externals">^/lib library&#13;\n^/other literal&amp;#13;&#13;\n</property></target></properties>', root)
    expect(Definitions.parse(root, properties[root]).map((row) => row.path)).toEqual([resolve(root, 'library'), resolve(root, 'literal&#13;')])
  })
  it.each([
    ['-r 12 ^/library@9 "my library"', '^/library@9', 'my library', '12'],
    ['"my library" -r12 https://svn.test/library', 'https://svn.test/library', 'my library', '12'],
    ['../library my\\ library', '../library', 'my library', undefined],
    ['https://svn.test/library@9 library', 'https://svn.test/library@9', 'library', undefined],
    ['-r{2026-10-18} ^/library library', '^/library', 'library', '{2026-10-18}'],
  ])('reads %s', (line, url, directory, revision) => {
    const carrier = resolve('carrier')
    expect(Definitions.parse(carrier, line)).toEqual([{ carrier, path: resolve(carrier, directory!), url, revision }])
  })

  it.each(['../outside https://svn.test/library', 'https://svn.test/library /absolute',
    '^/library "unclosed', '^/library same extra', '-r1 -r2 ^/library same', '^/library .', '^/library nested/../outside'])('refuses unsafe or ambiguous definitions: %s', (line) => {
    expect(() => Definitions.parse(resolve('carrier'), line)).toThrow()
  })

  it.each([
    ['^/../shared/lib@12', 'https://svn.test/svn/shared/lib@12'],
    ['../shared', 'https://svn.test/svn/app/trunk/shared'],
    ['/svn/shared', 'https://svn.test/svn/shared'],
    ['//else.test/svn/lib', 'https://else.test/svn/lib'],
  ])('resolves %s against the property carrier', (url, expected) => {
    expect(Definitions.url(url, 'https://svn.test/svn/app/trunk/modules', 'https://svn.test/svn/app')).toBe(expected)
  })

  it('does not treat an at sign inside a URL path as a peg revision', () => {
    expect(Definitions.peg('https://svn.test/@12/lib')).toBeUndefined()
    expect(Definitions.peg('https://svn.test/lib@12')).toBe('12')
    expect(Definitions.peg('https://svn.test/lib@')).toBeUndefined()
  })

  it('preserves a date pin after relative URL resolution encodes its braces', () => {
    const url = Definitions.url('^/library@{2026-10-18T09:00:00Z}', 'https://svn.test/app', 'https://svn.test')
    expect(Definitions.peg(url)).toBe('{2026-10-18T09:00:00Z}')
    expect(Definitions.peg('https://svn.test/lib@invalid%')).toBeUndefined()
  })
})
