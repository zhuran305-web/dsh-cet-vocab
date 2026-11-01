// Behaviour test for the resize grip: dragging the corner must map screen
// pixels onto the window's zoom factor (384 layout px = 1.0), clamp at both
// ends, live-update the element style, and persist exactly once on release.
//
// The smoke test only boots the module; this extracts the resize block from
// client.src.js and drives it with a fake grip element and fake pointer events.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = [path.resolve(here, '..'), path.resolve(here, '..', 'dsh-cet-vocab')]
  .find((d) => fs.existsSync(path.join(d, 'client.src.js')))
if (!pkgDir) throw new Error('找不到 dsh-cet-vocab 包目录（client.src.js）')
const src = fs.readFileSync(path.join(pkgDir, 'client.src.js'), 'utf8')

// ---- extract the resize block --------------------------------------------
const at = src.indexOf('const WIN_W = 384')
if (at < 0) throw new Error('WIN_W not found')
const end = src.indexOf('function beginDrag(e, geom) {')
if (end < 0 || end < at) throw new Error('beginDrag not found')
const chunk = src.slice(at, end)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  if (!ok) console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
}

function load(store) {
  const factory = new Function('clamp', 'store', 'window', chunk +
    '\nreturn { clampScale, winScale, beginResize, WIN_W, SCALE_MIN, SCALE_MAX }')
  return factory(clamp, store, { innerWidth: 1400, innerHeight: 900 })
}

// ---- fake grip ------------------------------------------------------------
function makeGrip() {
  const handlers = {}
  const styleProps = {}
  const winEl = {
    style: {
      transform: '',
      maxHeight: '',
      setProperty(k, v) { styleProps[k] = v },
    },
  }
  const grip = {
    closest: () => winEl,
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener(k, fn) { (handlers[k] = handlers[k] || []).push(fn) },
    removeEventListener(k, fn) { handlers[k] = (handlers[k] || []).filter((f) => f !== fn) },
  }
  return {
    grip, winEl, styleProps,
    emit(k, ev) { for (const fn of (handlers[k] || []).slice()) fn(ev) },
    count(k) { return (handlers[k] || []).length },
  }
}

function drag(api, store, { startX = 100, dx, startScale = 1 } = {}) {
  const g = makeGrip()
  let prevented = false
  let stopped = false
  const down = {
    button: 0, clientX: startX, pointerId: 7,
    currentTarget: g.grip,
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  }
  api.beginResize(down, { scale: startScale })
  if (dx != null) g.emit('pointermove', { clientX: startX + dx, pointerId: 7 })
  g.emit('pointerup', { pointerId: 7 })
  return { g, prevented, stopped }
}

// ---- constants -----------------------------------------------------------
{
  const api = load({ setScale() {} })
  check('布局宽度 384px', api.WIN_W === 384, String(api.WIN_W))
  check('缩放区间 0.7–2.0', api.SCALE_MIN === 0.7 && api.SCALE_MAX === 2,
    `${api.SCALE_MIN}–${api.SCALE_MAX}`)
  check('clampScale 上钳制', api.clampScale(9) === 2, String(api.clampScale(9)))
  check('clampScale 下钳制', api.clampScale(0.1) === 0.7, String(api.clampScale(0.1)))
  check('clampScale 处理脏值', api.clampScale(undefined) === 1 && api.clampScale('x') === 1)
  check('winScale 缺省为 1', api.winScale({}) === 1 && api.winScale(null) === 1)
  check('winScale 读回已存值', api.winScale({ scale: 1.35 }) === 1.35)
}

// ---- dragging maps pixels to zoom ---------------------------------------
{
  const saved = []
  const api = load({ setScale: (z) => saved.push(z) })
  const { g, prevented, stopped } = drag(api, null, { dx: 192 })
  check('拖 192px → 1.5 倍', saved.length === 1 && Math.abs(saved[0] - 1.5) < 1e-9, JSON.stringify(saved))
  check('实时写入 --cv-scale', g.styleProps['--cv-scale'] === '1.5', g.styleProps['--cv-scale'])
  check('实时写入 transform', g.winEl.style.transform === 'scale(1.5)', g.winEl.style.transform)
  check('实时收紧 max-height', g.winEl.style.maxHeight === 'min(calc(74vh / 1.5), 660px)',
    g.winEl.style.maxHeight)
  check('阻止默认行为并拦下事件冒泡（不触发窗口拖动）', prevented && stopped)
  check('松手后监听已清理', g.count('pointermove') === 0 && g.count('pointerup') === 0)
}

// ---- clamps at the ends --------------------------------------------------
{
  const saved = []
  const api = load({ setScale: (z) => saved.push(z) })
  drag(api, null, { dx: 5000 })
  check('拖过头钳到 2.0', saved[0] === 2, String(saved[0]))
  saved.length = 0
  drag(api, null, { dx: -5000 })
  check('反向拖过头钳到 0.7', saved[0] === 0.7, String(saved[0]))
}

// ---- relative to the current zoom ---------------------------------------
{
  const saved = []
  const api = load({ setScale: (z) => saved.push(z) })
  drag(api, null, { startScale: 1.5, dx: -192 })
  check('从 1.5 缩小 192px → 1.0', Math.abs(saved[0] - 1) < 1e-9, String(saved[0]))
  saved.length = 0
  drag(api, null, { startScale: 0.8, dx: 76.8 })
  check('从 0.8 放大 76.8px → 1.0', Math.abs(saved[0] - 1) < 1e-9, String(saved[0]))
}

// ---- no move, no write ---------------------------------------------------
{
  const saved = []
  const api = load({ setScale: (z) => saved.push(z) })
  drag(api, null, { dx: null })
  check('只点不拖不写盘', saved.length === 0, JSON.stringify(saved))
}

// ---- non-left button is ignored -----------------------------------------
{
  const saved = []
  const api = load({ setScale: (z) => saved.push(z) })
  const g = makeGrip()
  api.beginResize({ button: 2, clientX: 10, pointerId: 1, currentTarget: g.grip,
    preventDefault() {}, stopPropagation() {} }, { scale: 1 })
  check('右键不启动缩放', g.count('pointermove') === 0)
}

// ---- wiring in the component --------------------------------------------
{
  check('窗口使用 transform: scale', /transform:\s*'scale\(' \+ z \+ '\)'/.test(src))
  check('缩放原点是左上角', /transformOrigin:\s*'top left'/.test(src))
  check('默认位置按 --cv-scale 折算', /left:\s*calc\(100vw - 24px - 384px \* var\(--cv-scale, 1\)\)/.test(src))
  check('窗口里有缩放手柄', /className: 'cv-resize'/.test(src))
  check('手柄双击复位到 1.0', /onDoubleClick: \(\) => store\.setScale\(1\)/.test(src))
  check('手柄不触发窗口拖动', /onPointerDown: \(e\) => beginResize\(e, geom\)/.test(src))
  check('默认状态存 scale', /win:\s*\{ x: null, y: null, min: false, scale: 1 \}/.test(src))
  check('持久化走 store.setScale', /setScale\(scale\) \{/.test(src))
  check('手柄有提示文案', /title: t\('resizeHint'\)/.test(src))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  process.exit(1)
}
console.log('PASS: 拖拽缩放 + 整体字号同步')
