import { routeTypesPlugin } from '@guren/cli/vite'
import guren from '@guren/core/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => ({
  publicDir: false,
  plugins: [
    // The app's codegen script runs the CLI from source, where the plugin's
    // default spawns the built dist/bin.js. Dev-server only; the build script
    // already runs codegen before `vite build`.
    ...(command === 'serve' ? [routeTypesPlugin({ args: ['run', 'codegen'] })] : []),
    guren(),
    react(),
    tailwindcss(),
  ],
}))
