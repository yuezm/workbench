#!/usr/bin/env node
/**
 * 推送并建 MR 合到主干：`npm run git:mr`
 *
 * 一条命令做完 push → 建 MR → 拿 URL → 通知，**合并留给人审批**。
 * 为什么合成一步：push 与建 MR 是同一个事务（`-o merge_request.create`），
 * 拆开就要处理「推上去了但 MR 没建成」的中间态。
 *
 * 为什么不默认设自动合并：`merge_when_pipeline_succeeds` 在本仓是个陷阱——
 * 仓库没有 `.gitlab-ci.yml`，GitLab 对「没有流水线的 MR」不等待任何东西，
 * 直接把 auto-merge 当立即合并执行，于是「建 MR」变成「绕过审批直接进主干」。
 * 要自动合并必须显式加 `--auto-merge`。
 *
 * 退出码：
 *   0 = 推送完成（MR 已建，URL 已拿到）
 *   1 = 有遗留物 / 没有新提交 / push 失败 / 解析不到 MR URL
 *   2 = 环境问题（不在 git 仓库、远端缺失、目标分支不存在）
 *
 * 目标分支写在本仓 `package.json` 的 `git:mr` 里（每个项目不一样），
 * 也可以在命令行临时覆盖：`npm run git:mr -- --target main`。
 *
 * 认证：push 走 git 自己的通道（SSH key / credential manager），不需要 token；
 * `--merge-now` 与「复用已存在的 MR」才需要 `GITLAB_TOKEN`（api scope）。
 *
 * 通知：默认 POST 本机工作台的 `/api/notify`（`WB_NOTIFY_URL` 可改），
 * 另可设 `WB_LARK_TO=ou_xxx` 额外发一条飞书私聊。两条都失败不影响推送结论。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  findMergeRequestUrl,
  git,
  inspectWorkspace,
  listSection,
  parseRemote,
  problemsOf,
} from './lib.mjs'

const VALUE_FLAGS = new Map([
  ['--target', 'target'],
  ['--source', 'source'],
  ['--remote', 'remote'],
  ['--title', 'title'],
  ['--description', 'description'],
  ['--description-file', 'descriptionFile'],
  ['--notify-url', 'notifyUrl'],
])

const opts = {
  target: null,
  source: null,
  remote: null,
  title: null,
  description: null,
  descriptionFile: null,
  notifyUrl: process.env.WB_NOTIFY_URL ?? 'http://127.0.0.1:3000/api/notify',
  labels: [],
  allowDirty: false,
  allowUntracked: false,
  noVerify: false,
  noFetch: false,
  dryRun: false,
  autoMerge: false,
  mergeNow: false,
  removeSourceBranch: true,
  notify: true,
  json: true,
}

function die(code, message) {
  console.log(`[git:mr] ${message}`)
  process.exit(code)
}

function info(message) {
  if (message !== '') console.log(`[git:mr] ${message}`)
}

function warn(message) {
  console.warn(`[git:mr] ${message}`)
}

const HELP = [
  '用法：npm run git:mr [-- 选项]',
  '  --target <branch>          目标分支（默认 .gitlab-mr.json > 远端默认分支）',
  '  --source <branch>          源分支（默认当前分支）',
  '  --remote <name>            远端名（默认 origin）',
  '  --title / --description / --description-file',
  '  --label <name>             MR 标签，可重复',
  '  --allow-dirty              允许已跟踪文件的未提交改动',
  '  --allow-untracked          允许未跟踪文件',
  '  --no-verify                跳过 git 自己的 pre-push 钩子（本仓默认启用 .githooks）',
  '  --no-fetch                 不先 fetch 目标分支（默认会 fetch，避免返工时重复提交）',
  '  --dry-run                  只打印将执行的 git 命令',
  '  --no-auto-merge            兼容旧调用：现在就是默认行为，不设自动合并',
  '  --auto-merge               建 MR 并设「流水线通过即合并」（本仓无流水线 = 立即合并，慎用）',
  '  --merge-now                建完立即合并（需 GITLAB_TOKEN）',
  '  --keep-source-branch       合并后保留源分支',
  '  --no-notify                不发通知',
  '  --no-json                  不输出回执块',
].join('\n')

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (VALUE_FLAGS.has(arg)) {
    const value = argv[i + 1]
    if (value === undefined) die(2, `${arg} 缺少取值`)
    i += 1
    opts[VALUE_FLAGS.get(arg)] = value
    continue
  }
  if (arg === '--label') {
    const value = argv[i + 1]
    if (value === undefined) die(2, '--label 缺少取值')
    i += 1
    opts.labels.push(value)
    continue
  }
  switch (arg) {
    case '--allow-dirty':
      opts.allowDirty = true
      break
    case '--allow-untracked':
      opts.allowUntracked = true
      break
    case '--no-verify':
      opts.noVerify = true
      break
    case '--no-fetch':
      opts.noFetch = true
      break
    case '--dry-run':
      opts.dryRun = true
      break
    case '--no-auto-merge':
      opts.autoMerge = false
      break
    case '--auto-merge':
      opts.autoMerge = true
      break
    case '--merge-now':
      opts.mergeNow = true
      break
    case '--keep-source-branch':
      opts.removeSourceBranch = false
      break
    case '--no-notify':
      opts.notify = false
      break
    case '--no-json':
      opts.json = false
      break
    case '-h':
    case '--help':
      console.log(HELP)
      process.exit(0)
    default:
      die(2, `未知参数：${arg}`)
  }
}

// ---------------------------------------------------------------- 工作区

let state
try {
  state = inspectWorkspace(process.cwd())
} catch (error) {
  die(2, `环境不满足：${error.message}`)
}

// --allow-dirty 只放行「已跟踪文件的改动」；未跟踪仍由 --allow-untracked 单独放行
const blocking = problemsOf(state, { allowUntracked: opts.allowUntracked }).filter(
  (problem) => !(opts.allowDirty && /未提交|未暂存/.test(problem)),
)
if (blocking.length > 0) {
  console.log('[git:mr] 工作区有遗留物，先清理再推送：')
  for (const problem of blocking) console.log(`  · ${problem}`)
  const sections = [
    listSection('已暂存未提交', state.staged),
    listSection('已改动未暂存', state.unstaged),
    listSection('未跟踪文件', state.untracked),
  ].filter((section) => section !== '')
  if (sections.length > 0) console.log(`\n${sections.join('\n\n')}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 分支

const remote = opts.remote ?? 'origin'
const remotes = git(['remote'])
  .out.split(/\r?\n/)
  .filter((line) => line.trim() !== '')
if (!remotes.includes(remote))
  die(2, `远端 ${remote} 不存在（可用：${remotes.join('、') || '无'}）`)

const parsedRemote = parseRemote(git(['remote', 'get-url', remote]).out)
if (parsedRemote === null) die(2, `无法解析远端地址：${git(['remote', 'get-url', remote]).out}`)

const source = opts.source ?? state.branch
if (source === 'HEAD' || source === '') die(2, '当前处于 detached HEAD，必须用 --source 指定分支')

const repoConfig = readRepoConfig(state.root)
let target = opts.target ?? repoConfig.targetBranch ?? null
if (target === null) {
  const symref = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], {
    allowFail: true,
  })
  if (symref.code === 0 && symref.out !== '')
    target = symref.out.replace(new RegExp(`^${remote}/`), '')
}
if (target === null) die(2, '无法确定目标分支：用 --target 指定，或在仓库根放 .gitlab-mr.json')

// 目标分支必须存在（远端或本地），否则建出来的 MR 指向一个不存在的基线
//
// 先同步目标分支的远端引用再算 ahead：分支被合并过、或者别人往目标分支推过之后，
// 本地那份 `origin/<target>` 已经过期——不 fetch 就会把已经合进主干的旧提交又算一遍，
// 返工那一轮的 MR 里会出现重复 diff。
if (!opts.noFetch) {
  const fetched = git(['fetch', '--quiet', remote, target], { cwd: state.root, allowFail: true })
  if (fetched.code !== 0) {
    warn(
      `fetch ${remote} ${target} 失败：${fetched.err || '未知原因'}（按本地远端引用判断，可能重复提交）`,
    )
  }
}

const targetRef = [`refs/remotes/${remote}/${target}`, `refs/heads/${target}`].find(
  (ref) => git(['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).code === 0,
)
if (targetRef === undefined) die(2, `目标分支 ${target} 在本地和 ${remote} 上都不存在`)

const sameBranch = source === target
const aheadCount = sameBranch
  ? Number(git(['rev-list', '--count', `${targetRef}..HEAD`], { allowFail: true }).out || '0')
  : Number(
      git(['rev-list', '--count', `${targetRef}..refs/heads/${source}`], { allowFail: true }).out ||
        '0',
    )
const commits = git([
  'log',
  '--no-merges',
  '--pretty=%h %s',
  '-20',
  `${targetRef}..refs/heads/${source}`,
])
  .out.split(/\r?\n/)
  .filter((line) => line.trim() !== '')

// 这个源分支是否已经有一张 open 的 MR：验收没过、改完再来一轮就是这一支——
// 同一分支再次 push 会更新那张 MR（流水线重跑），不需要也不能再开一张。
let existingMergeRequest = null
if (!sameBranch) existingMergeRequest = await lookupMergeRequest(source, target)

/** 没有新提交时：若已有 open MR（返工但本轮没改代码），复用它的链接，别当失败。 */
if (!sameBranch && aheadCount <= 0) {
  if (existingMergeRequest !== null) {
    await finish({
      url: existingMergeRequest,
      notice: `没有新提交，复用已打开的 MR（${source} → ${target}）：${existingMergeRequest}`,
      merged: null,
    })
  }
  die(
    1,
    `${source} 相对 ${target} 没有新提交，也没有可复用的 open MR。\n` +
      '（查已有 MR 需要 GITLAB_TOKEN；没有 token 时只能靠 push 输出里的链接判断）',
  )
}

