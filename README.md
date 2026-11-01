# dsh-cet-vocab / 背单词（四六级）

A CET-4 / CET-6 vocabulary trainer for the [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) Web UI: a draggable, minimizable floating word-card window you can open any time — including while the model is thinking.

一个 DeepSeek Harness（dsh）Web 界面的四六级背单词悬浮窗：可拖动、可最小化，随时点开背单词——包括模型思考的空档期。

## Features / 功能

- **Word list / 词库** — 5,805 words (CET-4 3,849 / CET-6 5,407, deduplicated), extracted from [ECDICT](https://github.com/skywind3000/ECDICT) by tag and sorted by frequency. The list is bundled into the client, so the plugin works fully offline. 词库按 cet4/cet6 标签从 ECDICT 提取、按词频排序，内嵌进前端，运行时不需要网络。
- **Two study modes / 两种模式** — flip-card with three-button grading (known / fuzzy / unknown), or multiple-choice quiz with distractors picked from confusable words (edit distance, shared prefix/suffix/bigrams). 翻卡三键评分（认识/模糊/不认识），或形近词干扰项的选择题模式。
- **Spaced repetition / 间隔复习** — Ebbinghaus-style ladder (10 min → 1 d → 2 d → 4 d → 8 d → 16 d); failed cards reset and re-queue after 10 minutes. 艾宾浩斯阶梯复习，答错 10 分钟后重新进队。
- **Daily plan / 每日计划** — configurable daily new-word quota (0–500); today's review count shown on the pill badge. 每日新词数可自定义（0–500），药丸徽标显示今日待复习数。
- **Review / extra practice / 复习与加练** — when today's quota is done, review due cards (≤20) or practice 10 unseen words; practice results don't consume the quota. 完成当日额度后可复习到期词或加练未学词，不计额度。
- **Auto-open / 思考时自动弹出** — opens the window automatically whenever a session starts running; toggleable in settings. 检测到会话运行时自动弹出窗口，可在设置中关闭。
- **Pronunciation / 发音** — real human US/UK recordings fetched per word from Youdao's open dictionary audio (accent selectable: auto / US / UK), with the browser's `speechSynthesis` as the offline fallback — no Windows voice pack or admin rights needed. 每个词实时取有道词典的真人美式/英式发音（口音可选：自动/美式/英式），断网时自动回落到系统语音合成——不需要安装任何 Windows 语音包，也不需要管理员权限。
- **Window / 窗口** — draggable with pointer capture and edge clamping, minimizes to a badge pill that stays where you left it; geometry persisted. 拖动带边界钳制，最小化成药丸且停在原地，几何持久化。
- **Stats & settings / 统计与设置** — per-book progress and streaks; switch between CET-4 / CET-6 / all books. 各词书进度统计，可切换四级/六级/全部词库。
- **Keyboard / 快捷键** — `Space` reveal, `1/2/3` grade in card mode, `1-4` answer in quiz mode. 卡片模式空格翻面、123 评分，选择题 1-4 作答。

Progress is stored in `localStorage` (per browser profile). 进度存于浏览器 `localStorage`。

## Install / 安装

From any DSH plugin marketplace that mirrors the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog (e.g. dshmarket, dsh-plugin-mall), or directly / 或直接：

```sh
dsh plugin add dsh-cet-vocab                      # from npm
dsh plugin add "https://github.com/zhuran305-web/dsh-cet-vocab/releases/latest/download/dsh-cet-vocab.tgz"   # from GitHub Releases
```

The package ships prebuilt `client.js` — no build step, no telemetry. Pronunciation streams one small mp3 per word from Youdao's dictionary audio on demand (cached by the browser); everything else works offline. 包内自带构建好的 client.js，无构建步骤、无遥测。发音按需流式加载有道词典音频（浏览器自带缓存），其余功能完全离线。

## Build from source / 从源码构建

```sh
node scripts/build_client.mjs   # embeds data/words.json into client.js
```

`data/words.json` is generated from ECDICT (`scripts/build_words.py` filters the `cet4`/`cet6` tags); download the [ECDICT](https://github.com/skywind3000/ECDICT) release CSV to `data/ecdict.csv` to regenerate it.

## Release / 发版

```sh
node scripts/release.mjs 0.2.2 --dry-run   # 彩排：构建/冒烟/打包/解包复核/临时 profile 安装验证，然后自动还原
node scripts/release.mjs 0.2.2             # 正式发版：提交推送 → tag → GitHub Release → npm publish → 核验
```

One command runs the whole chain: sync the three i18n places, bump the version, rebuild `client.js`, smoke-test the working copy, pack, unpack the tarball and smoke-test it again (byte-comparing `client.js` against the build), install the tarball into a throwaway DSH profile through the real CLI, then commit, tag, publish a GitHub Release and publish to npm — verifying both channels afterwards. 一条命令跑完整条发版链路，失败时会还原 dry-run 产生的临时改动。

| script | what it does |
| --- | --- |
| `scripts/release.mjs` | the one-command release above (`--dry-run`, `--no-npm`, `--no-github`, `--skip-smoke`, …) |
| `scripts/build_client.mjs` | embeds `data/words.json` into `client.js` and syntax-checks the result |
| `scripts/sync_locale.mjs [--check]` | keeps `locale/zh.json` + `locale/en.json` identical to the inline dictionaries in `client.src.js` |
| `scripts/smoke_release_install.mjs [dir] [reference client.js]` | 56–57 structural checks: package fields, `shell.overlay` registration, locale wiring, embedded word list |

Requirements: an authenticated `gh`, and an npm **granular access token with “Bypass 2FA” enabled** (npm requires 2FA, or such a token, to publish) supplied via `--token-file` or `NPM_TOKEN_FILE`. GitHub traffic uses the proxy from `--proxy` (default `http://127.0.0.1:7897`); npm is deliberately called without a proxy. The npm credential is written to a temporary userconfig and deleted afterwards — `~/.npmrc` is never touched. 需要已登录的 `gh`，以及开启 Bypass 2FA 的 npm granular token；GitHub 走代理、npm 不走代理，凭据只落在临时配置里且用完即删。

## Data license / 词库来源

The word list is extracted from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT License, © skywind3000). Everything else is MIT — see [LICENSE](LICENSE).

## License / 许可

MIT
