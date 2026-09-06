import { routeTypesPlugin } from '@guren/cli/vite'
import guren from '@guren/core/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => ({
  publicDir: false,
  plugins: [
    // The `guren` package is not on npm, so the plugin's default `bun x --bun
    // guren` fails in the monorepo. Dev-server only; the build script already
    // runs codegen before `vite build`.
    ...(command === 'serve' ? [routeTypesPlugin({ args: ['run', 'codegen'] })] : []),
    guren(),
    react(),
    tailwindcss(),
  ],
}))
