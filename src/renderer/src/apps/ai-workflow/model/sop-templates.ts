/**
 * 开箱 SOP 模板（`model/sop-templates.ts`）：把「产品 / 研发 / 测试 / 发版」的通行做法
 * 落成可直接用的阶段序列。
 *
 * 只做**纯数据 + 纯函数**（不依赖 React、不做 IO）：模板给出阶段名、进入方式、
 * 「要干什么」与流向；`draftFromTemplate` 把它翻成 `WorkflowInput`（下标式流转目标），
 * 交给 `WorkflowEditor` 让用户确认后再保存。模板**不替用户绑定智能体**——那属于本机配置，
 * 所以 `agentRole` 只作建议文案，进不了任务提示词。
 *
 * 方法论依据（2026-11 调研，逐条可查）：
 * - 产品发现：Amazon Working Backwards PR/FAQ（workingbackwards.com/pr-faq-mastery）、
 *   SVPG 双轨制 Discovery/Delivery、Product Talk 机会树、Intercom RICE 排序。
 * - 研发交付：Trunk Based Development、GitHub Flow、Conventional Commits 1.0.0 + SemVer 2.0.0、
 *   Google eng-practices 代码评审、ADR、Fowler 的 Feature Toggles。
 * - 测试质量：ISO/IEC/IEEE 29119-2 测试过程、ISTQB、Fowler 测试金字塔 / Testing Trophy、
 *   Google test sizes、Bach 的 SBTM 探索式测试、缺陷 triage。
 * - 发版运维：DORA 2024 报告四指标、Fowler CanaryRelease、SRE Workbook 的 error budget 政策、
 *   Keep a Changelog 1.1.0。
 * - 事故复盘：Google SRE Book《Postmortem Culture》的无责复盘。
 * - 迭代回顾：Start/Stop/Continue + Kanban WIP 限制与 flow 指标（Atlassian）。
 */
import type { EntryMode, StageInput, WorkflowInput } from '../../../../../protocol/entities'
import { withBuiltinStages } from './stage-draft'

/** 一个阶段模板：`onComplete` / `onReject` 写**阶段名**（找不到的名字按默认语义处理） */
export interface SopStage {
  name: string
  entryMode: EntryMode
  /** 该阶段具体要干什么：会拼进进入本阶段的任务提示词 */
  instructions: string
  /** 完成后进入；缺省 = 下一阶段（末阶段 = 任务完成） */
  onComplete?: string | null
  /** 打回时退回到；缺省 = 不指定（原地不动、不自动重试） */
  onReject?: string | null
  /** 这个阶段适合交给什么样的智能体（建 agent 时的参考文案） */
  agentRole: string
}

export interface SopTemplate {
  id: string
  name: string
  /** 适用场景，一句话 */
  description: string
  /** 方法论出处与这样排的理由 */
  basis: string
  stages: readonly SopStage[]
}

/** 阶段名 → 下标（找不到 / 空 → null = 走默认语义） */
function targetIndex(stages: readonly SopStage[], name: string | null | undefined): number | null {
  if (!name) return null
  const index = stages.findIndex((stage) => stage.name === name)
  return index >= 0 ? index : null
}

/**
 * 模板 → 工作流草稿。
 *
 * 流转目标在模板里是**阶段名**（人写起来稳定），落成 `StageInput` 时换成下标；
 * 名字对不上按默认处理（`null`），不会产出越界下标。
 *
 * M18：模板只描述「自己添加的阶段」，草稿再由 `withBuiltinStages` 补出四个内置阶段并排成
 * 「待办 → 模板阶段 → 已阻塞 → 已完成 → 已取消」，模板里的下标随之整体重映射。
 */
