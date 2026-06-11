import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves from /synthtagram/ — keep base in sync with the repo name.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/synthtagram/' : '/',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1500 },
}))
