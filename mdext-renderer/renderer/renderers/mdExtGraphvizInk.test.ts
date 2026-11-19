import { describe, expect, it } from 'vitest'

import { MdExtGraphvizInk } from './mdExtGraphvizInk'

const ink = '#e6eef6'

/** Shapes and labels as `@viz-js/viz` writes them for the dark workspace's default attributes. */
function graph(body: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    + '<svg width="402pt" height="174pt" viewBox="0.00 0.00 402.00 174.00" xmlns="http://www.w3.org/2000/svg">'
    + `<g id="graph0" class="graph">${body}</g></svg>`
}

function labels(svg: string): Record<string, string | null> {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return Object.fromEntries([...document.querySelectorAll('text')]
    .map((text) => [text.textContent ?? '', text.getAttribute('fill')]))
}

describe('mdext-renderer/renderer/renderers/mdExtGraphvizInk', () => {
  it('gives a default-ink label on a light fill the dark ink', () => {
    const svg = MdExtGraphvizInk.apply(graph(
      '<g id="node1" class="node"><title>a</title>'
      + '<path fill="#e8f0fe" stroke="#8b949e" d="M42,-124.8C42,-124.8 12,-124.8 12,-124.8 0,-118.8 0,-94.8 12,-88.8 54,-94.8 54,-118.8 42,-124.8"/>'
      + `<text x="27" y="-102.6" fill="${ink}">a</text></g>`
      + '<g id="clust1" class="cluster"><title>cluster_x</title>'
      + '<polygon fill="#e6e6fa" stroke="#8b949e" points="280,-80.8 280,-157.6 350,-157.6 350,-80.8 280,-80.8"/>'
      + `<text x="315" y="-141" fill="${ink}">plugins/</text></g>`), ink)

    expect(labels(svg)).toEqual({ a: '#1f2328', 'plugins/': '#1f2328' })
  })

  it('keeps the default ink on a dark fill, on no fill, and a font colour the source set', () => {
    const source = graph(
      '<g id="node1" class="node"><title>d</title>'
      + '<polygon fill="#123456" stroke="#8b949e" points="198,-124.8 144,-124.8 144,-88.8 198,-88.8 198,-124.8"/>'
      + `<text x="171" y="-102.6" fill="${ink}">d</text></g>`
      + '<g id="node2" class="node"><title>e</title>'
      + '<polygon fill="none" stroke="#8b949e" points="258,-124.8 216,-124.8 216,-88.8 258,-88.8 258,-124.8"/>'
      + `<text x="243" y="-102.6" fill="${ink}">e</text></g>`
      + '<g id="node3" class="node"><title>c</title>'
      + '<polygon fill="#ffffe0" stroke="#8b949e" points="126,-124.8 72,-124.8 72,-88.8 126,-88.8 126,-124.8"/>'
      + '<text x="99" y="-102.6" fill="#ff0000">c</text></g>')

    expect(MdExtGraphvizInk.apply(source, ink)).toBe(source)
  })

  it('reads the fill each label sits on, not the last one drawn', () => {
    const svg = MdExtGraphvizInk.apply(graph(
      '<g id="node7" class="node"><title>h</title>'
      + '<path fill="#e8f0fe" stroke="none" d="M394,-121.2 360,-121.2 360,-92.4 394,-92.4 394,-121.2"/>'
      + '<polygon fill="#000080" stroke="none" points="363,-95.4 363,-118.2 376,-118.2 376,-95.4 363,-95.4"/>'
      + `<text x="366" y="-101.2" fill="${ink}">x</text>`
      + '<polygon fill="none" stroke="#8b949e" points="378,-95.4 378,-118.2 391,-118.2 391,-95.4 378,-95.4"/>'
      + `<text x="381" y="-101.2" fill="${ink}">y</text></g>`
      + '<g id="edge1" class="edge"><title>a-&gt;b</title>'
      + '<polygon fill="#8b949e" stroke="#8b949e" points="30.5,-47.92 27,-37.92 23.5,-47.92 30.5,-47.92"/>'
      + `<text x="37.89" y="-58.2" fill="${ink}">imp</text></g>`), ink)

    expect(labels(svg)).toEqual({ x: ink, y: '#1f2328', imp: ink })
  })

  it('treats a mostly transparent fill as the page under it', () => {
    const source = graph(
      '<g id="node1" class="node"><title>a</title>'
      + '<polygon fill="#ffffff" fill-opacity="0.2" stroke="#8b949e" points="54,-124.8 0,-124.8 0,-88.8 54,-88.8 54,-124.8"/>'
      + `<text x="27" y="-102.6" fill="${ink}">a</text></g>`)

    expect(MdExtGraphvizInk.apply(source, ink)).toBe(source)
  })
})
