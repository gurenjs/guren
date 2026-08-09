import { routeTypesPlugin } from '@guren/cli/vite'
import { defineConfig } from 'vite'
import guren from '@guren/core/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  publicDir: false,
  plugins: [
    // web's codegen script runs a prerender:stub pre-step the plugin's default
    // command has no equivalent for — reuse the script so watcher-triggered
    // regeneration matches `bun run codegen` exactly.
    routeTypesPlugin({ args: ['run', 'codegen'] }),
    guren(),
    react(),
    tailwindcss(),
  ],
})
