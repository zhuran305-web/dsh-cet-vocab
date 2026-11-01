#!/usr/bin/env node
/**
 * release.mjs — dsh-cet-vocab 一条命令发版（GitHub Release + npm）。
 *
 * 把踩过的坑都固化成代码：
 *   · locale 三处 i18n 先对齐（以内联字典为准）
 *   · 构建产物必须重新生成并语法自检
 *   · 打包后解开 tgz 再冒烟一次，并与构建产物逐字节比对
 *   · 相对路径发布 tarball 一律带 `./`（否则 npm 当成 owner/repo 走 git）
 *   · tag 先在本地建好再 push，Release 就不用 `--target`（那个只认全 SHA）
 *   · npm 凭据只写临时 userconfig，用完即删，绝不碰 ~/.npmrc
 *   · GitHub 走代理，npm 不走代理（清掉代理变量）
 *   · 非 ASCII 的提交信息/发布说明走临时文件，避开 Windows 控制台编码
 *
 * 依次执行：
 *   1 预检（版本号、工具、工作区、凭据）
 *   2 同步 i18n
 *   3 版本号 +1
 *   4 构建 client.js
 *   5 冒烟（工作副本）
 *   6 打包（dist/dsh-cet-vocab-<ver>.tgz + dist/dsh-cet-vocab.tgz）
 *   7 解包复核（解开 tgz 再冒烟 + client.js 逐字节比对）
 *   8 真实安装验证（临时 profile，用完删）
 *   9 提交并推送
 *  10 打 tag 并推送
 *  11 GitHub Release（已有则 --clobber 覆盖资产）
 *  12 npm publish
 *  13 核验 + 汇总
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PKG_NAME, optionValue, resolvePkgDir } from './lib/pkgdir.mjs'

// ------------------------------------------------------------------ 参数
const VALUED = new Set(['--message', '--pkg', '--token-file', '--proxy'])
const argv = process.argv.slice(2)
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUED.has(a)) { i++; continue }
  if (a.startsWith('-')) continue
  positional.push(a)
}
const has = (flag) => argv.includes(flag)
const opt = (flag, fallback = '') => optionValue(argv, flag) || fallback

const USAGE = `
用法：node scripts/release.mjs <新版本号> [选项]

  node scripts/release.mjs 0.2.2             完整发版（GitHub Release + npm）
  node scripts/release.mjs 0.2.2 --dry-run   彩排：构建/冒烟/打包/解包复核后回滚

选项
  --dry-run            跑到第 7 步就停，回滚版本号，打印后续命令（不提交、不发布）
  --no-npm             跳过 npm publish
  --no-github          跳过 GitHub Release
  --no-install-check   跳过临时 profile 的真实安装验证
  --skip-smoke         跳过冒烟测试
  --message "..."      发布说明（非 ASCII 自动走临时文件）
  --pkg <目录>         包目录（默认自动探测）
  --token-file <路径>  npm token 文件（也可用环境变量 NPM_TOKEN_FILE）
  --proxy <url>        GitHub 代理，默认 http://127.0.0.1:7897
  --allow-dirty        允许工作区有未提交改动
  -h, --help           看这段
`.trim()

if (has('-h') || has('--help')) { console.log(USAGE); process.exit(0) }
if (!positional[0]) { console.log(USAGE); process.exit(2) }

const newVersion = positional[0]
const DRY = has('--dry-run')
const DO_NPM = !has('--no-npm')
const DO_GH = !has('--no-github')
const DO_INSTALL = !has('--no-install-check')
const DO_SMOKE = !has('--skip-smoke')
const PROXY = opt('--proxy', 'http://127.0.0.1:7897')
const TOKEN_FILE = opt('--token-file') || process.env.NPM_TOKEN_FILE
  || 'C:\\Users\\chichen\\Desktop\\工具\\AI\\重要文件\\npm token.txt'
const NPM_REGISTRY = 'https://registry.npmjs.org/'
const PKG = resolvePkgDir(import.meta.url, opt('--pkg'))
const GH_ENV = { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, http_proxy: PROXY }
const NO_PROXY_ENV = { HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '' }

// 产物路径：早于各步骤定义，这样中途失败也能清理干净
const distDir = join(PKG, 'dist')
const versionedTgz = join(distDir, `${PKG_NAME}-${newVersion}.tgz`)
const latestTgz = join(distDir, `${PKG_NAME}.tgz`)
const extractDir = join(distDir, `.extract-${newVersion}`)

// 失败 / 被 process.exit 打断时也必须跑的清理。exit 钩子里只能同步操作。
const cleanups = []
process.on('exit', () => {
  for (const fn of cleanups.reverse()) {
    try { fn() } catch { /* 清理失败不掩盖原错误 */ }
  }
})

