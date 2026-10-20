// Turns dist-editor/ (vite.editor.config.js) into one self-contained folder, editor-pack/editor/,
// to copy into the website repo: index.html + assets/ + the editor's service worker, manifest
// and LibRaw files. Everything inside is referenced relatively, so it works at /editor/.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const built = path.join(root, 'dist-editor')
const out = path.join(root, 'editor-pack', 'editor')
fs.rmSync(path.join(root, 'editor-pack'), { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const html = fs.readFileSync(path.join(built, 'editor', 'index.html'), 'utf8').replaceAll('../assets/', './assets/')
fs.writeFileSync(path.join(out, 'index.html'), html)
fs.cpSync(path.join(built, 'assets'), path.join(out, 'assets'), { recursive: true })
fs.cpSync(path.join(root, 'public', 'editor'), out, { recursive: true }) // sw.js, manifest, libraw/
console.log('[pack-editor] editor-pack/editor ready')
