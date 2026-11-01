/**
 * smoke_release_install.mjs — 冒烟测试：把 Release 里发出去的包，按“普通用户刚装完”
 * 的状态检查一遍（AI 不用改这个脚本也能读懂结论：末尾会打印 PASS/FAIL 汇总）。
 *
 * 用法（在包目录或工作区任意位置都能跑）：
 *   node scripts/smoke_release_install.mjs                            # 检查本包
 *   node scripts/smoke_release_install.mjs <包目录> [参照 client.js]  # 检查解包/已安装的副本
 *   --pkg <包目录>   显式指定“本包”目录（默认自动探测：本脚本的上一级，或上一级的 dsh-cet-vocab/）
 *
 * 检查三类：
 *   A 包完整性 —— files/exports/locale/icon/patch 是否齐、是否与仓库构建产物一致
 *   B 宿主半边 —— index.js 能被 import，导出 apply
 *   C 浏览器半边 —— 在 vm 沙箱里用假 module loader + 假 ctx 跑 client.js，
 *                   确认注册了 shell.overlay 槽位、注册了 locale、词库 5805 条
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { optionValue, resolvePkgDir } from './lib/pkgdir.mjs'

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const ownPkg = resolvePkgDir(import.meta.url, optionValue(process.argv, '--pkg'))
// 默认检查“本包”；传一个目录就检查那个副本（tgz 解包出来 / 已安装的）
const pkgDir = positional[0] ? resolve(positional[0]) : ownPkg
// 逐字节比对的参照物：显式传的第二个参数，或（检查的不是本包时）本包的构建产物
const repoClient = positional[1] || (pkgDir === ownPkg ? '' : join(ownPkg, 'client.js'))
if (!existsSync(join(pkgDir, 'package.json'))) {
  console.error(`usage: smoke_release_install.mjs [<package-dir> [reference client.js]] — 不是包目录：${pkgDir}`)
  process.exit(2)
}

const problems = []
const notes = []
const ok = (cond, label, detail = '') => {
  if (cond) notes.push(`  ok   ${label}${detail ? ' — ' + detail : ''}`)
  else problems.push(`${label}${detail ? ' — ' + detail : ''}`)
  return cond
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

// ------------------------------------------------------------------ A 包完整性
const pkgPath = join(pkgDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
console.log(`\n== A. 包完整性 (${pkg.name}@${pkg.version}) ==`)
ok(pkg.name === 'dsh-cet-vocab', 'package name', pkg.name)
ok(typeof pkg.version === 'string' && /^0\./.test(pkg.version), 'version', pkg.version)
ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web', String(pkg.dsh?.client?.platform))
ok(pkg.dsh?.client?.immediately === true, 'dsh.client.immediately = true')
const inject = pkg.dsh?.client?.inject || []
for (const need of ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-theme']) {
  ok(inject.includes(need), `client inject: ${need}`)
}
ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 patch 文件')

for (const f of pkg.files || []) ok(existsSync(join(pkgDir, f)), `files[] 存在: ${f}`)

for (const [key, target] of Object.entries(pkg.exports || {})) {
  if (key.includes('*')) {
    const dir = join(pkgDir, target.replace('./', '').replace('/*.json', ''))
    if (ok(existsSync(dir), `exports 通配目录: ${key}`)) {
      const n = readdirSync(dir).filter((f) => f.endsWith('.json')).length
      ok(n >= 2, `exports 通配命中文件数: ${key}`, `${n} 个 json`)
    }
  } else {
    ok(existsSync(join(pkgDir, target)), `exports 目标存在: ${key} -> ${target}`)
  }
}

const zh = JSON.parse(readFileSync(join(pkgDir, 'locale/zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(pkgDir, 'locale/en.json'), 'utf8'))
const kz = Object.keys(zh).sort(); const ke = Object.keys(en).sort()
ok(kz.length > 0, 'locale/zh.json 可解析', `${kz.length} 键`)
ok(JSON.stringify(kz) === JSON.stringify(ke), 'zh/en 键集一致', `zh ${kz.length} / en ${ke.length}`)
ok(Boolean(zh.meta?.title && zh.meta?.description), 'locale 含 meta.title/meta.description', String(zh.meta?.title || ''))

const iconBuf = readFileSync(join(pkgDir, 'icon.svg'))
ok(iconBuf.length <= 256 * 1024, 'icon ≤ 256 KiB', `${iconBuf.length} B`)
ok(iconBuf.slice(0, 80).toString('utf8').includes('<svg'), 'icon 是 SVG')

const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
ok(/^\s*-\s*insert:/m.test(patch) || patch.includes('insert:'), 'patch 含 insert:')
ok(/name:\s*['"]?dsh-cet-vocab['"]?/.test(patch), 'patch 指向包自己')
ok(/id:\s*cet-vocab/.test(patch), 'patch 条目 id = cet-vocab')

const clientCode = readFileSync(join(pkgDir, 'client.js'), 'utf8')
const idx = readFileSync(join(pkgDir, 'index.js'), 'utf8')
notes.push(`  info client.js ${Buffer.byteLength(clientCode)} B sha256:${sha(clientCode)}; index.js ${Buffer.byteLength(idx)} B sha256:${sha(idx)}`)
if (repoClient && existsSync(repoClient)) {
  const repo = readFileSync(repoClient, 'utf8')
  ok(sha(repo) === sha(clientCode), '发布产物与仓库构建产物逐字节一致', `repo ${Buffer.byteLength(repo)} B`)
}

// ------------------------------------------------------------------ B 宿主半边
console.log('== B. 宿主半边 ==')
const host = await import(pathToFileURL(join(pkgDir, 'index.js')).href)
ok(typeof host.apply === 'function', 'index.js 导出 apply()')
ok(Object.keys(host).every((k) => k === 'apply' || k === 'default'), '宿主导出面干净', Object.keys(host).join(','))

// ------------------------------------------------------------------ C 浏览器半边
console.log('== C. 浏览器半边（沙箱启动） ==')
const STYLE_VALUES = {
  '--dsw-alias-brand-primary': '#4d6bfe',
  '--dsw-alias-brand-primary-foreground': '#ffffff',
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-layer-1': '#f5f6f7',
  '--dsw-alias-text-primary': '#1b1c1e',
}
const styleStub = () => ({
  setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {},
  textContent: '', style: { setProperty() {}, removeProperty() {} },
})
const elStub = () => ({
  ...styleStub(), getAttribute: () => null, setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false },
})
let captured = null
const documentStub = {
  createElement: () => styleStub(),
  head: { appendChild() {} },
  body: elStub(),
  documentElement: elStub(),
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
}
const windowStub = {
  __ModuleLoader__: { load(mod) { captured = mod } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } })(),
  speechSynthesis: { getVoices: () => [], speak() {}, cancel() {}, addEventListener() {}, removeEventListener() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
}
const sandbox = {
  window: windowStub, document: documentStub, localStorage: windowStub.localStorage,
  getComputedStyle: () => ({ getPropertyValue: (n) => STYLE_VALUES[n] ?? '#808080' }),
  MutationObserver: class { observe() {} disconnect() {} },
  Audio: class { play() { return Promise.resolve() } pause() {} addEventListener() {} removeEventListener() {} },
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, Symbol, parseFloat, parseInt, isNaN,
}
sandbox.window.document = documentStub
sandbox.globalThis = sandbox
const ctxVm = vm.createContext(sandbox)
const instrumented = clientCode.replace(
  /\nreturn module\.exports;\n\} \}\);\s*$/,
  '\nglobalThis.__CET_WORDS__ = typeof CET_WORDS !== "undefined" ? CET_WORDS : null;\nglobalThis.__ZH__ = typeof ZH !== "undefined" ? ZH : null;\nreturn module.exports;\n} });\n',
)
ok(instrumented !== clientCode, '已插桩取出内嵌词库')
vm.runInContext(instrumented, ctxVm, { filename: 'client.js' })
ok(Boolean(captured), 'client.js 调用 window.__ModuleLoader__.load')
ok(captured?.id === 'dsh-cet-vocab', '模块 id', String(captured?.id))

const React = new Proxy({}, { get: (_t, k) => (k === 'default' ? React : () => null) })
const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
ok(mod?.name === 'dsh-cet-vocab', 'exports.name')
for (const need of ['slots', 'locale', 'sessions', 'remote']) ok((mod.inject || []).includes(need), `exports.inject 含 ${need}`)
ok(typeof mod.apply === 'function', 'exports.apply 是函数')

const calls = { slotInject: [], registered: [], locale: [], effects: 0, events: [] }
const fakeCtx = {
  effect(fn, label) { calls.effects++; const d = fn(); return typeof d === 'function' ? d : () => {} },
  on(name, fn) { calls.events.push(name); return () => {} },
  get: () => undefined,
  slots: {
    inject(slot, cb) { calls.slotInject.push(slot); return cb() },
    register(spec, Comp) { calls.registered.push({ spec, Comp }); return { spec } },
  },
  locale: {
    register(ns, loc, dict) { calls.locale.push({ ns, loc, keys: Object.keys(dict).length }) },
    bind: () => (k) => k,
    subscribe: () => () => {},
  },
  sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } },
}
let threw = null
try { mod.apply(fakeCtx) } catch (e) { threw = e }
ok(!threw, 'apply(ctx) 不抛异常', threw ? String(threw && threw.message) : '')
ok(calls.slotInject.includes('shell.overlay'), '注册进 shell.overlay 槽位', calls.slotInject.join(','))
const reg = calls.registered.find((r) => r.spec?.id === 'cet-vocab')
ok(Boolean(reg), '槽位条目 id = cet-vocab')
ok(reg?.spec?.name === 'shell.overlay', '槽位条目 name = shell.overlay', String(reg?.spec?.name))
ok(reg?.spec?.order === 45, '槽位 order = 45', String(reg?.spec?.order))
ok(typeof reg?.spec?.label === 'function', '槽位 label 是函数')
ok(calls.locale.some((l) => l.ns === 'cet-vocab' && l.loc === 'zh'), 'locale 注册 zh 字典', JSON.stringify(calls.locale.map((l) => l.loc)))
ok(calls.locale.some((l) => l.loc === 'en'), 'locale 注册 en 字典（中文回落）')
const inlineKeys = Object.keys(ctxVm.__ZH__ || {})
ok(calls.locale.length === 2 && calls.locale.every((l) => l.keys === inlineKeys.length), '注册字典键数 = 客户端内联字典', `注册 ${calls.locale.map((l) => l.keys).join('/') || '无'} vs 内联 ${inlineKeys.length}`)
ok(calls.effects >= 2, 'ctx.effect 至少注册 2 项（样式 + accent 探针）', String(calls.effects))

const words = ctxVm.__CET_WORDS__
ok(Boolean(words), '内嵌词库可取（CET_WORDS）')
ok(words?.counts?.total === 5805, 'counts.total = 5805', String(words?.counts?.total))
ok(words?.words?.length === 5805, 'words 数组长度 5805', String(words?.words?.length))
ok(words?.src?.includes('ECDICT'), '词库来源标注 ECDICT', String(words?.src))
const sample = words?.words?.find((r) => r.w === 'state')
ok(Boolean(sample && sample.p && sample.t), '词条字段完整（w/p/t）', sample ? `state -> ${String(sample.p)}` : 'missing')

const clientZh = ctxVm.__ZH__ || {}
const clientKeys = Object.keys(clientZh).sort()
const fileUiKeys = kz.filter((k) => k !== 'meta')
const onlyClient = clientKeys.filter((k) => !fileUiKeys.includes(k))
const onlyFile = fileUiKeys.filter((k) => !clientKeys.includes(k))
console.log(`  info 客户端内联字典 ${clientKeys.length} 键 / locale/zh.json（除 meta）${fileUiKeys.length} 键`)
if (onlyClient.length) console.log(`  info 仅客户端有: ${onlyClient.join(', ')}`)
if (onlyFile.length) console.log(`  info 仅 locale 文件有: ${onlyFile.join(', ')}`)
ok(onlyClient.length === 0 && onlyFile.length === 0, '客户端内联字典与 locale/zh.json（除 meta）键集一致',
  `仅客户端 ${onlyClient.length} / 仅文件 ${onlyFile.length}`)

// ------------------------------------------------------------------ 汇总
console.log(notes.join('\n'))
console.log('\n== 汇总 ==')
if (problems.length === 0) {
  console.log(`PASS — ${notes.filter((n) => n.trim().startsWith('ok')).length} 项检查全部通过（0 失败）`)
  process.exit(0)
} else {
  console.log(`FAIL — ${problems.length} 项失败：`)
  for (const p of problems) console.log('  FAIL ' + p)
  process.exit(1)
}
