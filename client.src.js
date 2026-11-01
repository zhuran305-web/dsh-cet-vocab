window.__ModuleLoader__.load({ id: "dsh-cet-vocab", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-cet-vocab — browser half.
 *
 * A floating vocabulary flashcard window in `shell.overlay` (the same seat
 * dsh-todo-board uses). Draggable, minimizable to a pill; three-key grading
 * (know / fuzzy / miss) with an Ebbinghaus-style spaced schedule; progress in
 * localStorage. Word list is embedded at build time as `CET_WORDS`
 * (scripts/build_client.mjs prepends data/words.json).
 *
 * Design: quiet surfaces from the host theme tokens, one accent, motion only
 * where it carries meaning.
 */

const React = require('react')
const h = React.createElement

/*__WORDS__*/

// ---------------------------------------------------------------- constants

const PLUGIN_ID = 'dsh-cet-vocab'
const LS_KEY = 'dsh-cet-vocab:v1'

/** Minutes per memory box 0..5; answering "know" at box 5 graduates (box 6). */
const INTERVALS_MIN = [10, 1440, 2880, 5760, 11520, 23040]
const GRADE_MISS = 0
const GRADE_FUZZY = 1
const GRADE_KNOW = 2
const GRADUATED_BOX = 6

// -------------------------------------------------------------------- utils

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function todayStr(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** "3 小时后" / "2 天后" style short duration in the current UI language. */
function fmtIn(minutes, t) {
  if (minutes < 60) return '<1h'
  const h = Math.round(minutes / 60)
  if (h < 24) return h + 'h'
  return Math.round(h / 24) + 'd'
}

function fmtT(str, params) {
  return String(str == null ? '' : str).replace(/\{(\w+)\}/g, (m, k) =>
    params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m)
}

// ------------------------------------------------------- speech (Web TTS)
//
// Pronunciation rides TWO engines, tried in order:
//
//   1. Online dictionary audio (Youdao dictvoice): real human US/UK
//      recordings, one small mp3 per word. This needs no Windows voice pack
//      and no admin rights, so it works on a Chinese-only machine where the
//      OS would otherwise pronounce English with a Chinese voice. Played via
//      an <audio> element — media playback is not subject to CORS, and the
//      DSH web UI ships no CSP, so cross-origin playback is allowed.
//   2. The browser's speechSynthesis as an offline fallback, preferring an
//      installed English voice (en-US / en-GB) over anything else.
//
// The user picks an accent (自动/美式/英式); "auto" behaves as US.

const ACCENT_TYPE = { us: 2, uk: 1 } // youdao dictvoice type codes
let AUDIO_CURRENT = null
const AUDIO_PREFETCH = new Map() // key -> HTMLAudioElement
const AUDIO_KEEP = 60 // cap the prefetch map so it cannot grow without bound

// ---- browser voice list (used by the offline fallback and the detection row)

let VOICE_LIST = []
let VOICE_RAW_COUNT = 0
let VOICE_WARMED = false

/** Re-read every voice the browser exposes into VOICE_LIST; returns the list. */
function refreshVoices() {
  try {
    const synth = window.speechSynthesis
    if (!synth || !synth.getVoices) return VOICE_LIST
    const all = (synth.getVoices() || []).slice()
    VOICE_RAW_COUNT = all.length
    VOICE_LIST = all
  } catch (e) { /* speech is best-effort */ }
  return VOICE_LIST
}

/**
 * Chromium/Electron keeps getVoices() empty until the TTS engine is actually
 * initialised; speak one silent word once to force it. Runs at most once.
 */
function warmUpVoices() {
  if (VOICE_WARMED) return
  VOICE_WARMED = true
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    if ((synth.getVoices() || []).length > 0) return
    const u = new SpeechSynthesisUtterance('a')
    u.volume = 0
    u.rate = 2
    synth.speak(u)
    window.setTimeout(() => { try { synth.cancel() } catch (e) {} }, 60)
  } catch (e) { /* speech is best-effort */ }
}

function resolveAccent(a) { return a === 'uk' ? 'uk' : 'us' }

function savedAccent() {
  try { return resolveAccent(store.state.settings.accent) } catch (e) { return 'us' }
}

function audioKey(word, accent) { return accent + ':' + String(word).toLowerCase() }

function audioUrl(word, accent) {
  const tp = ACCENT_TYPE[accent]
  if (!tp) return null
  return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + tp
}

/** How many English voices the browser currently exposes (0 on zh-only machines). */
function enVoiceCount() {
  const list = VOICE_LIST.length > 0 ? VOICE_LIST : refreshVoices()
  return list.filter((v) => /^en([-_]|$)/i.test(String((v && v.lang) || ''))).length
}

/** Start loading one word's audio early so 🔊/auto-speak is instant. */
function prefetchAudio(word, accent) {
  const a = resolveAccent(accent || savedAccent())
  const url = audioUrl(word, a)
  if (!url) return
  const key = audioKey(word, a)
  if (AUDIO_PREFETCH.has(key)) return
  try {
    const el = new Audio()
    el.preload = 'auto'
    el.src = url
    AUDIO_PREFETCH.set(key, el)
    if (AUDIO_PREFETCH.size > AUDIO_KEEP) {
      const first = AUDIO_PREFETCH.keys().next().value
      const old = AUDIO_PREFETCH.get(first)
      if (old && old !== AUDIO_CURRENT) { try { old.pause(); old.removeAttribute('src') } catch (e) {} }
      AUDIO_PREFETCH.delete(first)
    }
  } catch (e) { /* audio is best-effort */ }
}

function stopAudio() {
  if (AUDIO_CURRENT) {
    try { AUDIO_CURRENT.pause() } catch (e) {}
    AUDIO_CURRENT = null
  }
}

/**
 * Offline fallback: the browser TTS. Prefers a real English voice matching
 * the accent; with none installed it still speaks (the OS default voice will
 * pronounce the word as best it can — this path only runs when offline).
 */
function speakTTS(word, accent) {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const list = VOICE_LIST.length > 0 ? VOICE_LIST : refreshVoices()
    const want = accent === 'uk' ? /^en[-_]gb/i : /^en[-_]us/i
    const v = list.find((x) => want.test(String(x.lang || ''))) ||
      list.find((x) => /^en([-_]|$)/i.test(String(x.lang || ''))) || null
    const u = new SpeechSynthesisUtterance(word)
    u.rate = 0.92
    if (v) { u.voice = v; u.lang = v.lang || u.lang }
    else u.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    synth.cancel()
    synth.speak(u)
  } catch (e) { /* speech is best-effort */ }
}

/**
 * Speak one English word: online human audio first, browser TTS as fallback.
 * `accentOverride` lets the settings page preview an accent before saving.
 */
function speak(word, accentOverride) {
  const accent = resolveAccent(accentOverride || savedAccent())
  try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch (e) {}
  stopAudio()
  const url = audioUrl(word, accent)
  if (!url) { speakTTS(word, accent); return }
  const key = audioKey(word, accent)
  let el = AUDIO_PREFETCH.get(key)
  if (!el) {
    try { el = new Audio() } catch (e) { speakTTS(word, accent); return }
    el.preload = 'auto'
    el.src = url
    AUDIO_PREFETCH.set(key, el)
  }
  try { el.currentTime = 0 } catch (e) {}
  AUDIO_CURRENT = el
  let settled = false
  let watch = 0
  const done = () => { if (!settled) { settled = true; window.clearTimeout(watch) } }
  const fallbackOnce = () => {
    if (settled) return
    done()
    if (AUDIO_CURRENT === el) AUDIO_CURRENT = null
    try { el.pause() } catch (e) {}
    speakTTS(word, accent) // offline / blocked: fall back to browser TTS
  }
  watch = window.setTimeout(fallbackOnce, 4500) // play() may hang on slow networks
  el.addEventListener('playing', done, { once: true })
  el.addEventListener('error', fallbackOnce, { once: true })
  el.play().catch(fallbackOnce)
}

// ------------------------------------------------- adaptive accent colors
//
// Themes put wildly different values in --dsw-alias-brand-primary (the
// default theme's is pale enough to vanish behind white text). Instead of
// hardcoding an accent, measure the real color once per theme change and
// derive three readable variables: --cv-accent (solid background),
// --cv-accent-fg (text on it), --cv-accent-text (accent used as text on
// surfaces). Every rule below falls back to the raw token before the probe
// has run, so first paint is never worse than today.

function cssVar(name) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (v) return v
    // Token fallback: some themes set aliases on <body> (or only inside a scope).
    try {
      return getComputedStyle(document.body || document.documentElement).getPropertyValue(name).trim()
    } catch (e) { return '' }
  } catch (e) { return '' }
}

function parseColor(str) {
  if (!str) return null
  str = String(str).trim().toLowerCase()
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(str)
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16)]
  m = /^#([0-9a-f]{6})$/.exec(str)
  if (m) return [parseInt(str.slice(1, 3), 16), parseInt(str.slice(3, 5), 16), parseInt(str.slice(5, 7), 16)]
  m = /^rgba?\(([^)]+)\)$/.exec(str)
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => !isNaN(n))) return parts.slice(0, 3)
  }
  // Any other CSS color form (hsl/oklch/named/…): let the browser parse it.
  try {
    let cv = parseColor._cv
    if (!cv) { cv = parseColor._cv = document.createElement('canvas'); cv.width = 1; cv.height = 1 }
    const g = cv.getContext('2d')
    g.clearRect(0, 0, 1, 1)
    g.fillStyle = '#000'
    g.fillStyle = str
    g.fillRect(0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    if (d[3] === 0) return null
    return [d[0], d[1], d[2]]
  } catch (e) { return null }
}

function srgbToLin(c) {
  c /= 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function relLum(rgb) {
  return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2])
}

function contrastRatio(a, b) {
  const l1 = Math.max(relLum(a), relLum(b))
  const l2 = Math.min(relLum(a), relLum(b))
  return (l1 + 0.05) / (l2 + 0.05)
}

function mixRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function rgbHex(rgb) {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')
}

const BLACK_RGB = [0, 0, 0]
const WHITE_RGB = [255, 255, 255]
const DARK_FG = [18, 22, 28]

/** Smallest mix ratio of `base` toward `toward` that clears `min` contrast vs `against`. */
function findMixTo(base, toward, against, min) {
  let lo = 0, hi = 1
  if (contrastRatio(mixRgb(base, toward, 1), against) < min) return mixRgb(base, toward, 1)
  while (hi - lo > 0.02) {
    const mid = (lo + hi) / 2
    if (contrastRatio(mixRgb(base, toward, mid), against) >= min) hi = mid
    else lo = mid
  }
  return mixRgb(base, toward, hi)
}

/**
 * Push a surface and its text apart until they clear `min`. Direction
 * follows the text: white-ish text means the theme expects a dark surface,
 * so the surface goes toward black (and the text only toward white); dark
 * text lightens the surface instead. This keeps each theme's mood — a gray
 * window with white text becomes a darker gray window, not a surprise light
 * one — while guaranteeing body text stays readable.
 */
