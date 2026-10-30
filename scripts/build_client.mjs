#!/usr/bin/env node
/**
 * Build dsh-cet-vocab/client.js:
 *   client.src.js  with  /*__WORDS__*​/  replaced by  const CET_WORDS = {...};
 * then syntax-check the result with node --check.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('.', import.meta.url)) // .../四六级/scripts/
const pkg = join(root, '..', 'dsh-cet-vocab')
const src = readFileSync(join(pkg, 'client.src.js'), 'utf8')
const words = JSON.parse(readFileSync(join(root, '..', 'data', 'words.json'), 'utf8'))

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
