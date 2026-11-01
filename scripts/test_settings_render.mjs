// Render-test for SettingsView: the smoke test boots the module but never
// renders a component, so a broken settings tree would only surface in the
// browser. This extracts SettingsView from client.src.js and renders it with a
// fake React for each panel state, asserting the structure of the result.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Layout-agnostic: works from the repo (<pkg>/scripts/) and from the workspace
// (<work>/scripts/ with the package in <work>/dsh-cet-vocab/).
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = [path.resolve(here, '..'), path.resolve(here, '..', 'dsh-cet-vocab')]
  .find((d) => fs.existsSync(path.join(d, 'client.src.js')))
if (!pkgDir) throw new Error('找不到 dsh-cet-vocab 包目录（client.src.js）')
const FILE = path.join(pkgDir, 'client.src.js')
const src = fs.readFileSync(FILE, 'utf8')

// ---- extract the component ------------------------------------------------
const START = 'function SettingsView({ state }) {'
const at = src.indexOf(START)
if (at < 0) throw new Error('SettingsView not found')
const tail = src.indexOf('\n}\n', at)
if (tail < 0) throw new Error('SettingsView end not found')
const fnSrc = src.slice(at, tail + 2)

// ---- dictionaries out of the module (single source of truth) --------------
const ZH = JSON.parse(src.match(/const ZH = (\{.*?\})\n/)[1])

const t = (key) => (ZH[key] != null ? ZH[key] : key)
const fmtT = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
})

const SC_GUIDE = ['toggle', 'modeCard', 'speak']
const SC = {
  toggle: { keys: ['Alt', 'Q'], key: 'scToggle' },
  modeCard: { keys: ['Alt', '1'], key: 'scModeCard' },
  speak: { keys: ['Alt', 'S'], key: 'scSpeak' },
}

function makeReact(panelInit) {
  const setterCalls = []
  let n = 0
  const React = {
    useState(init) {
      const value = typeof init === 'function' ? init() : init
      const idx = n++
      const setter = (v) => setterCalls.push({ idx, v })
      // declaration order in SettingsView: armed, panel, voices
      const resolved = idx === 0 ? false : idx === 1 ? panelInit : []
      return [resolved, setter]
    },
    useEffect() {},
  }
  return { React, setterCalls }
}

function render(panelInit, state) {
  const { React, setterCalls } = makeReact(panelInit)
  const store = { setSettings: () => {}, reset: () => {} }
  const speak = () => {}
  const enVoiceCount = () => 0
  const refreshVoices = () => []
  const warmUpVoices = () => {}
  const setVoices = () => {}
  let VOICE_WARMED = false
  const factory = new Function(
    'React', 'h', 't', 'store', 'clamp', 'fmtT', 'SC_GUIDE', 'SC', 'enVoiceCount',
    'speak', 'VOICE_WARMED', 'refreshVoices', 'warmUpVoices', 'setVoices',
    fnSrc + '\nreturn SettingsView',
  )
  const Comp = factory(React, h, t, store, clamp, fmtT, SC_GUIDE, SC, enVoiceCount,
    speak, VOICE_WARMED, refreshVoices, warmUpVoices, setVoices)
  const tree = Comp({ state })
  return { tree, setterCalls }
}

// ---- helpers --------------------------------------------------------------
const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const c of node.children || []) walk(c, out)
  return out
}
const cls = (n) => (n && n.props && n.props.className) || ''
const text = (node) => walk(node).filter((n) => typeof n.type === 'string')
  .flatMap((n) => (n.children || []).filter((c) => typeof c === 'string' || typeof c === 'number').map(String))
  .join(' ')

