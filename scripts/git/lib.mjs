#!/usr/bin/env node
/**
 * 「提交与推送」两个脚本共用的 git 工具：调用、工作区体检、远端 URL 解析。
 *
 * 为什么放在仓库内而不是个人工具目录：每个项目的目标分支、保护规则、提交口径都不一样，
 * 这些配置属于项目本身，交给项目自己的 npm script 表达（`npm run git:clean` / `npm run git:mr`），
 * 换项目就换一份配置，工作台那边只认这两条命令。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 单次 git 调用：默认失败即抛，`allowFail` 时把退出码交给调用方判断。 */
export function git(args, { cwd = process.cwd(), allowFail = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw new Error(`无法执行 git：${result.error.message}`)
  const stdout = (result.stdout ?? '').replace(/\s+$/, '')
  const stderr = (result.stderr ?? '').replace(/\s+$/, '')
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `git ${args.join(' ')} 失败（退出码 ${result.status}）${stderr === '' ? '' : `\n${stderr}`}`,
    )
  }
  return { code: result.status ?? 0, out: stdout, err: stderr }
}

/** 在途操作：这些文件或目录还在，说明上一次操作没走完，此时提交或推送只会更乱。 */
const IN_PROGRESS = [
  ['MERGE_HEAD', 'merge 未完成'],
  ['CHERRY_PICK_HEAD', 'cherry-pick 未完成'],
  ['REVERT_HEAD', 'revert 未完成'],
  ['rebase-merge', 'rebase 未完成'],
  ['rebase-apply', 'rebase / am 未完成'],
]

/**
 * 工作区体检：分支、HEAD、upstream、遗留文件分类、在途操作。
 *
 * 分类口径（`--porcelain=v1` 的 XY 两列）：
 * - `??` → 未跟踪（ignored 不算：`.gitignore` 里的东西本来就不该提交）；
 * - X 非 ' ' 且非 '?' → 已暂存；
 * - Y 非 ' ' → 未暂存（工作区改动）。
 */
export function inspectWorkspace(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], { cwd }).out
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd, allowFail: true }).out
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).out
  const head = git(['rev-parse', '--short', 'HEAD'], { cwd, allowFail: true }).out
  const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    cwd,
    allowFail: true,
  })
  const upstream = upstreamResult.code === 0 ? upstreamResult.out : null

  const staged = []
  const unstaged = []
  const untracked = []
  const status = git(['status', '--porcelain=v1'], { cwd }).out
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    const filePath = line.slice(3)
    if (xy === '??') {
      untracked.push(filePath)
      continue
    }
    if (xy[0] !== ' ' && xy[0] !== '?') staged.push(filePath)
    if (xy[1] !== ' ') unstaged.push(filePath)
  }

  const inProgress = []
  if (gitDir !== '') {
    for (const [marker, label] of IN_PROGRESS) {
      if (existsSync(join(gitDir, marker))) inProgress.push(label)
    }
  }

  const detached = branch === 'HEAD'
  const behind =
    upstream === null
      ? 0
      : Number(
          git(['rev-list', '--count', `HEAD..${upstream}`], { cwd, allowFail: true }).out || '0',
        )
  const ahead =
    upstream === null
      ? 0
      : Number(
          git(['rev-list', '--count', `${upstream}..HEAD`], { cwd, allowFail: true }).out || '0',
        )

  return {
    root,
    gitDir,
    branch,
    head,
    upstream,
    staged,
    unstaged,
    untracked,
    inProgress,
    detached,
    ahead,
    behind,
    dirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
  }
}

/** 遗留 / 在途问题清单：空数组 = 干净。 */
export function problemsOf(state, { allowUntracked = false } = {}) {
  const problems = []
  if (state.inProgress.length > 0)
    problems.push(`仓库有未完成的操作：${state.inProgress.join('、')}`)
  if (state.detached) problems.push('当前处于 detached HEAD，没有分支可推')
  if (state.staged.length > 0) problems.push(`已暂存但未提交：${state.staged.length} 个文件`)
  if (state.unstaged.length > 0) problems.push(`已改动但未暂存：${state.unstaged.length} 个文件`)
  if (!allowUntracked && state.untracked.length > 0) {
    problems.push(`未跟踪的遗留文件：${state.untracked.length} 个`)
  }
  return problems
}

/** 每个分类最多列这么多行：闸门失败时要看清是什么，不是要把整棵树打印出来。 */
const MAX_LISTED = 30

export function listSection(title, items) {
  if (items.length === 0) return ''
  const shown = items.slice(0, MAX_LISTED)
  const rest = items.length - shown.length
  return [
    `${title}（${items.length}）`,
    ...shown.map((item) => `  - ${item}`),
    ...(rest > 0 ? [`  … 还有 ${rest} 个`] : []),
  ].join('\n')
}

/**
 * 远端 URL → { host, projectPath, webBase, apiBase }；认 git@host:path、ssh://、http(s):// 三种。
 *
 * `webBase` 带项目路径（页面链接用），`apiBase` 只到 host——GitLab 的 REST 是
 * `https://host/api/v4/projects/<urlencoded path>/…`，把项目路径拼进 base 会拼出 404。
 */
export function parseRemote(url) {
  const raw = url.trim()
  let host = ''
  let projectPath = ''
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const parsed = new URL(raw)
    host = parsed.host
    projectPath = parsed.pathname.replace(/^\/+/, '')
  } else {
    const scp = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+)$/.exec(raw)
    if (scp === null) return null
    host = scp[1]
    projectPath = scp[2]
  }
  projectPath = projectPath.replace(/\.git$/, '').replace(/\/+$/, '')
  if (host === '' || projectPath === '') return null
  const scheme = raw.startsWith('http://') ? 'http' : 'https'
  return {
    host,
    projectPath,
    webBase: `${scheme}://${host}/${projectPath}`,
    apiBase: `${scheme}://${host}`,
  }
}

/** push 输出里找 MR 链接（GitLab 打印在 `remote:` 行，也可能直接给一行）。 */
export function findMergeRequestUrl(text) {
  const current = /https?:\/\/\S+\/-\/merge_requests\/\d+/.exec(text)
  if (current !== null) return current[0]
  const legacy = /https?:\/\/\S+\/merge_requests\/\d+/.exec(text)
  return legacy === null ? null : legacy[0]
}
