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
// Everything here rides on the host browser's speechSynthesis: no audio files,
// no network. Chromium fills getVoices() asynchronously (often empty on the
// first call), so we keep a module cache and let the settings view re-read it
// on "voiceschanged".
//
// Note: we deliberately do NOT filter to English-only. On a Chinese Windows
// install the only SAPI voice is often "Microsoft Huihui" (zh-CN), and hiding
// it left the picker with nothing but "Auto". We list every voice and sort
// English first so the good ones are on top.

let VOICE_LIST = []
let VOICE_RAW_COUNT = 0
let VOICE_WARMED = false

function voiceRank(v) {
  const l = String((v && v.lang) || '')
  if (/^en[-_]us/i.test(l)) return 0
  if (/^en[-_]gb/i.test(l)) return 1
  if (/^en([-_]|$)/i.test(l)) return 2
  return 3
}

/** Re-read every voice the browser exposes into VOICE_LIST; returns the list. */
function refreshVoices() {
  try {
    const synth = window.speechSynthesis
    if (!synth || !synth.getVoices) return VOICE_LIST
    const all = (synth.getVoices() || []).slice()
    VOICE_RAW_COUNT = all.length
    all.sort((a, b) => {
      const ra = voiceRank(a)
      const rb = voiceRank(b)
      if (ra !== rb) return ra - rb
      return String(a.name || '').localeCompare(String(b.name || ''))
    })
    VOICE_LIST = all
  } catch (e) { /* speech is best-effort */ }
  return VOICE_LIST
}

/**
 * Chromium/Electron keeps getVoices() empty until the TTS engine is actually
 * initialised, and on desktop that sometimes only happens after the first
 * utterance. Speak one silent word once to force it, then the normal
 * voiceschanged path takes over. Guarded so it runs at most once per page.
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

/** Resolve a saved voiceURI (or name) against the cached English voices. */
function pickVoice(uri) {
  if (!uri) return null
  const list = VOICE_LIST.length > 0 ? VOICE_LIST : refreshVoices()
  for (const v of list) if (v.voiceURI === uri || v.name === uri) return v
  return null
}

/**
 * Speak one English word. `forceUri` overrides the saved preference so the
 * settings page can preview a voice before committing to it.
 */
function speak(word, forceUri) {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const u = new SpeechSynthesisUtterance(word)
    u.lang = 'en-US'
    u.rate = 0.92
    let uri = forceUri
    if (uri == null) {
      try { uri = store.state.settings.voice || '' } catch (e) { uri = '' }
    }
    const v = pickVoice(uri)
    if (v) {
      u.voice = v
      u.lang = v.lang || u.lang
    }
    synth.cancel()
    synth.speak(u)
  } catch (e) { /* speech is best-effort */ }
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
    settings: { book: 'cet4', dailyNew: 10, autoSpeak: false, speakOnOpen: false, mode: 'card', autoOpen: true, appearance: 'auto', voice: '' },
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

