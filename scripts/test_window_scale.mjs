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
    '\nreturn { clampScale, winScale, beginResize, windowLeftFor, pillLabelRoom, pillLeftFor, pillTopFor, windowTopFor, WIN_W, SCALE_MIN, SCALE_MAX }')
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
  // 标签可用宽度 = 视口 - x - 开关槽位 - 边距 - pill 内边距 - gap。
  // 少扣内边距就会剩出约两个字的宽度，于是折成「背单」/「词」而不是一字一行。
  check('pill 标签可用宽度扣除开关槽位与 pill 内边距',
    api.pillLabelRoom(1000, 1400) === 1400 - 1000 - 42 - 16 - 30 - 7,
    String(api.pillLabelRoom(1000, 1400)))
  check('贴右时可用宽度收敛到单字宽（真正一字一行）',
    api.pillLabelRoom(1400 - 42 - 16, 1400) === 17, String(api.pillLabelRoom(1358, 1400)))
  check('可用宽度有单字下限（不塌成 0）', api.pillLabelRoom(9999, 1400) === 17)
  check('贴右时 pill 右边缘正好贴边（x + 开关42 + pill54 = vw - 16）',
    (() => { const x = api.pillLeftFor(9999, 1400); return x + 42 + 54 === 1400 - 16 })(),
    String(api.pillLeftFor(9999, 1400) + 42 + 54))
  check('挤压由 CSS 变量驱动（拖动中浏览器连续重排，非渲染期快照）',
    src.includes('--cv-pill-x') && /setProperty\('--cv-pill-x'/.test(src) &&
    /maxWidth: 'calc\(100vw - var\(--cv-pill-x/.test(src) &&
    !src.includes('label.dataset.room') && !src.includes('cv-cluster--squeezed'))
  check('角标在文字流内且排在最后（挤压顺序 📖→背→单→词→数量）',
    /parts\.map\([\s\S]{0,200}badge > 0 && h\('span', \{ className: 'cv-pill-badge cv-pill-ch' \}/.test(src) &&
    !/\.cv-pill-label \{[^}]*overflow: hidden/.test(src))
  // 大屏拖到右侧后变小窗口：旧存档 x 会落在视口外，pill 必须被拉回来。
  check('pill 位置按视口钳制（小窗口不跑到界外）',
    api.pillLeftFor(2000, 1400) === 1400 - 42 - 54 - 16 && api.pillLeftFor(2000, 1400) >= 8,
    String(api.pillLeftFor(2000, 1400)))
  check('pill 左侧正常位置不被误推', api.pillLeftFor(100, 1400) === 100, String(api.pillLeftFor(100, 1400)))
  check('pill 无存档返回 null（用 CSS 默认位）', api.pillLeftFor(null, 1400) === null)
  check('pill 左侧也有 8px 保底（拖到左边界不飞出）', api.pillLeftFor(-50, 1400) === 8)
  // 纵向：窗口变矮 / 拖到下方时按钮同样不能掉出视口
  check('pill 纵向钳制：底部不越界',
    api.pillTopFor(9999, 900, 150) === 900 - 150 - 16 && api.pillTopFor(9999, 900, 150) >= 6,
    String(api.pillTopFor(9999, 900, 150)))
  check('pill 纵向钳制：顶部 6px 保底', api.pillTopFor(-99, 900, 150) === 6)
  check('pill 纵向：正常位置不被误推', api.pillTopFor(200, 900, 54) === 200, String(api.pillTopFor(200, 900, 54)))
  check('展开卡片纵向钳制：缩放后仍完整可见',
    api.windowTopFor(9999, 900, 1) + Math.min(660, 900 * 0.74) <= 900,
    String(api.windowTopFor(9999, 900, 1)))
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
  check('展开窗口统一走 windowLeftFor/windowTopFor 双向适应',
    /const left = geom\.x != null \? windowLeftFor\(geom\.x, z, vw\) : null/.test(src) &&
    /const top = geom\.y != null \? windowTopFor\(geom\.y, vh, z\) : null/.test(src) &&
    /left != null && top != null \? \{ left: left \+ 'px', top: top \+ 'px' \}/.test(src))
  check('pill 自由拖动到边界（右界预留开关槽位，左界 8px 保底）',
    /const isPill = el\.classList\.contains\('cv-cluster'\)/.test(src) &&
    /clamp\(ev\.clientX - offX, 8,\s*Math\.max\(8, window\.innerWidth - READER_SLOT - PILL_MIN_VISIBLE - PILL_EDGE_PAD\)\)/.test(src) &&
    /Math\.max\(8, window\.innerWidth - WIN_W \* z - WIN_EDGE\)/.test(src))
  check('贴右时 pill 被真实挤压成一列（无阈值、无淡入淡出）',
    src.includes('PILL_EDGE_PAD') && !src.includes('PILL_SQUEEZE_PX') &&
    src.includes('cv-pill-label') && src.includes('cv-pill-ch') &&
    /flex-wrap: wrap/.test(src) && !/\.cv-pill-h, \.cv-pill-v/.test(src) &&
    !/data-narrow="1"/.test(src))
  check('拖动中实时更新 CSS 变量（布局自然回流，不靠 store 重渲染）',
    src.includes('pillLabelRoom') && src.includes('READER_SLOT') &&
    /el\.style\.setProperty\('--cv-pill-x', x \+ 'px'\)/.test(src) &&
    /className: 'cv-cluster'/.test(src))
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
