import { routeTypesPlugin } from '@guren/cli/vite'
import guren from '@guren/core/vite'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  publicDir: false,
  plugins: [routeTypesPlugin(), guren(), react(), tailwindcss()],
})