function solvePair(surface, text, min) {
  if (contrastRatio(surface, text) >= min) return [surface, text]
  const textIsLight = relLum(text) > 0.4
  const surfToward = textIsLight ? BLACK_RGB : WHITE_RGB
  const textToward = textIsLight ? WHITE_RGB : BLACK_RGB
  let lo = 0, hi = 1
  const ok = (t) => contrastRatio(mixRgb(surface, surfToward, t), mixRgb(text, textToward, t)) >= min
  if (!ok(1)) return [mixRgb(surface, surfToward, 1), mixRgb(text, textToward, 1)]
  while (hi - lo > 0.02) {
    const mid = (lo + hi) / 2
    if (ok(mid)) hi = mid
    else lo = mid
  }
  return [
    mixRgb(surface, surfToward, hi),
    mixRgb(text, textToward, hi),
  ]
}

/** Lift `layer` away from `surface` until they differ by at least `min`. */
function ensureSeparation(layer, surface, min, toward) {
  if (contrastRatio(layer, surface) >= min) return layer
  return findMixTo(layer, toward, surface, min)
}

function rgbaStr(rgb, a) {
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'
}

const PROBE_VARS = [
  '--cv-surface', '--cv-text', '--cv-text-secondary',
  '--cv-layer-1', '--cv-layer-2', '--cv-border-1', '--cv-border-2',
  '--cv-accent', '--cv-accent-fg', '--cv-accent-text',
  '--cv-ok', '--cv-warn', '--cv-err',
]

let probeStyleEl = null
function probeStyleSheet() {
  if (probeStyleEl && probeStyleEl.isConnected) return probeStyleEl
  probeStyleEl = document.createElement('style')
  probeStyleEl.setAttribute('data-dsh-cet-vocab', '')
  probeStyleEl.setAttribute('data-plugin', PLUGIN_ID)
  document.head.appendChild(probeStyleEl)
  return probeStyleEl
}

let probeMemo = null
function applyAccentProbe() {
  const appearance = (store.get().settings || {}).appearance || 'auto'
  const inputs = [
    cssVar('--dsw-alias-brand-primary'),
    cssVar('--dsw-alias-bg-overlay'),
    cssVar('--dsw-alias-bg-layer-1'),
    cssVar('--dsw-alias-bg-layer-2'),
    cssVar('--dsw-alias-label-primary'),
    cssVar('--dsw-alias-label-secondary'),
    cssVar('--dsw-alias-border-l1'),
    cssVar('--dsw-alias-border-l2'),
    cssVar('--dsw-alias-state-success-primary'),
    cssVar('--dsw-alias-state-warn-primary'),
    cssVar('--dsw-alias-state-error-primary'),
  ]
  const memo = appearance + '|' + inputs.join('|')
  if (memo === probeMemo && probeStyleEl && probeStyleEl.textContent) return
  probeMemo = memo
  try {
    let brand = parseColor(inputs[0])
    let overlay = parseColor(inputs[1]) || [245, 246, 248]
    let layer1 = parseColor(inputs[2]) || mixRgb(overlay, BLACK_RGB, 0.05)
    let layer2 = parseColor(inputs[3]) || mixRgb(overlay, BLACK_RGB, 0.1)
    let text = parseColor(inputs[4]) || [24, 26, 30]
    let text2 = parseColor(inputs[5]) || mixRgb(text, overlay, 0.35)
    let surface = overlay
    if (!brand) brand = [61, 126, 255] // same blue as the plugin icon

    // ---- forced dark: override every surface token except the brand accent
    if (appearance === 'dark') {
      surface = [20, 22, 26]
      text = [236, 238, 241]
      text2 = mixRgb(text, surface, 0.42)
      layer1 = [34, 38, 44]
      layer2 = [46, 51, 59]
    }

    // ---- window surface & text: guarantee readable body text
    let pair = solvePair(surface, text, 4.5)
    surface = pair[0]; text = pair[1]
    // secondary text: >=3 on the (possibly adjusted) surface
    text2 = contrastRatio(text2, surface) >= 3 ? text2 : findMixTo(text2, text, surface, 3.2)

    // ---- cards & controls: keep them lifted off the surface, text still readable
    // ensureSeparation guarantees the layer is visible against the window;
    // the second check guarantees --cv-text stays readable ON the layer — a
    // theme whose card color sits mid-way can otherwise swallow white text.
    function pickLayer(layer, surface, text, minSep) {
      let l = ensureSeparation(layer, surface, minSep, text)
      if (contrastRatio(l, text) < 4.5) {
        l = findMixTo(l, relLum(text) > 0.4 ? BLACK_RGB : WHITE_RGB, text, 4.5)
        if (contrastRatio(l, surface) < 1.15) l = mixRgb(surface, relLum(text) > 0.4 ? BLACK_RGB : WHITE_RGB, 0.18)
      }
      return l
    }
    const l1 = pickLayer(layer1, surface, text, 1.25)
    const l2 = pickLayer(layer2, surface, text, 1.5)
    const border1 = mixRgb(text, surface, 0.78)
    const border2 = mixRgb(text, surface, 0.55)

    // ---- accent (solid buttons & pill): readable label on the brand color
    let accent, fg
    // Button labels are semibold, so white-on-accent at >=3 (AA large/bold)
    // is kept — that preserves the familiar blue-pill-with-white-text look
    // on saturated themes. Anything palier falls through to dark text or a
    // recomputed accent until it clears 4.5.
    if (contrastRatio(brand, WHITE_RGB) >= 3.0) { accent = brand; fg = '#ffffff' }
    else if (contrastRatio(brand, DARK_FG) >= 4.5) { accent = brand; fg = rgbHex(DARK_FG) }
    else {
      const darkened = findMixTo(brand, BLACK_RGB, WHITE_RGB, 4.5)
      const lightened = findMixTo(brand, WHITE_RGB, DARK_FG, 4.5)
      if (contrastRatio(darkened, WHITE_RGB) >= contrastRatio(lightened, DARK_FG)) {
        accent = darkened; fg = '#ffffff'
      } else {
        accent = lightened; fg = rgbHex(DARK_FG)
      }
    }
    // ---- state colors (know / fuzzy / miss, quiz feedback, reset): these are
    // NOT the brand accent, so they keep following the theme in `auto`, but a
    // forced-dark panel on a light theme would otherwise print a light-theme
    // dark-green label on our near-black card and it vanishes. Nudge each one
    // until it clears 3:1 on every panel shade we actually paint on.
    const panels = [surface, l1, l2]
    function readableState(raw, fallback) {
      let c = parseColor(raw) || fallback
      for (const panel of panels) {
        if (contrastRatio(c, panel) < 3.0) {
          c = relLum(panel) > 0.5
            ? findMixTo(c, BLACK_RGB, panel, 3.0)
            : findMixTo(c, WHITE_RGB, panel, 3.2)
        }
      }
      return c
    }
    const okC = readableState(inputs[8], [22, 128, 84])
    const warnC = readableState(inputs[9], [190, 120, 12])
    const errC = readableState(inputs[10], [214, 69, 65])

    // accent used as text on the window body: >=4.5 on the surface
    let accentText = brand
    if (contrastRatio(brand, surface) < 4.5) {
      accentText = relLum(surface) > 0.5
        ? findMixTo(brand, BLACK_RGB, surface, 4.5)
        : findMixTo(brand, WHITE_RGB, surface, 4.5)
    }

    probeStyleSheet().textContent = '.cv-root{' +
      '--cv-surface:' + rgbHex(surface) + ';' +
      '--cv-text:' + rgbHex(text) + ';' +
      '--cv-text-secondary:' + rgbHex(text2) + ';' +
      '--cv-layer-1:' + rgbHex(l1) + ';' +
      '--cv-layer-2:' + rgbHex(l2) + ';' +
      '--cv-border-1:' + rgbaStr(border1, 0.55) + ';' +
      '--cv-border-2:' + rgbaStr(border2, 0.7) + ';' +
      '--cv-accent:' + rgbHex(accent) + ';' +
      '--cv-accent-fg:' + fg + ';' +
      '--cv-accent-text:' + rgbHex(accentText) + ';' +
      '--cv-ok:' + rgbHex(okC) + ';' +
      '--cv-warn:' + rgbHex(warnC) + ';' +
      '--cv-err:' + rgbHex(errC) + ';' +
      '}'
  } catch (e) {
    // Probe failed — fall back to the raw tokens so nothing is worse than before.
    probeStyleSheet().textContent = '.cv-root{' +
      '--cv-surface:' + (inputs[1] || '#f5f6f8') + ';' +
      '--cv-text:' + (inputs[4] || '#181a1e') + ';' +
      '--cv-text-secondary:' + (inputs[5] || '#5a5f68') + ';' +
      '--cv-layer-1:' + (inputs[2] || '#ffffff') + ';' +
      '--cv-layer-2:' + (inputs[3] || '#eef0f3') + ';' +
      '--cv-border-1:' + (inputs[6] || 'rgba(0,0,0,.1)') + ';' +
      '--cv-border-2:' + (inputs[7] || 'rgba(0,0,0,.18)') + ';' +
      '--cv-accent:' + (inputs[0] || '#3D7EFF') + ';' +
      '--cv-accent-fg:#fff;' +
      '--cv-accent-text:' + (inputs[0] || '#3D7EFF') + ';' +
      '--cv-ok:' + (inputs[8] || '#168054') + ';' +
      '--cv-warn:' + (inputs[9] || '#BE780C') + ';' +
      '--cv-err:' + (inputs[10] || '#D64541') + ';' +
      '}'
  }
}

function teardownAccentProbe() {
  try { if (probeStyleEl) probeStyleEl.remove() } catch (e) {}
  probeStyleEl = null
  probeMemo = null
  // Leftover --cv-* on the root would keep tinting the host page and the
  // next mount, so clear the whole derived set by name.
  for (const name of PROBE_VARS) {
    try { document.documentElement.style.removeProperty(name) } catch (e) {}
    try { if (document.body) document.body.style.removeProperty(name) } catch (e) {}
  }
}

// ------------------------------------------------- look-alike word matching

function commonPrefixLen(a, b) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function commonSuffixLen(a, b) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

function sharedBigrams(a, b) {
  if (a.length < 2 || b.length < 2) return 0
  const set = new Set()
  for (let i = 0; i < a.length - 1; i++) set.add(a.slice(i, i + 2))
  let n = 0
  const seen = new Set()
  for (let j = 0; j < b.length - 1; j++) {
    const g = b.slice(j, j + 2)
    if (set.has(g) && !seen.has(g)) { seen.add(g); n++ }
  }
  return n
}

/** Levenshtein distance capped at `cap` (returns cap+1 once proven larger). */
function editDistanceLE(a, b, cap) {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > cap) return cap + 1
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    let best = cur[0]
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < best) best = cur[j]
    }
    if (best > cap) return cap + 1
    const tmp = prev; prev = cur; cur = tmp
  }
  return prev[n]
}

