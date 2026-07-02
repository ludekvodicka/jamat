# Third-Party Licenses

Jamat is licensed under the [MIT License](LICENSE). It builds on the open-source components listed
below. **All are under permissive licenses** (MIT, BSD-3-Clause, ISC, Apache-2.0, or
MPL-2.0/Apache-2.0) — there is **no copyleft (GPL/AGPL/LGPL)** dependency in the distributed app.

Versions reflect the resolved versions at the time of this audit; the authoritative, exact set
(including all transitive dependencies) lives in the `package-lock.json` files. To regenerate a full
report:

```bash
npx license-checker --production --summary          # root
cd app-electron && npx license-checker --production  # the desktop app
```

## Bundled in the desktop app (ships to users)

### Terminal
| Package | Version | License |
|---|---|---|
| `@xterm/xterm` + addons (`addon-fit`, `addon-search`, `addon-webgl`) | 6.1.0-beta / 0.x | MIT |
| `node-pty` | 1.2.0-beta.12 | MIT |

### UI framework
| Package | Version | License |
|---|---|---|
| `react`, `react-dom` | 19.2.x | MIT |
| `dockview` | 4.13.1 | MIT |
| `zustand` | 5.0.13 | MIT |
| `electron` | 35.7.5 | MIT |

`electron` bundles **Chromium** (BSD-3-Clause + others), **Node.js** (MIT), and **V8** (BSD-3-Clause)
— all permissive.

### Markdown, syntax & diagram rendering
| Package | Version | License |
|---|---|---|
| `react-markdown` | 9.1.0 | MIT |
| `remark-gfm`, `remark-directive` | 4.x | MIT |
| `rehype-raw`, `rehype-sanitize` | 7.0 / 6.0 | MIT |
| `marked` | 18.0.3 | MIT |
| `shiki` | 1.29.2 | MIT |
| `mermaid` | 11.15.0 | MIT |
| `@viz-js/viz` (Graphviz/WASM) | 3.28.0 | MIT |
| `vega` | 6.2.0 | BSD-3-Clause |
| `vega-lite` | 6.4.3 | BSD-3-Clause |
| `dompurify` | 3.4.10 | MPL-2.0 OR Apache-2.0 |
| `yaml` | 2.9.0 | ISC |
| `diff` | 9.0.0 | BSD-3-Clause |

> `dompurify` is dual-licensed; Jamat uses it under **Apache-2.0** (permissive).

### Networking
| Package | Version | License |
|---|---|---|
| `ws` | 8.21.0 | MIT |

## CLI / agent / stats runtime

| Package | Version | License |
|---|---|---|
| `tsx` | 4.22.0 | MIT |
| `esbuild` | 0.25.12 | MIT |
| `ccusage` | 18.0.11 | MIT |
| `typescript` | 6.0.3 | Apache-2.0 |

## In-tree components

- **Archify** diagram engine — vendored in-tree, MIT.
- **mdExtRenderer** Markdown widget — part of this repository (MIT); its runtime dependencies are the
  Markdown/diagram packages listed above.

## License summary

| License | Count (direct) |
|---|---|
| MIT | majority |
| BSD-3-Clause | `vega`, `vega-lite`, `diff` (+ Chromium/V8 via Electron) |
| ISC | `yaml` |
| Apache-2.0 | `typescript` (dev/runtime tooling) |
| MPL-2.0 / Apache-2.0 | `dompurify` (used under Apache-2.0) |

No GPL, LGPL, or AGPL dependencies are present in the distributed application.
