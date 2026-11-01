// Render-test for QuizView's answer flow: long definitions must reach the DOM
// uncut, a miss must stay put until it is dismissed, a hit must still move on
// by itself, and → must advance exactly once.
//
// The smoke test boots the module but never renders a component, so this
// extracts QuizView from client.src.js and drives it with a miniature React
// (hooks + effect cleanup + fake timers) instead of a browser.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = [path.resolve(here, '..'), path.resolve(here, '..', 'dsh-cet-vocab')]
  .find((d) => fs.existsSync(path.join(d, 'client.src.js')))
if (!pkgDir) throw new Error('找不到 dsh-cet-vocab 包目录（client.src.js）')
const FILE = path.join(pkgDir, 'client.src.js')
const src = fs.readFileSync(FILE, 'utf8')

// ---- extract the component ------------------------------------------------
const START = 'function QuizView({ card, isNew, state, onGrade }) {'
const at = src.indexOf(START)
if (at < 0) throw new Error('QuizView not found')
const tail = src.indexOf('\n}\n', at)
if (tail < 0) throw new Error('QuizView end not found')
const fnSrc = src.slice(at, tail + 2)

// ---- dictionaries out of the module (single source of truth) --------------
const ZH = JSON.parse(src.match(/const ZH = (\{.*?\})\n/)[1])
const t = (key) => (ZH[key] != null ? ZH[key] : key)

const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
})

// ---- miniature React ------------------------------------------------------
function makeRunner() {
  let hooks = []
  let cursor = 0
  let tree = null
  let props = null
  let Component = null
  let queue = []
  let dirty = false
  let rendering = false
  const React = {
    useState(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      return [hooks[i], (v) => {
        hooks[i] = typeof v === 'function' ? v(hooks[i]) : v
        dirty = true
        if (!rendering) render() // a click outside the render pass re-renders
      }]
    },
    useMemo(fn, deps) {
      const i = cursor++
      const prev = hooks[i]
      const stale = !prev || !deps || !prev.deps || deps.length !== prev.deps.length ||
        deps.some((d, k) => d !== prev.deps[k])
      if (stale) hooks[i] = { value: fn(), deps }
      return hooks[i].value
    },
    // Queued, not run inline: React commits effects after the render pass, and
    // a setState inside an effect must not re-enter the component body.
    useEffect(fn, deps) {
      const i = cursor++
      const prev = hooks[i]
      const stale = !prev || !deps || !prev.deps || deps.length !== prev.deps.length ||
        deps.some((d, k) => d !== prev.deps[k])
      if (!stale) return
      queue.push({ i, fn, deps, prevCleanup: prev && prev.cleanup })
    },
    useRef(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
  }
  function render() {
    let guard = 0
    rendering = true
    try {
      do {
        dirty = false
        cursor = 0
        queue = []
        tree = Component(props)
        const pending = queue
        queue = []
        for (const e of pending) {
          if (e.prevCleanup) e.prevCleanup()
          hooks[e.i] = { deps: e.deps, cleanup: e.fn() }
        }
        guard++
      } while (dirty && guard < 25)
    } finally {
      rendering = false
    }
    return tree
  }
  return {
    React,
    mount(comp, p) { Component = comp; props = p; return render() },
    setProps(p) { props = p; return render() },
    get tree() { return tree },
  }
}

// ---- fake browser ---------------------------------------------------------
function makeWindow() {
  const listeners = {}
  const timers = []
  let nextId = 1
  const win = {
    addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn) },
    removeEventListener(k, fn) { listeners[k] = (listeners[k] || []).filter((f) => f !== fn) },
    setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, ms, cancelled: false }); return id },
    clearTimeout(id) { const x = timers.find((v) => v.id === id); if (x) x.cancelled = true },
  }
  return {
    win,
    pending: () => timers.filter((x) => !x.cancelled && !x.fired).length,
    flush() {
      for (const x of timers) {
        if (x.cancelled || x.fired) continue
        x.fired = true
        x.fn()
      }
    },
    key(ev) {
      const e = {
        key: ev.key, code: ev.code || ev.key, defaultPrevented: false, isComposing: false,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: null,
        preventDefault() { e.defaultPrevented = true },
      }
      for (const fn of (listeners.keydown || []).slice()) fn(e)
      return e
    },
  }
}

// ---- fixture --------------------------------------------------------------
const LONG = 'v. 放弃，抛弃；离弃，丢弃；停止做（某事）；使陷入（某种状态），使沉溺于；放任，纵情；屈从于（情感、欲望）'
const POOL = [
  { w: 'abandon', t: LONG, b: 'cet4' },
  { w: 'abundant', t: 'adj. 丰富的，充裕的', b: 'cet4' },
  { w: 'abandoned', t: 'adj. 被抛弃的', b: 'cet6' },
  { w: 'absurd', t: 'adj. 荒谬的', b: 'cet4' },
  { w: 'abuse', t: 'v. 滥用；虐待', b: 'cet4' },
  { w: 'academy', t: 'n. 学院', b: 'cet6' },
]
const BOOK_INDEX = { entry: (w) => POOL.find((e) => e.w === w) || null }
const visibleWords = () => POOL

const GRADE_KNOW = 'know'
const GRADE_MISS = 'miss'

const factory = new Function(
  'React', 'h', 't', 'fmtT', 'speak', 'GRADE_KNOW', 'GRADE_MISS',
  'isTypingTarget', 'plainKey', 'confusionScore', 'visibleWords', 'BOOK_INDEX', 'window', 'Badge',
  fnSrc + '\nreturn QuizView',
)
const Badge = (props) => h('span', { className: 'cv-badge' }, String(props.book))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  if (!ok) console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
}

