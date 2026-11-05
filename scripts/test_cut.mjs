// 行为测试：斩单词（cut）数据契约。切片真实 store + 队列 + 统计 + 朗读范围代码，
// 在 Node 里驱动，验证「斩不是删除」这一核心语义。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = [path.resolve(here, '..'), path.resolve(here, '..', 'dsh-cet-vocab')]
  .find((d) => fs.existsSync(path.join(d, 'client.src.js')))
if (!pkgDir) throw new Error('找不到 dsh-cet-vocab 包目录')
const src = fs.readFileSync(path.join(pkgDir, 'client.src.js'), 'utf8')

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// ---- 静态契约 -------------------------------------------------------------
check('常量与数据契约齐备',
  src.includes('const CUT_BOX = 5') && src.includes("const CUT_DAYS = { d15: 15, d30: 30, d60: 60 }") &&
  src.includes('cutWord(word)') && src.includes('uncutWord(word)') && src.includes('cut: true'))
check('卡片第 4 键 + Alt+Z + 统计页召回',
  src.includes('cv-grade--cut') && src.includes("k === 'z'") && src.includes('cv-cut-recall') &&
  src.includes('cutWords(state)'))
check('朗读排除已斩词 + 只读已斩档',
  src.includes("if (!st || st.cut) continue") && src.includes("readRange === 'cut'"))
check('卡片内斩词按钮 + 维护抽查角标 + 加练排除斩词',
  src.includes('cv-cut-chip') && src.includes('cv-chip--maint') &&
  src.includes('maintenance: !!(st && st.cut && st.due <= now)') &&
  src.includes('return st && !st.cut && st.box < GRADUATED_BOX'))
check('卡片模式与选择题模式都有斩词按钮',
  (src.match(/className: 'cv-cut-chip'/g) || []).length >= 2 && src.includes('onCut: cutCard }'))
check('斩后驻留展示释义（cutHold + 继续按钮）',
  src.includes('cutHold') && src.includes('cutHoldNext') && src.includes('const card = cutHoldEntry || queueCard'))

// ---- 源码切片：constants → store → bookIndex → queue/stats/readerQueue ------
const A = 'const PLUGIN_ID'
const Z = '// ------------------------------------------------------------------- locale'
const iA = src.indexOf(A), iZ = src.indexOf(Z)
if (iA < 0 || iZ < 0) throw new Error('切片锚点缺失')
const code = src.slice(iA, iZ)

// 假 localStorage + 假 window（store/migrate 用到）
let LS = {}
const localStorage = {
  getItem: (k) => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
}
const win = { setTimeout, clearTimeout, innerWidth: 1600, innerHeight: 900, speechSynthesis: null }
const BOOK = [
  { w: 'alpha', t: '阿尔法', b: 1 },
  { w: 'beta', t: '贝塔', b: 1 },
  { w: 'gamma', t: '伽马', b: 2 },
  { w: 'delta', t: '德尔塔', b: 1 },
]

const factory = new Function(
  'window', 'localStorage', 'CET_WORDS', 'visibleWordsOverride',
  code + `
  // store 依赖的 visibleWords 来自 BOOK_INDEX；用同一份词库即可。
  return { store, buildQueue, bookStats, cutWords, readerQueue, defaultState, INTERVALS_MIN, GRADUATED_BOX, CUT_BOX, cutDays, pickCard, GRADE_KNOW: 2, GRADE_FUZZY: 1, GRADE_MISS: 0 };`,
)
const CET_WORDS = { words: BOOK, counts: { cet4: 4, cet6: 1 } }
const api = factory(win, localStorage, CET_WORDS, null)

const DAY = 86400000
const NOW = 1770000000000
// 固定 Date.now（cutWord/answer 用），避免时间漂移
const RealDate = Date
class FakeDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FakeDate

const S = () => api.store.get()
const words = () => S().words
const reset = (init) => {
  LS = { 'dsh-cet-vocab:v1': JSON.stringify(init || api.defaultState()) }
  api.store.state = JSON.parse(LS['dsh-cet-vocab:v1'])
}
reset()

// ---- 1. 斩的落点 ----------------------------------------------------------
api.store.cutWord('alpha')
const ca = words().alpha
check('斩：落点 = 记忆阶段6(box5) + cut 标记 + cutAt',
  ca.box === 5 && ca.cut === true && ca.cutAt === NOW, JSON.stringify(ca))
check('斩：due = 默认 30 天后（不是 0、不是毕业）',
  ca.due === NOW + 30 * DAY && ca.box < api.GRADUATED_BOX, String(ca.due - NOW))
check('斩：记录 first/seen/last（不算新词丢失）',
  ca.first === NOW && ca.seen === 1 && ca.last === NOW)
