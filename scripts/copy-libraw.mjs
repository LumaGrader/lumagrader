// Copies the LibRaw WebAssembly build into public/editor/libraw/ (served at /editor/libraw/) so it is served as-is (its worker
// loads libraw.wasm relative to itself, which bundlers would otherwise rename/break).
// Runs automatically after `npm install` and before `npm run dev` / `npm run build`.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = path.join(root, 'node_modules', 'libraw-wasm', 'dist')
const dst = path.join(root, 'public', 'editor', 'libraw')
if (!fs.existsSync(src)) {
  console.warn('[copy-libraw] libraw-wasm not installed — RAW files will use their embedded previews.')
  process.exit(0)
}
fs.mkdirSync(dst, { recursive: true })
for (const f of ['worker.js', 'libraw.js', 'libraw.wasm']) fs.copyFileSync(path.join(src, f), path.join(dst, f))
fs.copyFileSync(path.join(root, 'scripts', 'LIBRAW_NOTICE.txt'), path.join(dst, 'NOTICE.txt'))
console.log('[copy-libraw] copied LibRaw WASM to public/editor/libraw/')
