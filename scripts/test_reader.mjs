// Behavior test for the ambient reader (循环朗读, client.src.js ~222-438): slices
// the REAL speech + reader code out of client.src.js and drives it in node
// against fake <audio>/speechSynthesis engines. Asserts the pronunciation ORDER
// of the three read modes (word / word+meaning / word→meaning→word), range
// filtering, the audio→TTS fallback ladder and stop/kick semantics.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Layout-agnostic: works from the repo (<pkg>/scripts/) and from the workspace
// (<work>/scripts/, package in <work>/dsh-cet-vocab/).
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = [path.resolve(here, '..'), path.resolve(here, '..', 'dsh-cet-vocab')]
  .find((d) => fs.existsSync(path.join(d, 'client.src.js')))
if (!pkgDir) throw new Error('找不到 dsh-cet-vocab 包目录（client.src.js）')
// CV_SRC lets a mutation run point this at a modified copy of client.src.js.
const srcPath = process.env.CV_SRC || path.join(pkgDir, 'client.src.js')
const src = fs.readFileSync(srcPath, 'utf8')

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

check('源码含 audioWait / readerSpeakEng / readerLoop',
  src.includes('function audioWait(') && src.includes('async function readerSpeakEng(') &&
  src.includes('async function readerLoop('))
check('store.answer 记录 last/first（范围过滤 + 新学按天可分）',
  src.includes('e.last = now') && src.includes('e.first = now'))
