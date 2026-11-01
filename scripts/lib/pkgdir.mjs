/**
 * pkgdir.mjs — 定位 dsh-cet-vocab 的包目录，兼容两种布局：
 *
 *   仓库布局   <pkg>/scripts/xxx.mjs        → 脚本的上一级就是包目录
 *   工作区布局 <work>/scripts/xxx.mjs        → 上一级下的 dsh-cet-vocab/ 才是包目录
 *
 * 判定依据：该目录的 package.json 里 name === 'dsh-cet-vocab'。
 * 这样同一份脚本在仓库里直接跑、在工作区通过薄包装跑，行为完全一致。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG_NAME = 'dsh-cet-vocab'

/** dir 是不是本插件的包目录 */
export function isPkgDir(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return false
  try {
    return JSON.parse(readFileSync(file, 'utf8')).name === PKG_NAME
  } catch {
    return false
  }
}

/**
 * @param {string} scriptUrl 调用方的 import.meta.url
 * @param {string} [explicit] --pkg 传进来的目录（可空）
 */
export function resolvePkgDir(scriptUrl, explicit) {
  if (explicit) {
    const dir = resolve(explicit)
    if (!isPkgDir(dir)) throw new Error(`--pkg 指向的不是 ${PKG_NAME} 包目录：${dir}`)
    return dir
  }
  const here = dirname(fileURLToPath(scriptUrl))
  const candidates = [resolve(here, '..'), resolve(here, '..', PKG_NAME)]
  for (const candidate of candidates) if (isPkgDir(candidate)) return candidate
  throw new Error(
    `找不到 ${PKG_NAME} 包目录，试过：${candidates.join(' | ')}（用 --pkg <目录> 指定）`,
  )
}

/** 取 `--flag value` / `--flag=value` 的值；没传返回 '' */
export function optionValue(argv, flag) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === flag) {
      const next = argv[i + 1]
      return next !== undefined && !next.startsWith('--') ? next : ''
    }
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1)
  }
  return ''
}
