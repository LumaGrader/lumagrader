// Public links shown in the app. Leave kofiUsername empty ('') to hide the Support buttons.
export const LINKS = {
  kofiUsername: 'lumagrader', // ko-fi.com/<kofiUsername> (same page as the Mac app)
}

export const kofiUrl = () => (LINKS.kofiUsername ? `https://ko-fi.com/${encodeURIComponent(LINKS.kofiUsername)}` : '')

// A gentle "Support" nudge after a successful export: at most once every 7 days per browser.
const NUDGE_KEY = 'lumagrader.supportNudgeAt'
const NUDGE_EVERY_MS = 7 * 24 * 60 * 60 * 1000

/** True (and remembers it) when it's been a week since the last nudge. Never throws. */
export function takeSupportNudge(now = Date.now()) {
  if (!kofiUrl()) return false
  try {
    const last = Number(window.localStorage.getItem(NUDGE_KEY)) || 0
    if (now - last < NUDGE_EVERY_MS) return false
    window.localStorage.setItem(NUDGE_KEY, String(now))
    return true
  } catch {
    return false // private mode / storage blocked: no nudge rather than one every time
  }
}

// The support card (components/SupportPrompt.jsx) listens for this event.
export const SUPPORT_EVENT = 'lumagrader:support-prompt'

/** Asks the app to show the support card once the download has started. */
export function requestSupportPrompt(detail = {}) {
  window.dispatchEvent(new window.CustomEvent(SUPPORT_EVENT, { detail }))
}
