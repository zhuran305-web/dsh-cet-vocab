#!/usr/bin/env node
/**
 * Build dsh-cet-vocab/client.js (repo layout):
 *   scripts/ lives inside the package, client.src.js and data/words.json
 *   sit next to it. `/*__WORDS__*​/` in the source is replaced by
 *   `const CET_WORDS = {...};`, then the result is syntax-checked.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scripts = fileURLToPath(new URL('.', import.meta.url)) // <pkg>/scripts/
const pkg = join(scripts, '..')
const src = readFileSync(join(pkg, 'client.src.js'), 'utf8')
const words = JSON.parse(readFileSync(join(pkg, 'data', 'words.json'), 'utf8'))

const wordsLiteral =
  'const CET_WORDS = ' + JSON.stringify(words) + ';\n'
const out = src.replace('/*__WORDS__*/', wordsLiteral)

const dest = join(pkg, 'client.js')
writeFileSync(dest, out, 'utf8')

const size = statSync(dest).size
console.log('client.js written:', size, 'bytes',
  'words:', words.words.length,
  'cet4:', words.counts.cet4, 'cet6:', words.counts.cet6)

const check = spawnSync(process.execPath, ['--check', dest], { encoding: 'utf8' })
if (check.status !== 0) {
  console.error('SYNTAX CHECK FAILED:\n' + (check.stderr || check.stdout))
  process.exit(1)
}
console.log('node --check OK')
