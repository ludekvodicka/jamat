# Third-Party Licenses

Jamat is [MIT licensed](LICENSE) and builds on the work below. This file is **generated** by
`pnpm release:third-party` from the installed production dependency graphs; the release script
regenerates it and refuses to release when the committed copy is out of date. Edit
`scripts/release/generate-third-party.ts`, never this file.

The graphs it reads are the ones an installer carries:

- `app-client-ui` - the Electron client, packed into the installer
- `app-host` - the detached Host, bundled into `resources/host`
- `lib-orchestrator` - the library bundled into the client's main process

A component whose manifest declares no license is read out of the license file shipped in the
package, and one that has neither fails the generator, so nothing reaches this list unattributed.

## Runtimes

| Component | Version | License | What it is |
| --- | --- | --- | --- |
| Electron | 43.2.0 | MIT | the application runtime the installer carries. Electron embeds Chromium (BSD-3-Clause and the licenses named in its own credits), Node.js (MIT) and V8 (BSD-3-Clause). |
| Node.js | 22.23.2 | MIT | the runtime the reMarkable sidecar runs on. The installer carries a sha256-pinned official build from nodejs.org, unmodified. |
| remarkable-cli | 0.3.0 | MIT | the reMarkable command line tool the sidecar invokes. Its own dependency tree is installed beside it at seed time and pinned in `configs/remarkable-sidecar/package-lock.json`, which names each of those licenses. |

## Licenses in use

330 npm components across the three graphs.

| License | Components |
| --- | --- |
| (MPL-2.0 OR Apache-2.0) | 1 |
| 0BSD | 1 |
| Apache-2.0 | 1 |
| BlueOak-1.0.0 | 1 |
| BSD-3-Clause | 40 |
| ISC | 43 |
| MIT | 239 |
| MPL-2.0 | 2 |
| Python-2.0 | 1 |
| Unlicense | 1 |

## Components

The `Graphs` column names which shipped graph pulls the component in. A `*` on the license means
the package declares none in its manifest and the id was read from its license file.

