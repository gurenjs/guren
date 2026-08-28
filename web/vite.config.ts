import { routeTypesPlugin } from '@guren/cli/vite'
import { defineConfig } from 'vite'
import guren from '@guren/core/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Parallel worktree sessions each start a managed Vite on 5173; on macOS the
// IPv4/IPv6 split lets two of them "succeed" on the same port while the
// browser's `localhost` reaches only one. An explicit port opts a session out.
const devPort = Number.parseInt(process.env.GUREN_VITE_PORT ?? '', 10)

export default defineConfig(({ command }) => ({
  publicDir: false,
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
