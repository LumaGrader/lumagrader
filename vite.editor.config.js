import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const root = new URL('.', import.meta.url).pathname

// Editor-only build for the static website repo (LumaGrader/website): `npm run build:editor`
// → dist-editor/. scripts/pack-editor.mjs then turns it into a self-contained editor/ folder.
export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist-editor',
    emptyOutDir: true,
    rollupOptions: { input: { editor: resolve(root, 'editor/index.html') } },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
})