// ------------------------------------------------------------------ 输出小工具
let stepNo = 0
const line = (s = '') => console.log(s)
const step = (title) => line(`\n▶ ${++stepNo}. ${title}`)
const info = (s) => line(`    ${s}`)
const warn = (s) => line(`    ! ${s}`)
const indent = (s) => String(s).split(/\r?\n/).map((l) => '      ' + l).join('\n')
const tail = (s, n = 8) => String(s).trim().split(/\r?\n/).slice(-n).join('\n')
function fail(s) {
  line(`\n[FAIL] ${s}`)
  line('       已完成的步骤不会自动回滚；修好问题后重跑本命令（重复发版用 --no-github/--no-npm 跳过已完成的通道）。')
  process.exit(1)
}
function run(cmd, args, { cwd = PKG, env = {}, allowFail = false, quiet = false } = {}) {
  const shown = [cmd, ...args].join(' ')
  const r = spawnSync(cmd, args, {
    cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', encoding: 'utf8',
  })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  if (!quiet) {
    line(`    $ ${shown}`)
    if (out) line(indent(tail(out)))
  }
  if (r.status !== 0 && !allowFail) fail(`命令失败（exit ${r.status}）：${shown}\n${indent(tail(out, 12))}`)
  return { status: r.status ?? 1, out }
}

