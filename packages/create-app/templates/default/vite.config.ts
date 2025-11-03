import { defineConfig } from 'vite'
import guren from '@guren/server/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [guren(), react(), ...tailwindcss()],
})