export function draftFromTemplate(template: SopTemplate): WorkflowInput {
  const stages = template.stages.map((stage): StageInput => ({
    name: stage.name,
    entryMode: stage.entryMode,
    onCompleteIndex: targetIndex(template.stages, stage.onComplete),
    onRejectIndex: targetIndex(template.stages, stage.onReject),
    handoffWorkflowId: null,
    handoffStageId: null,
    subtaskStageId: null,
    onChildrenSettled: null,
    spawnPolicy: null,
    instructions: stage.instructions,
  }))
  return {
    name: template.name,
    description: template.description,
    stages: withBuiltinStages(stages),
  }
}

/** 开箱模板清单：顺序即设置页展示顺序。 */
export const SOP_TEMPLATES: readonly SopTemplate[] = [
  {
    id: 'product-discovery',
    name: '产品发现',
    description: '从模糊想法到立项：先验证需求再投入，适合新产品或新功能探索。',
    basis: 'Amazon PR/FAQ + 双轨制 Discovery + 机会树 + RICE：先证伪问题，避免为伪需求写代码。',
    stages: [
      {
        name: '机会识别',
        entryMode: 'agent',
        instructions:
          '· 汇总信号源：用户反馈、工单、埋点、竞品动态，各摘 3 条证据\n· 画机会树：目标结果 → 机会 → 方案假设，标出证据强度\n· 写问题陈述：谁、什么场景、什么痛点，附证据出处',
        agentRole: '产品分析型：擅长从反馈与数据里提炼机会',
      },
      {
        name: '用户验证',
        entryMode: 'none',
        instructions:
          '· 设计 5–8 个开放式访谈问题，避免引导性提问\n· 完成 N 次真实用户访谈并逐字记录\n· 每条假设标注「成立 / 证伪」，附用户原话',
        agentRole: '用户研究型：能拟访谈脚本并归纳结论',
      },
      {
        name: '方案设计',
        entryMode: 'agent',
        instructions:
          '· 针对 Top 机会给 2–3 个候选方案并写取舍\n· 写 1 页 PR/FAQ：客户视角新闻稿 + 内部/外部 FAQ\n· 写清目标客户、核心收益、上线判定标准\n· 列出尚未回答的开放问题',
        agentRole: '产品设计型：能把方案写成 PR/FAQ 并说清取舍',
      },
      {
        name: '价值排序',
        entryMode: 'agent',
        instructions:
          '· 用 RICE（触达/影响/信心/投入）给候选方案打分，出分值表\n· 标注依赖、前置条件与「不做会怎样」\n· 给出建议优先级 Top3 及理由',
        agentRole: '产品运营型：能用 RICE/ICE 做量化排序',
      },
      {
        name: '立项评审',
        entryMode: 'user',
        instructions:
          '· 核对 PR/FAQ 与 RICE 结论：目标、范围、成功指标是否清楚\n· 拍板 Go / No-Go / 打回补充；No-Go 要写明缺口\n· 记录决策与理由，回写到任务描述',
        onReject: '方案设计',
        agentRole: '人工拍板（不需要智能体）',
      },
      {
        name: '交接排期',
        entryMode: 'agent',
        instructions:
          '· 输出交付包：PR/FAQ 终稿、RICE 表、验收指标、依赖清单\n· 拆出首个可交付里程碑与工作量预估\n· 生成待进入「研发交付」的需求条目',
        agentRole: '产品助理型：负责整理交付物并生成研发需求',
      },
    ],
  },
  {
    id: 'dev-delivery',
    name: '研发交付',
    description: '把已立项需求交付成可上线代码：小步提交 + 评审 + 开关，适合功能开发。',
    basis:
      'Trunk-based Development + GitHub Flow + Conventional Commits/SemVer + ADR + 功能开关：小 PR 上主干，降低合并风险。',
    stages: [
      {
        name: '需求澄清',
        entryMode: 'agent',
        instructions:
          '· 把需求拆成可独立验收的用户故事\n· 每条写 Given/When/Then 验收标准\n· 列出边界条件、异常路径与非功能约束（性能、安全）\n· 输出待确认的澄清问题清单',
        agentRole: '业务分析型：擅长把需求转成可验收的用户故事',
      },
      {
        name: '技术方案',
        entryMode: 'agent',
        instructions:
          '· 写 ADR：背景、决策、备选方案、后果\n· 标注影响面（模块 / 接口 / 数据 / 兼容性）\n· 给出回滚与降级方案\n· 更新关键时序图或架构图',
        agentRole: '架构型：负责输出 ADR 与影响面评估',
      },
      {
        name: '任务拆解',
        entryMode: 'agent',
        instructions:
          '· 拆成 ≤1 天粒度的任务，标注依赖与顺序\n· 每个任务写完成定义（DoD）\n· 标出可并行项与关键路径\n· 输出任务清单表',
        agentRole: '技术管理型：能把方案拆成可排期任务',
      },
      {
        name: '编码实现',
        entryMode: 'agent',
        instructions:
          '· 在主干上拉短分支，小步提交，单个 PR ≤400 行\n· 提交信息按 Conventional Commits 写\n· 未完成功能用 feature flag 包住并默认关闭\n· 补单测/集成测试并本地跑通 lint、typecheck',
        onReject: '技术方案',
        agentRole: '编码型：能改代码、补测试并跑本地门禁',
      },
      {
        name: '代码评审',
        entryMode: 'user',
        instructions:
          '· 按正确性 / 可读性 / 测试 / 安全 / 性能逐项看，不纠结风格偏好\n· 每条评论标注是否 blocking\n· 通过则批准；否则打回编码实现并写明必须改的点',
        onReject: '编码实现',
        agentRole: '人工评审（可由评审智能体辅助，结论由人下）',
      },
      {
        name: '合并归档',
        entryMode: 'agent',
        instructions:
          '· squash merge 到主干并删分支\n· 按 SemVer 判定版本号并更新 Changelog\n· 把 ADR 归档到 docs/adr\n· 输出本次交付摘要与遗留项',
        agentRole: '发布工程型：负责合并、打版本与归档',
      },
    ],
  },
  {
    id: 'testing-qa',
    name: '测试质量',
    description: '系统化验证待上线版本：分层测试 + 缺陷闭环 + 出口准则，适合迭代测试。',
    basis:
      'ISO/IEC/IEEE 29119 测试过程 + 测试金字塔/Testing Trophy + Google test sizes + SBTM + 缺陷 triage：分层覆盖成本最低。',
    stages: [
      {
        name: '测试计划',
        entryMode: 'agent',
        instructions:
          '· 定义测试范围、风险、环境与资源\n· 写出口准则（通过阈值）与暂停 / 恢复条件\n· 输出测试计划与风险矩阵',
        agentRole: '测试负责型：能写测试计划与风险矩阵',
      },
      {
        name: '用例设计',
        entryMode: 'agent',
        instructions:
          '· 按测试金字塔分配单元 / 接口 / E2E 比例\n· 用等价类、边界值、状态迁移设计用例\n· 每条含前置、步骤、预期、优先级\n· 输出用例表并关联需求条目',
        agentRole: '测试设计型：擅长等价类 / 边界值等方法',
      },
      {
        name: '自动化测试',
        entryMode: 'agent',
        instructions:
          '· 编写并运行单元 + 集成测试，按 test size 标注规模\n· 覆盖率达标（如行覆盖 ≥70%）\n· 输出测试报告与失败明细\n· 记录不稳定（flaky）用例并单独列出',
        onReject: '用例设计',
        agentRole: '自动化测试型：能写测试、跑 CI、出报告',
      },
      {
        name: '探索测试',
        entryMode: 'none',
        instructions:
          '· 按 SBTM 写 charter：目标、时长 60–90 分钟、范围\n· 执行探索会话，记录操作 / 发现 / 疑点\n· 输出 session sheet 与缺陷候选',
        agentRole: '人工测试（智能体可协助整理 session sheet）',
      },
      {
        name: '缺陷分级',
        entryMode: 'agent',
        instructions:
          '· 按严重度 S1–S4 与优先级 triage\n· 去重合并，关联用例与日志\n· 输出缺陷清单：状态 / 负责人 / 复现步骤\n· 标出阻断发布的缺陷',
        agentRole: '缺陷管理型：负责 triage 与缺陷清单维护',
      },
      {
        name: '回归验证',
        entryMode: 'agent',
        instructions:
          '· 依据影响面圈定回归范围 + 全量冒烟\n· 跑自动化回归并比对基线\n· 输出回归结果：通过率、新增失败、遗留风险',
        onReject: '缺陷分级',
        agentRole: '回归测试型：能跑回归并比对基线',
      },
      {
        name: '验收确认',
        entryMode: 'user',
        instructions:
          '· 对照出口准则与验收标准逐条核对（预期 / 实测 / 结论）\n· 判定是否放行并签署\n· 不通过则打回回归验证',
        onReject: '回归验证',
        agentRole: '人工拍板（测试负责人或产品验收人）',
      },
    ],
  },
  {
    id: 'release-ops',
    name: '发版运维',
    description: '把通过测试的版本安全上线：go/no-go + 灰度 + 监控回滚，适合生产发布。',
    basis:
      'DORA 四指标 + 渐进式交付（canary / feature flag）+ 发布就绪评审 + SRE error budget：灰度让发布可控可退。',
    stages: [
      {
        name: '发布准备',
        entryMode: 'agent',
        instructions:
          '· 生成发布就绪清单：变更项、依赖、DB 迁移、配置\n· 写回滚方案与触发条件（错误率 / 延迟阈值）\n· 确认监控看板与告警就位\n· 更新 Changelog / Release Notes（Keep a Changelog 格式）',
        agentRole: '发布工程型：负责发布准备与回滚预案',
      },
      {
        name: '发布评审',
        entryMode: 'user',
        instructions:
          '· go/no-go 核对：DORA 指标、error budget 余量、风险清单\n· 确认回滚可用、值守到位\n· 拍板 Go / No-Go；No-Go 则打回发布准备并写明缺什么',
        onReject: '发布准备',
        agentRole: '人工拍板（发布负责人或 on-call lead 主持）',
      },
      {
        name: '灰度发布',
        entryMode: 'agent',
        instructions:
          '· 以 5% 流量 canary 放量，用 feature flag 控制开关\n· 观察错误率、延迟、SLO 与 error budget 消耗\n· 输出灰度对比数据与是否放行建议',
        onReject: '发布准备',
        agentRole: 'SRE 型：负责 canary 放量与指标观察',
      },
      {
        name: '发布确认',
        entryMode: 'user',
        instructions:
          '· 审阅灰度数据，判定指标是否达成\n· 拍板进入全量，或打回发布准备\n· 记录决策时间点与依据',
        onReject: '发布准备',
        agentRole: '人工拍板（发布负责人确认灰度结果）',
      },
      {
        name: '全量发布',
        entryMode: 'agent',
        instructions:
          '· 分批放量至 100%，每批之间留观察窗口\n· 逐步打开 feature flag，按 cohort 扩量\n· 记录每批时间、指标、异常',
        onReject: '发布准备',
        agentRole: 'SRE 型：负责分批放量与开关推进',
      },
      {
        name: '发布监控',
        entryMode: 'agent',
        instructions:
          '· 发布后 30–60 分钟盯 SLO、告警、error budget burn rate\n· 输出发布后健康报告（与发布前指标对比）\n· 异常则按 runbook 回滚，并在任务里记录触发点',
        agentRole: 'SRE 监控型：负责发布后观测与回滚执行',
      },
    ],
  },
  {
    id: 'incident-postmortem',
    name: '事故复盘',
    description: '生产事故后的无责复盘：从止损到根因到行动项闭环，适合 P0/P1 事故。',
    basis: 'Google SRE 无责复盘（Postmortem Culture）：止损优先、时间线事实化、行动项必须可跟踪。',
    stages: [
      {
        name: '事故响应',
        entryMode: 'none',
        instructions:
          '· 记录告警时间、影响面、严重级别（P0–P3）\n· 执行止损：回滚 / 降级 / 切流，记录每步时间\n· 建时间线草稿与沟通频道',
        agentRole: '值班工程师主导；智能体可协助拉取告警上下文',
      },
      {
        name: '恢复确认',
        entryMode: 'user',
        instructions:
          '· 确认服务恢复、核心指标回到 SLO 内\n· 核对数据一致性与残留影响\n· 拍板宣布事故结束',
        agentRole: '人工拍板（事故指挥确认恢复）',
      },
      {
        name: '时间线梳理',
        entryMode: 'agent',
        instructions:
          '· 从日志 / 告警 / 工单 / 聊天记录重建时间线，时间戳对齐\n· 标注每个关键动作与决策点\n· 事实与推测分开写，推测注明依据',
        agentRole: '日志分析型：能重建可核对的时间线',
      },
      {
        name: '根因分析',
        entryMode: 'agent',
        instructions:
          '· 用 5 Whys / 鱼骨图区分触发因素与系统性根因\n· 分析检测与响应为什么快或慢\n· 输出根因结论与证据链',
        onReject: '时间线梳理',
        agentRole: '可靠性分析型：擅长 RCA 与证据链整理',
      },
      {
        name: '复盘评审',
        entryMode: 'user',
        instructions:
          '· 组织无责复盘会，确认时间线、影响与根因\n· 只谈机制不谈个人；根因不成立则打回重分析\n· 校准改进方向',
        onReject: '根因分析',
        agentRole: '人工拍板（事故负责人主持）',
      },
      {
        name: '改进跟踪',
        entryMode: 'agent',
        instructions:
          '· 把改进措施拆成行动项：动作、负责人、期限、验收方式\n· 区分预防 / 检测 / 响应三类\n· 建跟踪表并定期核对闭环率',
        agentRole: '工程效率型：负责行动项建账与闭环跟踪',
      },
    ],
  },
  {
    id: 'sprint-retro',
    name: '迭代回顾',
    description: '每个迭代末的团队复盘：用 flow 指标驱动 Start/Stop/Continue，适合 Scrum/Kanban。',
    basis:
      'Start/Stop/Continue + Kanban flow 指标（WIP、周期时间、吞吐）：数据 + 行动项闭环，避免空谈。',
    stages: [
      {
        name: '数据准备',
        entryMode: 'agent',
        instructions:
          '· 拉本迭代 flow 指标：吞吐、周期时间、WIP、缺陷数\n· 与上一迭代环比，标出异常点\n· 整理关键事件与阻塞点清单\n· 输出回顾数据包',
        agentRole: '数据分析型：负责聚合 flow 指标并做趋势对比',
      },
      {
        name: '回顾会议',
        entryMode: 'user',
        instructions:
          '· 用 Start/Stop/Continue 组织讨论\n· 先各自写、再投票，聚焦可控项\n· 汇总 Top 问题并达成共识',
        agentRole: '人工主持（Scrum Master 或团队轮值）',
      },
      {
        name: '行动提炼',
        entryMode: 'agent',
        instructions:
          '· 把 Top 问题转成 2–3 个 SMART 行动项\n· 每项指定负责人、截止迭代、验收标准\n· 输出可直接建任务的行动项卡片',
        onReject: '回顾会议',
        agentRole: '敏捷教练型：能把问题转成可跟踪行动项',
      },
      {
        name: '跟踪验证',
        entryMode: 'agent',
        instructions:
          '· 下个迭代检查行动项完成率与效果\n· 未完成项分析原因，决定顺延还是撤销\n· 输出改进闭环报告',
        agentRole: '敏捷教练型：负责行动项闭环跟踪与报告',
      },
    ],
  },
]
