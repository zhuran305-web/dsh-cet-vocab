// Offline verification for the whole-window contrast probe.
// Pure functions are scraped out of client.src.js by name so the browser
// bundle and this test can never drift apart.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.src.js'), 'utf8')

function grab(name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) throw new Error('function not found in client.src.js: ' + name)
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('unbalanced braces for ' + name)
  return src.slice(start, end) + '\n'
}

const constStart = src.indexOf('const BLACK_RGB')
const consts = src.slice(constStart, src.indexOf('const PROBE_VARS'))

const names = ['srgbToLin', 'relLum', 'contrastRatio', 'mixRgb', 'rgbHex', 'findMixTo', 'ensureSeparation', 'solvePair']
const nested = grab('pickLayer')
const api = eval(consts + names.map(grab).join('\n') + nested + '\n;({' + names.join(',') + ',pickLayer})')
const { relLum, contrastRatio, mixRgb, rgbHex, solvePair, pickLayer } = api

const WHITE = [255, 255, 255], BLACK = [0, 0, 0]
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const r2 = (n) => Math.round(n * 100) / 100

let failures = 0
const check = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= (tol === undefined ? 0.05 : tol)
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + r2(got) + (ok ? '' : ' (expected ' + want + ')'))
}

// 1. already-passing themes must not move by a single byte
for (const [surf, text, name, expect] of [
  ['#6e7378', '#ffffff', 'default gray + white text', 4.79],
  ['#2a2d31', '#ffffff', 'pure dark + white text', 13.83],
  ['#f5f6f8', '#181a1e', 'pure white + dark text', 16.11],
]) {
  const s = hex(surf), t = hex(text)
  const before = contrastRatio(s, t)
  const out = solvePair(s, t, 4.5)
  check(name + ' unchanged', contrastRatio(out[0], out[1]), before)
  check(name + ' value', before, expect)
  if (rgbHex(out[0]) !== surf || rgbHex(out[1]) !== text) {
    console.log('FAIL  ' + name + ' untouched rgb: got ' + rgbHex(out[0]) + '/' + rgbHex(out[1]))
    failures++
  } else console.log('PASS  ' + name + ' rgb untouched')
}

// 2. the failing theme: pale gray window with white text gets darkened only enough
{
  const s = hex('#8a8f94'), t = WHITE
  check('#8a8f94 + white before', contrastRatio(s, t), 3.26)
  const out = solvePair(s, t, 4.5)
  check('#8a8f94 + white after', contrastRatio(out[0], out[1]), 4.57)
  console.log('      surface -> ' + rgbHex(out[0]) + '  text -> ' + rgbHex(out[1]) + ' (must stay near white)')
  if (relLum(out[1]) < 0.8) { console.log('FAIL  text was flipped dark'); failures++ }
  if (rgbHex(out[0]) !== '#72767b') console.log('      note: surface ' + rgbHex(out[0]) + ' (evidence #72767b)')
}

// 3. card / control layers on the adjusted surface: readable text AND visible separation
for (const [surf, card, label] of [
  ['#8a8f94', '#f5f6f8', 'white card on adjusted gray window'],
  ['#6e7378', '#f5f6f8', 'white card on default gray window'],
  ['#2a2d31', '#3a3f45', 'dark card on dark window'],
]) {
  const s = solvePair(hex(surf), WHITE, 4.5)
  const l = pickLayer(hex(card), s[0], s[1], 1.25)
  const onCard = contrastRatio(l, s[1])
  const sep = contrastRatio(l, s[0])
  console.log('      ' + label + ': card ' + rgbHex(l) + ' text-on-card ' + r2(onCard) + ' separation ' + r2(sep))
  if (onCard < 4.5) { console.log('FAIL  ' + label + ' text-on-card < 4.5'); failures++ }
  if (sep < 1.1) { console.log('FAIL  ' + label + ' card not separable from surface'); failures++ }
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall surface checks pass')
process.exit(failures ? 1 : 0)
