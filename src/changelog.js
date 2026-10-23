// User-facing release notes — newest first. All are listed in About; the "What's new" popup
// after an update only shows versions from POPUP_FROM on. `quiet: true` = About only, no popup.
// Keep items short and written for photographers, not developers.
export const POPUP_FROM = '0.9.4'

export const CHANGELOG = [
  {
    version: '1.1.1',
    date: '2026-10-24',
    title: 'Tone curves',
    items: [
      'Presets with Red, Green or Blue tone curves now look like they do in the editor they were made in.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-23',
    title: 'Presets look right',
    items: [
      'Light sliders, Saturation and Color Mixer re-measured: imported presets now look like they do in the editor they were made in.',
      'Calibration from imported presets is now applied (no panel yet).',
      'Note: photos edited in earlier versions will look a little different.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-08',
    title: 'New look',
    items: [
      'New LumaGrader logo and a cleaner, calmer editor.',
      'Top bar simplified: Save, Export and one ⋯ menu for everything else.',
      'Resize the editing panel by dragging its edge.',
      'Filmstrip: show or hide it, put it on the left or at the bottom, pick the thumbnail size.',
      'Slider values are easier to type in, and changed values are highlighted.',
      'Clearer saving and exporting: progress, Saved ✓, and Try again if something fails.',
      'Asks before removing a photo or deleting a mask.',
      'Crop: the frame stays on the photo when you straighten (no black corners), plus edge handles and a grid.',
      'Masks: Duplicate, Feather and Amount you can change after painting, smoother edges, and the red overlay only while you paint.',
      'Fixed: the photo flickered or changed brightness when you let go of a slider.',
      'Removed: the LUTs section.',
    ],
  },
  {
    version: '0.9.8',
    date: '2026-09-27',
    title: 'More Lightroom presets',
    items: [
      'Import Lightroom presets in every common form: .xmp, .dng (Lightroom Mobile), .lrtemplate (older Lightroom) or a .zip pack — now also on iPad.',
      'Fixed: .xmp presets and .cube LUTs couldn\'t be picked on iPad.',
    ],
  },
  {
    version: '0.9.7',
    date: '2026-09-27',
    title: 'Phone speed fix',
    quiet: true,
    items: [
      'Fixed: on phones with Mali graphics (many Xiaomi, Samsung, Oppo…) the editor was stuck in the slow compatibility mode. It now uses the graphics chip again.',
      'Fixed: after locking the phone or switching apps, the editor could get stuck in a slow mode. It now stays fast.',
      '"Try GPU again" button when compatibility mode is on; automatic retry when you come back to the app.',
      'White balance selector is now a target you drag onto something grey or white, with a magnifier and live preview; Done or Cancel when finished.',
    ],
  },
  {
    version: '0.9.6',
    date: '2026-09-27',
    title: 'White Balance Picker & Preset Amount',
    quiet: true,
    items: [
      'White balance selector: tap something grey or white in the photo to fix the colour cast.',
      'Preset Amount: after applying a preset, set its strength from 0% to 200%.',
      'Fixed: applying a preset to several selected photos no longer copies one photo\'s crop, masks or spot removal to the others.',
    ],
  },
  {
    version: '0.9.5',
    date: '2026-09-27',
    title: 'Phone fix',
    quiet: true,
    items: ['Fixed: on some phones the photo could still go blank. The app now recovers by itself and switches to a compatibility mode if the graphics chip keeps failing.'],
  },
  {
    version: '0.9.4',
    date: '2026-09-27',
    title: 'Healing, Masks, Albums & more',
    items: [
      'Heal & Clone: tap a dust spot or blemish to remove it; drag to adjust.',
      'New Luminance and Color range masks; any mask can be refined by brightness or colour. Brush masks are now saved with your project.',
      'Lens corrections: Distortion, Vignetting and Remove Chromatic Aberration.',
      'Snapshots: save named versions of a photo\'s edit and switch between them anytime.',
      'Albums: group a project\'s photos (e.g. Day 1, Best shots) — saved with the project.',
      'Save a project to your device as one .lumagrader file (original photos + all edits) and open it again from Projects → Open file.',
      'Saved presets are kept more safely and travel with your .lumagrader project files.',
      'New user guide — open it from About.',
      'Fixed: very large photos opened blank on some phones. They now load faster and use much less memory.',
    ],
  },
  {
    version: '0.9.3',
    date: '2026-09-27',
    title: 'No more update popup',
    items: ['The "What\'s new" popup no longer appears after an update. Release notes are still in About.'],
  },
  {
    version: '0.9.2',
    date: '2026-09-27',
    title: 'Maintenance',
    items: ['Behind-the-scenes cleanup. Your photos and edits look exactly the same.'],
  },
  {
    version: '0.9.1',
    date: '2026-09-27',
    title: 'Phone fixes & support',
    items: [
      'Fixed: on some phones the photo went blank after zooming in (the graphics chip ran out of memory). The app now stays within the phone\'s limits and recovers by itself if it happens.',
      'Exports on phones automatically fit what the device can handle.',
      'You can now support LumaGrader on Ko-fi (About → Support).',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-09-27',
    title: 'Presence & Effects',
    items: [
      'Clarity and Texture now work on brightness only (no colour shifts); Clarity focuses on the midtones without halos, Texture on fine detail (skin, foliage) and leaves strong edges alone.',
      'Dehaze now estimates the haze in each area of the photo; negative Dehaze adds a soft haze.',
      'Presence effects look the same in the preview and in the full-size export.',
      'Vignette: new Midpoint, Roundness, Feather and Highlights sliders (applied after crop).',
      'Grain: new Size and Roughness sliders.',
      'This "What\'s new" popup, and an About page with the version and full history.',
    ],
  },
  {
    version: '0.8.1',
    date: '2026-09-27',
    title: 'Color Grading fine-tuned',
    items: [
      'Color Grading strength, tonal ranges and wheel hues fine-tuned (e.g. 200° is teal).',
      'Softer, film-like Grain that looks the same in the preview and the export.',
      'A notice appears if a RAW could only be opened as the camera preview.',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-27',
    title: 'Color Grading',
    items: [
      'Shadows / Midtones / Highlights / Global colour wheels with Luminance, Blending and Balance.',
      '.xmp presets with Color Grading or Split Toning import fully.',
    ],
  },
  {
    version: '0.7.4',
    date: '2026-09-27',
    title: 'White balance in Kelvin',
    items: [
      'RAW photos: Temp in Kelvin and Tint, starting from the camera\'s As Shot values.',
      'The histogram updates live while you drag a slider.',
      'New "Luma Color" base look for RAW photos, with richer, more natural colour.',
      'Profiles renamed: Luma Color, Luma Standard, Luma Vivid, …',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-09-27',
    title: 'New colour engine',
    items: [
      'Real white balance, plus new Vibrance, Saturation and HSL.',
      'Texture, Clarity and Dehaze go negative; negative Vignette now darkens the corners.',
    ],
  },
  {
    version: '0.6.3',
    date: '2026-09-27',
    title: 'Safer editing on phones',
    items: [
      'Unsaved work is kept if the app closes — you\'re offered to restore it next time.',
      'Sliders only move when you drag their handle, so scrolling never changes a value.',
      'Bigger photo on phones.',
    ],
  },
  {
    version: '0.6.1',
    date: '2026-09-27',
    title: 'Curves',
    items: ['Separate Red, Green and Blue tone curves, drawn as smooth curves.'],
  },
]

/** Compares dotted versions: negative if a < b. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}
