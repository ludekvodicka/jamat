import { describe, expect, it } from 'vitest'

import { UrlDetector } from './urlDetector'

describe('lib-orchestrator/terminalDetector/detect/urlDetector', () => {
  it('finds a URL in the middle of a sentence', () => {
    expect(UrlDetector.find('see https://example.com/a/b for details'))
      .to.deep.equal(['https://example.com/a/b'])
  })

  it('leaves the sentence punctuation out of the URL', () => {
    expect(UrlDetector.find('open https://example.com/a.')).to.deep.equal(['https://example.com/a'])
    expect(UrlDetector.find('(https://example.com/a)')).to.deep.equal(['https://example.com/a'])
  })

  it('keeps a path that legitimately ends in a slash or a query', () => {
    expect(UrlDetector.find('https://example.com/a/?q=1&r=2'))
      .to.deep.equal(['https://example.com/a/?q=1&r=2'])
  })

  it('takes http as well as https', () => {
    expect(UrlDetector.find('http://localhost:8080/x')).to.deep.equal(['http://localhost:8080/x'])
  })

  it('offers no other scheme', () => {
    expect(UrlDetector.find('file:///C:/a.md ftp://host/x mailto:a@b.c')).to.deep.equal([])
  })

  it('reports each URL once and stops at the limit', () => {
    const text = 'https://a.example/1 https://a.example/1 https://b.example/2 https://c.example/3 https://d.example/4'

    expect(UrlDetector.find(text)).to.deep.equal([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ])
  })

  it('finds nothing in text without a URL', () => {
    expect(UrlDetector.find('Q:\\Proj\\src\\a.ts:12 and a plain sentence')).to.deep.equal([])
  })
})