check('CSS 含 .cv-reader 开关样式', /\.cv-reader \{/.test(src))
check('CSS 含开启态与脉冲动画', src.includes('.cv-reader--on') && src.includes('@keyframes cv-pulse'))
check('收起时开关在 pill 左侧同一簇，展开/关闭时独立浮动',
  src.includes("h(ReaderToggle, { inCluster: true })") &&
  /const floatToggle = collapsed \? null : h\(ReaderToggle, null\)/.test(src) &&
  /closest\('\.cv-cluster'\)/.test(src))
check('speak() 接了 readerKick（手动发音让位）',
  /function speak\(word, accentOverride\) \{\n  readerKick\(\)/.test(src))
check('settings 默认含 readOn/readRange/readMode',
  /readOn: false, readRange: 'd2', readMode: 'wt'/.test(src))
check('翻译走在线中文语音（fanyi.baidu.com gettts）', src.includes('fanyi.baidu.com/gettts'))
check('拖动实时跟随（move 钩住 readerFollowDrag）', /readerFollowDrag\(x, y\)/.test(src) && src.includes("'data-cv-reader'"))
check('例句：设置项/获取/朗读链路齐备',
  src.includes('settingsReadExample') && src.includes('async function fetchExample(') &&
  src.includes('async function readerSpeakExample(') && src.includes('dictionaryapi.dev'))
check('例句二级回落（dictionaryapi → tatoeba）',
  src.includes('api.tatoeba.org/unstable/sentences') && src.includes('function fetchJson(') &&
  src.includes('function pickSentence('))
check('孤儿循环防线：实例启动先杀上一实例的朗读并注册停读清理',
  src.includes('__cetVocabReaderStop') && src.includes('dsh-cet-vocab: reader teardown'))
check('停止时暂停全部音频元素并二次确认静音', src.includes('AUDIO_PREFETCH.values()'))
check('一轮 = 全量列表恰好一遍（roundLeft 防重复）', src.includes('roundLeft'))
check('新学词范围走 first 过滤', src.includes("readRange === 'new'") && src.includes('st.first >= from'))

// ---- source slice: speech helpers + ambient reader -------------------------
const A = 'const ACCENT_TYPE'
const B = '// --------------------------------------------------- ambient reader'
const C = '// ------------------------------------------------- adaptive accent colors'
const iA = src.indexOf(A)
const iB = src.indexOf(B)
const iC = src.indexOf(C)
if (iA < 0 || iB < 0 || iC < 0 || !(iA < iB && iB < iC)) throw new Error('源码切片锚点缺失（speech/reader）')
const code = src.slice(iA, iC)

// ---- fake engines: one ordered timeline of every sound actually produced ----
const events = [] // { kind:'audio'|'tts', text, lang }
const utterances = []
let audioMode = 'ok' // 'ok' → ended · 'error' → error · 'hang' → never settles
class FakeAudio {
  constructor(s) { this.src = s || ''; this.preload = ''; this.paused = false; this.currentTime = 0 }
  addEventListener(t, fn) { if (t === 'ended') this._ended = fn; if (t === 'error') this._error = fn; if (t === 'playing') this._playing = fn }
  removeEventListener() {}
  pause() { this.paused = true }
  play() {
    const el = this
    el.paused = false // real HTMLAudio.play() clears paused
    events.push({ kind: 'audio', text: (() => {
      try {
        const s = String(el.src)
        if (s.indexOf('fanyi.baidu.com/gettts') >= 0) { // baidu uses ?text=, youdao uses ?audio=
          const m = /[?&]text=([^&]+)/.exec(s)
          return m ? decodeURIComponent(m[1]) : ''
        }
        return decodeURIComponent(s.split('audio=')[1] || '').split('&')[0]
      } catch (e) { return '' }
    })() })
    if (audioMode === 'ok') setTimeout(() => { if (!el.paused && el._ended) el._ended() }, 2)
    else if (audioMode === 'error') setTimeout(() => { if (!el.paused && el._error) el._error() }, 2)
    else if (audioMode === 'slow') {
      // 长录音：很快开始播放（应清掉启动看门狗），很久才真正结束
      setTimeout(() => { if (!el.paused && el._playing) el._playing() }, 2)
      setTimeout(() => { if (!el.paused && el._ended) el._ended() }, 20)
    }
    return { catch() {} }
  }
}
class FakeUtter {
  constructor(text) { this.text = text; this.lang = ''; this.rate = 0; this.voice = null }
  addEventListener(t, fn) { if (t === 'end') this._end = fn; if (t === 'error') this._error = fn }
}
const synth = {
  cancel() {},
  speak(u) {
    events.push({ kind: 'tts', text: u.text, lang: u.lang })
    utterances.push({ text: u.text, lang: u.lang, rate: u.rate })
    setTimeout(() => { if (u._end) u._end() }, 2)
  },
  getVoices() { return [] },
}
// Cap long timers (reader gaps 600-10000ms, watchdogs 4500/9000ms) to 8ms so the
// loop runs fast while the fake engines' 2ms completions still win.
const win = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 8)),
  clearTimeout: (id) => clearTimeout(id),
  speechSynthesis: synth,
  innerWidth: 1600,
  innerHeight: 900,
}

const flashCalls = []
// Example-lane stubs: the dictionary API only knows alpha/beta; gamma exists
// ONLY in the Tatoeba corpus lane — proving the fallback actually chains.
const DICT_EXAMPLES = { alpha: 'Alpha is the first letter.', beta: 'Beta is the second Greek letter.' }
const TATOEBA_EXAMPLES = { gamma: 'Gamma rays are very energetic.' }
const fetchCalls = []
const fetchStub = async (url) => {
  fetchCalls.push(String(url))
  const u = String(url)
  const dm = /entries\/en\/([a-z]+)/.exec(u)
  if (dm) {
    return (dm[1] in DICT_EXAMPLES)
      ? { ok: true, json: async () => [{ meanings: [{ definitions: [{ example: DICT_EXAMPLES[dm[1]] }] }] }] }
      : { ok: false, json: async () => [] }
  }
  const tm = /[?&]q=([a-z]+)/.exec(u)
  if (tm) {
    return (tm[1] in TATOEBA_EXAMPLES)
      ? { ok: true, json: async () => ({ data: [{ text: TATOEBA_EXAMPLES[tm[1]] }] }) }
      : { ok: false, json: async () => ({ data: [] }) }
  }
  return { ok: false, json: async () => [] }
}
const BOOK = [
  { w: 'alpha', t: '阿尔法', b: 1, p: '/ˈælfə/' },
  { w: 'beta', t: '贝塔\\n第二种', b: 1 }, // 字面反斜杠-n：必须被清洗成自然停顿
  { w: 'gamma', t: '伽马', b: 2 },
  { w: 'delta', t: '德尔塔', b: 1 }, // only in 'all' (old entry, no last)
]