/** How confusable two English words look: higher = more alike (0 = unrelated). */
function confusionScore(w, c) {
  if (w === c) return -1
  let s = 0
  const cap = w.length <= 3 ? 1 : 2
  const d = editDistanceLE(w, c, cap)
  if (d === 1) s = 100          // one edit: adapt/adopt, affect/effect
  else if (d === 2) s = 62      // two edits: quite/quiet, accept/except
  const p = commonPrefixLen(w, c)
  if (p >= 3) s = Math.max(s, 50 + p * 5)   // inter*/pre* stems
  const sf = commonSuffixLen(w, c)
  if (sf >= 3) s = Math.max(s, 44 + sf * 4) // *cept, *duce endings
  const bg = sharedBigrams(w, c)
  if (bg >= 2) s = Math.max(s, 22 + bg * 6) // loose letter-pair kinship
  if (s > 0) s += Math.max(0, 8 - Math.abs(w.length - c.length) * 4)
  return s
}

// -------------------------------------------------------------------- store

function defaultState() {
  return {
    v: 1,
    settings: { book: 'cet4', dailyNew: 10, autoSpeak: false, speakOnOpen: false, mode: 'card', autoOpen: true, appearance: 'auto', accent: 'auto', voice: '' },
    words: {}, // word -> { box, due, seen, ok, fz, no }
    today: { date: todayStr(), newDone: 0, reviewDone: 0 },
    streak: 0,
    lastDay: '',
    win: { x: null, y: null, min: false },
    open: true,
    practice: null,
  }
}

function migrate(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const s = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
    today: { ...base.today, ...(raw.today || {}) },
    win: { ...base.win, ...(raw.win || {}) },
    words: (raw.words && typeof raw.words === 'object') ? raw.words : {},
    practice: (raw.practice && Array.isArray(raw.practice.words)) ? raw.practice : null,
  }
  if (s.today.date !== todayStr()) s.today = { date: todayStr(), newDone: 0, reviewDone: 0 }
  // 0.2.0: the old per-voice picker became a coarse accent choice. Map any
  // saved voiceURI onto an accent so nobody's setting silently disappears.
  // (base.settings already carries accent:'auto', so test the RAW state.)
  if (!raw.settings || raw.settings.accent == null) {
    const old = String((raw.settings && raw.settings.voice) || '')
    s.settings.accent = old ? (/en[-_]gb/i.test(old) ? 'uk' : 'us') : 'auto'
  }
  return s
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return migrate(raw ? JSON.parse(raw) : null)
  } catch (e) {
    return defaultState()
  }
}

function saveState(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch (e) { /* quota/private mode: keep going */ }
}

const store = {
  state: loadState(),
  listeners: new Set(),
  get() { return store.state },
  subscribe(fn) { store.listeners.add(fn); return () => store.listeners.delete(fn) },
  emit() { for (const fn of Array.from(store.listeners)) { try { fn() } catch (e) {} } },
  set(mutator) {
    const next = { ...store.state }
    mutator(next)
    store.state = next
    saveState(next)
    store.emit()
  },
  minimize(min) { store.set((s) => { s.win = { ...s.win, min } }) },
  // Alt+Q: expand when hidden or collapsed, collapse to the pill when expanded.
  toggleWindow() {
    store.set((s) => {
      const hidden = s.open === false || (s.win && s.win.min)
      s.open = true
      s.win = { ...s.win, min: !hidden }
    })
  },
  setGeom(x, y) { store.set((s) => { s.win = { ...s.win, x, y } }) },
  setSettings(patch) {
    store.set((s) => { s.settings = { ...s.settings, ...patch } })
    try { applyAccentProbe() } catch (e) {}
  },
  reset() {
    store.set((s) => {
      const keep = { win: s.win, open: s.open }
      const fresh = defaultState()
      fresh.win = keep.win
      fresh.open = keep.open
      Object.keys(s).forEach((k) => { s[k] = fresh[k] })
    })
  },
  answer(word, grade, countToday) {
    const now = Date.now()
    store.set((s) => {
      if (countToday !== false && s.today.date !== todayStr()) s.today = { date: todayStr(), newDone: 0, reviewDone: 0 }
      const isNew = !s.words[word]
      const prev = s.words[word] || { box: 0, due: 0, seen: 0, ok: 0, fz: 0, no: 0 }
      const e = { ...prev }
      if (grade === GRADE_KNOW) {
        e.box = Math.min((prev.box || 0) + 1, GRADUATED_BOX)
        e.due = e.box >= GRADUATED_BOX ? 0 : now + INTERVALS_MIN[e.box] * 60000
        e.ok++
      } else if (grade === GRADE_FUZZY) {
        e.due = now + INTERVALS_MIN[0] * 60000
        e.fz++
      } else {
        e.box = 0
        e.due = now + INTERVALS_MIN[0] * 60000
        e.no++
      }
      e.seen++
      s.words = { ...s.words, [word]: e }
      if (countToday !== false) {
        if (isNew) s.today = { ...s.today, newDone: s.today.newDone + 1 }
        else s.today = { ...s.today, reviewDone: s.today.reviewDone + 1 }
      }
      const d = todayStr()
      if (s.lastDay !== d) {
        s.streak = s.lastDay === todayStr(-1) ? (s.streak || 0) + 1 : 1
        s.lastDay = d
      }
    })
  },
  startPractice(kind) {
    const now = Date.now()
    store.set((s) => {
      const list = visibleWords(s.settings.book)
      let picks = []
      if (kind === 'review') {
        picks = list
          .filter((e) => {
            const st = s.words[e.w]
            return st && st.box < GRADUATED_BOX && st.due > now
          })
          .sort((a, b) => s.words[a.w].due - s.words[b.w].due)
          .slice(0, 20)
      } else {
        picks = list.filter((e) => !s.words[e.w]).slice(0, 10)
      }
      s.practice = picks.length > 0 ? { kind, words: picks.map((e) => e.w), i: 0 } : null
    })
  },
  practiceNext() {
    store.set((s) => {
      if (!s.practice) return
      const i = s.practice.i + 1
      s.practice = i >= s.practice.words.length ? null : { ...s.practice, i }
    })
  },
  endPractice() {
    store.set((s) => { s.practice = null })
  },
}

// --------------------------------------------------------------- book index

const BOOK_INDEX = (() => {
  const words = (typeof CET_WORDS !== 'undefined' && CET_WORDS && CET_WORDS.words) || []
  const byWord = new Map(words.map((e) => [e.w, e]))
  return {
    all: words,
    cet4: words.filter((e) => e.b === 1 || e.b === 2),
    cet6: words.filter((e) => e.b === 2 || e.b === 3),
    entry(w) { return byWord.get(w) },
  }
})()

function visibleWords(book) { return BOOK_INDEX[book] || BOOK_INDEX.all }

function countUnseen(state) {
  return visibleWords(state.settings.book).filter((e) => !state.words[e.w]).length
}

/** Reviews due now (earliest first) + fresh words within the daily quota. */
function buildQueue(state, now) {
  const list = visibleWords(state.settings.book)
  const reviews = []
  let dueLaterCount = 0
  for (const e of list) {
    const st = state.words[e.w]
    if (!st || st.box >= GRADUATED_BOX) continue
    if (st.due <= now) reviews.push(e)
    else dueLaterCount++
  }
  reviews.sort((a, b) => (state.words[a.w].due || 0) - (state.words[b.w].due || 0))
  const newLeft = Math.max(0, (state.settings.dailyNew || 0) - (state.today.newDone || 0))
  const fresh = []
  if (newLeft > 0) {
    for (const e of list) {
      if (!state.words[e.w]) {
        fresh.push(e)
        if (fresh.length >= newLeft) break
      }
    }
  }
  return { reviews, fresh, dueLaterCount }
}

// The card the learner is looking at right now. LearnView hands over its
// memoised queue so nothing is built twice; the Alt+S shortcut calls it with
// just the state, which is what makes it speak the word actually on screen.
function pickCard(state, now, queue) {
  const practice = state.practice || null
  if (practice) {
    const w = practice.words[practice.i]
    const e = w ? BOOK_INDEX.entry(w) : null
    return { card: e || null, isNew: e ? !state.words[w] : false }
  }
  const q = queue || buildQueue(state, now)
  const card = q.reviews[0] || q.fresh[0] || null
  return { card, isNew: card ? !state.words[card.w] : false }
}

function bookStats(state) {
  const list = visibleWords(state.settings.book)
  let seen = 0, learning = 0, graduated = 0
  const boxes = [0, 0, 0, 0, 0, 0]
  for (const e of list) {
    const st = state.words[e.w]
    if (!st) continue
    seen++
    if (st.box >= GRADUATED_BOX) graduated++
    else { learning++; if (st.box >= 0 && st.box < 6) boxes[st.box]++ }
  }
  return { total: list.length, seen, learning, graduated, boxes }
}

// ------------------------------------------------------------------- locale

