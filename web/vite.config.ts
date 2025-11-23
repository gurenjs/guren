import { routeTypesPlugin } from '@guren/cli/vite'
import { defineConfig } from 'vite'
import guren from '@guren/server/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [routeTypesPlugin(), guren(), react(), tailwindcss()],
  build: {
    // Prevent Vite from copying `public/` into `public/assets` (outDir) which fails on Vite 7+
    copyPublicDir: false,
  },
})
