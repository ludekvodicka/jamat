import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The mdExtRenderer widget is vendored into the renderer tree at
// src/renderer/widgets/mdExtRenderer. It lives under src/renderer (NOT src/shared, which
// tsconfig.node ALSO compiles — a React/JSX widget must be renderer-only). The `@mdext` alias
// points the import there; its runtime deps resolve from app-electron/node_modules (the
// vendored copy carries no node_modules).
const dir = fileURLToPath(new URL('.', import.meta.url))
const mdextAlias = resolve(dir, 'src/renderer/widgets/mdExtRenderer')

export default defineConfig({
  // preserveSymlinks (all three builds): needed when the repo runs from a `subst`
  // virtual drive (e.g. X:\ => D:\). Without it, Rollup/Vite canonicalizes the subst
  // path to the real drive inconsistently, so the same source file resolves to two
  // module IDs (X:\... and D:\...). Effects seen:
  //   - main: ipc-windows.ts bundled TWICE → split `appConfig` singleton →
  //     getAppConfig() returns null in debug-api (different copy than the one
  //     loadScreenConfig set) and split window/menu state.
  //   - renderer: dev server root X:\ vs entry resolved D:\ → "Failed to load
  //     /main.tsx, resolved id: D:/...".
  // Keeping paths on the launch drive fixes both. No-op on a native (non-subst) path.
  main: {
    resolve: { preserveSymlinks: true },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `relaunch.ts` / `update/update-manager.ts` are INTENTIONALLY dynamic-imported by the menu in
        // `ipc-windows.ts` to break the static cycle (both import ipc-windows back), while `debug-ops`
        // imports them statically. Rollup then notes the dynamic import "won't move it to another
        // chunk" — meaningless for the single-file main bundle. Suppress just that one benign note.
        onwarn(warning, defaultHandler) {
          if (warning.code === 'DYNAMIC_IMPORT_WILL_NOT_BE_MOVED') return
          defaultHandler(warning)
        }
      }
    }
  },
  preload: {
    resolve: { preserveSymlinks: true },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      preserveSymlinks: true,
      alias: { '@mdext': mdextAlias }
    },
    plugins: [react()]
  }
})