const ZH = {"title":"背单词","tabLearn":"学习","tabStats":"统计","tabSettings":"设置","reveal":"显示释义","known":"认识","fuzzy":"模糊","unknown":"不认识","newToday":"今日新学","reviewDone":"今日复习","streak":"连续","streakUnit":"天","dueNow":"待复习","newLeft":"待新学","allDone":"今日计划完成","dueLater":"{n} 个词稍后到期","seeYou":"明天见 👋","mastered":"已掌握","learning":"学习中","bookTotal":"词库","overallProgress":"总进度","settingsBook":"词库","settingsLearn":"学习","cet4":"四级","cet6":"六级","all":"全部","settingsDaily":"每日新词","dailyPerDay":"{n} 词/天","settingsSpeak":"显示释义时自动发音","settingsVoice":"发音口音","accentAuto":"自动","accentUS":"美式","accentUK":"英式","voiceTest":"试听","voiceSysNone":"未检测到系统英语语音包——已自动改用在线真人发音（美式/英式，需联网）；如需离线发音，可让管理员在 Windows 设置 → 时间和语言 → 语音 中添加英语语音包。","voiceSysOk":"系统已装 {n} 个英语语音，作断网时的备用发音；正常情况用在线真人发音。","voiceRetry":"重新检测","settingsReset":"重置全部进度","resetConfirm":"再点一次确认重置","dataSource":"词库数据：ECDICT（MIT 许可）","bookBadge4":"四级","bookBadge6":"六级","bookBadgeBoth":"四六级","minimize":"收起","review":"复习","newWord":"新词","noPhonetic":"—","todayCard":"今日","learnedCard":"已学","boxCard":"记忆阶段","emptyQueueHint":"复习和新词都已完成，可以收起来啦","changeBookHint":"可在「设置」里切换四六级词库","graduated":"已毕业","modeCard":"卡片","modeQuiz":"选择","practiceTag":"加练","practiceReview":"复习到期词","practiceExtra":"加练 10 词","practiceExit":"退出加练","quizCorrect":"答对了","quizWrong":"答错了","optHint":"按 1-4 选择答案","settingsAutoOpen":"模型思考时自动弹出","autoOpenToast":"模型思考中，来背两个单词吧 📖","settingsAppearance":"外观","appearanceAuto":"跟随主题","appearanceDark":"深色","hintCard":"Space 显示释义 · 1/2/3 评分","scTitle":"快捷键","scToggle":"展开 / 收起悬浮窗","scModeCard":"切换到卡片模式","scModeQuiz":"切换到选择题模式","scSpeak":"朗读当前单词","scReveal":"显示释义","scGrade":"认识 / 模糊 / 不认识","scPick":"选择答案 1-4","scNote":"单键（Space、数字）只在窗口展开且光标不在输入框时生效；Alt 组合键在页面任何位置都能用。","scReview":"复习稍后到期的词（最多 20 个）","scExtra":"加练 10 个生词","scExit":"退出加练（加练中）","practiceNoReview":"暂时没有待复习的词","practiceNoExtra":"没有更多生词可以加练"}
const EN = {"title":"Vocabulary","tabLearn":"Learn","tabStats":"Stats","tabSettings":"Settings","reveal":"Show meaning","known":"Know","fuzzy":"Fuzzy","unknown":"Miss","newToday":"New today","reviewDone":"Reviewed today","streak":"Streak","streakUnit":"d","dueNow":"Due","newLeft":"New left","allDone":"Daily plan complete","dueLater":"{n} words due later","seeYou":"See you tomorrow 👋","mastered":"Mastered","learning":"Learning","bookTotal":"Book","overallProgress":"Overall progress","settingsBook":"Word book","settingsLearn":"Learning","cet4":"CET-4","cet6":"CET-6","all":"All","settingsDaily":"New words / day","dailyPerDay":"{n} / day","settingsSpeak":"Speak on reveal","settingsVoice":"Accent","accentAuto":"Auto","accentUS":"US","accentUK":"UK","voiceTest":"Preview","voiceSysNone":"No English voice pack detected — pronunciation now uses online human recordings (US/UK, needs network). For offline use, an administrator can add English voices in Windows Settings → Time & language → Speech.","voiceSysOk":"{n} system English voice(s) found; online recordings are preferred and system voices serve as the offline fallback.","voiceRetry":"Retry","settingsReset":"Reset all progress","resetConfirm":"Click again to confirm","dataSource":"Word data: ECDICT (MIT license)","bookBadge4":"CET-4","bookBadge6":"CET-6","bookBadgeBoth":"CET-4/6","minimize":"Collapse","review":"Review","newWord":"New","noPhonetic":"—","todayCard":"Today","learnedCard":"Learned","boxCard":"Memory stage","emptyQueueHint":"Reviews and new words are done for today","changeBookHint":"Switch word book in Settings","graduated":"Graduated","modeCard":"Cards","modeQuiz":"Quiz","practiceTag":"Practice","practiceReview":"Review due words","practiceExtra":"Practice +10","practiceExit":"Exit practice","quizCorrect":"Correct","quizWrong":"Wrong","optHint":"Press 1-4 to answer","settingsAutoOpen":"Pop up while the model thinks","autoOpenToast":"Model is thinking — quick vocab break 📖","settingsAppearance":"Appearance","appearanceAuto":"Follow theme","appearanceDark":"Dark","hintCard":"Space reveal · 1/2/3 grade","scTitle":"Keyboard shortcuts","scToggle":"Expand / collapse the window","scModeCard":"Switch to card mode","scModeQuiz":"Switch to quiz mode","scSpeak":"Speak the current word","scReveal":"Reveal the meaning","scGrade":"Known / Fuzzy / Miss","scPick":"Pick an answer (1-4)","scNote":"Single keys (Space, digits) work only while the window is expanded and the caret is not in a text field; Alt combos work anywhere on the page.","scReview":"Review words due later (up to 20)","scExtra":"Practise 10 new words","scExit":"Exit practice (while practising)","practiceNoReview":"Nothing due for review yet","practiceNoExtra":"No more new words to practise"}

let localeBinder = null
const t = (key) => {
  const v = localeBinder ? localeBinder(key) : null
  // Chinese-first UI per user preference: fall back to the zh dict whenever
  // the locale service has nothing (or a key) for us.
  return v && v !== key ? v : (ZH[key] != null ? ZH[key] : key)
}

// ---------------------------------------------------------------------- CSS

