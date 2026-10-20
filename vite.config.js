import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const root = new URL('.', import.meta.url).pathname

// Two pages: the download site (index.html → /) and the web editor (editor/index.html →
// /editor/). Relative base: the same build works at lumagrader.app, on Cloudflare Pages
// preview addresses and in any subfolder, without hardcoding a path.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        home: resolve(root, 'index.html'),
        editor: resolve(root, 'editor/index.html'),
      },
    },
  },
  // App version + build date for the About dialog and the "What's new" popup.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
})