function makeStore(words, settings) {
  let state = {
    settings: Object.assign({ accent: 'us', readMode: 'wt', readRange: 'd2', readOn: false, readHead: 0 }, settings || {}),
    words: words || {},
    book: 'cet4',
  }
  return {
    get: () => state,
    set(mut) { const n = { ...state }; mut(n); state = n },
    setSettings(p) { state = { ...state, settings: { ...state.settings, ...p } } },
    subscribe() { return () => {} },
    _state: () => state,
  }
}

const DAY = 86400000
const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
const makeWords = () => ({
  alpha: { box: 1, due: midnight + DAY, seen: 2, last: midnight + 1000, first: midnight + 2000, ok: 1, fz: 1, no: 0 },
  beta: { box: 0, due: midnight, seen: 1, last: midnight - 60000, first: midnight - 60000, ok: 0, fz: 0, no: 1 },
  gamma: { box: 2, due: midnight + DAY, seen: 5, last: midnight - 3 * DAY + 60000, first: midnight - 3 * DAY + 60000, ok: 3, fz: 0, no: 2 },
  delta: { box: 0, due: 0, seen: 3, last: 0, ok: 1, fz: 1, no: 1 }, // 旧词条：无 last/first
})

const factory = new Function(
  'window', 'store', 'visibleWords', 'flash', 'Audio', 'SpeechSynthesisUtterance', 'fetch',
  code + '\nreturn { READER, readRangeDays, readerQueue, readerSet, readerKick, readerApplySettingsChange, readerStopHard, cleanSpeechZh, shortenMeaning };',
)
const store = makeStore({}, {})
const api = factory(win, store, () => BOOK, (k) => flashCalls.push(k), FakeAudio, FakeUtter, fetchStub)

const eqWords = (q, want) => JSON.stringify(q.map((e) => e.w)) === JSON.stringify(want)
const waitFor = async (cond, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 4))
  }
  return cond()
}
const timeline = () => events.map((e) => (e.kind === 'audio' ? 'audio:' : 'tts:') + e.text)

// ---- 1. range filter (pure functions) --------------------------------------
store._state().words = makeWords()
check('readRangeDays 映射与兜底', api.readRangeDays('today') === 1 && api.readRangeDays('d2') === 2 &&
  api.readRangeDays('d3') === 3 && api.readRangeDays('d7') === 7 && api.readRangeDays('all') === 0 &&
  api.readRangeDays('zzz') === 2)
check('空进度 → 队列为空', api.readerQueue(makeStore({})._state()).length === 0)
store._state().settings.readRange = 'today'
check('today 只含今天学的词', eqWords(api.readerQueue(store._state()), ['alpha']))
store._state().settings.readRange = 'd2'
check('d2（默认）含今天+昨天，按最新排序', eqWords(api.readerQueue(store._state()), ['alpha', 'beta']))
store._state().settings.readRange = 'd3'
check('d3 不含 3 天前的词', eqWords(api.readerQueue(store._state()), ['alpha', 'beta']))
store._state().settings.readRange = 'd7'
check('d7 含最近 7 天', eqWords(api.readerQueue(store._state()), ['alpha', 'beta', 'gamma']))
store._state().settings.readRange = 'all'
check('all 兼容旧词条（无 last 字段）', eqWords(api.readerQueue(store._state()), ['alpha', 'beta', 'gamma', 'delta']))
check('清洗：字面 \\n、换行与 POS 标记都处理掉',
  api.cleanSpeechZh('n. 阿尔法\\nvt. 朗读') === '阿尔法；朗读' && api.cleanSpeechZh('') === '',
  JSON.stringify(api.cleanSpeechZh('n. 阿尔法\\nvt. 朗读')))
