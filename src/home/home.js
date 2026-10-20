// Download site: finds the newest Mac release on GitHub, starts the download and shows the
// thank-you card (with the Ko-fi link). Works without JavaScript too: the button then opens
// the GitHub releases page.
import '@fontsource-variable/archivo/wdth.css'

const REPO = 'RMalayte/lumagrader-photo-studio'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const KOFI_USERNAME = 'lumagrader' // ko-fi.com/lumagrader, same page as the Mac app

const button = document.getElementById('download-btn')
const meta = document.getElementById('download-meta')
const dialog = document.getElementById('thanks')
const retry = document.getElementById('thanks-retry')
const thanksFile = document.getElementById('thanks-file')

for (const link of document.querySelectorAll('[data-kofi]')) link.href = `https://ko-fi.com/${KOFI_USERNAME}`

let dmg = null // { url, name, version, sizeMB }

async function findLatestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return // no release yet, or rate-limited: keep the releases-page link
    const release = await res.json()
    const asset = (release.assets || []).find((a) => /\.dmg$/i.test(a.name))
    if (!asset) return
    dmg = {
      url: asset.browser_download_url,
      name: asset.name,
      version: String(release.tag_name || '').replace(/^v/i, ''),
      sizeMB: Math.round(asset.size / 1e6),
    }
    button.href = dmg.url
    retry.href = dmg.url
    const version = dmg.version ? `Version ${dmg.version}, ` : ''
    meta.textContent = `${version}${dmg.sizeMB} MB. Free. Needs macOS 14 Sonoma or newer, Apple silicon or Intel.`
  } catch {
    // Offline or blocked: the button still opens the releases page.
  }
}

button.addEventListener('click', (event) => {
  // Without a direct file link, let the button open the GitHub releases page as usual.
  if (!dmg || typeof dialog.showModal !== 'function') return
  event.preventDefault()
  // Start the download in a hidden frame so this page (and the thank-you card) never navigates
  // away, even if the file server answered without a download header.
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = dmg.url
  document.body.append(frame)
  setTimeout(() => frame.remove(), 60_000)
  thanksFile.textContent = `${dmg.name} is in your Downloads folder once it finishes.`
  dialog.showModal()
})

dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close() // click on the backdrop
  if (event.target.closest('[data-close]')) dialog.close()
})

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent
    try {
      await navigator.clipboard.writeText(text)
      btn.textContent = 'Copied'
    } catch {
      btn.textContent = 'Select and copy'
    }
    setTimeout(() => (btn.textContent = 'Copy'), 2000)
  })
}

retry.href = RELEASES_PAGE
findLatestRelease()
