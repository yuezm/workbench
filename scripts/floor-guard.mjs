#!/usr/bin/env node
// floor-guard.mjs — diff 范围内守护 CONSTRAINTS.md 的 Floor。
// 用法: node scripts/floor-guard.mjs [--base <ref>]   (默认 base: origin/HEAD → 常见分支探测)
// 退出码: 0 干净 / 1 至少一处 floor 违规（应阻断）/ 2 无法运行（无 merge base、非 git 仓库）
// 来源: 基于 constraint-driven-development 的 references/floor-guard.md 参考实现裁剪，
//       仅保留本仓库需要的模式；contract 保持不变（exit 0/1/2、只报规则与位置、不报密文值）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { BASE_MISSING_HINT, resolveBase } from './base-ref.mjs'

const base = resolveBase()
const argBase = base?.ref ?? ''

const git = (args) => {
  try {
    // maxBuffer 放宽到 64 MB：内核拆分这类大改动会让默认 1 MB 溢出（ENOBUFS 被吞成 diff 失败）
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}
const bail = (msg) => {
  console.error('floor-guard: ' + msg)
  process.exit(2)
}

const top = git(['rev-parse', '--show-toplevel'])?.trim()
if (!top) bail('not inside a git work tree')
process.chdir(top)

if (!argBase) bail(BASE_MISSING_HINT)
const mergeBase = git(['merge-base', argBase, 'HEAD'])?.trim()
if (!mergeBase) bail('no merge base against ' + argBase + '（' + BASE_MISSING_HINT + '）')

const tracked = git(['diff', '--unified=0', mergeBase, '--'])
if (tracked === null) bail('could not diff against ' + mergeBase)

// 解析 git diff：--- / +++ 仅在 diff 行到首个 @@ 之间的头部区识别，hunk 内一律当内容。
const added = []
const removed = []
const deleted = []
const addedPaths = new Set()
const pathOf = (s) => s.replace(/^[ab]\//, '')
let file = ''
let oldFile = ''
let inHeader = false
for (const line of tracked.split('\n')) {
  if (line.startsWith('diff ')) inHeader = true
  else if (line.startsWith('@@')) inHeader = false
  else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4))
    else if (line.startsWith('+++ ')) {
      const newFile = pathOf(line.slice(4))
      file = newFile === '/dev/null' ? oldFile : newFile
      if (newFile === '/dev/null') deleted.push(file)
      else addedPaths.add(newFile)
    }
  } else if (line.startsWith('+')) added.push({ file, text: line.slice(1) })
  else if (line.startsWith('-')) removed.push({ file, text: line.slice(1) })
}