check('长释义只取前两组并截断预算',
  api.shortenMeaning('第一；第二；第三；第四') === '第一；第二' &&
  api.shortenMeaning('x'.repeat(60)).length === 48,
  api.shortenMeaning('第一；第二；第三；第四'))

// ---- 2..N. runtime: drive the real readerLoop through the fake engines -----
async function startReader(opts) {
  api.readerSet(false)
  events.length = 0
  utterances.length = 0
  audioMode = opts.audio || 'ok'
  store._state().words = opts.words || makeWords()
  store._state().settings.readRange = opts.range || 'today'
  store._state().settings.readMode = opts.mode
  store._state().settings.readExample = !!opts.example
  api.readerSet(true)
}
async function firstN(n, ms) {
  const ok = await waitFor(() => events.length >= n, ms || 4000)
  return { ok, snap: timeline().slice(0, n) }
}

{
  // d2 range → queue is [alpha(today), beta(yesterday)]: the interleaving is provable.
  store._state().settings.readHead = 0
  await startReader({ mode: 'wt', range: 'd2' })
  const { ok, snap } = await firstN(4)
  api.readerSet(false)
  check('wt：顺序为 词 → 释义 → 词 → 释义（在线中文音，字面 \\n 已清洗）', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:阿尔法' &&
    snap[2] === 'audio:beta' && snap[3] === 'audio:贝塔；第二种', JSON.stringify(snap))
  check('wt：在线中文音可用时不落本地 TTS', utterances.length === 0,
    JSON.stringify(utterances.map((u) => [u.text, u.lang])))
}

{
  await startReader({ mode: 'wt', range: 'today', audio: 'error' })
  const { ok, snap } = await firstN(4)
  api.readerSet(false)
  check('音频全挂：词与释义都退回 TTS（释义用清洗后文本）', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'tts:alpha' &&
    snap[2] === 'audio:阿尔法' && snap[3] === 'tts:阿尔法', JSON.stringify(snap))
  const zh = utterances.filter((u) => /^zh/i.test(u.lang))
  check('释义回落 TTS 语言 zh-CN', zh.length >= 1 && zh[0].text === '阿尔法',
    JSON.stringify(utterances.map((u) => [u.text, u.lang])))
}

