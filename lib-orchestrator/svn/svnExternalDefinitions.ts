import { resolve } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { PathCompare } from '../shared/pathCompare'

export interface SvnExternalDefinition {
  carrier: string
  path: string
  url: string
  revision?: string
}

export class SvnExternalDefinitions {
  static properties(xml: string, root: string): Record<string, string> {
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, htmlEntities: true,
      isArray: (name) => name === 'target' || name === 'property' }).parse(xml)
    if (parsed.properties === undefined) throw new Error('svn propget returned no <properties> document')
    const result: Record<string, string> = {}
    for (const target of parsed.properties.target ?? []) {
      if (typeof target['@_path'] !== 'string') throw new Error('An external property has no carrier')
      const carrier = resolve(root, target['@_path'])
      if (!PathCompare.isInside(root, carrier)) throw new Error('An external carrier is outside its working copy')
      for (const property of target.property ?? [])
        if (property['@_name'] === 'svn:externals') result[carrier] = property['#text'] ?? ''
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)))
  }

  static parse(carrier: string, value: string): SvnExternalDefinition[] {
    return value.split(/\r?\n/).flatMap((line) => {
      if (!line.trim() || line.trimStart().startsWith('#')) return []
      const tokens = SvnExternalDefinitions.tokens(line)
      let revision: string | undefined
      const fields: string[] = []
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]
        if (token === '-r' || /^-r.+/.test(token)) {
          if (revision !== undefined) throw new Error(`Repeated external revision: ${line}`)
          revision = token === '-r' ? tokens[++index] : token.slice(2)
          if (revision === undefined || !/^(\d+|HEAD|\{[^{}]+\})$/.test(revision)) throw new Error(`Invalid external revision: ${line}`)
        } else fields.push(token)
      }
      if (fields.length !== 2) throw new Error(`Invalid external definition: ${line}`)
      const isUrl = (text: string) => /^(?:[a-z][a-z\d+.-]*:\/\/|\^\/|\/|\.\.\/)/i.test(text)
      const [url, local] = isUrl(fields[0]) ? fields : [fields[1], fields[0]]
      if (!isUrl(url) || isUrl(local) || /^[a-z]:/i.test(local) || local.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'))
        throw new Error(`Unsafe external definition: ${line}`)
      const path = resolve(carrier, local)
      if (!PathCompare.isInside(carrier, path) || PathCompare.comparable(carrier) === PathCompare.comparable(path))
        throw new Error(`External escapes its carrier: ${line}`)
      return [{ carrier, path, url, revision }]
    })
  }

  static url(value: string, carrierUrl: string, repository: string): string {
    if (value.startsWith('^/')) return new URL(value.slice(2), `${repository.replace(/\/$/, '')}/`).href
    if (value.startsWith('//')) return `${new URL(carrierUrl).protocol}${value}`
    if (value.startsWith('/') || value.startsWith('../')) return new URL(value, `${carrierUrl.replace(/\/$/, '')}/`).href
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value
    throw new Error(`Unsupported external URL: ${value}`)
  }

  static peg(url: string): string | undefined {
    let suffix: string
    try { suffix = decodeURIComponent(url.slice(url.lastIndexOf('@') + 1)) }
    catch { return undefined }
    return /^(\d+|HEAD|\{[^{}]+\})$/.test(suffix) ? suffix : undefined
  }

  private static tokens(line: string): string[] {
    const tokens: string[] = []
    let token = '', quote = '', active = false
    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      if (char === '\\') {
        if (++index === line.length) throw new Error('An external definition ends with an escape')
        token += line[index]; active = true
      } else if (quote) {
        if (char === quote) quote = ''
        else token += char
      } else if (char === '"' || char === "'") { quote = char; active = true }
      else if (/\s/.test(char)) {
        if (active) { tokens.push(token); token = ''; active = false }
      } else { token += char; active = true }
    }
    if (quote) throw new Error('An external definition has an unclosed quote')
    if (active) tokens.push(token)
    return tokens
  }
}
