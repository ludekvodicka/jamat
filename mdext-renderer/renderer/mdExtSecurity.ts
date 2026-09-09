import DOMPurify from 'dompurify'
import { defaultSchema } from 'rehype-sanitize'

import { MdExtNames } from './mdExtNames'

export class MdExtSecurity {
  static readonly sanitizeSchema: typeof defaultSchema = {
    ...defaultSchema,
    tagNames: [...new Set([
      ...(defaultSchema.tagNames ?? []),
      'div', 'span', 'details', 'summary',
    ])],
    attributes: {
      ...defaultSchema.attributes,
      div: [
        ...(defaultSchema.attributes?.div ?? []),
        ['className',
          'mdext-callout', ...MdExtNames.calloutClassesConst,
          'mdext-callout-title', 'mdext-status'],
        ['role', 'note'],
      ],
      span: [
        ...(defaultSchema.attributes?.span ?? []),
        ['className', 'mdext-chip', ...MdExtNames.chipClassesConst],
      ],
      details: [
        ...(defaultSchema.attributes?.details ?? []),
        ['className', 'mdext-details'],
      ],
    },
  }

  static href(value: string | undefined): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.startsWith('//')) return null
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
    return /^https?:/i.test(trimmed) ? trimmed : null
  }

  static relativeImage(value: string | undefined): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed || trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed))
      return null
    return trimmed
  }

  /**
   * The sanitizer's answer is taken as a DOM and serialised as XML, never as its HTML string.
   *
   * The two spellings disagree about exactly one thing and it is fatal here: HTML allows a bare `<`
   * inside an attribute value, so DOMPurify's own serialisation turns a correctly escaped
   * `aria-label="A &lt;b&gt;"` back into `aria-label="A <b>"` - and the XML parse on the next line
   * then fails with "disallowed character", which this method reports as `''`. A diagram whose title
   * or node label contained `<` or `>` therefore VANISHED, silently and completely, however
   * carefully the engine that drew it had escaped. `XMLSerializer` spells the attribute the way the
   * parser beside it reads one.
   */
  static svg(source: string): string {
    const sanitized = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: [
        'script', 'foreignObject', 'use', 'image', 'feImage', 'a',
        'animate', 'animateMotion', 'animateTransform', 'set',
      ],
      RETURN_DOM: true,
    }) as Element
    const root = sanitized.firstElementChild
    if (root === null) return ''
    const clean = new XMLSerializer().serializeToString(root)
    const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml')
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') return ''
    for (const element of parsed.querySelectorAll('*')) {
      if (element.localName === 'style') {
        if (!MdExtSecurity.safeCss(element.textContent ?? '')) element.remove()
        continue
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase()
        const value = attribute.value.trim()
        if (name.startsWith('on') || name === 'src' || name === 'data' || name === 'poster'
          || name === 'xml:base')
          element.removeAttribute(attribute.name)
        else if (name === 'href' || name === 'xlink:href') {
          if (!/^#[A-Za-z_][\w:.-]*$/.test(value)) element.removeAttribute(attribute.name)
        }
        else if (name === 'style') {
          if (!MdExtSecurity.safeCss(value)) element.removeAttribute(attribute.name)
        }
        else if (/url\s*\(/i.test(value) && !MdExtSecurity.safeFragmentUrls(value))
          element.removeAttribute(attribute.name)
      }
    }
    return new XMLSerializer().serializeToString(parsed.documentElement)
  }

  /**
   * A whole HTML file, made safe to draw. The frame it goes into is sandboxed and inherits the
   * app's CSP, so nothing here runs and nothing here reaches the network; this pass is the second
   * lock, and it is what makes the first one's failure survivable.
   *
   * What goes is what would act or fetch on its own: scripts and handlers (DOMPurify's own work),
   * nested frames and plugins, `base` and `meta`, which redirect or re-root every relative URL
   * below them, and `link`, whose stylesheet the CSP would refuse anyway - so a page keeps only the
   * `style` it carries inside itself. DOMPurify drops `noscript` with them, so the fallback a page
   * wrote for a reader without scripts is not shown either: unwrapping it means parsing and
   * re-serialising untrusted markup around the sanitiser, which is the mutation route this whole
   * method exists to avoid.
   */
  static page(source: string): string {
    return DOMPurify.sanitize(source, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: [
        'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
        'base', 'meta', 'link',
      ],
      FORBID_ATTR: ['srcdoc', 'ping', 'formaction'],
    })
  }

  static clipboard(source: string): string {
    return source
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/[\r\n]+$/, '')
  }

  private static safeCss(value: string): boolean {
    if (value.includes('\\')
      || /@import|@font-face|expression\s*\(|behavior\s*:|-moz-binding/i.test(value)
      || /https?:|data:|blob:|file:|image-set\s*\(|cross-fade\s*\(/i.test(value)
      || /(^|[\s("'=:\[])\/\//.test(value))
      return false
    // A gradient or a marker the same document defines is the ordinary case, not an escape:
    // mermaid's own stylesheet reaches for `url(#<id>-gradient)`, and rejecting it dropped the
    // whole sheet, which left every node painted the SVG default black.
    return !/url\s*\(/i.test(value) || MdExtSecurity.safeFragmentUrls(value)
  }

  private static safeFragmentUrls(value: string): boolean {
    if (value.includes('\\')) return false
    let count = 0
    const remainder = value.replace(
      /url\s*\(\s*(['"]?)(#[A-Za-z_][\w:.-]*)\1\s*\)/gi,
      () => { count += 1; return '' },
    )
    return count > 0 && !/url\s*\(/i.test(remainder)
  }
}
