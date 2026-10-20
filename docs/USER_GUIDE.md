# LumaGrader User Guide

LumaGrader is a free photo editor that runs in your browser, on a computer or a phone.
Open it, add photos, edit, and export. There is no account and nothing is uploaded: your
photos and edits stay on your device.

**Open the app:** <https://lumagrader.app>

---

## Contents

1. [Getting started](#1-getting-started)
2. [The screen](#2-the-screen)
3. [Editing tools](#3-editing-tools)
4. [Presets and profiles](#4-presets-and-profiles)
5. [Healing, masks and optics](#5-healing-masks-and-optics)
6. [Albums, ratings and snapshots](#6-albums-ratings-and-snapshots)
7. [Saving your work](#7-saving-your-work)
8. [Exporting](#8-exporting)
9. [Using it on a phone](#9-using-it-on-a-phone)
10. [Keyboard shortcuts](#10-keyboard-shortcuts)
11. [Tips and troubleshooting](#11-tips-and-troubleshooting)

---

## 1. Getting started

1. Open the app in Chrome, Edge, Firefox or Safari (a recent version).
2. Press **Add photos** (or **Open folder**), or drag photos onto the window.
3. Pick a photo in the filmstrip and start editing with the panels on the right
   (on a phone: the tabs at the bottom).
4. Press **Save Project** to keep your work, and **Export** to get finished JPEG/PNG/WebP files.

**Supported files:** JPEG, PNG, WebP and camera RAW files (CR2, CR3, NEF, ARW, DNG, RAF, ORF,
RW2, PEF, SRW). RAW files are developed from the real sensor data. If a RAW can't be decoded,
the camera's built-in preview is used instead, and a notice tells you.

**Install it (optional):** in Chrome, use *Install app* / *Add to Home screen*. It then opens
like a normal app and works offline after the first visit.

## 2. The screen

| Area | What it's for |
|---|---|
| **Header** | Views (Filmstrip, Loupe, Projects), Reset / Copy to all / Remove, **Export**, **Save Project**, save to device, shortcuts, Support, About |
| **Filmstrip** (left) | Your photos, the **Albums** button, star ratings. Shift/Ctrl+click selects several photos |
| **Photo** (centre) | Zoom (Fit, 1:1, pinch or scroll), Before/After, Crop, Fullscreen, histogram and photo info |
| **Panels** (right) | All editing tools, grouped: Look, Light, Color, Detail, Heal, Masks |

- **Before/After** (`\`) compares your edit with the original. On a phone, touch and hold the photo.
- **Undo / Redo** work per photo (`Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`).
- Each panel has an **eye** button (turn that panel's changes off for a moment) and a
  **reset** button.
- Double-click a slider (double-tap its handle on a phone) to reset it.

## 3. Editing tools

### Light
- **Exposure** (in stops), **Contrast**, **Highlights**, **Shadows**, **Whites**, **Blacks**.
  Highlights and Shadows adapt to the surrounding area, so detail and texture are kept.
- **Curves:** RGB, Red, Green and Blue point curves. Click to add a point, drag it off the
  graph to remove it.
- Press **J** to show clipped highlights (red) and shadows (blue).

### Color
- **White balance:** RAW photos use **Temp** in Kelvin and **Tint**, starting from the camera's
  *As Shot* values. JPEGs get relative Temp/Tint sliders.
  - **White balance selector** (eyedropper next to *White Balance*): a target appears on the
    photo. Drag it (or tap to move it) onto something that should be neutral grey or white — a
    grey wall, a white shirt, pavement, clouds. A magnifier above it shows the exact pixels, and
    Temp/Tint update live. Blown-out whites and near-black areas are skipped (the target turns
    red). **Done** keeps the result, **Cancel** (or Esc) puts back what you had.
- **Vibrance** (boosts muted colours and protects skin tones) and **Saturation**.
- **HSL:** Hue, Saturation and Luminance for eight colour ranges. Use the eyedropper to pick
  a colour on the photo.
- **Color Grading:** Shadows, Midtones, Highlights and Global colour wheels with Luminance, plus
  **Blending** and **Balance**. Drag a wheel's dot; double-tap the dot to reset it.

### Detail
- **Texture** (fine detail), **Clarity** (midtone contrast), **Dehaze**. All go negative too,
  to soften or add haze.
- **Sharpening** (Amount, Radius, Detail, Masking) and **Noise Reduction** (luminance and colour).
- **Effects:** **Vignette** (Amount, Midpoint, Roundness, Feather, Highlights; applied after
  the crop) and **Grain** (Amount, Size, Roughness).
- **Optics:** see [section 5](#optics).

### Crop
Press **Crop** (`R`) to crop, straighten or rotate by 90°. Choose an aspect ratio or crop freely;
drag a corner or an edge to resize. When you straighten, the crop shrinks just enough that no
empty corners show. Straighten moves in 0.1° steps — double-click it to go back to 0°.

## 4. Presets and profiles

- **Profile:** the photo's starting look: Luma Color, Standard, Vivid, Landscape, Portrait,
  Neutral or Monochrome.
- **Grade presets:** apply a look with one click. **Save current as preset** stores this
  photo's look (never the crop, masks or spots) so you can use it on any photo.
  - **Amount:** after you apply a preset, an *Amount* slider appears above the presets.
    0% = your photo without the preset, 100% = the preset as made, up to 200% for a stronger
    version. Trying another preset keeps 0% as your original photo. The slider goes away once
    you edit something else (Undo brings it back).
  - **Import presets:** Lightroom presets in any of their usual forms — `.xmp`, `.dng`
    (how Lightroom Mobile presets are shared), `.lrtemplate` (older Lightroom Classic) or a
    `.zip` pack of them — plus LumaGrader `.json` files. Pick several at once. Lightroom looks
    are translated to the closest LumaGrader settings (approximate); masks, graduated filters
    and spot removal inside a preset are skipped, and a DNG's crop is never applied.
  - **Export presets:** saves all your presets into one `.json` file, a good backup.
- To apply to several photos, select them first (Shift/Ctrl+click), or use **⋯ → Copy edits to all photos**.

Your presets are saved in the browser and also travel inside project files you save to your
device (see [section 7](#7-saving-your-work)).

## 5. Healing, masks and optics

### Healing (Heal tab)
1. Open **Healing** and tap a dust spot or blemish on the photo.
2. LumaGrader picks a clean area to copy from (the dashed circle).
3. Drag the circle to move the spot, or drag the dashed circle to choose another source.
4. Adjust **Size**, **Feather** and **Opacity**. **Heal** blends texture and colour; **Clone**
   copies exactly. Press `Delete` to remove the selected spot.

### Masks (Masks tab)
Masks let you edit only part of the photo, with their own Exposure, Contrast, Saturation,
Temperature, Sharpness and Noise Reduction.

| Mask | How it selects |
|---|---|
| **Linear** | A soft gradient, e.g. a sky. Drag on the photo |
| **Radial** | An ellipse, e.g. a face. Drag on the photo |
| **Brush** | Paint it yourself. Size, Hardness, Flow and an eraser |
| **Luminance** | Everything within a brightness range (Darkest, Brightest, Smoothness) |
| **Color** | Everything close to a colour you tap on the photo (Range sets how close) |

Any Linear, Radial or Brush mask can also be **refined by** luminance or colour, e.g. a
linear mask that only touches the blue of the sky. **Invert** flips a mask and **Show overlay**
tints the selected area red.

### Optics
In **Detail → Optics**:
- **Remove chromatic aberration** removes purple/green colour fringes near the edges.
- **Distortion** straightens bulging (barrel, +) or pinched (−) lines.
- **Vignetting** brightens (+) or darkens (−) the lens's dark corners; **Midpoint** sets how
  far in it reaches.

## 6. Albums, ratings and snapshots

### Albums
Albums group photos inside a project, e.g. *Day 1*, *Portraits*, *Best shots*. A photo can be
in several albums.

- Press the **Albums** button at the top of the filmstrip.
- **New album…** creates one and adds the current photo (or all selected photos).
- **+** next to an album adds the current/selected photos to it.
- Pick an album to show only its photos. Photos you import while an album is open go into it.
- In an open album: **Remove from album**, **Rename album…**, **Delete album**. Deleting an
  album never deletes the photos.
- Albums are saved with the project (in the browser and in project files).

### Ratings
Give a photo 1–5 stars in the filmstrip or with the keys `1`–`5` (`0` clears).

### Snapshots
In **Look → Snapshots**, **+ Create snapshot** saves the photo's whole edit under a name, e.g.
"Warm" and "B&W". Click a snapshot to go back to it (Undo restores the previous edit).
Use Rename, Update or Delete to manage them. Snapshots are saved with the project.

## 7. Saving your work

There are two ways to save, and you can use both:

| | **Save Project** | **Save to device** |
|---|---|---|
| Where | In this browser, listed under **Projects** | A `.lumagrader` file in your Downloads/Files |
| Good for | Everyday work on this device | Backups, moving to another phone or computer, freeing browser space |
| Contains | Original photos, all edits, snapshots, masks, albums, ratings | The same, plus your saved presets |

- **Save Project** (`Ctrl/⌘+S`): the first time it asks for a name; after that it updates the
  same project. Click the project name in the header to rename it.
- **Save to device:** the download icon next to Save Project (desktop), **⋯ → Save project
  to device** (phone), or the download icon on a project card in **Projects**.
- **Open a file:** **Projects → Open file**, then choose a `.lumagrader` file. Press
  **Save Project** afterwards to also keep it in this browser. Presets from the file that you
  don't have yet are added automatically.
- **Crash recovery:** unsaved work is kept while you edit. If the tab closes or the phone runs
  out of memory, the app offers to **Restore** it the next time you open it.
- An orange dot on Save Project means there are unsaved changes.

> Browser storage belongs to one browser on one device, and is removed if you clear your
> browsing data or use a private/incognito window. Save important projects to your device too.

## 8. Exporting

Press **Export** and choose **This photo**, **Selected photos** or **All photos**.

- **Format:** JPEG (with Quality), PNG or WebP.
- **Size:** Original, 2048 px, 1920 px or 1080 px on the long side.
- **Watermark:** none, text or your logo, in a corner or the centre.
- Several photos are downloaded together as a ZIP.

On phones, very large photos are exported at the largest size the phone's graphics chip
supports, and the app tells you when that happens.

## 9. Using it on a phone

- The photo fills the screen; the tools are in tabs at the bottom (**Look, Light, Color,
  Detail, Heal, Masks**). Tap the open tab again to hide the tools.
- Sliders only move when you drag their **handle**, so scrolling never changes them by
  accident. Double-tap a handle to reset it.
- Swipe left/right on the photo for the next/previous photo; pinch or double-tap to zoom;
  touch and hold for Before.
- The filmstrip button in the header shows the photos and the Albums button.
- **⋯** holds Reset, Copy edits, Save project to device, Support, About and Remove.

## 10. Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/⌘ + Z` / `Ctrl/⌘ + Shift + Z` | Undo / Redo |
| `Ctrl/⌘ + S` | Save project |
| `Ctrl/⌘ + E` | Export this photo |
| `Del` | Remove photo (undoable) |
| `\` | Before / After |
| `Z` | Toggle Fit ↔ 1:1 |
| `+` / `−` | Zoom in / out |
| `J` | Show clipping |
| `R` | Crop |
| `F` | Fullscreen |
| `I` | Show / hide photo info |
| `←` / `→` | Previous / next photo (within the open album) |
| `1`–`5`, `0` | Star rating, clear rating |
| `?` | Show all shortcuts |

## 11. Tips and troubleshooting

- **My presets or projects are gone.** Browser storage is per browser *and* per web address.
  A project saved at one address (for example a local test copy) won't appear at another.
  Clearing browsing data or using incognito removes it too. Keep backups with **Export
  presets** and **Save to device**.
- **"Ran low on graphics memory" / "compatibility mode".** The phone's graphics chip gave up
  (often on low-memory phones). Locking the phone or switching apps is handled quietly and is
  not a problem. The app recovers by itself: first with a lighter preview, then, if it keeps
  failing, in compatibility mode (slower, masks off). While in compatibility mode a
  **Try GPU again** button sits on the photo, and the app retries by itself when you come back
  to it. *About → Diagnostics* shows which mode the preview is in.
- **"RAW preview" badge:** this RAW couldn't be decoded, so the camera's embedded JPEG is used.
  Please [report it](https://github.com/LumaGrader/lumagrader/issues) with the camera model.
- **Masks do nothing:** masks need WebGL. Turn on hardware acceleration in your browser settings,
  and tap **Try GPU again** if the app switched to compatibility mode.
- **Something else?** [Report a problem](https://github.com/LumaGrader/lumagrader/issues). Please
  include your device, browser and what you did.

---

LumaGrader is free and open source (MIT). If it helps you, you can support it on
[Ko-fi](https://ko-fi.com/lumagrader).