// ------------------------------------------------------------------ 小逻辑
function semverGt(a, b) {
  const pa = a.split(/[-+]/)[0].split('.').map(Number)
  const pb = b.split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return b.includes('-') && !a.includes('-')
}
function readToken(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/npm_[A-Za-z0-9]{20,}/) || text.match(/_authToken\s*=\s*(\S+)/)
  if (!m) throw new Error(`在 ${file} 里没找到 npm token（npm_… 或 _authToken=… ）`)
  return m[1] ?? m[0]
}
function withTempText(content, fn) {
  const f = join(tmpdir(), `dsh-cet-vocab-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(f, content, 'utf8')
  try { return fn(f) } finally { rmSync(f, { force: true }) }
}
const size = (p) => statSync(p).size

if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(newVersion)) fail(`版本号不合法：${newVersion}（要 x.y.z 形式）`)

// ------------------------------------------------------------------ 1 预检
step('预检')
info(`包目录 ${PKG}`)
info(`目标版本 ${newVersion}${DRY ? '（dry-run）' : ''}`)
if (!existsSync(join(PKG, 'client.src.js'))) fail('client.src.js 不存在，跑错目录了？')
const pkgText = readFileSync(join(PKG, 'package.json'), 'utf8')
const pkgJson = JSON.parse(pkgText)
const oldVersion = pkgJson.version
if (pkgJson.private === true) fail('package.json 里 private: true，npm 不接受发布（先删掉这行）')
if (!semverGt(newVersion, oldVersion)) fail(`新版本 ${newVersion} 必须大于当前版本 ${oldVersion}`)
for (const tool of ['node', 'git', ...(DO_NPM ? ['npm'] : []), 'pnpm', ...(DO_GH ? ['gh'] : [])]) {
  const r = run(tool, ['--version'], { quiet: true, allowFail: true })
  if (r.status !== 0) fail(`找不到可执行文件：${tool}`)
}
info(`工具就绪（node/git/pnpm${DO_NPM ? '/npm' : ''}${DO_GH ? '/gh' : ''}）`)
if (DO_NPM) {
  if (!existsSync(TOKEN_FILE)) fail(`npm token 文件不存在：${TOKEN_FILE}（用 --token-file 指定）`)
  try { readToken(TOKEN_FILE) } catch (e) { fail(String(e.message)) }
  info(`token 文件可读（${TOKEN_FILE}）`)
}
const dirty = run('git', ['status', '--porcelain'], { quiet: true }).out
if (dirty && !has('--allow-dirty')) {
  fail(`工作区有未提交改动，先处理干净再发版（或加 --allow-dirty）：\n${indent(tail(dirty, 10))}`)
}
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).out.trim()
if (branch !== 'main') warn(`当前分支是 ${branch}，不是 main`)
const lines = [`    计划：${oldVersion} → ${newVersion}；`]
lines.push(`    通道：${[DO_GH ? 'GitHub Release' : '跳过 GitHub', DO_NPM ? 'npm' : '跳过 npm'].join(' + ')}`)
line(lines.join('\n'))

// dry-run 期间产生的东西，退出时必须还原（失败也一样，靠 exit 钩子）
if (DRY) {
  cleanups.push(() => {
    // 直接把原文本写回去，比 git checkout 更安全（不依赖 git 状态、不动其它改动）
    writeFileSync(join(PKG, 'package.json'), pkgText, 'utf8')
    rmSync(extractDir, { recursive: true, force: true })
    rmSync(versionedTgz, { force: true })
    const previous = join(distDir, `${PKG_NAME}-${oldVersion}.tgz`)
    if (existsSync(previous)) copyFileSync(previous, latestTgz)
  })
}

// ------------------------------------------------------------------ 2 同步 i18n
step('同步 i18n（locale/*.json ← client.src.js 内联字典）')
const chk = run('node', ['scripts/sync_locale.mjs', '--check'], { quiet: true, allowFail: true })
if (chk.status === 2) fail('内联 ZH/EN 键集本身不一致，先修 client.src.js')
if (chk.status === 1) {
  warn('locale 文件与内联字典有漂移，写入…')
  run('node', ['scripts/sync_locale.mjs'], { quiet: true })
  const again = run('node', ['scripts/sync_locale.mjs', '--check'], { quiet: true, allowFail: true })
  if (again.status !== 0) fail('同步后仍有漂移')
  info('已同步并复核 PASS')
} else {
  info('三处 i18n 已一致')
}

// ------------------------------------------------------------------ 3 版本号
step(`版本号 ${oldVersion} → ${newVersion}`)
// dry-run 也真的写一次：这样打包出的 tgz 名、解包后的版本断言都按真实路径走，
// 最后在 dry-run 出口用 git checkout 回滚。
const bumped = pkgText.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${newVersion}"`)
if (bumped === pkgText) fail('没能在 package.json 里定位 version 字段')
writeFileSync(join(PKG, 'package.json'), bumped, 'utf8')
info(`package.json 已更新${DRY ? '（dry-run 结束会回滚）' : ''}`)

// ------------------------------------------------------------------ 4 构建
step('构建 client.js')
run('node', ['scripts/build_client.mjs'])
const built = readFileSync(join(PKG, 'client.js'), 'utf8')
if (built.includes('__WORDS__')) fail('client.js 里还残留 /*__WORDS__*/ 占位符')
info(`client.js ${Buffer.byteLength(built)} B`)

// ------------------------------------------------------------------ 5 冒烟（工作副本）
if (DO_SMOKE) {
  step('冒烟（工作副本）')
  run('node', ['scripts/smoke_release_install.mjs'])
} else {
  step('冒烟（工作副本）：按 --skip-smoke 跳过')
}

// ------------------------------------------------------------------ 6 打包
step('打包')
if (!existsSync(distDir)) mkdirSync(distDir)
const packedInRoot = join(PKG, `${PKG_NAME}-${newVersion}.tgz`)
if (existsSync(packedInRoot)) rmSync(packedInRoot, { force: true })
run('pnpm', ['pack'])
if (!existsSync(packedInRoot)) {
  const stray = readdirSync(PKG).filter((f) => /^dsh-cet-vocab-\d.*\.tgz$/.test(f))
  if (!stray.length) fail('pnpm pack 没有产出 tgz')
  renameSync(join(PKG, stray[0]), packedInRoot)
}
renameSync(packedInRoot, versionedTgz)
copyFileSync(versionedTgz, latestTgz)
info(`dist/${PKG_NAME}-${newVersion}.tgz ${size(versionedTgz)} B`)
info(`dist/${PKG_NAME}.tgz（市场 latest/download 用的那份）${size(latestTgz)} B`)

// ------------------------------------------------------------------ 7 解包复核
step('解包复核（解开 tgz 再冒烟 + 逐字节比对）')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
run('tar', ['-xzf', `dist/${PKG_NAME}-${newVersion}.tgz`, '-C', `dist/.extract-${newVersion}`])
const unpacked = join(extractDir, 'package')
if (!existsSync(join(unpacked, 'package.json'))) fail('tgz 解包后没有 package/package.json')
const unpackedPkg = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
if (unpackedPkg.version !== newVersion) fail(`解包后的版本号是 ${unpackedPkg.version}，不是 ${newVersion}`)
if (unpackedPkg.private === true) fail('解包后的 package.json 里 private: true')
if (DO_SMOKE) run('node', ['scripts/smoke_release_install.mjs', `dist/.extract-${newVersion}/package`, 'client.js'])
else info('按 --skip-smoke 跳过解包冒烟')

// ------------------------------------------------------------------ 8 真实安装验证
if (DO_INSTALL) {
  step('真实安装验证（临时 profile）')
  const prof = `cet-rel-${Date.now().toString(36)}`
  const profDir = join(homedir(), '.dsh', 'profiles', prof)
  // 中途失败（fail → process.exit）也要把临时 profile 删掉，所以挂到 exit 钩子
  cleanups.push(() => rmSync(profDir, { recursive: true, force: true }))
  try {
    // 注意：相对路径必须带 `./`，否则被当成 owner/repo 走 git（与 npm publish 同一个坑）
    run('dsh', ['plugin', '--profile', prof, 'add', `./dist/${PKG_NAME}-${newVersion}.tgz`])
    const dump = run('dsh', [prof, '--dump-config'], { quiet: true }).out
    if (!dump.includes(PKG_NAME) || !dump.includes('- id: cet-vocab')) fail('dump-config 里没有 cet-vocab 条目')
    info('装上即启用 ✓')
  } finally {
    rmSync(profDir, { recursive: true, force: true })
    info(`已删除临时 profile ${prof}`)
  }
} else {
  step('真实安装验证：按 --no-install-check 跳过')
}

// ------------------------------------------------------------------ dry-run 出口
if (DRY) {
  line('\n▶ dry-run 收尾')
  info('退出时自动还原：package.json 版本号、dist 彩排产物、解包目录')
  const msg = opt('--message')
  line('    接下来（去掉 --dry-run）会执行：')
  line(indent([
    `git add -A && git commit -m "v${newVersion}${msg ? ': ' + msg : ''}" && git push`,
    `git tag -a v${newVersion} -m "v${newVersion}" && git push origin v${newVersion}`,
    DO_GH ? `gh release create v${newVersion} dist/${PKG_NAME}-${newVersion}.tgz dist/${PKG_NAME}.tgz` : '（跳过 GitHub Release）',
    DO_NPM ? `npm publish ./dist/${PKG_NAME}-${newVersion}.tgz  # token 走临时 userconfig` : '（跳过 npm）',
  ].join('\n')))
  line('\ndry-run 完成：未提交、未打 tag、未发布。')
  process.exit(0)
}

// ------------------------------------------------------------------ 9 提交并推送
step('提交并推送')
const message = opt('--message')
const commitSubject = `v${newVersion}${message ? ': ' + message : ''}`
run('git', ['add', '-A'])
const commitFiles = run('git', ['diff', '--cached', '--name-only'], { quiet: true }).out.trim()
if (!commitFiles) warn('暂存区是空的，git commit 可能失败')
else info(`将提交 ${commitFiles.split(/\r?\n/).length} 个文件`)
if (/[^\x20-\x7E]/.test(commitSubject)) withTempText(commitSubject, (f) => run('git', ['commit', '-F', f]))
else run('git', ['commit', '-m', commitSubject])
const head = run('git', ['rev-parse', 'HEAD'], { quiet: true }).out.trim()
info(`提交 ${head.slice(0, 12)}`)
run('git', ['push'], { env: GH_ENV })

// ------------------------------------------------------------------ 10 tag
step(`打 tag v${newVersion} 并推送`)
const tag = `v${newVersion}`
if (run('git', ['tag', '--list', tag], { quiet: true }).out.trim()) {
  warn(`本地已存在 tag ${tag}，跳过创建`)
} else {
  run('git', ['tag', '-a', tag, '-m', commitSubject])
}
run('git', ['push', 'origin', tag], { env: GH_ENV })

// ------------------------------------------------------------------ 11 GitHub Release
if (DO_GH) {
  step('GitHub Release')
  const assets = [`dist/${PKG_NAME}-${newVersion}.tgz`, `dist/${PKG_NAME}.tgz`]
  const existing = run('gh', ['release', 'view', tag], { quiet: true, allowFail: true, env: GH_ENV }).status === 0
  if (existing) {
    warn(`Release ${tag} 已存在，覆盖资产（--clobber）`)
    run('gh', ['release', 'upload', tag, ...assets, '--clobber'], { env: GH_ENV })
  } else {
    const notes = `dsh-cet-vocab v${newVersion}${message ? '\n\n' + message : ''}`
    withTempText(notes, (f) => run(
      'gh', ['release', 'create', tag, ...assets, '--title', tag, '--notes-file', f],
      { env: GH_ENV },
    ))
  }
} else {
  step('GitHub Release：按 --no-github 跳过')
}

// ------------------------------------------------------------------ 12 npm publish
if (DO_NPM) {
  step('npm publish')
  const token = readToken(TOKEN_FILE)
  const rc = join(tmpdir(), `dsh-cet-vocab-npmrc-${process.pid}`)
  try {
    writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 })
    cleanups.push(() => rmSync(rc, { force: true })) // 含密钥，无论如何都要删
    const args = ['publish', `./dist/${PKG_NAME}-${newVersion}.tgz`, `--userconfig=${rc}`, `--registry=${NPM_REGISTRY}`]
    if (newVersion.includes('-')) args.push('--tag', 'next') // 预发布版本不打 latest
    run('npm', args, { env: NO_PROXY_ENV })
  } finally {
    if (existsSync(rc)) rmSync(rc, { force: true })
    info('临时 npmrc 已删除')
  }
} else {
  step('npm publish：按 --no-npm 跳过')
}

