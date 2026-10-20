# LumaGrader website + web editor

This repo is **lumagrader.app**:

- **`/`**: the download site for **LumaGrader Photo Studio**, the free, open-source Mac app
  (source: [RMalayte/lumagrader-photo-studio](https://github.com/RMalayte/lumagrader-photo-studio)).
  `index.html` + `src/home/` (no framework). The Download button finds the newest `.dmg` in that
  repo's GitHub Releases and then shows a thank-you card with the Ko-fi link.
- **`/editor/`**: the **LumaGrader web editor**, a free RAW and JPEG photo editor that runs
  entirely in the browser, on phones and computers. `editor/index.html` + the rest of `src/`.

**▶ Web editor:** <https://lumagrader.app/editor/>
**📖 [User guide](docs/USER_GUIDE.md)** · **☕ [Support on Ko-fi](https://ko-fi.com/lumagrader)**

The editor moved from `/` to `/editor/` in October 2026. Same origin, so projects and presets saved
in the browser are kept. `public/sw.js` is a retired service worker that removes the old root
worker and its caches; the editor's worker, manifest and LibRaw files live in `public/editor/`.

**Privacy:** your photos never leave your device. RAW decoding, editing and export all run in
the browser. There is no server, account, analytics or upload.

## Features

- **RAW + JPEG/PNG/WebP**: real sensor decoding for CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2,
  PEF and SRW, with the camera's embedded preview as a fallback
- **Light**: Exposure, Contrast, Highlights, Shadows, Whites, Blacks, RGB and per-channel curves
- **Color**: white balance in Kelvin, Vibrance, Saturation, HSL, Color Grading wheels, profiles
- **Detail & effects**: Texture, Clarity, Dehaze, sharpening, noise reduction, vignette, grain
- **Optics & geometry**: distortion, lens vignetting, chromatic aberration removal, crop,
  straighten and rotate
- **Local edits**: Heal/Clone spots; Linear, Radial, Brush, Luminance and Color masks
- **Organise**: albums, star ratings, snapshots, presets (`.json` and `.xmp` import)
- **Save**: projects in the browser, `.lumagrader` project files on your device, crash recovery
- **Export**: JPEG/PNG/WebP, resize, watermark, batch export as ZIP
- **Works offline** after the first visit, and can be installed as an app

## Getting started (development)

Requires Node.js 20+.

```bash
npm install
npm run dev       # local dev server (add -- --host to test on a phone on the same Wi-Fi)
npm run lint      # ESLint
npm run build     # production build → dist/
npm run preview   # serve the production build locally
```

`npm install` also copies the LibRaw WebAssembly files into `public/libraw/` (git-ignored).

## Deployment

Hosted on **Cloudflare Pages**, connected to this GitHub repo, at **lumagrader.app**.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js | 20 (from `.node-version`) |

Pushing to `main` deploys the live site. Pushing any other branch gives a preview deploy at
its own `*.pages.dev` address (HTTPS), handy for testing on a phone before merging.
GitHub Actions (`.github/workflows/ci.yml`) only lints and builds; it doesn't publish anything.

## Project structure

```
src/
├── components/   UI (panels, filmstrip, preview, dialogs)
├── engine/       image pipeline: tone, colour, RAW develop, masks, healing, lens,
│   └── webgl/    WebGL2 renderer and shaders (Canvas 2D fallback in pipeline.js)
├── hooks/        import, saving, IndexedDB storage, crash recovery
├── store/        app state (React Context + useReducer)
├── workers/      RAW decoding and developing off the main thread
└── changelog.js  release notes shown in the app
docs/             user guide and developer notes
public/           icons, web manifest, service worker
```

More detail on the architecture and release steps: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Known limitations

- Projects and presets are stored in the browser they were saved in. Use **Save to device**
  for backups or to move work to another device.
- Full-size RAW export can take 10–15 s for a 24 MP file and needs a few hundred MB of memory.
- On phones, very large images are zoomed and exported at the largest size the device's
  graphics chip supports.
- Masks require WebGL.

## Contributing

Issues and pull requests are welcome.

1. Fork the repo and create a branch (`git checkout -b fix/short-description`).
2. `npm install`, then `npm run dev`.
3. Before pushing, `npm run lint` and `npm run build` must pass. CI runs both on every push and PR.
4. Keep changes focused and use commit messages like `feat: …`, `fix: …` or `docs: …`.
5. Never commit secrets (`.env` files are git-ignored) or personal photos.

## License

[MIT](LICENSE) © 2026 LumaGrader.

Third-party components keep their own licenses:

| Component | License |
|---|---|
| LibRaw (via `libraw-wasm`, loaded as a separate, unmodified `.wasm`) | LGPL-2.1 or CDDL-1.0 (wrapper: ISC) |
| React, exifr, extract-raw-preview, piexifjs | MIT |
| JSZip | MIT (dual MIT / GPL-3.0) |

The MIT license covers the code. The "LumaGrader" name and logo identify the original
project; if you publish a fork, please give it a different name and logo.
