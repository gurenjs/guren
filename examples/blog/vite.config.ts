import { routeTypesPlugin } from '@guren/cli/vite'
import guren from '@guren/server/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [routeTypesPlugin(), guren(), react(), ...tailwindcss()],
})