// ------------------------------------------------------------------ 13 核验
step('核验')
if (DO_NPM) {
  const view = run('npm', ['view', `${PKG_NAME}@${newVersion}`, 'version', `--registry=${NPM_REGISTRY}`],
    { quiet: true, allowFail: true, env: NO_PROXY_ENV })
  const got = view.out.trim().split(/\r?\n/).pop()
  if (got === newVersion) info(`npm registry 上已有 ${PKG_NAME}@${newVersion}`)
  else warn(`npm 上暂时查不到 ${newVersion}（可能要等几秒）：${got || view.status}`)
}
if (DO_GH) {
  const r = run('gh', ['release', 'view', tag, '--json', 'tagName,assets'], { quiet: true, allowFail: true, env: GH_ENV })
  try {
    const parsed = JSON.parse(r.out)
    const names = (parsed.assets || []).map((a) => a.name)
    info(`Release ${parsed.tagName} 资产：${names.join(', ') || '（无）'}`)
    if (names.length < 2) warn('资产少于 2 个，检查 Release')
  } catch {
    warn('读不到 Release 详情（gh 网络？）')
  }
}

// ------------------------------------------------------------------ 汇总
line(`\n✅ v${newVersion} 发布完成`)
line(`   提交      ${head.slice(0, 12)}（tag ${tag}）`)
if (DO_GH) line(`   Release   https://github.com/zhuran305-web/${PKG_NAME}/releases/tag/${tag}`)
if (DO_NPM) line(`   npm       https://www.npmjs.com/package/${PKG_NAME}/v/${newVersion}`)
line('   市场条目不用改（指向 releases/latest/download）；官方 index.json 与 npm 快照每天自动重建。')
line('   已装用户：市场里会提示更新，或 `dsh plugin --profile <p> add ' + PKG_NAME + '`。')