const state = {
  settings: { book: 'cet4', dailyNew: 10, accent: 'us', appearance: 'auto', autoSpeak: true, autoOpen: true },
}

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// ---- main page ------------------------------------------------------------
const main = render('', state)
const nodes = walk(main.tree)
const entries = nodes.filter((n) => cls(n) === 'cv-set-entry')
check('主页面渲染不抛异常', !!main.tree)
check('主页面有 2 个二级菜单入口（学习 / 快捷键）', entries.length === 2, entries.map((e) => text(e).trim().split(' ')[0]).join(' | '))
check('学习入口标题 = 学习', entries.some((e) => text(e).includes('学习')))
check('学习入口有右侧摘要（词库 · 每日 · 口音）', /四级 · 10 词\/天 · 美式/.test(text(entries[0])), text(entries[0]).trim())
check('学习入口有 chevron', entries.some((e) => (e.children || []).some((c) => c && c.children && c.children.includes('›'))))
const rows = nodes.filter((n) => cls(n) === 'cv-set-row')
check('主页面只留 3 行设置（外观/自动发音/自动弹出）', rows.length === 3, String(rows.length))
check('主页面不再出现「自定义」行', !text(main.tree).includes('自定义'))
check('主页面保留重置按钮', nodes.some((n) => cls(n) === 'cv-resetbtn'))
check('主页面保留数据来源脚注', cls(nodes.find((n) => cls(n) === 'cv-foot')) === 'cv-foot' && text(main.tree).includes('ECDICT'))
check('点学习入口把 panel 置为 learn', (() => { entries[0].props.onClick(); return main.setterCalls.at(-1)?.v === 'learn' })())

// ---- learn page -----------------------------------------------------------
const learn = render('learn', state)
const lnodes = walk(learn.tree)
const lrows = lnodes.filter((n) => cls(n) === 'cv-set-row')
check('学习页渲染不抛异常', !!learn.tree)
check('学习页有返回按钮 + 标题', lnodes.some((n) => cls(n) === 'cv-set-back') && lnodes.some((n) => cls(n) === 'cv-sub-title'))
check('返回按钮文案 = ‹ 设置', text(lnodes.find((n) => cls(n) === 'cv-set-back')).includes('设置'))
check('学习页标题 = 学习', text(lnodes.find((n) => cls(n) === 'cv-sub-title')).includes('学习'))
check('学习页 3 行：词库 / 每日新词 / 发音口音', lrows.length === 3, lrows.map((r) => text(r).split(' ')[0]).join(' | '))
const dailyRow = lrows.find((r) => text(r).includes('每日新词'))
check('每日新词行内含数字输入框', !!dailyRow && walk(dailyRow).some((n) => n.type === 'input'))
const numInput = dailyRow && walk(dailyRow).find((n) => n.type === 'input')
check('输入框用行内窄样式 cv-numinput--inline', !!numInput && cls(numInput).includes('cv-numinput--inline'), numInput ? cls(numInput) : '')
check('输入框回填当前每日新词数', !!numInput && numInput.props.value === '10', numInput ? numInput.props.value : '')
check('学习页无「自定义」行', !text(learn.tree).includes('自定义'))
check('发音口音行含试听按钮', !!lrows.find((r) => text(r).includes('发音口音')) && walk(lrows.find((r) => text(r).includes('发音口音'))).some((n) => cls(n) === 'cv-voice-test'))
check('点返回把 panel 置为空', (() => { lnodes.find((n) => cls(n) === 'cv-set-back').props.onClick(); return learn.setterCalls.at(-1)?.v === '' })())

// ---- keys page ------------------------------------------------------------
const keys = render('keys', state)
const knodes = walk(keys.tree)
check('快捷键页渲染不抛异常', !!keys.tree)
check('快捷键页标题 = 快捷键', text(knodes.find((n) => cls(n) === 'cv-sub-title')).includes('快捷键'))
check('快捷键页行数 = SC_GUIDE 长度', knodes.filter((n) => cls(n) === 'cv-sc-row').length === SC_GUIDE.length,
  String(knodes.filter((n) => cls(n) === 'cv-sc-row').length))
check('快捷键页有底部说明', knodes.some((n) => cls(n) === 'cv-sc-note'))

console.log('\n== 汇总 ==')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' 项通过 / ' + fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
