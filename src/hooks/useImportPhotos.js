import { useProject } from '../store/ProjectContext'
import { useFeedback } from '../store/FeedbackContext'
import { defaultSettings } from '../engine/defaults'
import { isRawFile } from '../engine/rawFormats'
import { makeImageEntry } from '../engine/imageStore'

let nextId = 1
export const newImageId = () => `img_${Date.now().toString(36)}_${nextId++}`

export const SUPPORTED_EXT = /\.(jpe?g|png|webp|cr2|cr3|nef|arw|dng|orf|rw2|raf|pef|srw)$/i
export const FILE_ACCEPT = 'image/*,.cr2,.cr3,.nef,.arw,.dng,.orf,.rw2,.raf,.pef,.srw'

/**
 * Decodes a photo once (for its thumbnail + first preview) and returns the lightweight
 * record kept in state: { sourceBlob, thumbUrl, width, height }. JPEG/PNG keep the file itself
 * (EXIF orientation is applied on decode); RAW keeps its upright embedded preview JPEG.
 */
export async function ingestPhoto(blob, isRaw, id) {
  if (!isRaw) return makeImageEntry(blob, id)

  // RAW: the camera's embedded JPEG is still extracted — as the look target for developing
  // the real sensor data, and as the fallback if the RAW can't be decoded here.
  const { loadRawPreview } = await import('../engine/rawUtils') // RAW libs load on demand
  const embedded = await loadRawPreview(blob)
  try {
    const { decodeAndDevelopRaw, targetStatsFromBlob, imageDataToBlob } = await import('../engine/rawPipeline')
    const target = embedded ? await targetStatsFromBlob(embedded) : null
    const { imageData, params, asShotWB, colorUnknown, camera } = await decodeAndDevelopRaw(blob, { half: true, target })
    const bitmap = await createImageBitmap(imageData)
    const sourceBlob = await imageDataToBlob(imageData)
    const entry = await makeImageEntry(sourceBlob, id, bitmap)
    // Half-size decode for editing; report the real sensor resolution (export decodes full size).
    return {
      ...entry, width: entry.width * 2, height: entry.height * 2, rawDevelop: params, rawSource: 'libraw', wbAsShot: asShotWB || null,
      ...(colorUnknown ? { rawColorUnknown: camera || 'this camera' } : {}),
    }
  } catch (err) {
    console.warn('RAW decode failed — using the embedded preview instead.', err)
    if (!embedded) throw err
    return { ...(await makeImageEntry(embedded, id)), rawSource: 'embedded', rawError: String(err?.message || err).slice(0, 160) }
  }
}

/** Shared photo import (file picker, folder picker, drag & drop) with progress + toasts. */
export function useImportPhotos() {
  const { state, dispatch } = useProject()
  const { toast } = useFeedback()

  async function importFiles(fileList) {
    const all = Array.from(fileList || [])
    const files = all.filter((f) => SUPPORTED_EXT.test(f.name) || f.type.startsWith('image/'))
    const skipped = all.length - files.length
    if (!files.length) {
      if (all.length) toast('No supported photos in what you dropped', { type: 'error' })
      return
    }

    const hadNone = state.images.length === 0
    const failed = []
    const previewOnly = []
    const colorUnknown = new Set()
    let added = 0
    dispatch({ type: 'SET_IMPORT_PROGRESS', progress: { done: 0, total: files.length } })

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx]
      try {
        const isRaw = isRawFile(file.name)
        const id = newImageId()
        const entry = await ingestPhoto(file, isRaw, id)
        dispatch({
          type: 'ADD_IMAGES',
          images: [{
            id,
            name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
            ...entry,
            originalBlob: file,
            isRawPreview: isRaw,
            rating: 0,
            settings: defaultSettings(),
            history: { past: [], future: [] },
          }],
        })
        if (hadNone && added === 0) dispatch({ type: 'SET_ACTIVE', id })
        if (entry.rawSource === 'embedded') previewOnly.push(file.name)
        if (entry.rawColorUnknown) colorUnknown.add(entry.rawColorUnknown)
        added++
      } catch (err) {
        console.warn('Failed to load', file.name, err)
        failed.push(file.name)
      }
      dispatch({ type: 'SET_IMPORT_PROGRESS', progress: { done: idx + 1, total: files.length } })
    }

    dispatch({ type: 'SET_IMPORT_PROGRESS', progress: null })
    if (added) toast(`Imported ${added} photo${added === 1 ? '' : 's'}`)
    if (failed.length) {
      const names = failed.slice(0, 2).join(', ') + (failed.length > 2 ? ` +${failed.length - 2} more` : '')
      toast(`Couldn't open ${failed.length} file${failed.length === 1 ? '' : 's'}: ${names}`, { type: 'error', duration: 7000 })
    }
    if (previewOnly.length) {
      // Visible, so a silent fallback to the camera's JPEG preview is never mistaken for the real RAW.
      const names = previewOnly.slice(0, 2).join(', ') + (previewOnly.length > 2 ? ` +${previewOnly.length - 2} more` : '')
      toast(`${names}: RAW data couldn't be decoded — using the camera preview. Reload the page and import again; if it keeps happening, check the console.`, { type: 'error', duration: 9000 })
    }
    if (colorUnknown.size) {
      // LibRaw has no colour profile for this camera yet → colours will be off; DNG carries its own.
      const cams = [...colorUnknown].slice(0, 2).join(', ')
      toast(`${cams}: no colour profile for this camera yet, so colours may look off. Converting the files to DNG first gives correct colours.`, { type: 'error', duration: 10000 })
    }
    if (skipped) toast(`Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}`, { type: 'error' })
  }

  async function importFolder() {
    if (!window.showDirectoryPicker) {
      toast('Folder import needs Chrome or Edge. Use "Add photos" instead.', { type: 'error', duration: 6000 })
      return
    }
    try {
      const dirHandle = await window.showDirectoryPicker()
      const files = []
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file' && SUPPORTED_EXT.test(name)) files.push(await handle.getFile())
      }
      if (!files.length) {
        toast('No supported photos in that folder', { type: 'error' })
        return
      }
      await importFiles(files)
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Folder import failed:', err)
        toast('Could not open that folder', { type: 'error' })
      }
    }
  }

  return { importFiles, importFolder, importing: !!state.importProgress, progress: state.importProgress }
}
