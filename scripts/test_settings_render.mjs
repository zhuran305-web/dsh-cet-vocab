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
    'speak', 'VOICE_WARMED', 'refreshVoices', 'warmUpVoices', 'setVoices', 'readerApplySettingsChange',
    'REPO_URL', 'window', 'bookStats',
    fnSrc + '\nreturn SettingsView',
  )
  const Comp = factory(React, h, t, store, clamp, fmtT, SC_GUIDE, SC, enVoiceCount,
    speak, VOICE_WARMED, refreshVoices, warmUpVoices, setVoices, () => {},
    'https://github.com/zhuran305-web/dsh-cet-vocab', { open() {} },
    () => ({ total: 5407, seen: 42, learning: 40, graduated: 1, cut: 1, boxes: [0, 0, 0, 0, 0, 0] }))
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
  settings: { book: 'cet4', dailyNew: 10, accent: 'us', appearance: 'auto', autoSpeak: true, autoOpen: true, readMode: 'wt', readRange: 'd7' },
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
check('主页面有 3 个二级菜单入口（学习 / 快捷键 / 数据与重置）', entries.length === 3, entries.map((e) => text(e).trim().split(' ')[0]).join(' | '))
check('学习入口标题 = 学习', entries.some((e) => text(e).includes('学习')))
check('学习入口有右侧摘要（词库 · 每日 · 口音）', /四级 · 10 词\/天 · 美式/.test(text(entries[0])), text(entries[0]).trim())
check('学习入口有 chevron', entries.some((e) => (e.children || []).some((c) => c && c.children && c.children.includes('›'))))
const rows = nodes.filter((n) => cls(n) === 'cv-set-row')
check('主页面只留 3 行设置（外观/自动发音/自动弹出）', rows.length === 3, String(rows.length))
check('主页面不再出现「自定义」行', !text(main.tree).includes('自定义'))
check('主页面不再直接挂红色重置按钮（已移入二级页）', !nodes.some((n) => cls(n) === 'cv-resetbtn'))
check('主页面有「数据与重置」入口', entries.some((e) => text(e).includes('数据与重置')))
check('重置有二次确认：armed 自动复位 + 危险态样式 + 显示将清空数量',
  /const \[armed, setArmed\] = React\.useState\(false\)/.test(src) &&
  /window\.setTimeout\(\(\) => setArmed\(false\), 3500\)/.test(src) &&
  src.includes('cv-resetbtn--armed') &&
  /armed \? fmtT\(t\('resetConfirm'\), \{ n: bookStats\(state\)\.seen \}\)/.test(src))
const starBtn = nodes.find((n) => cls(n) === 'cv-starbtn')
check('主页面有 Star 鼓励按钮且指向仓库', !!starBtn && typeof starBtn.props.onClick === 'function' &&
  text(starBtn).includes('Star'), starBtn ? text(starBtn) : 'missing')
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
check('学习页 7 行：词库 / 每日新词 / 发音口音 / 朗读内容 / 朗读范围 / 斩词抽查 / 朗读例句', lrows.length === 7, lrows.map((r) => text(r).split(' ')[0]).join(' | '))
const cutDaysRow = lrows.find((r) => text(r).includes('斩词抽查'))
check('斩词抽查行有 15/30/60 三档', !!cutDaysRow && walk(cutDaysRow).filter((n) => n.type === 'button').length === 3,
  String(cutDaysRow ? walk(cutDaysRow).filter((n) => n.type === 'button').length : -1))
const readExRow = lrows.find((r) => text(r).includes('朗读例句'))
check('朗读例句行是开关', !!readExRow && walk(readExRow).some((n) => cls(n).includes('cv-switch')),
  readExRow ? 'switch' : 'missing')
const readExHint = lnodes.find((n) => cls(n).includes('cv-read-ex-hint') && !cls(n).includes('cv-cut-days-hint'))
check('朗读例句开关下有无例句提示', !!readExHint && text(readExHint).includes('暂无例句'), readExHint ? text(readExHint) : 'missing')
const cutDaysHint = lnodes.find((n) => cls(n).includes('cv-cut-days-hint'))
check('斩词抽查下方有说明', !!cutDaysHint && text(cutDaysHint).includes('抽查答错'), cutDaysHint ? text(cutDaysHint) : 'missing')
const readModeRow = lrows.find((r) => text(r).includes('朗读内容'))
check('朗读内容行 3 个选项', !!readModeRow && walk(readModeRow).filter((n) => n.type === 'button').length === 3,
  String(readModeRow ? walk(readModeRow).filter((n) => n.type === 'button').length : -1))
const readRangeRow = lrows.find((r) => text(r).includes('朗读范围'))
const rangeSel = readRangeRow && walk(readRangeRow).find((n) => n.type === 'select')
check('朗读范围行是下拉框且回填 d7', !!rangeSel && rangeSel.props.value === 'd7', rangeSel ? String(rangeSel.props.value) : 'no select')
check('朗读范围有 7 个选项（含新学词/已斩词）', !!rangeSel && walk(rangeSel).filter((n) => n.type === 'option').length === 7,
  String(rangeSel ? walk(rangeSel).filter((n) => n.type === 'option').length : -1))
const dailyRow = lrows.find((r) => text(r).includes('每日新词'))
check('每日新词行内含数字输入框', !!dailyRow && walk(dailyRow).some((n) => n.type === 'input'))
const numInput = dailyRow && walk(dailyRow).find((n) => n.type === 'input')
check('输入框用行内窄样式 cv-numinput--inline', !!numInput && cls(numInput).includes('cv-numinput--inline'), numInput ? cls(numInput) : '')
check('输入框回填当前每日新词数', !!numInput && numInput.props.value === '10', numInput ? numInput.props.value : '')
check('学习页无「自定义」行', !text(learn.tree).includes('自定义'))
check('发音口音行含试听按钮', !!lrows.find((r) => text(r).includes('发音口音')) && walk(lrows.find((r) => text(r).includes('发音口音'))).some((n) => cls(n) === 'cv-voice-test'))
check('点返回把 panel 置为空', (() => { lnodes.find((n) => cls(n) === 'cv-set-back').props.onClick(); return learn.setterCalls.at(-1)?.v === '' })())

// ---- data page ------------------------------------------------------------
const dataPage = render('data', state)
const dnodes = walk(dataPage.tree)
check('数据与重置页渲染不抛异常', !!dataPage.tree)
check('数据页标题 = 数据与重置', text(dnodes.find((n) => cls(n) === 'cv-sub-title')).includes('数据与重置'))
check('数据页有风险说明', text(dataPage.tree).includes('不可撤销'))
check('数据页才有红色重置按钮', dnodes.some((n) => cls(n) === 'cv-resetbtn'))
check('点返回把 panel 置为空（数据页）', (() => { dnodes.find((n) => cls(n) === 'cv-set-back').props.onClick(); return dataPage.setterCalls.at(-1)?.v === '' })())

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