const CSS = `
.cv-root, .cv-root * { box-sizing: border-box; }
.cv-root {
  font-size: 14px; line-height: 1.5;
  color: var(--cv-text, var(--dsw-alias-label-primary));
  font-family: inherit;
}
.cv-window {
  position: fixed; width: 384px; max-height: min(74vh, 660px);
  display: flex; flex-direction: column;
  background: var(--cv-surface, var(--dsw-alias-bg-overlay));
  border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); border-radius: 14px;
  box-shadow: 0 18px 48px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.12);
  user-select: none;
}
.cv-window--default { right: 24px; top: 88px; }
.cv-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 10px 8px 14px; cursor: grab; touch-action: none;
  border-bottom: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
}
.cv-head:active { cursor: grabbing; }
.cv-head-title { font-weight: 600; font-size: 14px; }
.cv-head-due {
  font-size: 11px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
  background: var(--cv-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  border-radius: 999px; padding: 1px 8px;
}
.cv-head-spacer { flex: 1; }
.cv-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 8px; border: none; cursor: pointer;
  background: transparent; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
}
.cv-iconbtn:hover { background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); color: var(--cv-text, var(--dsw-alias-label-primary)); }
.cv-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.cv-tab {
  flex: 1; text-align: center; padding: 6px 0; font-size: 13px; cursor: pointer;
  border: none; border-radius: 8px; background: transparent; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
}
.cv-tab:hover { background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); }
.cv-tab--on {
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); color: var(--cv-text, var(--dsw-alias-label-primary));
  font-weight: 600; border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
}
.cv-body { padding: 12px 14px 14px; overflow-y: auto; }
.cv-today { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); margin-bottom: 6px; }
.cv-today b { color: var(--cv-text, var(--dsw-alias-label-primary)); font-weight: 600; }
.cv-bar { height: 4px; border-radius: 999px; background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); overflow: hidden; margin-bottom: 12px; }
.cv-bar > i { display: block; height: 100%; background: var(--cv-accent, var(--dsw-alias-brand-primary)); border-radius: 999px; transition: width .35s ease; }
.cv-card {
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  border-radius: 12px; padding: 18px 16px 16px; text-align: center; user-select: text;
}
.cv-word { font-size: 28px; font-weight: 700; letter-spacing: .2px; word-break: break-word; }
.cv-phon { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 4px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); font-size: 13px; min-height: 20px; }
.cv-speak {
  border: none; background: transparent; cursor: pointer; color: var(--cv-accent-text, var(--dsw-alias-brand-primary));
  font-size: 14px; padding: 2px 6px; border-radius: 6px; line-height: 1;
}
.cv-speak:hover { background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); }
.cv-meta { display: flex; justify-content: center; gap: 6px; margin-bottom: 10px; }
.cv-chip {
  font-size: 10.5px; padding: 1px 8px; border-radius: 999px; line-height: 1.6;
  background: color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 12%, transparent);
  color: var(--cv-accent-text, var(--dsw-alias-brand-primary));
}
.cv-chip--rev { background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-chip--c6 { background: color-mix(in srgb, var(--cv-warn, var(--dsw-alias-state-warn-primary)) 14%, transparent); color: var(--cv-warn, var(--dsw-alias-state-warn-primary)); }
.cv-meaning {
  margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--cv-border-2, var(--dsw-alias-border-l2));
  font-size: 15px; line-height: 1.7; text-align: left; white-space: pre-wrap;
  word-break: break-word; max-height: 180px; overflow-y: auto;
}
.cv-reveal {
  width: 100%; margin-top: 14px; padding: 9px 0; font-size: 14px; font-weight: 600;
  border: none; border-radius: 10px; cursor: pointer;
  background: var(--cv-accent, var(--dsw-alias-brand-primary)); color: var(--cv-accent-fg, #fff);
}
.cv-reveal:hover { filter: brightness(1.08); }
.cv-grades { display: flex; gap: 8px; margin-top: 14px; }
.cv-grade {
  flex: 1; padding: 9px 0; font-size: 13.5px; font-weight: 600; cursor: pointer;
  border-radius: 10px; border: 1px solid transparent;
}
.cv-grade--know {
  background: color-mix(in srgb, var(--cv-ok, var(--dsw-alias-state-success-primary)) 13%, transparent);
  color: var(--cv-ok, var(--dsw-alias-state-success-primary)); border-color: color-mix(in srgb, var(--cv-ok, var(--dsw-alias-state-success-primary)) 32%, transparent);
}
.cv-grade--fuzzy {
  background: color-mix(in srgb, var(--cv-warn, var(--dsw-alias-state-warn-primary)) 13%, transparent);
  color: var(--cv-warn, var(--dsw-alias-state-warn-primary)); border-color: color-mix(in srgb, var(--cv-warn, var(--dsw-alias-state-warn-primary)) 32%, transparent);
}
.cv-grade--miss {
  background: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 13%, transparent);
  color: var(--cv-err, var(--dsw-alias-state-error-primary)); border-color: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 32%, transparent);
}
.cv-grade:hover { filter: brightness(1.06); }
.cv-done { text-align: center; padding: 26px 8px 18px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-done-emoji { font-size: 34px; margin-bottom: 8px; }
.cv-done-title { font-size: 15px; font-weight: 600; color: var(--cv-text, var(--dsw-alias-label-primary)); margin-bottom: 4px; }
.cv-done-sub { font-size: 12.5px; }
.cv-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.cv-tile { background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); border-radius: 10px; padding: 10px 12px; }
.cv-tile-num { font-size: 20px; font-weight: 700; }
.cv-tile-label { font-size: 11.5px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); margin-top: 2px; }
.cv-boxrow { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 11.5px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-boxrow-label { width: 76px; flex: none; }
.cv-boxrow-bar { flex: 1; height: 6px; background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); border-radius: 999px; overflow: hidden; }
.cv-boxrow-bar > i { display: block; height: 100%; background: var(--cv-accent, var(--dsw-alias-brand-primary)); opacity: .8; }
.cv-boxrow-num { width: 34px; text-align: right; flex: none; }
.cv-set-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); }
.cv-set-row:last-of-type { border-bottom: none; }
.cv-set-label { font-size: 13px; width: 92px; flex: none; color: var(--cv-text, var(--dsw-alias-label-primary)); }
.cv-set-entry {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 0;
  border: none; border-bottom: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  background: transparent; color: var(--cv-text, var(--dsw-alias-label-primary));
  font: inherit; font-size: 13px; cursor: pointer; text-align: left;
}
.cv-set-entry:hover .cv-set-label { color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); }
.cv-set-value {
  margin-left: auto; font-size: 11.5px; text-align: right;
  color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
}
.cv-set-chevron { flex: none; font-size: 15px; line-height: 1; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-sub-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding-bottom: 8px; border-bottom: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
}
.cv-set-back {
  border: none; background: transparent; padding: 2px 6px 2px 0; font: inherit; font-size: 12.5px;
  cursor: pointer; color: var(--cv-accent-text, var(--dsw-alias-brand-primary));
}
.cv-set-back:hover { filter: brightness(1.12); }
.cv-sub-title { font-size: 12.5px; font-weight: 600; color: var(--cv-text, var(--dsw-alias-label-primary)); }
.cv-set-row .cv-numinput--inline { width: 62px; flex: none; }
.cv-sc-flat { padding-top: 8px; }

.cv-seg { display: flex; flex: 1; gap: 4px; background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); border-radius: 9px; padding: 3px; }
.cv-seg button {
  flex: 1; border: none; background: transparent; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
  font-size: 12.5px; padding: 5px 0; border-radius: 7px; cursor: pointer;
}
.cv-seg button:hover { color: var(--cv-text, var(--dsw-alias-label-primary)); }
.cv-seg button.cv-on { background: var(--cv-surface, var(--dsw-alias-bg-overlay)); color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.14); }
.cv-switch {
  position: relative; width: 40px; height: 22px; border-radius: 999px; border: none; cursor: pointer;
  background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); transition: background .2s ease; flex: none;
}
.cv-switch > i {
  position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--cv-surface, var(--dsw-alias-bg-overlay)); box-shadow: 0 1px 3px rgba(0,0,0,.25);
  transition: left .2s ease;
}
.cv-switch--on { background: var(--cv-accent, var(--dsw-alias-brand-primary)); }
.cv-switch--on > i { left: 21px; }
.cv-sc { margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); }
.cv-sc-title { font-size: 12.5px; font-weight: 600; color: var(--cv-text, var(--dsw-alias-label-primary)); margin-bottom: 8px; }
.cv-sc-row { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
.cv-sc-keys { display: flex; gap: 3px; flex: none; width: 96px; }
.cv-sc-keys kbd {
  font: inherit; font-size: 10.5px; line-height: 1; padding: 4px 6px; border-radius: 6px;
  background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); color: var(--cv-text, var(--dsw-alias-label-primary));
  border: 1px solid var(--cv-border-2, var(--dsw-alias-border-l1)); box-shadow: 0 1px 0 rgba(0,0,0,.2);
}
.cv-sc-desc { font-size: 11.5px; line-height: 1.35; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-sc-note { margin-top: 7px; font-size: 10.5px; line-height: 1.4; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); }
.cv-resetbtn {
  width: 100%; margin-top: 12px; padding: 8px 0; font-size: 13px; cursor: pointer; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 40%, transparent);
  color: var(--cv-err, var(--dsw-alias-state-error-primary)); background: transparent;
}
.cv-resetbtn:hover { background: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 10%, transparent); }
.cv-foot { margin-top: 12px; font-size: 11px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); text-align: center; }
.cv-pill {
  position: fixed; display: flex; align-items: center; gap: 7px;
  padding: 9px 15px; border-radius: 999px; border: none; cursor: grab; touch-action: none;
  background: var(--cv-accent, var(--dsw-alias-brand-primary)); color: var(--cv-accent-fg, #fff); font-size: 13.5px; font-weight: 600;
  box-shadow: 0 8px 22px rgba(0,0,0,.28); user-select: none;
}
.cv-pill:active { cursor: grabbing; }
.cv-pill--default { right: 24px; top: 88px; }
.cv-mode-row { display: flex; gap: 6px; margin-bottom: 10px; }
.cv-mode-btn {
  flex: 1; padding: 6px 0; font-size: 12.5px; cursor: pointer; border-radius: 8px;
  border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); background: transparent; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
}
.cv-mode-btn--on { background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); font-weight: 600; border-color: color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 30%, transparent); }
.cv-practice {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 7px 10px;
  background: color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 28%, transparent);
  border-radius: 10px; font-size: 12.5px; color: var(--cv-accent-text, var(--dsw-alias-brand-primary));
}
.cv-practice-x { margin-left: auto; border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 6px; }
.cv-practice-x:hover { background: color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 16%, transparent); }
.cv-quiz-opts { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.cv-opt {
  text-align: left; padding: 10px 12px; font-size: 13.5px; line-height: 1.45; cursor: pointer;
  border-radius: 10px; border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1)); color: var(--cv-text, var(--dsw-alias-label-primary));
}
.cv-opt:hover { background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); }
.cv-opt--correct {
  background: color-mix(in srgb, var(--cv-ok, var(--dsw-alias-state-success-primary)) 14%, transparent);
  border-color: color-mix(in srgb, var(--cv-ok, var(--dsw-alias-state-success-primary)) 45%, transparent);
  color: var(--cv-ok, var(--dsw-alias-state-success-primary)); font-weight: 600;
}
.cv-opt--wrong {
  background: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 12%, transparent);
  border-color: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 45%, transparent);
  color: var(--cv-err, var(--dsw-alias-state-error-primary));
}
.cv-opt--dim { opacity: .45; pointer-events: none; }
.cv-feedback {
  margin-top: 12px; padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 1.6;
  text-align: left; white-space: pre-wrap; word-break: break-word;
}
.cv-feedback--ok { background: color-mix(in srgb, var(--cv-ok, var(--dsw-alias-state-success-primary)) 10%, transparent); color: var(--cv-ok, var(--dsw-alias-state-success-primary)); }
.cv-feedback--no { background: color-mix(in srgb, var(--cv-err, var(--dsw-alias-state-error-primary)) 10%, transparent); color: var(--cv-err, var(--dsw-alias-state-error-primary)); }
.cv-done-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.cv-actionbtn {
  padding: 9px 0; font-size: 13.5px; font-weight: 600; cursor: pointer; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 38%, transparent);
  background: color-mix(in srgb, var(--cv-accent, var(--dsw-alias-brand-primary)) 10%, transparent);
  color: var(--cv-accent-text, var(--dsw-alias-brand-primary));
}
.cv-actionbtn:hover { filter: brightness(1.06); }
.cv-numinput {
  width: 76px; padding: 5px 8px; font-size: 13px; border-radius: 8px;
  border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1)); background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1));
  color: var(--cv-text, var(--dsw-alias-label-primary)); outline: none;
}
.cv-numinput:focus { border-color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); }
.cv-voice { display: flex; flex: 1; gap: 6px; align-items: center; min-width: 0; }
.cv-select {
  flex: 1; min-width: 0; max-width: 100%; padding: 5px 6px; font-size: 12px;
  border-radius: 8px; border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1));
  color: var(--cv-text, var(--dsw-alias-label-primary)); outline: none;
}
.cv-select:focus { border-color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); }
.cv-voice-test {
  flex: none; width: 26px; height: 26px; padding: 0; font-size: 12px; line-height: 1;
  border-radius: 7px; cursor: pointer;
  border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1));
  color: var(--cv-text, var(--dsw-alias-label-primary));
}
.cv-voice-test:hover { border-color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); }
.cv-voice-empty { text-align: left; margin-top: 2px; padding: 0 0 8px 102px; line-height: 1.5; }
.cv-voice-retry {
  margin-top: 6px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; border-radius: 7px;
  border: 1px solid var(--cv-border-1, var(--dsw-alias-border-l1));
  background: var(--cv-layer-1, var(--dsw-alias-bg-layer-1));
  color: var(--cv-text, var(--dsw-alias-label-primary));
}
.cv-voice-retry:hover { border-color: var(--cv-accent-text, var(--dsw-alias-brand-primary)); }
.cv-pill:hover { filter: brightness(1.08); }
.cv-pill-badge {
  min-width: 19px; height: 19px; padding: 0 5px; border-radius: 999px;
  background: color-mix(in srgb, var(--cv-accent-fg, #fff) 30%, transparent);
  font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
}
.cv-hint { font-size: 11.5px; color: var(--cv-text-secondary, var(--dsw-alias-label-secondary)); text-align: center; margin-top: 10px; }
.cv-flash {
  margin-top: 10px; padding: 6px 10px; border-radius: 8px; text-align: center; font-size: 11.5px;
  background: var(--cv-layer-2, var(--dsw-alias-bg-layer-2)); color: var(--cv-text-secondary, var(--dsw-alias-label-secondary));
}
`

// --------------------------------------------------------------- shortcuts
//
// Key choices, and why the conflicts stay away:
//   * Anything that acts outside the window uses Alt. Ctrl/Cmd combos belong
//     to the browser and the host shell (Ctrl+1..8 switches tabs, Ctrl+S saves,
//     Ctrl+W closes the tab, Ctrl+K opens the host's pickers), so we never go
//     near them; Alt+letter/digit is free in both Chromium and the DSH shell.
//   * Plain keys (Space, 1-4) act only while the window is expanded *and* no
//     text field has focus, so typing a prompt is never disturbed (this fixed
//     a real bug: Space used to reveal a card while typing in the chat box).
//   * Every handler first checks `defaultPrevented`/`isComposing` and simply
//     yields, so a shortcut the host already claimed always wins. We listen on
//     `window` in the bubble phase, after the shell's own listeners.
//   * AltGr arrives as ctrl+alt on Windows layouts, so requiring altKey *and*
//     no ctrlKey keeps AltGr typing (e.g. Polish/German characters) working.
const SC = {
  toggle: { keys: ['Alt', 'Q'], key: 'scToggle' },
  card: { keys: ['Alt', '1'], key: 'scModeCard' },
  quiz: { keys: ['Alt', '2'], key: 'scModeQuiz' },
  review: { keys: ['Alt', 'R'], key: 'scReview' },
  extra: { keys: ['Alt', 'P'], key: 'scExtra' },
  exit: { keys: ['Alt', 'X'], key: 'scExit' },
  speak: { keys: ['Alt', 'S'], key: 'scSpeak' },
  reveal: { keys: ['Space'], key: 'scReveal' },
  grades: { keys: ['1', '2', '3'], key: 'scGrade' },
  pick: { keys: ['1', '2', '3', '4'], key: 'scPick' },
}
// Display order of the settings guide. SC is the single source of truth, so
// the guide can never advertise a key the code does not actually handle.
const SC_GUIDE = ['toggle', 'card', 'quiz', 'review', 'extra', 'exit', 'speak', 'reveal', 'grades', 'pick']