check('斩：data 里仍有这个词（不是删除）', Object.prototype.hasOwnProperty.call(words(), 'alpha'))

// ---- 2. 队列隔离 ----------------------------------------------------------
let q = api.buildQueue(S(), NOW)
check('斩后立刻退出日常复习队列', !q.reviews.some((e) => e.w === 'alpha') && !q.fresh.some((e) => e.w === 'alpha'),
  'reviews=' + q.reviews.map((e) => e.w).join(',') )
q = api.buildQueue(S(), NOW + 30 * DAY + 1)
check('维护到期后回来抽查一次（不占 dueLater 计数）',
  q.reviews.some((e) => e.w === 'alpha') && q.dueLaterCount === 0,
  'reviews=' + q.reviews.map((e) => e.w).join(',') )
const picked = api.pickCard(S(), NOW + 30 * DAY + 1, q)
check('抽查词被 pickCard 标记为 maintenance（角标依据）',
  picked.card && picked.card.w === 'alpha' && picked.maintenance === true,
  JSON.stringify({ w: picked.card && picked.card.w, maintenance: picked.maintenance }))
const pickedEarly = api.pickCard(S(), NOW, api.buildQueue(S(), NOW))
check('未到期的斩词不会被误标为抽查', !(pickedEarly.card && pickedEarly.maintenance === true))

// ---- 3. 抽查作答 ----------------------------------------------------------
api.store.answer('alpha', api.GRADE_MISS)
const cm = words().alpha
check('抽查答错：打回阶段1、清斩标记、10 分钟后复习',
  cm.cut === false && cm.box === 0 && cm.due === NOW + 10 * 60000, JSON.stringify(cm))
api.store.cutWord('beta')
api.store.answer('beta', api.GRADE_KNOW)
const ck = words().beta
check('抽查答对：维持斩 + 继续 30 天低频维护（不毕业）',
  ck.cut === true && ck.box === 5 && ck.due === NOW + 30 * DAY && ck.box < 6, JSON.stringify(ck))

// ---- 4. 召回 --------------------------------------------------------------
api.store.cutWord('gamma')
api.store.uncutWord('gamma')
const cg = words().gamma
check('召回：清斩标记、回到队列可复习',
  cg.cut === false && cg.cutAt === 0 && cg.box === 5 && cg.due === 0, JSON.stringify(cg))
check('召回后 buildQueue 立刻能看到它', api.buildQueue(S(), NOW).reviews.some((e) => e.w === 'gamma'))

// ---- 5. 自定义抽查间隔 ----------------------------------------------------
reset({ ...api.defaultState(), settings: { ...api.defaultState().settings, cutDays: 'd15' } })
api.store.cutWord('alpha')
check('间隔 15 天生效', words().alpha.due === NOW + 15 * DAY, String(words().alpha.due - NOW))
reset({ ...api.defaultState(), settings: { ...api.defaultState().settings, cutDays: 'zzz' } })
api.store.cutWord('alpha')
check('非法间隔回落到 30 天', words().alpha.due === NOW + 30 * DAY, String(words().alpha.due - NOW))

// ---- 6. 统计口径 ----------------------------------------------------------
reset()
api.store.answer('alpha', api.GRADE_KNOW) // box 1
api.store.cutWord('beta')
const st = api.bookStats(S())
check('统计：seen 含已斩、learning 不含、cut 单独成池',
  st.seen === 2 && st.learning === 1 && st.cut === 1 && st.graduated === 0,
  JSON.stringify({ seen: st.seen, learning: st.learning, cut: st.cut, boxes: st.boxes }))
check('统计：阶段 1~6 分布不被手动斩污染', st.boxes[5] === 0, JSON.stringify(st.boxes))
check('cutWords 只返回已斩词', api.cutWords(S()).map((e) => e.w).join(',') === 'beta')

// ---- 7. 朗读范围 ----------------------------------------------------------
reset()
api.store.answer('alpha', api.GRADE_KNOW)
api.store.cutWord('beta')
const today0 = (() => { const d = new FakeDate(); d.setHours(0, 0, 0, 0); return d.getTime() })()
S().settings.readRange = 'all'
check('循环朗读默认排除已斩词', api.readerQueue(S()).map((e) => e.w).join(',') === 'alpha',
  api.readerQueue(S()).map((e) => e.w).join(','))
S().settings.readRange = 'cut'
check('「只读已斩词」档只返回已斩词', api.readerQueue(S()).map((e) => e.w).join(',') === 'beta',
  api.readerQueue(S()).map((e) => e.w).join(','))
void today0

globalThis.Date = RealDate
console.log('\n== 汇总 ==')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ': 斩单词行为测试 ' + pass + '/' + (pass + fail) + ' 项通过')
process.exit(fail === 0 ? 0 : 1)