| Component | Version | License | Graphs |
| --- | --- | --- | --- |
| `@antfu/install-pkg` | 1.1.0 | MIT | app-client-ui |
| `@braintree/sanitize-url` | 7.1.2 | MIT | app-client-ui |
| `@chevrotain/types` | 11.1.2 | Apache-2.0 | app-client-ui |
| `@iconify/types` | 2.0.0 | MIT | app-client-ui |
| `@iconify/utils` | 3.1.4 | MIT | app-client-ui |
| `@mermaid-js/parser` | 1.2.0 | MIT | app-client-ui |
| `@nodable/entities` | 3.0.0 | MIT | app-client-ui, lib-orchestrator |
| `@resvg/resvg-js` | 2.6.2 | MPL-2.0 | app-client-ui |
| `@resvg/resvg-js-win32-x64-msvc` | 2.6.2 | MPL-2.0 | app-client-ui |
| `@shikijs/core` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/engine-javascript` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/engine-oniguruma` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/langs` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/primitive` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/themes` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/types` | 4.4.3 | MIT | app-client-ui |
| `@shikijs/vscode-textmate` | 10.0.2 | MIT | app-client-ui |
| `@types/d3` | 7.4.3 | MIT | app-client-ui |
| `@types/d3-array` | 3.2.2 | MIT | app-client-ui |
| `@types/d3-axis` | 3.0.6 | MIT | app-client-ui |
| `@types/d3-brush` | 3.0.6 | MIT | app-client-ui |
| `@types/d3-chord` | 3.0.6 | MIT | app-client-ui |
| `@types/d3-color` | 3.1.3 | MIT | app-client-ui |
| `@types/d3-contour` | 3.0.6 | MIT | app-client-ui |
| `@types/d3-delaunay` | 6.0.4 | MIT | app-client-ui |
| `@types/d3-dispatch` | 3.0.7 | MIT | app-client-ui |
| `@types/d3-drag` | 3.0.7 | MIT | app-client-ui |
| `@types/d3-dsv` | 3.0.7 | MIT | app-client-ui |
| `@types/d3-ease` | 3.0.2 | MIT | app-client-ui |
| `@types/d3-fetch` | 3.0.7 | MIT | app-client-ui |
| `@types/d3-force` | 3.0.10 | MIT | app-client-ui |
| `@types/d3-format` | 3.0.4 | MIT | app-client-ui |
| `@types/d3-geo` | 3.1.1 | MIT | app-client-ui |
| `@types/d3-hierarchy` | 3.1.7 | MIT | app-client-ui |
| `@types/d3-interpolate` | 3.0.4 | MIT | app-client-ui |
| `@types/d3-path` | 3.1.1 | MIT | app-client-ui |
| `@types/d3-polygon` | 3.0.2 | MIT | app-client-ui |
| `@types/d3-quadtree` | 3.0.6 | MIT | app-client-ui |
| `@types/d3-random` | 3.0.4 | MIT | app-client-ui |
| `@types/d3-scale` | 4.0.9 | MIT | app-client-ui |
| `@types/d3-scale-chromatic` | 3.1.0 | MIT | app-client-ui |
| `@types/d3-selection` | 3.0.11 | MIT | app-client-ui |
| `@types/d3-shape` | 3.1.8 | MIT | app-client-ui |
| `@types/d3-time` | 3.0.4 | MIT | app-client-ui |
| `@types/d3-time-format` | 4.0.3 | MIT | app-client-ui |
| `@types/d3-timer` | 3.0.2 | MIT | app-client-ui |
| `@types/d3-transition` | 3.0.9 | MIT | app-client-ui |
| `@types/d3-zoom` | 3.0.8 | MIT | app-client-ui |
| `@types/debug` | 4.1.13 | MIT | app-client-ui |
| `@types/estree` | 1.0.9 | MIT | app-client-ui |
| `@types/estree-jsx` | 1.0.5 | MIT | app-client-ui |
| `@types/geojson` | 7946.0.16 | MIT | app-client-ui |
| `@types/hast` | 3.0.5 | MIT | app-client-ui |
| `@types/mdast` | 4.0.4 | MIT | app-client-ui |
| `@types/ms` | 2.1.0 | MIT | app-client-ui |
| `@types/react` | 19.2.17 | MIT | app-client-ui |
| `@types/trusted-types` | 2.0.7 | MIT | app-client-ui |
| `@types/unist` | 2.0.11 | MIT | app-client-ui |
| `@types/unist` | 3.0.3 | MIT | app-client-ui |
| `@ungap/structured-clone` | 1.3.3 | ISC | app-client-ui |
| `@upsetjs/venn.js` | 2.0.0 | MIT | app-client-ui |
| `@viz-js/viz` | 3.29.0 | MIT | app-client-ui |
| `@xterm/addon-fit` | 0.12.0-beta.287 | MIT | app-client-ui |
| `@xterm/addon-serialize` | 0.14.0 | MIT | app-host |
| `@xterm/addon-unicode11` | 0.10.0-beta.287 | MIT | app-client-ui, app-host |
| `@xterm/headless` | 6.1.0-beta.287 | MIT | app-host |
| `@xterm/xterm` | 6.1.0-beta.287 | MIT | app-client-ui |
| `@xterm/xterm` | 6.1.0-beta.303 | MIT | app-host |
| `ansi-regex` | 6.3.0 | MIT | app-client-ui |
| `ansi-styles` | 6.2.3 | MIT | app-client-ui |
| `anynum` | 1.0.1 | MIT | app-client-ui, lib-orchestrator |
| `argparse` | 2.0.1 | Python-2.0 | app-client-ui |
| `bail` | 2.0.2 | MIT | app-client-ui |
| `builder-util-runtime` | 9.7.0 | MIT | app-client-ui |
| `ccount` | 2.0.1 | MIT | app-client-ui |
| `character-entities` | 2.0.2 | MIT | app-client-ui |
| `character-entities-html4` | 2.1.0 | MIT | app-client-ui |
| `character-entities-legacy` | 3.0.0 | MIT | app-client-ui |
| `character-reference-invalid` | 2.0.1 | MIT | app-client-ui |
| `cliui` | 9.0.1 | ISC | app-client-ui |
| `comma-separated-tokens` | 2.0.3 | MIT | app-client-ui |
| `commander` | 2.20.3 | MIT | app-client-ui |
| `commander` | 7.2.0 | MIT | app-client-ui |
| `commander` | 8.3.0 | MIT | app-client-ui |
| `cose-base` | 1.0.3 | MIT | app-client-ui |
| `cose-base` | 2.2.0 | MIT | app-client-ui |
| `csstype` | 3.2.3 | MIT | app-client-ui |
| `cytoscape` | 3.34.1 | MIT | app-client-ui |
| `cytoscape-cose-bilkent` | 4.1.0 | MIT | app-client-ui |
| `cytoscape-fcose` | 2.2.0 | MIT | app-client-ui |
| `d3` | 7.9.0 | ISC | app-client-ui |
| `d3-array` | 2.12.1 | BSD-3-Clause | app-client-ui |
| `d3-array` | 3.2.4 | ISC | app-client-ui |
| `d3-axis` | 3.0.0 | ISC | app-client-ui |
| `d3-brush` | 3.0.0 | ISC | app-client-ui |
| `d3-chord` | 3.0.1 | ISC | app-client-ui |
| `d3-color` | 3.1.0 | ISC | app-client-ui |
| `d3-contour` | 4.0.2 | ISC | app-client-ui |
| `d3-delaunay` | 6.0.4 | ISC | app-client-ui |
| `d3-dispatch` | 3.0.1 | ISC | app-client-ui |
| `d3-drag` | 3.0.0 | ISC | app-client-ui |
| `d3-dsv` | 3.0.1 | ISC | app-client-ui |
| `d3-ease` | 3.0.1 | BSD-3-Clause | app-client-ui |
| `d3-fetch` | 3.0.1 | ISC | app-client-ui |
| `d3-force` | 3.0.0 | ISC | app-client-ui |
| `d3-format` | 3.1.2 | ISC | app-client-ui |
| `d3-geo` | 3.1.1 | ISC | app-client-ui |
| `d3-geo-projection` | 4.0.0 | ISC | app-client-ui |
| `d3-hierarchy` | 3.1.2 | ISC | app-client-ui |
| `d3-interpolate` | 3.0.1 | ISC | app-client-ui |
| `d3-path` | 1.0.9 | BSD-3-Clause | app-client-ui |
| `d3-path` | 3.1.0 | ISC | app-client-ui |
| `d3-polygon` | 3.0.1 | ISC | app-client-ui |
| `d3-quadtree` | 3.0.1 | ISC | app-client-ui |
| `d3-random` | 3.0.1 | ISC | app-client-ui |
| `d3-sankey` | 0.12.3 | BSD-3-Clause | app-client-ui |
| `d3-scale` | 4.0.2 | ISC | app-client-ui |
| `d3-scale-chromatic` | 3.1.0 | ISC | app-client-ui |
| `d3-selection` | 3.0.0 | ISC | app-client-ui |
| `d3-shape` | 1.3.7 | BSD-3-Clause | app-client-ui |
| `d3-shape` | 3.2.0 | ISC | app-client-ui |
| `d3-time` | 3.1.0 | ISC | app-client-ui |
| `d3-time-format` | 4.1.0 | ISC | app-client-ui |
| `d3-timer` | 3.0.1 | ISC | app-client-ui |
| `d3-transition` | 3.0.1 | ISC | app-client-ui |
| `d3-zoom` | 3.0.0 | ISC | app-client-ui |
| `dagre-d3-es` | 7.0.14 | MIT | app-client-ui |
| `dayjs` | 1.11.21 | MIT | app-client-ui |
| `debug` | 4.4.3 | MIT | app-client-ui |
| `decode-named-character-reference` | 1.3.0 | MIT | app-client-ui |
| `delaunator` | 5.1.0 | ISC | app-client-ui |
| `dequal` | 2.0.3 | MIT | app-client-ui |
| `devlop` | 1.1.0 | MIT | app-client-ui |
| `diff` | 9.0.0 | BSD-3-Clause | lib-orchestrator |
| `dockview` | 4.13.1 | MIT | app-client-ui |
| `dockview-core` | 4.13.1 | MIT | app-client-ui |
| `dompurify` | 3.4.13 | (MPL-2.0 OR Apache-2.0) | app-client-ui |
| `electron-updater` | 6.8.9 | MIT | app-client-ui |
| `emoji-regex` | 10.6.0 | MIT | app-client-ui |
| `es-toolkit` | 1.50.0 | MIT | app-client-ui |
| `escalade` | 3.2.0 | MIT | app-client-ui |
| `escape-string-regexp` | 5.0.0 | MIT | app-client-ui |
| `estree-util-is-identifier-name` | 3.0.0 | MIT | app-client-ui |
| `extend` | 3.0.2 | MIT | app-client-ui |
| `fast-xml-builder` | 1.3.0 | MIT | lib-orchestrator |
| `fast-xml-builder` | 1.3.1 | MIT | app-client-ui |
| `fast-xml-parser` | 5.10.1 | MIT | app-client-ui, lib-orchestrator |
| `fs-extra` | 10.1.0 | MIT | app-client-ui |
| `get-caller-file` | 2.0.5 | ISC | app-client-ui |
| `get-east-asian-width` | 1.6.0 | MIT | app-client-ui |
| `graceful-fs` | 4.2.11 | ISC | app-client-ui |
| `hachure-fill` | 0.5.2 | MIT | app-client-ui |
| `has-flag` | 4.0.0 | MIT | app-client-ui |
| `hast-util-sanitize` | 5.0.2 | MIT | app-client-ui |
| `hast-util-to-html` | 9.0.5 | MIT | app-client-ui |
| `hast-util-to-jsx-runtime` | 2.3.6 | MIT | app-client-ui |
| `hast-util-whitespace` | 3.0.0 | MIT | app-client-ui |
| `html-url-attributes` | 3.0.1 | MIT | app-client-ui |
| `html-void-elements` | 3.0.0 | MIT | app-client-ui |
| `iconv-lite` | 0.6.3 | MIT | app-client-ui |
| `import-meta-resolve` | 4.2.0 | MIT | app-client-ui |
| `inline-style-parser` | 0.2.7 | MIT | app-client-ui |
| `internmap` | 1.0.1 | ISC | app-client-ui |
| `internmap` | 2.0.3 | ISC | app-client-ui |
| `is-alphabetical` | 2.0.1 | MIT | app-client-ui |
| `is-alphanumerical` | 2.0.1 | MIT | app-client-ui |
| `is-decimal` | 2.0.1 | MIT | app-client-ui |
| `is-hexadecimal` | 2.0.1 | MIT | app-client-ui |
| `is-plain-obj` | 4.1.0 | MIT | app-client-ui |
| `is-unsafe` | 2.0.0 | MIT | app-client-ui, lib-orchestrator |
| `js-yaml` | 4.3.1 | MIT | app-client-ui |
| `json-stringify-pretty-compact` | 4.0.0 | MIT | app-client-ui |
| `jsonfile` | 6.2.1 | MIT | app-client-ui |
| `katex` | 0.16.47 | MIT | app-client-ui |
| `khroma` | 2.1.0 | MIT \* | app-client-ui |
| `layout-base` | 1.0.2 | MIT | app-client-ui |
| `layout-base` | 2.0.1 | MIT | app-client-ui |
| `lazy-val` | 1.0.5 | MIT | app-client-ui |
| `lodash-es` | 4.18.1 | MIT | app-client-ui |
| `lodash.escaperegexp` | 4.1.2 | MIT | app-client-ui |
| `lodash.isequal` | 4.5.0 | MIT | app-client-ui |
| `longest-streak` | 3.1.0 | MIT | app-client-ui |
| `markdown-table` | 3.0.4 | MIT | app-client-ui |
| `marked` | 16.4.2 | MIT | app-client-ui |
| `mdast-util-directive` | 3.1.0 | MIT | app-client-ui |
| `mdast-util-find-and-replace` | 3.0.2 | MIT | app-client-ui |
| `mdast-util-from-markdown` | 2.0.3 | MIT | app-client-ui |
| `mdast-util-gfm` | 3.1.0 | MIT | app-client-ui |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | MIT | app-client-ui |
| `mdast-util-gfm-footnote` | 2.1.0 | MIT | app-client-ui |
| `mdast-util-gfm-strikethrough` | 2.0.0 | MIT | app-client-ui |
| `mdast-util-gfm-table` | 2.0.0 | MIT | app-client-ui |
| `mdast-util-gfm-task-list-item` | 2.0.0 | MIT | app-client-ui |
| `mdast-util-mdx-expression` | 2.0.1 | MIT | app-client-ui |
| `mdast-util-mdx-jsx` | 3.2.0 | MIT | app-client-ui |
| `mdast-util-mdxjs-esm` | 2.0.1 | MIT | app-client-ui |
| `mdast-util-phrasing` | 4.1.0 | MIT | app-client-ui |
| `mdast-util-to-hast` | 13.2.1 | MIT | app-client-ui |
| `mdast-util-to-markdown` | 2.1.2 | MIT | app-client-ui |
| `mdast-util-to-string` | 4.0.0 | MIT | app-client-ui |
| `mermaid` | 11.16.1 | MIT | app-client-ui |
| `micromark` | 4.0.2 | MIT | app-client-ui |
| `micromark-core-commonmark` | 2.0.3 | MIT | app-client-ui |
| `micromark-extension-directive` | 4.0.0 | MIT | app-client-ui |
| `micromark-extension-gfm` | 3.0.0 | MIT | app-client-ui |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | MIT | app-client-ui |
| `micromark-extension-gfm-footnote` | 2.1.0 | MIT | app-client-ui |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | MIT | app-client-ui |
| `micromark-extension-gfm-table` | 2.1.1 | MIT | app-client-ui |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | MIT | app-client-ui |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | MIT | app-client-ui |
| `micromark-factory-destination` | 2.0.1 | MIT | app-client-ui |
| `micromark-factory-label` | 2.0.1 | MIT | app-client-ui |
| `micromark-factory-space` | 2.0.1 | MIT | app-client-ui |
| `micromark-factory-title` | 2.0.1 | MIT | app-client-ui |
| `micromark-factory-whitespace` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-character` | 2.1.1 | MIT | app-client-ui |
| `micromark-util-chunked` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-classify-character` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-combine-extensions` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT | app-client-ui |
| `micromark-util-decode-string` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-encode` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-html-tag-name` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-normalize-identifier` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-resolve-all` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-subtokenize` | 2.1.0 | MIT | app-client-ui |
| `micromark-util-symbol` | 2.0.1 | MIT | app-client-ui |
| `micromark-util-types` | 2.0.2 | MIT | app-client-ui |
| `ms` | 2.1.3 | MIT | app-client-ui |
| `node-addon-api` | 7.1.1 | MIT | app-host |
| `node-pty` | 1.2.0-beta.12 | MIT | app-host |
| `oniguruma-parser` | 0.12.2 | MIT | app-client-ui |
| `oniguruma-to-es` | 4.3.6 | MIT | app-client-ui |
| `package-manager-detector` | 1.8.0 | MIT | app-client-ui |
| `parse-entities` | 4.0.2 | MIT | app-client-ui |
| `path-data-parser` | 0.1.0 | MIT | app-client-ui |
| `path-expression-matcher` | 1.6.2 | MIT | app-client-ui, lib-orchestrator |
| `points-on-curve` | 0.2.0 | MIT | app-client-ui |
| `points-on-path` | 0.2.1 | MIT | app-client-ui |
| `property-information` | 7.2.0 | MIT | app-client-ui |
| `react` | 19.2.7 | MIT | app-client-ui |
| `react-dom` | 19.2.7 | MIT | app-client-ui |
| `react-markdown` | 10.1.0 | MIT | app-client-ui |
| `regex` | 6.1.0 | MIT | app-client-ui |
| `regex-recursion` | 6.0.2 | MIT | app-client-ui |
| `regex-utilities` | 2.3.0 | MIT | app-client-ui |
| `rehype-sanitize` | 6.0.0 | MIT | app-client-ui |
| `remark-directive` | 4.0.0 | MIT | app-client-ui |
| `remark-gfm` | 4.0.1 | MIT | app-client-ui |
| `remark-parse` | 11.0.0 | MIT | app-client-ui |
| `remark-rehype` | 11.1.2 | MIT | app-client-ui |
| `remark-stringify` | 11.0.0 | MIT | app-client-ui |
| `robust-predicates` | 3.0.3 | Unlicense | app-client-ui |
| `roughjs` | 4.6.6 | MIT | app-client-ui |
| `rw` | 1.3.3 | BSD-3-Clause | app-client-ui |
| `safer-buffer` | 2.1.2 | MIT | app-client-ui |
| `sax` | 1.6.1 | BlueOak-1.0.0 | app-client-ui |
| `scheduler` | 0.27.0 | MIT | app-client-ui |
| `semver` | 7.7.4 | ISC | app-client-ui |
| `shiki` | 4.4.3 | MIT | app-client-ui |
| `space-separated-tokens` | 2.0.2 | MIT | app-client-ui |
| `string-width` | 7.2.0 | MIT | app-client-ui |
| `stringify-entities` | 4.0.4 | MIT | app-client-ui |
| `strip-ansi` | 7.2.0 | MIT | app-client-ui |
| `strnum` | 2.4.1 | MIT | lib-orchestrator |
| `strnum` | 2.4.2 | MIT | app-client-ui |
| `style-to-js` | 1.1.21 | MIT | app-client-ui |
| `style-to-object` | 1.0.14 | MIT | app-client-ui |
| `stylis` | 4.4.0 | MIT | app-client-ui |
| `supports-color` | 7.2.0 | MIT | app-client-ui |
| `tiny-typed-emitter` | 2.1.0 | MIT | app-client-ui |
| `tinyexec` | 1.3.0 | MIT | app-client-ui |
| `topojson-client` | 3.1.0 | ISC | app-client-ui |
| `trim-lines` | 3.0.1 | MIT | app-client-ui |
| `trough` | 2.2.0 | MIT | app-client-ui |
| `ts-dedent` | 2.3.0 | MIT | app-client-ui |
| `tslib` | 2.8.1 | 0BSD | app-client-ui |
| `unified` | 11.0.5 | MIT | app-client-ui |
| `unist-util-is` | 6.0.1 | MIT | app-client-ui |
| `unist-util-position` | 5.0.0 | MIT | app-client-ui |
| `unist-util-stringify-position` | 4.0.0 | MIT | app-client-ui |
| `unist-util-visit` | 5.1.0 | MIT | app-client-ui |
| `unist-util-visit-parents` | 6.0.2 | MIT | app-client-ui |
| `universalify` | 2.0.1 | MIT | app-client-ui |
| `uuid` | 14.0.1 | MIT | app-client-ui |
| `vega` | 6.4.0 | BSD-3-Clause | app-client-ui |
| `vega-canvas` | 2.0.0 | BSD-3-Clause | app-client-ui |
| `vega-crossfilter` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-dataflow` | 6.1.3 | BSD-3-Clause | app-client-ui |
| `vega-encode` | 5.2.2 | BSD-3-Clause | app-client-ui |
| `vega-event-selector` | 4.0.0 | BSD-3-Clause | app-client-ui |
| `vega-expression` | 6.1.0 | BSD-3-Clause | app-client-ui |
| `vega-expression` | 6.2.2 | BSD-3-Clause | app-client-ui |
| `vega-force` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-format` | 2.1.3 | BSD-3-Clause | app-client-ui |
| `vega-functions` | 6.2.0 | BSD-3-Clause | app-client-ui |
| `vega-geo` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-hierarchy` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-label` | 2.1.3 | BSD-3-Clause | app-client-ui |
| `vega-lite` | 6.4.3 | BSD-3-Clause | app-client-ui |
| `vega-loader` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-parser` | 7.1.3 | BSD-3-Clause | app-client-ui |
| `vega-projection` | 2.1.3 | BSD-3-Clause | app-client-ui |
| `vega-regression` | 2.1.3 | BSD-3-Clause | app-client-ui |
| `vega-runtime` | 7.1.3 | BSD-3-Clause | app-client-ui |
| `vega-scale` | 8.1.3 | BSD-3-Clause | app-client-ui |
| `vega-scenegraph` | 5.3.0 | BSD-3-Clause | app-client-ui |
| `vega-selections` | 6.1.5 | BSD-3-Clause | app-client-ui |
| `vega-statistics` | 2.0.0 | BSD-3-Clause | app-client-ui |
| `vega-time` | 3.3.0 | BSD-3-Clause | app-client-ui |
| `vega-transforms` | 5.2.2 | BSD-3-Clause | app-client-ui |
| `vega-typings` | 2.3.0 | BSD-3-Clause | app-client-ui |
| `vega-util` | 2.1.2 | BSD-3-Clause | app-client-ui |
| `vega-util` | 2.1.3 | BSD-3-Clause | app-client-ui |
| `vega-view` | 6.2.0 | BSD-3-Clause | app-client-ui |
| `vega-view-transforms` | 5.2.2 | BSD-3-Clause | app-client-ui |
| `vega-voronoi` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vega-wordcloud` | 5.1.3 | BSD-3-Clause | app-client-ui |
| `vfile` | 6.0.3 | MIT | app-client-ui |
| `vfile-message` | 4.0.3 | MIT | app-client-ui |
| `wrap-ansi` | 9.0.2 | MIT | app-client-ui |
| `ws` | 8.21.1 | MIT | app-client-ui, app-host, lib-orchestrator |
| `xml-naming` | 0.3.0 | MIT | app-client-ui, lib-orchestrator |
| `y18n` | 5.0.8 | ISC | app-client-ui |
| `yaml` | 2.9.0 | ISC | app-client-ui |
| `yargs` | 18.0.0 | MIT | app-client-ui |
| `yargs-parser` | 22.0.0 | ISC | app-client-ui |
| `zwitch` | 2.0.4 | MIT | app-client-ui |