// 未跟踪文件：git diff 看不到，整文件视为新增行（直接读文件，避免 /dev/null 在 Windows 上的兼容问题）。
const untracked = git(['ls-files', '--others', '--exclude-standard'])
if (untracked === null) bail('could not list untracked files')
for (const f of untracked.split('\n').filter(Boolean)) {
  let content = ''
  try {
    content = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const normalized = f.replace(/\\/g, '/')
  // 未跟踪的新文件同样是「新增路径」（迁移判定要用到）
  addedPaths.add(normalized)
  for (const text of content.split('\n')) added.push({ file: normalized, text })
}

const findings = []
const flag = (rule, f, text) => findings.push({ rule, file: f, text: text.trim().slice(0, 120) })
const isTest = (f) => /\.(test|spec)\.|_test\.|test_/.test(f)
// 规则页与详情页（2026-11-18 拆分）：CONSTRAINTS.md 只放「有命令、可判定」的规则；
// 复核记录 / 例外理由 / 实测值演进在详情页。两处正文都会合法引用 `@ts-ignore` 这类字样，
// 一律不做代码类扫描（它们不是源码）。
const HISTORY_FILE = 'docs/testing/CONSTRAINTS-HISTORY.md'
const isConstraints = (f) => /CONSTRAINTS(-HISTORY)?\.md$/.test(f)
// 例外行（Exceptions 表的索引行）：本仓用 `| EX-001 | …`，也认 `| E12 |` / `| W3 |`。
// 2026-11-26 修：原写法 `/^\| *(W|E)\d+ *\|/` 只认「E 紧跟数字」，认不出实际在用的 `EX-001`，
// 于是两个方向同时失效——删例外行被判 rule-removed（正当下线也被拦），
// 新增例外行也不会触发 new-exception（「放松必须显式登记」的守卫形同虚设）。
const isExceptionRow = (t) => /^\| *(?:W|E)X?-?\d+ *\|/.test(t.trim())

// 1. 关闭检查器的注释（本仓库生态：TS/ESLint/istanbul）。后续可扩展。
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/
// 4. 未完成的工作。
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/
// 2. 被放松的测试。
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/

for (const { file, text } of added) {
  // 守卫脚本自身、以及 CONSTRAINTS.md / CONSTRAINTS-HISTORY.md 正文（会合法地引用 @ts-ignore 等字样）不算违规。
  if (file.startsWith('scripts/')) continue
  if (isConstraints(file)) {
    if (isExceptionRow(text)) flag('new-exception', file, text)
    continue
  }
  if (SUPPRESSIONS.test(text)) flag('silenced-checker', file, text)
  if (STUBS.test(text)) flag('unfinished-work', file, text)
  if (SKIPS.test(text)) flag('test-made-easier', file, text)
}

// 2b. 测试文件被删，或仍在的测试文件里断言净减少。
// 契约迁移（v1 → v2 重写测试）会删掉旧断言、同时补上新断言；只有「同文件断言净减少」
// 才是真正的放松。被测源码也一起删除时，删除其测试不算放松（死代码清理）。
const deletedSet = new Set(deleted)
const sourceOf = (f) =>
  f.replace(/\.(test|spec)\.(ts|tsx)$/, '.$2').replace(/_test\.(go|py)$/, '.$1')
// 测试与源码同构镜像：源码在 src/<layer>/、测试在 tests/<layer>/ 时，删测试的「被测源码」
// 不在同目录。两处都查，才能识别「源码与其测试一起删除」= 死代码清理，而不是放松门槛。
const sourceCandidates = (f) => {
  const candidates = [sourceOf(f)]
  if (f.startsWith('tests/')) {
    candidates.push('src/' + f.slice('tests/'.length).replace(/\.(test|spec)\.(ts|tsx)$/, '.$2'))
  }
  return candidates
}
// 拆包后源码在 `packages/<域>/<包>/src`（拆分方案 B1–B6），`tests/<layer>` 与源码目录不再同名前缀。
// 这一层用「文件名」兜底：删掉的源码与被删的测试同名 = 源码与其测试一起删除（死代码清理）。
const stemOf = (p) =>
  (p.split('/').pop() ?? '').replace(/\.(test|spec)\.(ts|tsx)$/, '').replace(/\.(ts|tsx)$/, '')
const deletedSourceStems = new Set(
  deleted.filter((f) => !isTest(f) && /\.(ts|tsx)$/.test(f)).map(stemOf),
)
// 功能删除（2026-11-17）：整个子功能（实现 + 它的页面 / e2e 用例）一起删除时，随删除消失的
// 测试与断言不是放松——它们只在测已经不存在的入口。登记项必须列出**本次 diff 里被改动或
// 删除的源码**：任何一项没被动过，豁免就不成立（源码原样留着就不能拿它当理由）。
// 只登记「整块功能下线」，新增/改写功能时该补的断言照旧要补。
const FEATURE_REMOVALS = {
  'tests/e2e/pomodoro.spec.ts': {
    sources: [
      'packages/client/app-pomodoro/src/index.tsx',
      'packages/client/shell/src/registry.ts',
    ],
    reason: '番茄时钟 app 整体删除（包、registry 行、规格）',
  },
  'tests/e2e/chat-execution.spec.ts': {
    sources: [
      'packages/client/app-ai-workflow/src/components/ChatPanel.tsx',
      'packages/client/app-ai-workflow/src/hooks/useChat.ts',
    ],
    reason: '聊天功能整体删除（面板、状态机、会话清单），工作台只跑自动化',
  },
  'tests/e2e/ai-workflow.spec.ts': {
    sources: ['packages/client/app-ai-workflow/src/AiWorkflowPage.tsx'],
    reason: '侧栏栏目切换（任务 / 聊天）随聊天一起删除，只留项目 + 工作流',
  },
  'tests/e2e/project-dimension.spec.ts': {
    sources: ['packages/client/app-ai-workflow/src/AiWorkflowPage.tsx'],
    reason: '项目维度用例里的会话清单断言随聊天删除，只验看板切换',
  },
  'tests/e2e/rules.spec.ts': {
    sources: ['packages/contract/app-events/src/index.ts'],
    reason: 'app 插件事件白名单清空（番茄移除后无 app 发事件），规则改由 webhook 来源覆盖',
  },
  'tests/e2e/smoke.spec.ts': {
    sources: ['packages/client/shell/src/registry.ts'],
    reason: '顶部栏只剩一个 app，切番茄与栏目断言随功能删除',
  },
  'tests/renderer/src/apps/ai-workflow/AiWorkflowPage.test.tsx': {
    sources: [
      'packages/client/app-ai-workflow/src/AiWorkflowPage.tsx',
      'packages/client/app-ai-workflow/src/components/ChatPanel.tsx',
      'packages/client/app-ai-workflow/src/components/WorkspaceNav.tsx',
      'packages/client/app-ai-workflow/src/hooks/useChat.ts',
    ],
    reason: '聊天栏目整体移除（会话清单 / 消息流 / 栏目切换），页面用例只留任务栏',
  },
  'tests/renderer/src/apps/ai-workflow/components/ApprovalBar.test.tsx': {
    sources: ['packages/client/app-ai-workflow/src/components/ApprovalBar.tsx'],
    reason: '卡片落点只剩任务一种，会话落点的标签与跳转断言随落点一起删除',
  },
  'tests/e2e/ui-geometry.spec.ts': {
    sources: ['packages/client/app-pomodoro/src/components/TimerDisplay.tsx'],
    reason: '几何审计里的番茄钟一屏随 app 删除（大号倒计时的字号豁免一并取消）',
  },
  'tests/host/commands.test.ts': {
    sources: ['packages/contract/app-events/src/index.ts'],
    reason: 'app 插件事件白名单清空（番茄移除后无 app 发事件），只留拒绝路径',
  },
  'tests/plugins/channels/feishu.test.ts': {
    sources: [
      'packages/plugins/channel-feishu/src/index.ts',
      'packages/plugins/channel-feishu/src/inbound.ts',
    ],
    reason: '飞书关掉入站与进展回帖（只推需要拍板的卡），入站解析 / 派活 / 回执用例随入口删除',
  },
  'tests/renderer/src/apps/ai-workflow/components/FeishuConnections.test.tsx': {
    sources: [
      'packages/client/app-ai-workflow/src/components/FeishuConnections.tsx',
      'packages/client/app-ai-workflow/src/components/FeishuConnectionDialog.tsx',
    ],
    reason: '连接不再绑「派给哪个智能体」（飞书不做聊天），相关交互断言随字段删除',
  },
  'tests/renderer/src/apps/ai-workflow/components/KanbanBoard.test.tsx': {
    sources: [
      'packages/client/app-ai-workflow/src/components/KanbanBoard.tsx',
      'packages/client/app-ai-workflow/src/AiWorkflowPage.tsx',
    ],
    reason:
      '列内快速新建整体下线（M41：新建入口收敛到弹窗），就地建卡的整组用例随入口删除；等价断言迁到 AiWorkflowPage / TaskDialog 的弹窗路径用例与 thread.spec 的 e2e',
  },
}
/** 本次 diff 里被新增 / 修改 / 删除的源码路径（功能删除豁免的成立条件） */
const touchedSources = new Set([...addedPaths, ...deleted])
for (const { file: changed } of [...added, ...removed]) touchedSources.add(changed)
// diff 基线是 merge-base：拆包后新建的文件在基线里还不存在，它们的删除在 diff 里不可见
// （净效果是「原本也没有」），必须再从工作区状态确认一次，否则功能删除豁免永远命不中。
// 同一批次里「先新增、后删除」的路径净 diff 里同样看不到（包拆分新增 app-pomodoro、下一个
// 提交又整包删掉）：豁免条件是「源码在本次交付里被动过」，按提交序列取路径并集才算数。
const rangeLog = git([
  'log',
  '--name-only',
  '--no-renames',
  '--pretty=format:',
  `${mergeBase}..HEAD`,
])
if (rangeLog === null) bail('could not list changed paths in range')
for (const p of rangeLog.split('\n')) {
  const path = p.trim().replace(/^"|"$/g, '')
  if (path !== '') touchedSources.add(path.replace(/\\/g, '/'))
}
const worktreeStatus = git(['status', '--porcelain'])
if (worktreeStatus === null) bail('could not read working tree status')
for (const line of worktreeStatus.split('\n')) {
  const raw = line.slice(3).trim().replace(/^"|"$/g, '')
  if (raw === '') continue
  for (const p of raw.split(' -> ')) touchedSources.add(p.trim().replace(/^"|"$/g, ''))
}
/** 命中的功能删除登记（源码必须全部被动过） */
const featureRemoval = (file) => {
  const entry = FEATURE_REMOVALS[file]
  if (entry === undefined) return null
  return entry.sources.every((source) => touchedSources.has(source)) ? entry : null
}

// 测试搬家（src/**.test.ts → tests/**.test.ts）：旧路径删除 + 新路径新增 = 迁移，不是删测试。
// git 有时识别不出 rename（相似度阈值），此时会退化成 delete + add，用路径对应关系兜底。
// 显式登记的「按层搬家」（T16 计划表）：旧测试的行为在新位置重写，断言同等覆盖。
const RELOCATED_TESTS = {
  // T14b：repository 聊天 SQL 用例 → 宿主聊天执行链用例（IPC/scheduler/投影）
  'tests/main/ai-workflow/repository.chat.test.ts': 'tests/host/chat.test.ts',
  // T16：main 层用例按层搬家（读路径收口后 host 已有等价覆盖）
  'tests/main/ai-workflow/ipc.test.ts': 'tests/host/ipc.test.ts',
  // repository 补充用例（runs / 负载 / 聊天投影）→ 投影视图与 IPC 用例
  'tests/main/ai-workflow/repository.extra.test.ts': 'tests/host/ipc.test.ts',
  // M5：旧 ai-workflow RPC 表用例 → 三动词命令路由 / 幂等 / 宿主视图用例
  'tests/host/ipc.test.ts': 'tests/host/commands.test.ts',
  // 服务器部署重写（Electron → 常驻服务）：装配根与 IPC 用例搬成服务端装配 / HTTP 生命周期用例
  'tests/main/index.test.ts': 'tests/server/assembly.test.ts',
  'tests/host/boot.test.ts': 'tests/server/assembly.test.ts',
  'tests/e2e-packaged/packaged-sqlite.spec.ts': 'tests/server/assembly.test.ts',
  // 服务器重写：装配根搬到 src/server 后，工作目录与提权记录用例随源码同层搬家
  'tests/main/workdir.test.ts': 'tests/server/workdir.test.ts',
  'tests/main/workdir-mkdir-error.test.ts': 'tests/server/workdir-mkdir-error.test.ts',
  'tests/main/run-approvals.test.ts': 'tests/server/run-approvals.test.ts',
  'tests/main/run-approvals-read-error.test.ts': 'tests/server/run-approvals-read-error.test.ts',
  // M3：执行器插件化后按层搬家（T5 登记，新位置行为等价覆盖）
  'tests/main/ai-workflow/runtime/dsh.test.ts': 'tests/plugins/executors/dsh/dsh.test.ts',
  'tests/main/ai-workflow/runtime/detect.test.ts': 'tests/plugins/executors/dsh/detect.test.ts',
  'tests/main/ai-workflow/runtime/registry.test.ts': 'tests/plugins/registry.test.ts',
  'tests/main/ai-workflow/runtime/executor-port.test.ts':
    'tests/plugins/executors/dsh/port.test.ts',
  'tests/main/ai-workflow/runtime/process.test.ts': 'tests/host/process.test.ts',
  'tests/main/ai-workflow/runtime/executable.test.ts': 'tests/host/executable.test.ts',
  // M37：内核拆两层，cron 测试随 cron.ts 搬到 core/（import 路径变化使相似度低于 rename 阈值，
  // git 退化成 delete + add；新位置断言语义等价）
  'tests/kernel/cron.test.ts': 'tests/kernel/core/cron.test.ts',
  // M36：提示词按 scope 拆到 scopes/，测试同层跟着搬；拆分改写了大量断言，相似度低于 rename
  // 阈值，git 退化成 delete + add（2026-11-21 改闸门文案时这条退化才被触发出来）
  'tests/kernel/prompt.test.ts': 'tests/kernel/scopes/prompt.test.ts',
  // 同上：thread-context 随 M14 待修复清单段改写（2026-11-21）后相似度同样跌破阈值
  'tests/kernel/thread-context.test.ts': 'tests/kernel/scopes/thread-context.test.ts',
}
const migratedCounterpart = (f) => {
  const relocated = RELOCATED_TESTS[f]
  if (relocated !== undefined && addedPaths.has(relocated)) return relocated
  const strip = (p) => p.replace(/^(src|tests)\//, '')
  for (const g of addedPaths) {
    if (strip(g) === strip(f)) return g
  }
  return null
}
// 断言搬家（M27）：被测组件本身瘦身（运行时表单只留连接、执行配置移到智能体表单），
// 迁走的断言由另一个测试文件承接。这里登记「谁承接」，只有承接方的断言净增覆盖得住
// 迁出方的净减才算迁移；承接方没涨，照样按「断言净减少」阻断。
const ASSERTION_MIGRATIONS = {
  // 运行时表单精简：模型 / 思考强度 / 并发 / 权限 / 工作目录 的用例搬到智能体表单
  'tests/renderer/src/apps/ai-workflow/components/RuntimeDialog.test.tsx':
    'tests/renderer/src/apps/ai-workflow/components/AgentDialog.test.tsx',
}
for (const f of deleted) {
  if (!isTest(f)) continue
  if (sourceCandidates(f).some((source) => deletedSet.has(source))) continue
  if (deletedSourceStems.has(stemOf(f))) continue
  if (migratedCounterpart(f)) continue
  if (featureRemoval(f) !== null) continue
  flag('test-deleted', f, 'file deleted')
}
const assertionRe = /\b(expect|assert|should)\b/
const countBy = (list) => {
  const counts = new Map()
  for (const { file, text } of list) {
    if (!isTest(file) || !assertionRe.test(text)) continue
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return counts
}
const removedAssertions = countBy(removed)
const addedAssertions = countBy(added)
for (const [file, removedCount] of removedAssertions) {
  if (deletedSet.has(file)) continue
  const addedCount = addedAssertions.get(file) ?? 0
  if (removedCount <= addedCount) continue
  const counterpart = ASSERTION_MIGRATIONS[file]
  const movedIn = counterpart
    ? Math.max(
        0,
        (addedAssertions.get(counterpart) ?? 0) - (removedAssertions.get(counterpart) ?? 0),
      )
    : 0
  if (counterpart !== undefined && removedCount <= addedCount + movedIn) continue
  if (featureRemoval(file) !== null) continue
  flag('assertion-removed', file, `assertions ${removedCount} -> ${addedCount}`)
}

// 1b/2c. CONSTRAINTS.md 的规则被放松或删除（与参考实现一致的阈值方向判定）。
const ruleKey = (t) => {
  const s = t.trim()
  if (s.startsWith('|'))
    return (
      s
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)[0] ?? ''
    )
  if (/^[-*] /.test(s)) return s.slice(2).split(':')[0].trim()
  return null
}
const isException = isExceptionRow
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/
const MAX_BEFORE =
  /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/
const thresholds = (t) => {
  const out = []
  const re = /\d+(?:\.\d+)?/g
  let m
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase()
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase()
    const dir =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? 'min'
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? 'max'
          : null
    out.push({ n: Number(m[0]), dir })
  }
  return out
}
// 已登记的规则改写：旧规则在新架构下不再成立（不是放松），由右侧新规则等价替代。
// 服务器部署重写（Electron → 常驻服务）：桌面专属的边界与验收项换成服务端对应项；
// 包拆分后（2026-11-19）：`src/<层>` 改写成 `packages/<域>/<包>` 与 `apps/<壳>`，
// 门禁强度与断言集不变，只是路径对齐磁盘现状。同样只有「新规则真的出现在新增行里」才算迁移。
const REWRITTEN_RULES = {
  '`src/renderer/**` 禁止 import `electron` 与 Node 内置（`fs` / `path` / `os` / `child_process` / `crypto` / `node':
    '`packages/client/**` 禁止 import Node 内置（`node',
  '`src/renderer/**` 禁止 import Node 内置（`node':
    '`packages/client/**` 禁止 import Node 内置（`node',
  '`src/main/**` 禁止 import `renderer`（依赖方向单向：renderer → main）。':
    '`apps/server/**`（+ `packages/api/http/**`）禁止 import `renderer`，也不得直接 import 具体插件实现（只经 `plugins/registry`；依赖方向 server → host + 注册表单向）。',
  '`src/server/**` 禁止 import `renderer`，也不得直接 import 具体插件实现（只经 `plugins/registry`；依赖方向 server → host + 注册表单向）。':
    '`apps/server/**`（+ `packages/api/http/**`）禁止 import `renderer`，也不得直接 import 具体插件实现（只经 `plugins/registry`；依赖方向 server → host + 注册表单向）。',
  '测试同层同规：`tests/renderer/**` 禁 Electron/Node 内置，`tests/main/**` 禁 import `renderer`（ESLint 按同一规则集执行，门禁强度不因测试目录搬家而下降）。':
    '测试同层同规：`tests/renderer/**` 禁 Node 内置与服务端 import，`tests/server/**` 禁 import `renderer`（ESLint 按同一规则集执行，门禁强度不因测试目录搬家而下降）。',
  // 例外索引下线（2026-11-26）：覆盖率改为绝对阈值后，「覆盖率基线」类例外全部失效、索引行下线，
  // 这句「路径列当时怎么命名」的说明随之作废。原行还带一个损坏字符（`\u0007` 顶替了 `apps` 的 `a`，
  // 显示成 `pps/**`），改写顺带修掉；替代句说的是同一件事（历史命名 + 现状），不是放松。
  '路径列的 src/** 是登记当时的命名（当时代码在 src/ 下）；现在对应 packages/** 与 \u0007pps/**，EX-018 起登记的直接写 packages/**。':
    '例外索引行已下线（2026-11-26）：EX-001…EX-020 只在 CONSTRAINTS-HISTORY 的明细里出现；路径列当时写 src/**，2026-11-19 包拆分后对应 packages/** 与 apps/**。',
  打包验收: '服务冒烟',
}
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null)
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null)
// 规则行迁到详情页（2026-11-18）：正文只留可判定的规则，复核记录 / 例外明细 / 实测值搬进
// CONSTRAINTS-HISTORY.md。迁移成立的条件是「同一行文本在详情页逐字出现」——迁走即消失
// （详情页里也没有）照样判 rule-removed；拿详情页当垃圾桶、把规则行塞进去来绕过 diff，
// 会在详情页里留下一条原样的规则文本，review 时一眼可见。
//
// 比较前把连续空白归一成单空格：两边都是 Markdown 表格行，列宽对齐（Prettier）会插入
// 若干空格，原样比对会把「同一行」判成两行（实测 10 条 EX 行全被误报成 threshold-removed）。
// 只忽略空白差异，规则文本本身仍要逐字出现。
const normalizeRow = (text) => text.trim().replace(/\s+/g, ' ')
const relocatedToHistory = new Set(
  added.filter((l) => l.file === HISTORY_FILE).map((l) => normalizeRow(l.text)),
)
for (const r of removedRules) {
  if (relocatedToHistory.has(normalizeRow(r.text))) continue
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text))
  if (!a) {
    const replacement = REWRITTEN_RULES[ruleKey(r.text)]
    if (replacement !== undefined && addedRules.some((x) => ruleKey(x.text) === replacement)) {
      continue
    }
    if (!isException(r.text)) flag('rule-removed', r.file, r.text)
    continue
  }
  const before = thresholds(r.text)
  const after = thresholds(a.text)
  let verdict = null
  for (const dir of ['min', 'max', null]) {
    const was = before.filter((x) => x.dir === dir)
    const now = after.filter((x) => x.dir === dir)
    was.forEach((b, i) => {
      const n = now[i]
      if (verdict) return
      if (!n) verdict = 'threshold-removed'
      else if (n.n === b.n) return
      else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : n.n < b.n) {
        // 无方向标注的指标（如覆盖率四元组）按「不得下降」判定：提高不算放松
        verdict = dir ? 'threshold-loosened' : 'threshold-changed'
      }
    })
  }
  if (verdict) flag(verdict, r.file, r.text + '  ->  ' + a.text)
}

if (findings.length === 0) {
  console.log('floor-guard: clean')
  process.exit(0)
}
console.error('floor-guard: ' + findings.length + ' floor violation(s):')
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`)
console.error('\n每条都是「降低门槛」的动作。修代码，或走已登记的例外。')
process.exit(1)
