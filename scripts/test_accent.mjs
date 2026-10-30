// Offline verification for the accent (button / pill / progress / switch) rule.
// Scrapes the pure helpers out of client.src.js, then replays exactly the
// decision block applyAccentProbe uses for --cv-accent / --cv-accent-fg.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.src.js'), 'utf8')
function grab(name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('not found: ' + name)
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  return src.slice(start, end) + '\n'
}
const consts = src.slice(src.indexOf('const BLACK_RGB'), src.indexOf('const PROBE_VARS'))
const names = ['srgbToLin', 'relLum', 'contrastRatio', 'mixRgb', 'rgbHex', 'findMixTo']
const api = eval(consts + names.map(grab).join('\n') + '\n;({' + names.join(',') + '})')
const { contrastRatio, mixRgb, rgbHex, findMixTo } = api
const WHITE = [255, 255, 255], BLACK = [0, 0, 0], DARK_FG = [18, 22, 28]

// Mirrors the --cv-accent branch in applyAccentProbe (threshold 3.0 for white,
// because button labels are semibold = AA large/bold tier).
function solveAccent(brand) {
  if (contrastRatio(brand, WHITE) >= 3.0) return [brand, '#ffffff']
  if (contrastRatio(brand, DARK_FG) >= 4.5) return [brand, rgbHex(DARK_FG)]
  const darkened = findMixTo(brand, BLACK, WHITE, 4.5)
  const lightened = findMixTo(brand, WHITE, DARK_FG, 4.5)
  return contrastRatio(darkened, WHITE) >= contrastRatio(lightened, DARK_FG)
    ? [darkened, '#ffffff'] : [lightened, rgbHex(DARK_FG)]
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const r2 = (n) => Math.round(n * 100) / 100
let failures = 0
const expect = (label, brand, wantFg, wantRatio, tol) => {
  const [accent, fg] = solveAccent(hex(brand))
  const got = contrastRatio(accent, fg === '#ffffff' ? WHITE : hex(fg))
  const ok = fg === wantFg && Math.abs(got - wantRatio) <= (tol === undefined ? 0.05 : tol)
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ' ' + brand + ' -> bg ' + rgbHex(accent)
    + ' fg ' + fg + ' ratio ' + r2(got) + (ok ? '' : ' (want ' + wantFg + ' ' + wantRatio + ')'))
}

expect('saturated blue keeps WHITE text', '#3d7eff', '#ffffff', 3.73)
expect('pale blue falls to DARK text     ', '#d6e6ff', rgbHex(DARK_FG), 14.36)
expect('near-white falls to DARK text    ', '#f2f2f2', rgbHex(DARK_FG), 16.21)
// the reported bug: default style's pale brand color must never stay white-on-white
const [a, f] = solveAccent(hex('#d6e6ff'))
if (contrastRatio(a, WHITE) > 1.5 && f === '#ffffff') { console.log('FAIL  pale brand kept white text'); failures++ }

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall accent checks pass')
process.exit(failures ? 1 : 0)
