# Jamat — logo & icons

Brand assets, all derived from **concept A** — the "J_" monogram, a prompt waiting for your input:
a sky-blue **J** with a purple **cursor** block on a dark rounded card.

Palette: J `#56c0f5` · cursor `#c06bff` · card `#0d1117` · border `#2d333b`.

| File | Use |
|---|---|
| `jamat-icon.svg` | Vector source of the icon |
| `jamat.ico` | Windows app icon (16–256) — wired into electron-builder (`app-electron/package.json` → `build.win.icon`) |
| `jamat-256/512/1024.png` | Raster icon for mac / linux packaging and general use |
| `favicon.ico` · `favicon.svg` · `favicon-16/32.png` · `apple-touch-icon.png` | Web favicon set |
| `jamat-banner.png` · `jamat-banner.svg` | Logo lockup (icon + wordmark) — used at the top of the repo README |

The raster + `.ico` assets are generated from the two SVGs with `@resvg/resvg-js` + `png-to-ico`.
The per-window **tinted** taskbar icon is a separate mechanism, generated at runtime in
`app-electron/src/main/icon-generator.ts` (it can be updated to match this logo separately).