const ZH = {"title":"背单词","tabLearn":"学习","tabStats":"统计","tabSettings":"设置","reveal":"显示释义","known":"认识","fuzzy":"模糊","unknown":"不认识","newToday":"今日新学","reviewDone":"今日复习","streak":"连续","streakUnit":"天","dueNow":"待复习","newLeft":"待新学","allDone":"今日计划完成","dueLater":"{n} 个词稍后到期","seeYou":"明天见 👋","mastered":"已掌握","learning":"学习中","bookTotal":"词库","overallProgress":"总进度","settingsBook":"词库","cet4":"四级","cet6":"六级","all":"全部","settingsDaily":"每日新词","settingsSpeak":"显示释义时自动发音","settingsVoice":"发音音色","voiceAuto":"自动选择","voiceTest":"试听","voiceMissing":"（已卸载）","voiceNone":"系统里没有读到可用的语音包，下拉只有「自动选择」。可在 Windows 设置 → 时间和语言 → 语音 里添加英语语音包，然后点下面重试。","voiceRetry":"重新检测","settingsReset":"重置全部进度","resetConfirm":"再点一次确认重置","dataSource":"词库数据：ECDICT（MIT 许可）","bookBadge4":"四级","bookBadge6":"六级","bookBadgeBoth":"四六级","minimize":"收起","review":"复习","newWord":"新词","noPhonetic":"—","todayCard":"今日","learnedCard":"已学","boxCard":"记忆阶段","emptyQueueHint":"复习和新词都已完成，可以收起来啦","changeBookHint":"可在「设置」里切换四六级词库","graduated":"已毕业","modeCard":"卡片","modeQuiz":"选择","practiceTag":"加练","practiceReview":"复习到期词","practiceExtra":"加练 10 词","practiceExit":"退出加练","quizCorrect":"答对了","quizWrong":"答错了","optHint":"按 1-4 选择答案","settingsCustom":"自定义","settingsAutoOpen":"模型思考时自动弹出","autoOpenToast":"模型思考中，来背两个单词吧 📖","settingsAppearance":"外观","appearanceAuto":"跟随主题","appearanceDark":"深色"}
const EN = {"title":"Vocabulary","tabLearn":"Learn","tabStats":"Stats","tabSettings":"Settings","reveal":"Show meaning","known":"Know","fuzzy":"Fuzzy","unknown":"Miss","newToday":"New today","reviewDone":"Reviewed today","streak":"Streak","streakUnit":"d","dueNow":"Due","newLeft":"New left","allDone":"Daily plan complete","dueLater":"{n} words due later","seeYou":"See you tomorrow 👋","mastered":"Mastered","learning":"Learning","bookTotal":"Book","overallProgress":"Overall progress","settingsBook":"Word book","cet4":"CET-4","cet6":"CET-6","all":"All","settingsDaily":"New words / day","settingsSpeak":"Speak on reveal","settingsVoice":"Voice","voiceAuto":"Auto","voiceTest":"Preview","voiceMissing":"(not installed)","voiceNone":"No speech voice could be read, so only Auto is listed. Add an English voice pack in Windows Settings → Time & language → Speech, then use Retry below.","voiceRetry":"Retry","settingsReset":"Reset all progress","resetConfirm":"Click again to confirm","dataSource":"Word data: ECDICT (MIT license)","bookBadge4":"CET-4","bookBadge6":"CET-6","bookBadgeBoth":"CET-4/6","minimize":"Collapse","review":"Review","newWord":"New","noPhonetic":"—","todayCard":"Today","learnedCard":"Learned","boxCard":"Memory stage","emptyQueueHint":"Reviews and new words are done for today","changeBookHint":"Switch word book in Settings","graduated":"Graduated","modeCard":"Cards","modeQuiz":"Quiz","practiceTag":"Practice","practiceReview":"Review due words","practiceExtra":"Practice +10","practiceExit":"Exit practice","quizCorrect":"Correct","quizWrong":"Wrong","optHint":"Press 1-4 to answer","settingsCustom":"Custom","settingsAutoOpen":"Pop up while the model thinks","autoOpenToast":"Model is thinking — quick vocab break 📖","settingsAppearance":"Appearance","appearanceAuto":"Follow theme","appearanceDark":"Dark"}

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
`

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
      : h('div', { className: 'cv-hint' }, 'Space 显示释义 · 1/2/3 评分'),
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
      if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return
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

  let card = null
  let isNew = false
  if (practice) {
    const w = practice.words[practice.i]
    const e = w ? BOOK_INDEX.entry(w) : null
    if (e) { card = e; isNew = !state.words[w] }
  } else {
    card = q.reviews[0] || q.fresh[0] || null
    isNew = card ? !state.words[card.w] : false
  }
  const showing = card ? revealed === card.w : false

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
      if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return
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
    )
  }

  return h('div', null,
    practice ? h(PracticeBar, { practice }) : h(ModeRow, { mode }),
    !practice && h(TodayBar, { state }),
    mode === 'card'
      ? h(CardView, { card, isNew, showing, onReveal: doReveal, onGrade: gradeCard })
      : h(QuizView, { card, isNew, state, onGrade: gradeCard }),
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
  const curVoice = state.settings.voice || ''
  // Always keep the saved value selectable, even if the browser no longer
  // reports that voice (voice packs get uninstalled) — otherwise the <select>
  // would silently snap to "Auto" and the user's choice would look lost.
  const voiceOptions = [{ v: '', label: t('voiceAuto') }].concat(
    voices.map((v) => ({ v: v.voiceURI || v.name, label: v.name + (v.lang ? ' · ' + v.lang : '') })),
  )
  if (curVoice && !voiceOptions.some((o) => o.v === curVoice)) {
    voiceOptions.push({ v: curVoice, label: curVoice + ' · ' + t('voiceMissing') })
  }
  return h('div', null,
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsBook')),
      seg(state.settings.book, [
        { v: 'cet4', label: t('cet4') },
        { v: 'cet6', label: t('cet6') },
        { v: 'all', label: t('all') },
      ], (v) => store.setSettings({ book: v })),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsAppearance')),
      seg(state.settings.appearance || 'auto', [
        { v: 'auto', label: t('appearanceAuto') },
        { v: 'dark', label: t('appearanceDark') },
      ], (v) => store.setSettings({ appearance: v })),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsDaily')),
      seg(state.settings.dailyNew, [
        { v: 5, label: '5' }, { v: 10, label: '10' }, { v: 15, label: '15' }, { v: 20, label: '20' },
      ], (v) => store.setSettings({ dailyNew: v })),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsCustom')),
      h('input', {
        className: 'cv-numinput', type: 'number', min: 0, max: 500,
        value: String(state.settings.dailyNew),
        onChange: (e) => {
          const v = parseInt(e.target.value, 10)
          if (!isNaN(v)) store.setSettings({ dailyNew: clamp(v, 0, 500) })
        },
      }),
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
      h('span', { className: 'cv-set-label' }, t('settingsVoice')),
      h('div', { className: 'cv-voice' },
        h('select', {
          className: 'cv-select',
          value: curVoice,
          onChange: (e) => {
            const v = e.target.value
            store.setSettings({ voice: v })
            speak('vocabulary', v) // preview the freshly picked voice
          },
        }, voiceOptions.map((o) => h('option', { key: o.v, value: o.v }, o.label))),
        h('button', {
          className: 'cv-voice-test',
          title: t('voiceTest'),
          onClick: () => speak('vocabulary', curVoice),
        }, '🔊'),
      ),
    ),
    voices.length === 0 && h('div', { className: 'cv-hint cv-voice-empty' },
      h('div', null, t('voiceNone')),
      h('button', {
        className: 'cv-voice-retry',
        onClick: () => { VOICE_WARMED = false; refreshVoices(); setVoices(refreshVoices().slice()); warmUpVoices() },
      }, '↻ ' + t('voiceRetry')),
    ),
    h('div', { className: 'cv-set-row' },
      h('span', { className: 'cv-set-label' }, t('settingsAutoOpen')),
      h('button', {
        role: 'switch', 'aria-checked': state.settings.autoOpen !== false,
        className: 'cv-switch' + (state.settings.autoOpen !== false ? ' cv-switch--on' : ''),
        onClick: () => store.setSettings({ autoOpen: !(state.settings.autoOpen !== false) }),
      }, h('i', null)),
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