// ---------------------------------------------------------------- 计划

const clamp = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** push option 里不能有换行（git 会直接拒），压平。 */
const flatten = (text) =>
  String(text ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()

function descriptionOf() {
  if (opts.description !== null) return opts.description
  if (opts.descriptionFile !== null) {
    const file = resolve(opts.descriptionFile)
    if (!existsSync(file)) die(2, `描述文件不存在：${file}`)
    return readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
  }
  return sameBranch
    ? `workbench 提交与推送：直接更新 ${target}（${aheadCount} 个提交）`
    : `workbench 提交与推送：${source} → ${target}（${aheadCount} 个提交）`
}

const title = clamp(
  opts.title ?? git(['log', '-1', '--pretty=%s', `refs/heads/${source}`]).out,
  200,
)
const description = flatten(clamp(descriptionOf(), 1500))

/** 主干类分支永远不从 MR 侧删除：合并后删掉 develop / main 是最贵的一次误操作。 */
const PROTECTED_SOURCE = /^(main|master|develop|trunk|release\/.+)$/
const keepSource = !opts.removeSourceBranch || sameBranch || PROTECTED_SOURCE.test(source)

function pushArgs({ withAutoMerge }) {
  const base = ['push']
  if (opts.noVerify) base.push('--no-verify')
  base.push(remote, `HEAD:refs/heads/${source}`)
  if (sameBranch) return base
  const options = [
    'merge_request.create',
    `merge_request.target=${target}`,
    `merge_request.title=${title}`,
    `merge_request.description=${description}`,
  ]
  if (!keepSource) options.push('merge_request.remove_source_branch')
  for (const label of opts.labels) options.push(`merge_request.label=${label}`)
  if (withAutoMerge) options.push('merge_request.merge_when_pipeline_succeeds')
  return [...base, ...options.flatMap((option) => ['-o', option])]
}

function runPush(pushArgv) {
  const result = spawnSync('git', pushArgv, {
    cwd: state.root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) die(2, `无法执行 git push：${result.error.message}`)
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

info(
  sameBranch
    ? `直接推送主干 ${source}（${aheadCount} 个提交，不建 MR）`
    : `源分支 ${source} → 目标分支 ${target}（${aheadCount} 个提交）`,
)
if (!sameBranch) {
  info(`MR 标题：${title}`)
  info(
    opts.autoMerge
      ? '合并方式：建 MR 并设「流水线通过即合并」（--auto-merge；本仓没有流水线，等于立即合并）'
      : '合并方式：只建 MR，合并由人在 GitLab 上审批',
  )
  if (existingMergeRequest !== null) {
    info(`该分支已有 open MR，本轮推送会更新它：${existingMergeRequest}`)
  }
}

if (opts.dryRun) {
  const args = pushArgs({ withAutoMerge: opts.autoMerge && !sameBranch })
  console.log('\n[git:mr] --dry-run，以下命令不会执行：')
  console.log(
    `  git ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------- 推送

let result = runPush(pushArgs({ withAutoMerge: opts.autoMerge && !sameBranch }))
if (
  result.code !== 0 &&
  opts.autoMerge &&
  !sameBranch &&
  `${result.stdout}\n${result.stderr}`.includes('is not a valid push option')
) {
  warn('实例不认 merge_when_pipeline_succeeds，退回「只建 MR」重试一次')
  result = runPush(pushArgs({ withAutoMerge: false }))
}

const combined = `${result.stdout}\n${result.stderr}`.trim()
if (result.code !== 0) {
  console.log(combined)
  die(1, `git push 失败（退出码 ${result.code}）`)
}
for (const line of combined.split(/\r?\n/)) {
  const text = line.trim()
  if (text !== '')
    console.log(text.startsWith('remote:') ? `  ${text.slice(7).trim()}` : `  ${text}`)
}

// ---------------------------------------------------------------- MR URL

if (sameBranch) {
  const url = `${parsedRemote.webBase}/-/commits/${source}`
  await finish({
    url,
    notice: `主干 ${source} 已更新（${aheadCount} 个提交）：${url}`,
    merged: null,
  })
}

let mergeRequestUrl = findMergeRequestUrl(combined)
if (mergeRequestUrl === null)
  mergeRequestUrl = existingMergeRequest ?? (await lookupMergeRequest(source, target))
if (mergeRequestUrl === null) {
  die(
    1,
    '推送成功，但没有解析到 MR 链接。手工确认：' +
      `${parsedRemote.webBase}/-/merge_requests\n` +
      '常见原因：该分支已推过（git 输出 No new changes，不会重建 MR）、实例未启用 push options、' +
      '或没有 GITLAB_TOKEN 可供查询已存在的 MR。',
  )
}

const iid = /\/merge_requests\/(\d+)/.exec(mergeRequestUrl)?.[1] ?? '?'
const updated = existingMergeRequest !== null && mergeRequestUrl === existingMergeRequest

// ---------------------------------------------------------------- 立即合并

let merged = null
if (opts.mergeNow) {
  const token = (process.env.GITLAB_TOKEN ?? '').trim()
  if (token === '') die(1, '--merge-now 需要 GITLAB_TOKEN（api scope）')
  const path = `/api/v4/projects/${encodeURIComponent(parsedRemote.projectPath)}/merge_requests/${iid}/merge`
  const response = await api(`${parsedRemote.apiBase}${path}`, token)
  if (!response.ok) {
    die(
      1,
      `建 MR 成功但立即合并失败（HTTP ${response.status}）：${response.body}\nMR：${mergeRequestUrl}`,
    )
  }
  merged = iid
}

await finish({
  url: mergeRequestUrl,
  notice:
    merged !== null
      ? `MR !${iid} 已合并到 ${target}：${mergeRequestUrl}`
      : updated
        ? `MR !${iid} 已更新（${source} → ${target}）${opts.autoMerge ? '，流水线重跑后自动合并' : ''}：${mergeRequestUrl}`
        : `MR !${iid} 已创建（${source} → ${target}）${opts.autoMerge ? '，流水线通过即自动合并' : ''}：${mergeRequestUrl}`,
  merged,
})

// ---------------------------------------------------------------- 收尾

async function api(url, token) {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'PRIVATE-TOKEN': token, 'content-type': 'application/json' },
      body: '{}',
    })
    return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 500) }
  } catch (error) {
    return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }
  }
}

/** 有 token 时查同源分支的已存在 MR（重复执行时 push 不会重建 MR）。 */
async function lookupMergeRequest(sourceBranch, targetBranch) {
  const token = (process.env.GITLAB_TOKEN ?? '').trim()
  if (token === '') return null
  const query =
    '?state=opened' +
    `&source_branch=${encodeURIComponent(sourceBranch)}` +
    `&target_branch=${encodeURIComponent(targetBranch)}`
  const url =
    `${parsedRemote.apiBase}/api/v4/projects/` +
    `${encodeURIComponent(parsedRemote.projectPath)}/merge_requests${query}`
  try {
    const response = await fetch(url, { headers: { 'PRIVATE-TOKEN': token } })
    if (!response.ok) return null
    const body = await response.json()
    const first = Array.isArray(body) ? body[0] : null
    return typeof first?.web_url === 'string' ? first.web_url : null
  } catch {
    return null
  }
}

async function finish({ url, notice, merged: mergedIid }) {
  if (opts.notify && opts.notifyUrl !== '') await notify(notice)
  if (opts.json) {
    console.log('\n```json')
    console.log(
      JSON.stringify(
        {
          notices: [notice],
          deliverables: {
            branch: source,
            base: target,
            commits: commits.map((line) => line.split(' ')[0]).slice(0, 20),
            files: [],
            gates: [],
          },
          ...(mergedIid === null ? {} : { merged: mergedIid }),
        },
        null,
        2,
      ),
    )
    console.log('```')
  }
  info(`完成：${url}`)
  process.exit(0)
}

async function notify(body) {
  notifyLark(body)
  try {
    const response = await fetch(opts.notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '提交与推送：已完成', body }),
    })
    if (!response.ok) warn(`工作台通知未送达（HTTP ${response.status}），不影响推送结果`)
  } catch (error) {
    warn(`工作台通知未送达（${error.message}），不影响推送结果`)
  }
}

/**
 * 飞书私聊：`WB_LARK_TO=ou_xxx` 时额外发一条。
 *
 * 为什么走 lark-cli 而不经工作台的卡片通道：那条通道只投「要人拍板」的卡，
 * 这里发的是「已经做完的事」，不该再让人点一下。
 */
function notifyLark(text) {
  const to = (process.env.WB_LARK_TO ?? '').trim()
  if (to === '') return
  const result = spawnSync('lark-cli', ['im', '+messages-send', '--user-id', to, '--text', text], {
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  })
  if (result.error || result.status !== 0) {
    warn(`飞书消息未送达（${result.error?.message ?? `退出码 ${result.status}`}），不影响推送结果`)
  }
}

function readRepoConfig(root) {
  const file = resolve(root, '.gitlab-mr.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    die(2, `.gitlab-mr.json 解析失败：${error.message}`)
  }
}