function boot() {
  const w = makeWindow()
  const spoken = []
  const runner = makeRunner()
  const QuizView = factory(
    runner.React, h, t, (s) => s, (word) => spoken.push(word), GRADE_KNOW, GRADE_MISS,
    () => false, (ev) => !ev.altKey && !ev.ctrlKey && !ev.metaKey,
    () => 30, visibleWords, BOOK_INDEX, w.win, Badge,
  )
  const graded = []
  const view = runner
  view.mount(QuizView, {
    card: { w: 'abandon', b: 'cet4', p: '/əˈbændən/' },
    isNew: false,
    state: { settings: { book: 'all', autoSpeak: false, mode: 'quiz' } },
    onGrade: (g) => graded.push(g),
  })
  return { w, view, graded, spoken }
}

const textOf = (node) => {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children || []).map(textOf).join('')
}
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const c of node.children || []) findAll(c, pred, out)
  return out
}
const optsOf = (tree) => findAll(tree, (n) => String(n.props.className || '').includes('cv-opt'))
const byClass = (tree, cls) => findAll(tree, (n) => String(n.props.className || '').split(/\s+/).includes(cls))

// 1. long definitions survive to the DOM ------------------------------------
{
  const { view } = boot()
  const opts = optsOf(view.tree)
  check('四个选项都渲染出来', opts.length === 4, `got ${opts.length}`)
  const longOpt = opts.find((o) => textOf(o).includes('离弃'))
  check('长释义未被截断', !!longOpt, '找不到含「离弃」的选项')
  check('释义里没有省略号', !opts.some((o) => textOf(o).includes('…')),
    opts.map(textOf).find((s) => s.includes('…')))
  const longText = longOpt ? textOf(longOpt) : ''
  check('长释义完整（与词条释义逐字相同，超过旧的 46 字截断线）',
    longText.replace(/^\d+\. /, '') === LONG && LONG.length > 46,
    `len=${longText.length} text=${JSON.stringify(longText)}`)
}

// 2. a miss stays put -------------------------------------------------------
{
  const { w, view, graded } = boot()
  const opts = optsOf(view.tree)
  const wrongIdx = opts.findIndex((o) => !textOf(o).startsWith('1. ') && !textOf(o).includes('放弃'))
  // pick a wrong option by clicking it
  const wrong = opts.find((o) => !textOf(o).includes('放弃'))
  check('找到错误选项', !!wrong)
  wrong.props.onClick()
  check('答错后没有立即评分', graded.length === 0, JSON.stringify(graded))
  check('答错后 1.2s 定时器不存在', w.pending() === 0, `pending=${w.pending()}`)
  w.flush()
  check('定时器跑完仍然不前进', graded.length === 0, JSON.stringify(graded))

  const fb = byClass(view.tree, 'cv-feedback')
  check('有反馈条', fb.length === 1)
  check('反馈条带错误样式', fb.length === 1 && String(fb[0].props.className).includes('cv-feedback--no'))
  check('反馈条显示完整释义', fb.length === 1 && textOf(fb[0]).includes('屈从于'),
    fb.length ? textOf(fb[0]).slice(0, 40) : '')
  check('反馈条不截断释义', fb.length === 1 && !textOf(fb[0]).includes('…'))

  const nextBtn = byClass(view.tree, 'cv-nextbtn')
  check('答错后有「下一个」按钮', nextBtn.length === 1)
  check('「下一个」按钮文案来自 locale', nextBtn.length === 1 && textOf(nextBtn[0]).includes(ZH.quizNext),
    nextBtn.length ? textOf(nextBtn[0]) : '')
  const hint = findAll(view.tree, (n) => String(n.props.className || '').includes('cv-hint'))
  check('答错后有停留提示', hint.some((n) => textOf(n) === ZH.quizStay),
    hint.map(textOf).join(' | '))

  // → advances, and only once
  w.key({ key: 'ArrowRight' })
  check('按 → 前进', graded.length === 1 && graded[0] === GRADE_MISS, JSON.stringify(graded))
  w.key({ key: 'ArrowRight' })
  check('连按 → 只评分一次', graded.length === 1, JSON.stringify(graded))
  check('「下一个」按钮也能前进（防双触发）', (() => {
    const b = byClass(view.tree, 'cv-nextbtn')[0]
    if (!b) return false
    b.props.onClick()
    return graded.length === 1
  })(), JSON.stringify(graded))
}

// 3. a hit still moves on by itself ----------------------------------------
{
  const { w, view, graded } = boot()
  const right = optsOf(view.tree).find((o) => textOf(o).includes('放弃'))
  check('找到正确选项', !!right)
  right.props.onClick()
  check('答对后还没评分', graded.length === 0, JSON.stringify(graded))
  check('答对后有 1.2s 定时器', w.pending() === 1, `pending=${w.pending()}`)
  w.flush()
  check('答对后自动前进', graded.length === 1 && graded[0] === GRADE_KNOW, JSON.stringify(graded))
}

// 4. the guide advertises → ------------------------------------------------
{
  check('SC 表含 next 项', /next:\s*\{\s*keys:\s*\['→'\]/.test(src))
  check('SC_GUIDE 列出 next', /SC_GUIDE = \[[^\]]*'next'\]/.test(src))
  check('locale 有 scNext', ZH.scNext != null && ZH.scNext.length > 0)
  check('locale 有 quizNext / quizStay', ZH.quizNext != null && ZH.quizStay != null)
}

// 5. no stray clip() left in the quiz path --------------------------------
{
  const quizSrc = fnSrc
  check('QuizView 不再调用 clip()', !/clip\(/.test(quizSrc))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  process.exit(1)
}
console.log('PASS: 选择题释义完整 + 答错停留 + → 前进')