// Would this key land in a text field? Without this guard Space would be
// swallowed while the user types, and 1/2/3 would grade a card behind the
// caret. Covers nested contenteditable hosts (DSH's composer is one).
function isTypingTarget(ev) {
  const el = ev && ev.target
  if (!el || el.nodeType !== 1) return false
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return !!(el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

// A bare key: no Alt/Ctrl/Cmd. Used by the in-window Space and 1-4 handlers.
function plainKey(ev) {
  return !ev.altKey && !ev.ctrlKey && !ev.metaKey
}

// `ev.key` depends on the active layout/IME, `ev.code` on the physical key;
// prefer the physical one so Alt+Q and Alt+1 keep working on any layout.
function scKey(ev) {
  const code = String((ev && ev.code) || '')
  if (code.startsWith('Key')) return code.slice(3).toLowerCase()
  if (code.startsWith('Digit')) return code.slice(5)
  return String((ev && ev.key) || '').toLowerCase()
}

// One-line feedback for a shortcut that had nothing to do ("no words to review
// yet"). Deliberately not part of the persisted store: it must never survive a
// reload, and it must not dirty the saved progress.
const flashBox = { key: '', n: 0 }
const flashSubs = new Set()
function flash(key) {
  flashBox.key = key
  flashBox.n += 1
  for (const fn of flashSubs) fn()
}
function useFlash() {
  const [n, setN] = React.useState(flashBox.n)
  React.useEffect(() => {
    const fn = () => setN(flashBox.n)
    flashSubs.add(fn)
    return () => { flashSubs.delete(fn) }
  }, [])
  return n
}

// --------------------------------------------------------------- components

function useStoreState() {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(store.subscribe, store.get)
  }
  const [, force] = React.useState(0)
  React.useEffect(() => store.subscribe(() => force((x) => x + 1)), [])
  return store.get()
}

function useLocaleTick() {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    try {
      return ctxLocaleSubscribe(() => force((x) => x + 1))
    } catch (e) { return undefined }
  }, [])
  return null
}

// set by apply(); kept as mutable module state so components stay pure-ish
let ctxLocaleSubscribe = null

let dragMoved = false // true when a drag actually moved; suppresses pill click-to-open
function beginDrag(e, geom) {
  if (e.button !== 0) return
  if (e.target && e.target.closest && e.target.closest('button')) return
  dragMoved = false
  const el = e.currentTarget.closest('.cv-window') || e.currentTarget.closest('.cv-pill')
  if (!el) return
  const rect = el.getBoundingClientRect()
  const offX = e.clientX - rect.left
  const offY = e.clientY - rect.top
  const header = e.currentTarget
  let last = null
  const move = (ev) => {
    dragMoved = true
    const x = clamp(ev.clientX - offX, 8 - rect.width + 90, window.innerWidth - 90)
    const y = clamp(ev.clientY - offY, 6, window.innerHeight - 42)
    last = { x, y }
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    el.style.right = 'auto'
  }
  const up = () => {
    try { header.releasePointerCapture(e.pointerId) } catch (err) {}
    header.removeEventListener('pointermove', move)
    header.removeEventListener('pointerup', up)
    header.removeEventListener('pointercancel', up)
    if (last) store.setGeom(Math.round(last.x), Math.round(last.y))
  }
  try { header.setPointerCapture(e.pointerId) } catch (err) {}
  header.addEventListener('pointermove', move)
  header.addEventListener('pointerup', up)
  header.addEventListener('pointercancel', up)
  e.preventDefault()
}

function Badge({ book }) {
  const label = book === 2 ? t('bookBadgeBoth') : book === 3 ? t('bookBadge6') : t('bookBadge4')
  return h('span', { className: 'cv-chip' + (book === 3 ? ' cv-chip--c6' : '') }, label)
}

function ModeRow({ mode }) {
  return h('div', { className: 'cv-mode-row' },
    h('button', {
      className: 'cv-mode-btn' + (mode === 'card' ? ' cv-mode-btn--on' : ''),
      onClick: () => store.setSettings({ mode: 'card' }),
    }, '🃏 ' + t('modeCard')),
    h('button', {
      className: 'cv-mode-btn' + (mode === 'quiz' ? ' cv-mode-btn--on' : ''),
      onClick: () => store.setSettings({ mode: 'quiz' }),
    }, '🎯 ' + t('modeQuiz')),
  )
}

function TodayBar({ state }) {
  const daily = state.settings.dailyNew || 0
  const newDone = state.today.newDone || 0
  return h('div', null,
    h('div', { className: 'cv-today' },
      h('span', null, t('newToday') + ' '),
      h('b', null, newDone + '/' + daily),
      h('span', null, t('reviewDone') + ' '),
      h('b', null, String(state.today.reviewDone || 0)),
      state.streak > 0 && h('span', null, t('streak') + ' '),
      state.streak > 0 && h('b', null, state.streak + ' ' + t('streakUnit')),
    ),
    h('div', { className: 'cv-bar' }, h('i', { style: { width: (daily > 0 ? Math.min(100, (newDone / daily) * 100) : 100) + '%' } })),
  )
}

function PracticeBar({ practice }) {
  const label = practice.kind === 'review' ? t('practiceReview') : t('practiceExtra')
  return h('div', { className: 'cv-practice' },
    h('span', null, '🏃 ' + t('practiceTag') + ' · ' + label + '  ' + (practice.i + 1) + '/' + practice.words.length),
    h('button', { className: 'cv-practice-x', title: t('practiceExit'), onClick: () => store.endPractice() }, '✕'),
  )
}

function CardView({ card, isNew, showing, onReveal, onGrade }) {
  // Warm the pronunciation mp3 while the learner reads the word.
  React.useEffect(() => { prefetchAudio(card.w) }, [card && card.w])
  return h('div', null,
    h('div', { className: 'cv-card' },
      h('div', { className: 'cv-meta' },
        h(Badge, { book: card.b }),
        h('span', { className: 'cv-chip cv-chip--rev' }, isNew ? t('newWord') : t('review')),
      ),
      h('div', { className: 'cv-word' }, card.w),
      h('div', { className: 'cv-phon' },
        h('span', null, card.p || t('noPhonetic')),
        h('button', {
          className: 'cv-speak', title: '🔊', onClick: () => speak(card.w),
          'aria-label': 'speak',
        }, '🔊'),
      ),
      showing
        ? h('div', { className: 'cv-meaning' }, card.t || '—')
        : h('button', { className: 'cv-reveal', onClick: onReveal }, t('reveal')),
    ),
    showing
      ? h('div', { className: 'cv-grades' },
          h('button', { className: 'cv-grade cv-grade--know', onClick: () => onGrade(GRADE_KNOW) }, t('known')),
          h('button', { className: 'cv-grade cv-grade--fuzzy', onClick: () => onGrade(GRADE_FUZZY) }, t('fuzzy')),
          h('button', { className: 'cv-grade cv-grade--miss', onClick: () => onGrade(GRADE_MISS) }, t('unknown')),
        )
      : h('div', { className: 'cv-hint' }, t('hintCard')),
  )
}

