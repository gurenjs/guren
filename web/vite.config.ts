import { fileURLToPath } from 'node:url'

import { routeTypesPlugin } from '@guren/cli/vite'
import { defineConfig } from 'vite'
import guren from '@guren/core/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Parallel worktree sessions each start a managed Vite on 5173; on macOS the
// IPv4/IPv6 split lets two of them "succeed" on the same port while the
// browser's `localhost` reaches only one. An explicit port opts a session out.
const devPort = Number.parseInt(process.env.GUREN_VITE_PORT ?? '', 10)

// The docs pages import mermaid lazily, in a browser-only effect. Without
// this the SSR build still pulls every diagram renderer it can reach into
// `.guren/ssr` (~9 MB across 100+ chunks) — and that directory is what the
// Cloudflare Worker ships. The stub keeps the client build untouched, so
// readers still get the real, content-hashed, code-split library.
const MERMAID_SSR_STUB = fileURLToPath(new URL('./resources/js/lib/mermaid-ssr-stub.ts', import.meta.url))

export default defineConfig(({ command, isSsrBuild }) => ({
  publicDir: false,
  resolve: {
    alias: isSsrBuild ? { mermaid: MERMAID_SSR_STUB } : {},
  },
  build: {
    rollupOptions: {
      // The Guren plugin sets the Inertia entry only when no input is
      // declared, so listing it here keeps it while adding the stylesheet as
      // its own build input — content pages resolve it by manifest key via
      // viteAsset('resources/css/app.css') (RFC 0014).
      input: ['resources/js/app.tsx', 'resources/css/app.css'],
    },
  },
  ...(Number.isInteger(devPort) ? { server: { port: devPort, strictPort: true } } : {}),
  plugins: [
    // The `guren` package is not on npm, so the plugin's default
    // `bun x --bun guren` fails in the monorepo — delegate to this app's
    // codegen script instead. Dev-server only: the plugin re-running the
    // codegen script during `vite build` would overwrite the real
    // prerender output with stubs (the script runs `prerender:stub`).
    ...(command === 'serve' ? [routeTypesPlugin({ args: ['run', 'codegen'] })] : []),
    guren(),
    react(),
    tailwindcss(),
  ],
}))
