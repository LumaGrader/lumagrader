import { chromium } from '/opt/node-tools/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const pg = await b.newPage(); pg.on('console', m => console.log('page:', m.text())); pg.on('pageerror', e => console.log('err', e.message))
await pg.goto('http://localhost:5179/.tmptest/index.html'); await pg.waitForFunction(() => window.run)
const o = await pg.evaluate(() => window.run())
let sum = 0, mx = 0
for (let i = 0; i < o.gpu.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(o.gpu[i + c] - o.cpu[i + c]); sum += d; mx = Math.max(mx, d) }
console.log('size', o.w, o.h, 'mean abs diff', (sum / (o.gpu.length * 0.75)).toFixed(3), 'max', mx)
const fs = await import('fs'); fs.writeFileSync('out.json', JSON.stringify({ w: o.w, h: o.h, gpu: o.gpu }))
await b.close()