function QuizView({ card, isNew, state, onGrade }) {
  const entry = BOOK_INDEX.entry(card.w)
  const [picked, setPicked] = React.useState(null)
  const [nonce, setNonce] = React.useState(0)
  React.useEffect(() => { setPicked(null); setNonce((x) => x + 1) }, [card.w])

  const opts = React.useMemo(() => {
    if (!entry) return []
    const pool = visibleWords(state.settings.book)
    const seenDefs = new Set([String(entry.t || '').slice(0, 16)])

    // rank look-alike words first (edit distance / shared affixes), keep the top 3
    const cands = []
    for (const e of pool) {
      if (e.w === card.w || !e.t) continue
      const s = confusionScore(card.w, e.w)
      if (s >= 25) cands.push({ e, s: s + Math.random() * 12 })
    }
    cands.sort((a, b) => b.s - a.s)
    const dis = []
    for (const c of cands) {
      const key = String(c.e.t || '').slice(0, 16)
      if (seenDefs.has(key)) continue
      seenDefs.add(key)
      dis.push(c.e)
      if (dis.length >= 3) break
    }
    // fallback: fill remaining slots with random words (rare — lists are big)
    let guard = 0
    while (dis.length < 3 && guard++ < 200 && pool.length > 0) {
      const c = pool[(Math.random() * pool.length) | 0]
      if (c.w === card.w || !c.t) continue
      const key = String(c.t || '').slice(0, 16)
      if (seenDefs.has(key)) continue
      seenDefs.add(key)
      dis.push(c)
    }
    const all = [entry, ...dis]
    for (let i = all.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0
      const tmp = all[i]; all[i] = all[j]; all[j] = tmp
    }
    return all
  }, [card.w, nonce]) // eslint-disable-line

  const answered = picked != null && opts[picked] != null
  const wasRight = answered && opts[picked].w === card.w

  React.useEffect(() => {
    if (!answered) return
    // speak once the answer is revealed, same contract as card mode's reveal
    if (state.settings.autoSpeak) speak(card.w)
    const id = window.setTimeout(() => onGrade(wasRight ? GRADE_KNOW : GRADE_MISS), 1200)
    return () => window.clearTimeout(id)
  }, [answered]) // eslint-disable-line

  React.useEffect(() => {
    const onKey = (ev) => {
      if (ev.defaultPrevented || ev.isComposing) return
      if (isTypingTarget(ev) || !plainKey(ev)) return
      if (answered || opts.length === 0) return
      const n = parseInt(ev.key, 10)
      if (n >= 1 && n <= opts.length) { ev.preventDefault(); setPicked(n - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const clip = (s, n) => {
    s = String(s || '')
    return s.length > (n || 46) ? s.slice(0, n || 46) + '…' : s
  }

  return h('div', null,
    h('div', { className: 'cv-card' },
      h('div', { className: 'cv-meta' },
        h(Badge, { book: card.b }),
        h('span', { className: 'cv-chip cv-chip--rev' }, isNew ? t('newWord') : t('review')),
      ),
      h('div', { className: 'cv-word' }, card.w),
      h('div', { className: 'cv-phon' },
        h('span', null, card.p || t('noPhonetic')),
        h('button', { className: 'cv-speak', title: '🔊', onClick: () => speak(card.w) }, '🔊'),
      ),
    ),
    h('div', { className: 'cv-quiz-opts' },
      opts.map((o, i) => {
        let cls = 'cv-opt'
        if (answered) {
          if (o.w === card.w) cls += ' cv-opt--correct'
          else if (i === picked) cls += ' cv-opt--wrong'
          else cls += ' cv-opt--dim'
        }
        return h('button', {
          key: o.w + ':' + i, className: cls,
          onClick: () => { if (!answered) setPicked(i) },
        }, (i + 1) + '. ' + clip(o.t))
      }),
    ),
    answered && h('div', {
      className: 'cv-feedback ' + (wasRight ? 'cv-feedback--ok' : 'cv-feedback--no'),
    }, (wasRight ? '✓ ' + t('quizCorrect') : '✗ ' + t('quizWrong')) +
      ' · ' + card.w + ' ' + clip(entry ? entry.t : '', 80)),
    !answered && h('div', { className: 'cv-hint' }, t('optHint')),
  )
}

function DoneView({ q, state }) {
  const unseen = countUnseen(state)
  return h('div', null,
    h('div', { className: 'cv-done' },
      h('div', { className: 'cv-done-emoji' }, '🎉'),
      h('div', { className: 'cv-done-title' }, t('allDone')),
      h('div', { className: 'cv-done-sub' }, t('emptyQueueHint')),
      q.dueLaterCount > 0 && h('div', { className: 'cv-done-sub', style: { marginTop: 6 } },
        fmtT(t('dueLater'), { n: q.dueLaterCount })),
    ),
    (q.dueLaterCount > 0 || unseen > 0) && h('div', { className: 'cv-done-actions' },
      q.dueLaterCount > 0 && h('button', {
        className: 'cv-actionbtn',
        onClick: () => store.startPractice('review'),
      }, '🔁 ' + t('practiceReview') + ' (' + Math.min(20, q.dueLaterCount) + ')'),
      unseen > 0 && h('button', {
        className: 'cv-actionbtn',
        onClick: () => store.startPractice('extra'),
      }, '➕ ' + t('practiceExtra')),
    ),
    h('div', { className: 'cv-hint' }, t('seeYou') + '  ' + t('changeBookHint')),
  )
}

function LearnView({ state }) {
  const [revealed, setRevealed] = React.useState('')
  const [tick, setTick] = React.useState(0)
  // re-derive the queue every ~30s so "due now" moves forward while idling
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 30000)
    return () => window.clearInterval(id)
  }, [])
  void tick

  const mode = state.settings.mode === 'quiz' ? 'quiz' : 'card'
  const practice = state.practice || null
  const now = Date.now()
  const q = React.useMemo(() => buildQueue(state, now), [state, tick]) // eslint-disable-line

  // Same selection the Alt+S shortcut uses (pickCard), so the spoken word is
  // always the word on the card.
  const { card, isNew } = pickCard(state, now, q)
  const showing = card ? revealed === card.w : false

  // Shortcut feedback line (e.g. Alt+R with nothing due yet).
  const flashN = useFlash()
  const [flashMsg, setFlashMsg] = React.useState('')
  React.useEffect(() => {
    if (!flashN) return undefined
    setFlashMsg(flashBox.key)
    const id = setTimeout(() => setFlashMsg(''), 2400)
    return () => clearTimeout(id)
  }, [flashN])

  function doReveal() {
    if (!card) return
    setRevealed(card.w)
    if (state.settings.autoSpeak) speak(card.w)
  }
  function gradeCard(g) {
    if (!card) return
    if (practice) { store.answer(card.w, g, false); store.practiceNext() }
    else store.answer(card.w, g)
  }

  React.useEffect(() => {
    const onKey = (ev) => {
      if (ev.defaultPrevented || ev.isComposing) return
      if (isTypingTarget(ev) || !plainKey(ev)) return
      if (!card || mode !== 'card') return
      if ((ev.key === ' ' || ev.key === 'Enter') && !showing) { ev.preventDefault(); doReveal() }
      else if (showing && (ev.key === '1' || ev.key === '2' || ev.key === '3')) {
        ev.preventDefault()
        gradeCard(ev.key === '1' ? GRADE_KNOW : ev.key === '2' ? GRADE_FUZZY : GRADE_MISS)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!card) {
    return h('div', null,
      !practice && h(ModeRow, { mode }),
      h(DoneView, { q, state }),
      flashMsg && h('div', { className: 'cv-flash' }, t(flashMsg)),
    )
  }

  return h('div', null,
    practice ? h(PracticeBar, { practice }) : h(ModeRow, { mode }),
    !practice && h(TodayBar, { state }),
    mode === 'card'
      ? h(CardView, { card, isNew, showing, onReveal: doReveal, onGrade: gradeCard })
      : h(QuizView, { card, isNew, state, onGrade: gradeCard }),
    flashMsg && h('div', { className: 'cv-flash' }, t(flashMsg)),
  )
}

function StatsView({ state }) {
  const s = bookStats(state)
  const rows = [
    { key: 'seen', label: t('learnedCard'), num: s.seen },
    { key: 'learning', label: t('learning'), num: s.learning },
    { key: 'graduated', label: t('mastered'), num: s.graduated },
    { key: 'streak', label: t('streak'), num: state.streak || 0 },
  ]
  const pct = s.total > 0 ? Math.round((s.graduated / s.total) * 100) : 0
  return h('div', null,
    h('div', { className: 'cv-tiles' },
      rows.map((r) => h('div', { className: 'cv-tile', key: r.key },
        h('div', { className: 'cv-tile-num' }, String(r.num)),
        h('div', { className: 'cv-tile-label' }, r.label),
      )),
    ),
    h('div', { className: 'cv-today' },
      h('span', null, t('overallProgress') + ' '),
      h('b', null, pct + '%'),
      h('span', null, s.graduated + '/' + s.total),
    ),
    h('div', { className: 'cv-bar' }, h('i', { style: { width: pct + '%' } })),
    h('div', { style: { marginTop: 10 } },
      [0, 1, 2, 3, 4, 5].map((b) => h('div', { className: 'cv-boxrow', key: b },
        h('span', { className: 'cv-boxrow-label' }, t('boxCard') + ' ' + (b + 1)),
        h('span', { className: 'cv-boxrow-bar' },
          h('i', { style: { width: (s.seen > 0 ? Math.round((s.boxes[b] / Math.max(1, s.seen)) * 100) : 0) + '%' } })),
        h('span', { className: 'cv-boxrow-num' }, String(s.boxes[b])),
      )),
    ),
    h('div', { className: 'cv-foot' },
      t('bookTotal') + ': ' + (state.settings.book === 'cet4' ? t('cet4') : state.settings.book === 'cet6' ? t('cet6') : t('all')) +
      ' · ' + s.total + ' 词'),
  )
}

function SettingsView({ state }) {
  const [armed, setArmed] = React.useState(false)
  const [panel, setPanel] = React.useState('')
  const [voices, setVoices] = React.useState(() => refreshVoices().slice())
  // Chromium populates the voice list late; re-read on the event and once after
  // mount so the picker is never permanently empty.
  React.useEffect(() => {
    const synth = window.speechSynthesis
    let alive = true
    const sync = () => { if (alive) setVoices(refreshVoices().slice()) }
    sync()
    if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', sync)
    // Electron often reports zero voices until the engine initialises; nudge it
    // and poll briefly rather than relying on a single 'voiceschanged' we may
    // have missed before the listener was attached.
    if (VOICE_RAW_COUNT === 0) {
      warmUpVoices()
      const t1 = window.setTimeout(sync, 250)
      const t2 = window.setTimeout(sync, 900)
      const t3 = window.setTimeout(sync, 2000)
      return () => {
        alive = false
        if (synth && synth.removeEventListener) synth.removeEventListener('voiceschanged', sync)
        window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3)
      }
    }
    return () => {
      alive = false
      if (synth && synth.removeEventListener) synth.removeEventListener('voiceschanged', sync)
    }
  }, [])
  const seg = (value, options, onPick) => h('div', { className: 'cv-seg' },
    options.map((o) => h('button', {
      key: o.v, className: value === o.v ? 'cv-on' : '', onClick: () => onPick(o.v),
    }, o.label)))
  const bookLabel = state.settings.book === 'cet6' ? t('cet6')
    : state.settings.book === 'all' ? t('all') : t('cet4')
  const accentLabel = ({ auto: t('accentAuto'), us: t('accentUS'), uk: t('accentUK') })[state.settings.accent || 'auto'] || t('accentAuto')
  const subHead = (title) => h('div', { className: 'cv-sub-head' },
    h('button', { className: 'cv-set-back', onClick: () => setPanel('') }, '‹ ' + t('tabSettings')),
    h('span', { className: 'cv-sub-title' }, title),
  )
  const learnPage = h('div', null,
    subHead(t('settingsLearn')),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsBook')),
      seg(state.settings.book, [
        { v: 'cet4', label: t('cet4') },
        { v: 'cet6', label: t('cet6') },
        { v: 'all', label: t('all') },
      ], (v) => store.setSettings({ book: v })),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsDaily')),
      seg(state.settings.dailyNew, [
        { v: 5, label: '5' }, { v: 10, label: '10' }, { v: 15, label: '15' }, { v: 20, label: '20' },
      ], (v) => store.setSettings({ dailyNew: v })),
      h('input', {
        className: 'cv-numinput cv-numinput--inline', type: 'number', min: 0, max: 500,
        title: t('settingsDaily'), 'aria-label': t('settingsDaily'),
        value: String(state.settings.dailyNew),
        onChange: (e) => {
          const v = parseInt(e.target.value, 10)
          if (!isNaN(v)) store.setSettings({ dailyNew: clamp(v, 0, 500) })
        },
      }),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsVoice')),
      h('div', { className: 'cv-voice' },
        seg(state.settings.accent || 'auto', [
          { v: 'auto', label: t('accentAuto') },
          { v: 'us', label: t('accentUS') },
          { v: 'uk', label: t('accentUK') },
        ], (v) => { store.setSettings({ accent: v }); speak('vocabulary', v) }),
        h('button', {
          className: 'cv-voice-test',
          title: t('voiceTest'),
          onClick: () => speak('vocabulary', state.settings.accent || 'auto'),
        }, '🔊'),
      ),
    ),
    h('div', { className: 'cv-hint cv-voice-empty' },
      h('div', null, enVoiceCount() > 0
        ? t('voiceSysOk').replace('{n}', String(enVoiceCount()))
        : t('voiceSysNone')),
      enVoiceCount() === 0 && h('button', {
        className: 'cv-voice-retry',
        onClick: () => { VOICE_WARMED = false; refreshVoices(); setVoices(refreshVoices().slice()); warmUpVoices() },
      }, '↻ ' + t('voiceRetry')),
    ),
  )
  const keysPage = h('div', null,
    subHead(t('scTitle')),
    h('div', { className: 'cv-sc-flat' },
      SC_GUIDE.map((id) => h('div', { className: 'cv-sc-row', key: id },
        h('span', { className: 'cv-sc-keys' }, SC[id].keys.map((k, i) => h('kbd', { key: k + i }, k))),
        h('span', { className: 'cv-sc-desc' }, t(SC[id].key)),
      )),
      h('div', { className: 'cv-sc-note' }, t('scNote')),
    ),
  )
  if (panel === 'learn') return learnPage
  if (panel === 'keys') return keysPage
  return h('div', null,
    h('button', { className: 'cv-set-entry', onClick: () => setPanel('learn') },
      h('span', { className: 'cv-set-label' }, t('settingsLearn')),
      h('span', { className: 'cv-set-value' },
        bookLabel + ' · ' + fmtT(t('dailyPerDay'), { n: state.settings.dailyNew }) + ' · ' + accentLabel),
      h('span', { className: 'cv-set-chevron' }, '›'),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsAppearance')),
      seg(state.settings.appearance || 'auto', [
        { v: 'auto', label: t('appearanceAuto') },
        { v: 'dark', label: t('appearanceDark') },
      ], (v) => store.setSettings({ appearance: v })),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsSpeak')),
      h('button', {
        role: 'switch', 'aria-checked': !!state.settings.autoSpeak,
        className: 'cv-switch' + (state.settings.autoSpeak ? ' cv-switch--on' : ''),
        onClick: () => store.setSettings({ autoSpeak: !state.settings.autoSpeak }),
      }, h('i', null)),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsAutoOpen')),
      h('button', {
        role: 'switch', 'aria-checked': state.settings.autoOpen !== false,
        className: 'cv-switch' + (state.settings.autoOpen !== false ? ' cv-switch--on' : ''),
        onClick: () => store.setSettings({ autoOpen: !(state.settings.autoOpen !== false) }),
      }, h('i', null)),
    ),
    h('button', { className: 'cv-set-entry', onClick: () => setPanel('keys') },
      h('span', { className: 'cv-set-label' }, '⌨️ ' + t('scTitle')),
      h('span', { className: 'cv-set-chevron' }, '›'),
    ),
    h('button', {
      className: 'cv-resetbtn',
      onClick: () => {
        if (!armed) { setArmed(true); return }
        store.reset()
        setArmed(false)
      },
    }, armed ? t('resetConfirm') : t('settingsReset')),
    h('div', { className: 'cv-foot' },
      t('dataSource') +
      (typeof CET_WORDS !== 'undefined' && CET_WORDS && CET_WORDS.counts
        ? ' · CET4 ' + CET_WORDS.counts.cet4 + ' / CET6 ' + CET_WORDS.counts.cet6
        : '')),
  )
}

function VocabWindow() {
  const state = useStoreState()
  useLocaleTick()
  const [tab, setTab] = React.useState('learn')
  const now = Date.now()
  const due = React.useMemo(() => buildQueue(state, now), [state]) // eslint-disable-line
  const badge = due.reviews.length + due.fresh.length
  const geom = state.win || {}
  const style = geom.x != null && geom.y != null
    ? { left: geom.x + 'px', top: geom.y + 'px' }
    : null
  return h('div', {
    className: 'cv-root' + ' ',
    children: undefined,
  }, h('div', {
    className: 'cv-window' + (geom.x == null ? ' cv-window--default' : ''),
    style,
  },
    h('div', { className: 'cv-head', onPointerDown: (e) => beginDrag(e, geom) },
      h('span', { className: 'cv-head-title' }, t('title')),
      h('span', { className: 'cv-head-due' }, t('dueNow') + ' ' + badge),
      h('span', { className: 'cv-head-spacer' }),
      h('button', { className: 'cv-iconbtn', title: t('minimize'), onClick: () => store.minimize(true) }, '—'),
    ),
    h('div', { className: 'cv-tabs' },
      ['learn', 'stats', 'settings'].map((k) => h('button', {
        key: k,
        className: 'cv-tab' + (tab === k ? ' cv-tab--on' : ''),
        onClick: () => setTab(k),
      }, t(k === 'learn' ? 'tabLearn' : k === 'stats' ? 'tabStats' : 'tabSettings'))),
    ),
    h('div', { className: 'cv-body' },
      tab === 'learn' ? h(LearnView, { state }) :
      tab === 'stats' ? h(StatsView, { state }) :
      h(SettingsView, { state }),
    ),
  ))
}

function VocabPill() {
  const state = useStoreState()
  useLocaleTick()
  const now = Date.now()
  const due = React.useMemo(() => buildQueue(state, now), [state]) // eslint-disable-line
  const badge = due.reviews.length + due.fresh.length
  const geom = state.win || {}
  const style = geom.x != null && geom.y != null ? { left: geom.x + 'px', top: geom.y + 'px' } : null
  return h('div', { className: 'cv-root' },
    h('div', {
      className: 'cv-pill' + (geom.x == null ? ' cv-pill--default' : ''),
      style,
      onPointerDown: (e) => beginDrag(e, null),
      onClick: () => { if (!dragMoved) store.minimize(false) },
      title: t('title'),
    },
      h('span', null, '📖 ' + t('title')),
      badge > 0 && h('span', { className: 'cv-pill-badge' }, String(badge)),
    ))
}

function VocabApp() {
  const state = useStoreState()
  if (!state || state.open === false) return null
  return (state.win && state.win.min) ? h(VocabPill) : h(VocabWindow)
}

// ------------------------------------------------------------- plugin entry

exports.name = PLUGIN_ID
exports.inject = ['slots', 'locale', 'sessions', 'remote']
exports.apply = function apply(ctx) {
  ctx.effect(
    () => {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-cet-vocab', '')
      // Tag with our module id: dsh-client-modules' claimStyles adopts any
      // untagged <style> for whichever plugin materializes next, and the next
      // HMR replace of THAT plugin would then delete ours (see dsh-todo-board).
      style.setAttribute('data-plugin', PLUGIN_ID)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    },
    'dsh-cet-vocab: styles',
  )

  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.locale.register('cet-vocab', 'zh', ZH)
      // User prefers Chinese buttons regardless of the app's UI language:
      // serve the zh dict for every locale this plugin registers.
      ctx.locale.register('cet-vocab', 'en', ZH)
      if (typeof ctx.locale.bind === 'function') {
        localeBinder = ctx.locale.bind('cet-vocab')
        if (typeof ctx.locale.subscribe === 'function') {
          ctxLocaleSubscribe = ctx.locale.subscribe.bind(ctx.locale)
        }
      }
    }
  } catch (e) {
    console.warn('[dsh-cet-vocab] locale wiring failed; falling back to keys', e)
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'cet-vocab', order: 45, label: () => t('title') },
      VocabApp,
    ),
  )

  // Keyboard shortcuts (key table and rationale: see the `SC` block above).
  // Additive by design — a key the host or the page already handled is left
  // untouched, so this can never break typing or a shell shortcut.
  ctx.effect(
    () => {
      const onKey = (ev) => {
        if (ev.defaultPrevented || ev.isComposing) return
        if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return // Alt-only
        const k = scKey(ev)
        if (k === 'q') {
          ev.preventDefault()
          store.toggleWindow()
          return
        }
        // Everything below needs the window on screen and the caret elsewhere
        // — Alt+Q is deliberately the one key that also works while typing,
        // because it is the only way back to a collapsed window.
        if (isTypingTarget(ev)) return
        const s = store.get()
        if (s.open === false || (s.win && s.win.min)) return
        if (k === 'r' || k === 'p') {
          // A session already under way is left alone (no accidental restart).
          // When the store has nothing to pick it stays a no-op, so say why
          // rather than looking broken.
          const kind = k === 'r' ? 'review' : 'extra'
          const cur = store.get().practice
          if (!(cur && cur.kind === kind)) {
            ev.preventDefault()
            store.startPractice(kind)
            const after = store.get().practice
            if (!(after && after.kind === kind)) flash(kind === 'review' ? 'practiceNoReview' : 'practiceNoExtra')
          }
        } else if (k === 'x') {
          if (store.get().practice) {
            ev.preventDefault()
            store.endPractice()
          }
        } else if (k === '1' || k === '2') {
          ev.preventDefault()
          store.setSettings({ mode: k === '1' ? 'card' : 'quiz' })
        } else if (k === 's') {
          const picked = pickCard(s, Date.now())
          if (picked.card) {
            ev.preventDefault()
            speak(picked.card.w)
          }
        }
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    },
    'dsh-cet-vocab: keyboard shortcuts',
  )

  // Accent contrast probe: re-derive --cv-accent* whenever the theme can
  // change — theme/event switches, light-vs-dark flips, or any slot change
  // (theme packages re-emit tokens through their own registrations).
  ctx.effect(
    () => {
      applyAccentProbe()
      const offs = []
      try { if (typeof ctx.on === 'function') offs.push(ctx.on('theme/change', applyAccentProbe)) } catch (e) {}
      try { if (typeof ctx.on === 'function') offs.push(ctx.on('slots/changed', applyAccentProbe)) } catch (e) {}
      // Watch the html element for class/attribute mutations (theme switches
      // toggle `data-theme`/`class`) instead of relying on ctx.on signatures.
      let observer = null
      try {
        if (typeof MutationObserver === 'function') {
          observer = new MutationObserver(() => applyAccentProbe())
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-dsh-theme', 'style'] })
        }
      } catch (e) { /* observer unavailable */ }
      let mq = null, mqHandler = null
      try {
        if (typeof window.matchMedia === 'function') {
          mq = window.matchMedia('(prefers-color-scheme: dark)')
          mqHandler = () => applyAccentProbe()
          if (mq.addEventListener) mq.addEventListener('change', mqHandler)
          else if (mq.addListener) mq.addListener(mqHandler)
        }
      } catch (e) { /* no media query support */ }
      // The probe writes three custom properties on <html>; restore the page
      // by deleting them on teardown (unload or plugin disable).
      return () => {
        for (const off of offs) { try { if (typeof off === 'function') off() } catch (e) {} }
        try { if (observer) observer.disconnect() } catch (e) {}
        try {
          if (mq && mqHandler) {
            if (mq.removeEventListener) mq.removeEventListener('change', mqHandler)
            else if (mq.removeListener) mq.removeListener(mqHandler)
          }
        } catch (e) {}
        teardownAccentProbe()
      }
    },
    'dsh-cet-vocab: accent probe',
  )

  // Auto-open while the model is thinking: watch any session's `running`
  // state and (re)open the window on the idle->busy transition. Requires the
  // `sessions` service (see exports.inject) — community plugins use
  // ctx.sessions.list.getSnapshot().byId[id].running the same way.
  try {
    let busy = false
    let lastAutoOpenAt = 0
    const onBusyChange = (now) => {
      if (now === busy) return
      busy = now
      if (!now) return
      const s = store.get()
      if (s.settings.autoOpen === false) return
      const hidden = s.open === false || (s.win && s.win.min)
      if (!hidden) return
      // 20 s dampener: rapid running flaps (subagents, approvals) within one
      // burst should not nag a user who just dismissed the window.
      const t = Date.now()
      if (t - lastAutoOpenAt < 20000) return
      lastAutoOpenAt = t
      store.set((st) => { st.open = true; st.win = { ...st.win, min: false } })
    }
    const readBusy = (list) => {
      try {
        const snap = list.getSnapshot()
        const rows = snap && snap.byId ? Object.values(snap.byId) : []
        onBusyChange(rows.some((r) => r && r.running === true))
      } catch (e) { /* session list unavailable */ }
    }
    let sessionsList = (ctx.sessions && ctx.sessions.list) || undefined
    if (!sessionsList && typeof ctx.get === 'function') {
      try { const svc = ctx.get('sessions'); if (svc && svc.list) sessionsList = svc.list } catch (e) { /* not provided yet */ }
    }
    if (sessionsList && typeof sessionsList.subscribe === 'function') {
      ctx.effect(() => {
        const dispose = sessionsList.subscribe(() => readBusy(sessionsList))
        readBusy(sessionsList)
        return dispose
      }, 'dsh-cet-vocab: session busy watcher')
    } else {
      // Last resort: poll every 1.5 s until the session list shows up.
      ctx.effect(() => {
        if (ctx.timer && typeof ctx.timer.interval === 'function') {
          return ctx.timer.interval(() => { if (sessionsList) readBusy(sessionsList) }, 1500)
        }
        const id = setInterval(() => { if (sessionsList) readBusy(sessionsList) }, 1500)
        return () => clearInterval(id)
      }, 'dsh-cet-vocab: session busy poller')
    }
  } catch (e) {
    console.warn('[dsh-cet-vocab] busy watcher unavailable', e)
  }
}

return module.exports;
} });