{
  await startReader({ mode: 'wt', range: 'today', audio: 'slow' })
  const { ok, snap } = await firstN(2)
  api.readerSet(false)
  check('长音频完整播完不掐断（看门狗只守启动）', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:阿尔法', JSON.stringify(snap))
}

{
  store._state().settings.readHead = 0
  await startReader({ mode: 'w', range: 'd2' })
  const ok = await waitFor(() => events.length >= 4, 4000)
  await new Promise((r) => setTimeout(r, 40))
  const snap = timeline()
  api.readerSet(false)
  check('w：只有英语音频，一条释义都没有', ok && snap.every((x) => x.startsWith('audio:')),
    JSON.stringify(snap.slice(0, 6)))
  check('w：没有任何 TTS（中文/英文回落都没触发）', utterances.length === 0,
    JSON.stringify(utterances.map((u) => u.lang)))
  check('w：队列按 新→旧 循环，第二轮轮转到 beta 起头',
    snap.slice(0, 4).join(',') === 'audio:alpha,audio:beta,audio:beta,audio:alpha',
    JSON.stringify(snap.slice(0, 4)))
}

{
  // 轮替：连续两次开启，第二次从下一个词起头（readHead 持久化、回绕）
  store._state().settings.readHead = 0
  await startReader({ mode: 'w', range: 'd2' })
  await waitFor(() => events.length >= 1, 3000)
  const firstStart = timeline()[0]
  api.readerSet(false)
  await startReader({ mode: 'w', range: 'd2' })
  await waitFor(() => events.length >= 1, 3000)
  const secondStart = timeline()[0]
  api.readerSet(false)
  check('轮替：第二次开启不再从同一个词起头', firstStart === 'audio:alpha' && secondStart === 'audio:beta',
    firstStart + ' → ' + secondStart)
  check('轮替位置持久化（readHead 回绕到 0）', store._state().settings.readHead === 0,
    String(store._state().settings.readHead))
}

{
  // 一轮之内不重复：d7 三词，第一轮全量 alpha,beta,gamma；第二轮轮转到 beta 起头但仍全量
  store._state().settings.readHead = 0
  await startReader({ mode: 'w', range: 'd7' })
  const { ok, snap } = await firstN(6)
  api.readerSet(false)
  check('一轮内不重复：第一轮全量，第二轮轮转但仍全量',
    snap.join(',') === 'audio:alpha,audio:beta,audio:gamma,audio:beta,audio:gamma,audio:alpha',
    JSON.stringify(snap))
}

{
  // 例句：词 → 释义 → 例句 → 下一词（例句只读英文，不读翻译）
  store._state().settings.readHead = 0
  await startReader({ mode: 'wt', range: 'd2', example: true })
  const { ok, snap } = await firstN(6)
  api.readerSet(false)
  check('例句：词 → 释义 → 例句 → 下一词（不读例句翻译）', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:阿尔法' &&
    snap[2] === 'audio:Alpha is the first letter.' &&
    snap[3] === 'audio:beta' && snap[4] === 'audio:贝塔；第二种' &&
    snap[5] === 'audio:Beta is the second Greek letter.', JSON.stringify(snap))
}

{
  // 例句：wtw 下严格排在重复单词之后
  store._state().settings.readHead = 0
  await startReader({ mode: 'wtw', range: 'today', example: true })
  const { ok, snap } = await firstN(4)
  api.readerSet(false)
  check('例句：wtw 下排在重复单词之后', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:阿尔法' && snap[2] === 'audio:alpha' &&
    snap[3] === 'audio:Alpha is the first letter.', JSON.stringify(snap))
}

{
  // 例句二级回落：gamma 在词典 API 没有，Tatoeba 语料句接住；默认关闭时不发任何请求
  store._state().settings.readHead = 0
  await startReader({ mode: 'w', range: 'd7', example: true })
  const { ok, snap } = await firstN(6)
  api.readerSet(false)
  check('例句回落：词典 API 缺例句时用 Tatoeba 语料句', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:Alpha is the first letter.' &&
    snap[2] === 'audio:beta' && snap[3] === 'audio:Beta is the second Greek letter.' &&
    snap[4] === 'audio:gamma' && snap[5] === 'audio:Gamma rays are very energetic.', JSON.stringify(snap))
  const n0 = fetchCalls.length
  await startReader({ mode: 'wt', range: 'd2' })
  await waitFor(() => events.length >= 4, 5000)
  api.readerSet(false)
  check('默认不朗读例句（不发任何请求）', fetchCalls.length === n0, String(fetchCalls.length))
}

{
  store._state().settings.readHead = 0
  await startReader({ mode: 'wtw', range: 'd2' })
  const { ok, snap } = await firstN(6)
  api.readerSet(false)
  check('wtw：顺序为 词→释义→词，再下一个词（在线中文音）', ok &&
    snap[0] === 'audio:alpha' && snap[1] === 'audio:阿尔法' && snap[2] === 'audio:alpha' &&
    snap[3] === 'audio:beta' && snap[4] === 'audio:贝塔；第二种' && snap[5] === 'audio:beta',
    JSON.stringify(snap))
  check('wtw：两次英音是同一个词（读完词才进下一个）', snap[2] === snap[0] && snap[5] === snap[3],
    JSON.stringify(snap.slice(0, 6)))
}

{
  await startReader({ mode: 'w', range: 'today', audio: 'error' })
  const { ok, snap } = await firstN(2)
  api.readerSet(false)
  check('音频 error → 退回 TTS 读英语词', ok && snap[0] === 'audio:alpha' && snap[1] === 'tts:alpha',
    JSON.stringify(snap))
  check('回落 TTS 语言 en-US', utterances[0] && utterances[0].lang === 'en-US',
    utterances[0] && utterances[0].lang)
}

{
  await startReader({ mode: 'w', range: 'today', audio: 'hang' })
  const { ok, snap } = await firstN(2)
  api.readerSet(false)
  check('音频挂起（无 ended）→ 超时后 TTS 兜底', ok && snap[0] === 'audio:alpha' && snap[1] === 'tts:alpha',
    JSON.stringify(snap))
}

{
  // 'new' 范围：只读 first 落在昨天 0 点以后的词（新学），纯复习旧词不进队列
  store._state().settings.readHead = 0
  store._state().settings.readRange = 'new'
  check('new 范围只含今天/昨天新学的词', eqWords(api.readerQueue(store._state()), ['alpha', 'beta']))
  await startReader({ mode: 'w', range: 'new' })
  const { ok, snap } = await firstN(4)
  api.readerSet(false)
  check('new 范围朗读 = 新学词全量一轮', ok &&
    snap.join(',') === 'audio:alpha,audio:beta,audio:beta,audio:alpha', JSON.stringify(snap))
}

{
  await startReader({ mode: 'w', range: 'today' })
  await waitFor(() => events.length >= 2, 2000)
  await new Promise((r) => setTimeout(r, 60))
  const before = timeline()
  store._state().settings.readRange = 'd2'
  api.readerApplySettingsChange()
  const betaSeen = await waitFor(() => timeline().some((s) => s.includes('beta')), 2000)
  api.readerSet(false)
  check('today 范围运行时不会读昨天的 beta', !before.some((s) => s.includes('beta')),
    JSON.stringify(before.slice(0, 6)))
  check('切到 d2 后队列重建并开始读 beta', betaSeen)
}

{
  await startReader({ mode: 'wt', range: 'd2' })
  await waitFor(() => events.length >= 1, 3000)
  api.readerSet(false)
  const n = events.length
  await new Promise((r) => setTimeout(r, 80))
  check('停止后不再出声', events.length === n, n + ' → ' + events.length)
  check('停止持久化 readOn=false', store._state().settings.readOn === false)
  check('READER.on=false', api.READER.on === false)
}

{
  await startReader({ mode: 'w', words: {}, range: 'all' })
  const flashed = await waitFor(() => flashCalls.length > 0, 2000)
  api.readerSet(false)
  check('空队列闪 readEmpty 提示', flashed && flashCalls.includes('readEmpty'), flashCalls.join(','))
}

{
  await startReader({ mode: 'w', range: 'today' })
  await waitFor(() => events.length >= 1, 2000)
  const t0 = api.READER.token
  api.readerKick()
  check('readerKick 立即换 token 打断循环', api.READER.token === t0 + 1)
  const resumed = await waitFor(() => api.READER.token > t0 + 1 && api.READER.on, 3000)
  check('kick 后循环自行恢复', resumed)
  check('kick 不改 readOn 设置', store._state().settings.readOn === true)
  api.readerSet(false)
}

console.log('\n== 汇总 ==')
console.log((fail === 0 ? 'PASS' : 'FAIL') + ': 循环朗读行为测试 ' + pass + '/' + (pass + fail) + ' 项通过')
process.exit(fail === 0 ? 0 : 1)
