/**
 * sync_locale.mjs — 把 locale/zh.json、locale/en.json 与 client.src.js 里内联的
 * ZH / EN 字典对齐（三处 i18n 的单一真源 = 源码内联字典）。
 *
 * 用法（在包目录或工作区任意位置都能跑）：
 *   node scripts/sync_locale.mjs [--check] [--pkg <包目录>]
 *
 *   --check  只报告差异、不写文件（退出码 1 表示有差异；2 表示内联 ZH/EN 自身不一致）
 *   --pkg    显式指定包目录（默认自动探测：本脚本的上一级，或上一级的 dsh-cet-vocab/）
 *
 * 行为：
 *   - meta 块（插件市场用的 title/description）保留原样，永远取自 locale 文件
 *   - 其余键一律按内联字典的顺序与内容重写 → 补上只在客户端存在的键
 *   - locale 文件里客户端零引用的键会被删除（例如历史遗留的 dueBadge）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { optionValue, resolvePkgDir } from './lib/pkgdir.mjs'

const CHECK = process.argv.includes('--check')
const pkgDir = resolvePkgDir(import.meta.url, optionValue(process.argv, '--pkg'))
const src = readFileSync(join(pkgDir, 'client.src.js'), 'utf8')

const grab = (name) => {
  const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\})\\n`))
  if (!m) throw new Error(`client.src.js 里找不到 const ${name} 常量`)
  return JSON.parse(m[1])
}
const ZH = grab('ZH')
const EN = grab('EN')

const zk = Object.keys(ZH).sort()
const ek = Object.keys(EN).sort()
if (JSON.stringify(zk) !== JSON.stringify(ek)) {
  const onlyZh = zk.filter((k) => !ek.includes(k))
  const onlyEn = ek.filter((k) => !zk.includes(k))
  console.error(`内联 ZH/EN 键集不一致（仅 ZH: ${onlyZh.join(',') || '无'}；仅 EN: ${onlyEn.join(',') || '无'}）`)
  process.exit(2)
}

let problems = 0
for (const [file, dict, label] of [['locale/zh.json', ZH, 'zh'], ['locale/en.json', EN, 'en']]) {
  const path = join(pkgDir, file)
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const meta = raw.meta || {}
  const fileKeys = Object.keys(raw).filter((k) => k !== 'meta')

  const added = Object.keys(dict).filter((k) => !fileKeys.includes(k))
  const removed = fileKeys.filter((k) => !(k in dict))
  const changed = fileKeys.filter((k) => k in dict && raw[k] !== dict[k])

  const next = { meta, ...dict }
  const text = JSON.stringify(next, null, 2) + '\n'
  console.log(`[${label}] ${file}: ${fileKeys.length} 键 → ${Object.keys(dict).length} 键`
    + `  补 ${added.length}${added.length ? ' (' + added.join(',') + ')' : ''}`
    + `  删 ${removed.length}${removed.length ? ' (' + removed.join(',') + ')' : ''}`
    + `  改 ${changed.length}${changed.length ? ' (' + changed.join(',') + ')' : ''}`)
  if (added.length || removed.length || changed.length) problems++

  if (!CHECK && readFileSync(path, 'utf8') !== text) {
    writeFileSync(path, text, 'utf8')
    console.log(`      → 已写入 ${file}`)
  }
}

console.log(problems === 0 ? '\nPASS: 三处 i18n 已一致' : `\n${CHECK ? 'FAIL' : 'DONE'}: ${problems} 个文件有差异`)
process.exit(CHECK && problems ? 1 : 0)
