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
    '\nreturn { clampScale, winScale, beginResize, windowLeftFor, pillLabelRoom, WIN_W, SCALE_MIN, SCALE_MAX }')
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

// ---- horizontal fit (right border never leaves the viewport) --------------
{
  const api = load({ setScale() {} })
  const W = 1400, EDGE = 12
  // z=1: 384-wide window; z=2: 768-wide window
  for (const z of [0.7, 1, 1.5, 2]) {
    const rightMost = W - 90 // the old drag clamp's upper bound (pill near edge)
    const left = api.windowLeftFor(rightMost, z, W)
    check('z=' + z + '：贴右 pill 展开后右边框不越界',
      left + 384 * z <= W - EDGE && left >= 8,
      'left=' + left + ' right=' + (left + 384 * z))
  }
  check('左侧存档位置不被误推', api.windowLeftFor(100, 1, W) === 100, String(api.windowLeftFor(100, 1, W)))
  check('无存档返回 null（用 CSS 默认位）', api.windowLeftFor(null, 1, W) === null)
  check('超窄视口仍保留 8px 最小左距（不产生负值）',
    api.windowLeftFor(100, 2, 320) >= 8, String(api.windowLeftFor(100, 2, 320)))
  // 标签可用宽度 = 视口 - 容器 x - 朗读开关槽位 - 边距；不把开关那 42px 算进去
  // 就会「离右边界还有距离就先折行」（上一版的实际症状）。
  check('pill 标签可用宽度扣除朗读开关槽位',
    api.pillLabelRoom(1000, 1400) === 1400 - 1000 - 42 - 16,
    String(api.pillLabelRoom(1000, 1400)))
  check('贴右时可用宽度趋近 0（此时才真正折成一列）',
    api.pillLabelRoom(1400 - 42 - 16, 1400) === 0, String(api.pillLabelRoom(1358, 1400)))
  check('可用宽度永不为负', api.pillLabelRoom(9999, 1400) === 0)
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
  check('展开窗口统一走 windowLeftFor 水平适应（覆盖 pill/alt+Q/自动弹出）',
    /const left = geom\.x != null \? windowLeftFor\(geom\.x, z, vw\) : null/.test(src) &&
    /\{\s*left: left \+ 'px', top: geom\.y \+ 'px' \}/.test(src))
  check('pill 自由拖动不被窗口宽度钳制（拖到右边界由展开时适应）',
    /const isPill = el\.classList\.contains\('cv-cluster'\)/.test(src) &&
    /if \(isPill\)[\s\S]{0,160}window\.innerWidth - 90/.test(src) &&
    /else \{[\s\S]{0,200}WIN_W \* z - WIN_EDGE/.test(src))
  check('贴右时 pill 被真实挤压成一列（无阈值、无淡入淡出）',
    src.includes('PILL_EDGE_PAD') && !src.includes('PILL_SQUEEZE_PX') &&
    src.includes('cv-pill-label') && src.includes('cv-pill-ch') &&
    /flex-wrap: wrap/.test(src) && !/\.cv-pill-h, \.cv-pill-v/.test(src) &&
    !/data-narrow="1"/.test(src))
  check('拖动中实时把真实剩余宽度写入 maxWidth（布局自然回流，不靠 store）',
    src.includes('pillLabelRoom') && src.includes('READER_SLOT') &&
    /const room = pillLabelRoom\(x, window\.innerWidth\)/.test(src) &&
    /label\.style\.maxWidth = room \+ 'px'/.test(src) &&
    /const room = geom\.x != null \? pillLabelRoom\(geom\.x, vw\) : null/.test(src))
  check('视口宽度变化有 resize 监听且会重算', /function useViewportWidth\(\)/.test(src) &&
    src.includes("window.addEventListener('resize', onResize, { passive: true })"))
  check('拖动钳制按展开态视觉宽度算（不写入会越界的 x）',
    /window\.innerWidth - WIN_W \* z - WIN_EDGE/.test(src))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  process.exit(1)
}
console.log('PASS: 拖拽缩放 + 整体字号同步')
