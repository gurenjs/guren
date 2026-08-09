import { routeTypesPlugin } from '@guren/cli/vite'
import { defineConfig } from 'vite'
import guren from '@guren/core/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => ({
  publicDir: false,
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
