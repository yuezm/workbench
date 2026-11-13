/**
 * 开箱 SOP 模板（`model/sop-templates.ts`）：把「产品 / 研发 / 测试 / 发版」的通行做法
 * 落成可直接用的阶段序列。
 *
 * 只做**纯数据 + 纯函数**（不依赖 React、不做 IO）：模板给出阶段名、进入方式、
 * 「要干什么」与流向；`draftFromTemplate` 把它翻成 `WorkflowInput`（下标式流转目标），
 * 交给 `WorkflowEditor` 让用户确认后再保存。模板**不替用户绑定智能体**——那属于本机配置，
 * 所以 `agentRole` 只作建议文案，进不了任务提示词。
 *
 * M19/M34 的写法约定（约束分三层，见 docs/specs/SPEC-ai-workflow.md 的「柔性工作流（M19–M34）」）：
 * - 「要干什么」写**目标 / 产出 / 边界**三段，不再写「照着这几条做」的操作清单；
 *   参考做法放在「边界」段里并显式标注「可合并、可跳过」。
 * - 「验收」是**结构化字段** `acceptance`（一条一句），但只属于**闸门阶段**（M34）：
 *   执行阶段只负责跑完，判据由紧随其后的闸门阶段交给另一个智能体逐条核对。
 * - 只有**不可逆 / 需人拍板 / 口径不清**的地方才留 `user` 阶段；能自己判定的地方用
 *   闸门（`gate`）而不是人工阶段。
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
import type {
  EntryMode,
  OnChildrenSettled,
  SpawnPolicy,
  StageExitGuard,
  StageExitInput,
  StageInput,
  WorkflowInput,
} from '../../../../../protocol/entities'
import { withBuiltinStages } from './stage-draft'

/** 模板里的闸门（M19）：目标按**阶段名**写，落草稿时换成下标。 */
export interface SopGate {
  /** 允许未通过的次数（≥1） */
  maxFails: number
  /** 通过时进入；缺省 = 默认下一阶段 */
  onPass?: string | null
  /** 未通过时进入；缺省 = 原地不动 */
  onFail?: string | null
}

/** 一个阶段模板：`onComplete` / `onReject` / `gate.*` 写**阶段名**（找不到的名字按默认语义处理） */
export interface SopStage {
  name: string
  entryMode: EntryMode
  /**
   * 该阶段具体要干什么：会拼进进入本阶段的任务提示词。
   * 三段式：`### 目标` / `### 产出` / `### 边界`（参考做法放边界里，标「可跳过」）。
   */
  instructions: string
  /** 验收条目（一条一句，可判定）：**只给闸门阶段**（M34），执行阶段留空 */
  acceptance?: readonly string[]
  /** 完成后进入；缺省 = 下一阶段（末阶段 = 任务完成） */
  onComplete?: string | null
  /** 打回时退回到；缺省 = 不指定（原地不动、不自动重试） */
  onReject?: string | null
  /** 闸门（M19）：非空时本阶段按判定结果流转 */
  gate?: SopGate | null
  /** 本阶段是否允许 Agent 派生子任务（缺省 = 允许；`off` = 丢弃） */
  spawnPolicy?: SpawnPolicy | null
  /**
   * 本阶段派生的子任务（含交接来的任务）全部结束时父任务怎么办（缺省 = 按入口模式推断：
   * agent → wake，否则 notify）。测试流把「缺陷修复」交给别的流水线时，这里配 `wake`
   * 才能在缺陷全部关闭后自动进入回归验证。
   */
  onChildrenSettled?: OnChildrenSettled | null
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
 * 「待办 → 模板阶段 → 已阻塞 → 已完成 → 已取消」，模板里的下标（含闸门两侧）随之整体重映射。
 */
export function draftFromTemplate(template: SopTemplate): WorkflowInput {
  const stages = template.stages.map((stage): StageInput => ({
    name: stage.name,
    entryMode: stage.entryMode,
    exits: templateExits(template, stage),
    handoffs: [],
    subtaskStageId: null,
    onChildrenSettled: stage.onChildrenSettled ?? null,
    spawnPolicy: stage.spawnPolicy ?? null,
    instructions: stage.instructions,
    acceptance: stage.acceptance ?? [],
    judge: stage.gate ? { maxFails: stage.gate.maxFails } : null,
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
          '### 目标\n把模糊诉求收敛成一组可验证的机会，并说清证据强度。\n\n### 产出\n- 机会卡：目标结果 → 机会 → 方案假设\n- 问题陈述：谁、什么场景、什么痛点，附证据出处\n\n### 边界\n- 只整理证据，不替人拍板做不做\n- 参考做法（可合并、可跳过）：按用户反馈 / 工单 / 埋点 / 竞品各摘 3 条',
        agentRole: '产品分析型：擅长从反馈与数据里提炼机会',
      },
      {
        name: '用户验证',
        entryMode: 'none',
        instructions:
          '### 目标\n用真实用户的话确认或证伪机会卡上的假设。\n\n### 产出\n- 访谈记录（原话，不美化）\n- 每条假设标「成立 / 证伪」及依据\n\n### 边界\n- 人来做访谈；智能体只协助整理记录\n- 参考做法（可跳过）：5–8 个开放式问题，避免引导性提问',
        agentRole: '用户研究型：能拟访谈脚本并归纳结论',
      },
      {
        name: '方案设计',
        entryMode: 'agent',
        instructions:
          '### 目标\n针对已验证的 Top 机会给出可取舍的方案，并写成决策依据。\n\n### 产出\n- 2–3 个候选方案，各自写清覆盖哪条机会、放弃什么\n- 1 页 PR/FAQ：客户视角新闻稿 + 内部问答\n\n### 边界\n- 不做技术选型的最终决定（留给研发阶段）\n- 参考做法（可跳过）：按「人日成本 / 风险 / 可逆性」列对比表',
        agentRole: '产品设计型：能把方案写成 PR/FAQ 并说清取舍',
      },
      {
        name: '价值排序',
        entryMode: 'agent',
        instructions:
          '### 目标\n把候选方案排成「先做哪个」的确定顺序。\n\n### 产出\n- RICE（触达 / 影响 / 信心 / 投入）分值表\n- 建议优先级 Top3 与理由\n\n### 边界\n- 排序依据要能被人复核：分值怎么来的要写出来\n- 参考做法（可跳过）：RICE 换成 ICE / 加权评分表',
        agentRole: '产品运营型：能用 RICE/ICE 做量化排序',
      },
      {
        name: '立项评审',
        entryMode: 'user',
        instructions:
          '### 目标\n拍板 Go / No-Go，并留下决策依据。\n\n### 产出\n- 决策结论 + 理由\n- No-Go 或缺口的补充清单\n\n### 边界\n- 人拍板；结论回写到任务描述',
        onReject: '方案设计',
        agentRole: '人工拍板（不需要智能体）',
      },
      {
        name: '交接排期',
        entryMode: 'agent',
        instructions:
          '### 目标\n把立项结论整理成研发能直接开工的交付包。\n\n### 产出\n- PR/FAQ 终稿、RICE 表、验收指标、依赖清单\n- 首个可交付里程碑与工作量预估\n\n### 边界\n- 不重写立项结论；有异议写成开放问题\n- 产出交给「研发交付」工作流接手（可用跨工作流交接）',
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
          '### 目标\n把需求变成可独立验收的工作项，让实现阶段不必再猜口径。\n\n### 产出\n- 用户故事 + 每条 Given/When/Then 验收标准\n- 边界条件、异常路径、非功能约束（性能 / 安全）\n- 待确认的澄清问题（能自己定的就别问）\n\n### 边界\n- 不写实现细节；方案取舍留给实现阶段\n- 参考做法（可跳过）：技术方案单独出 ADR，或直接并进本阶段产出',
        onReject: null,
        agentRole: '业务分析型：擅长把需求转成可验收的用户故事',
      },
      {
        name: '编码实现',
        entryMode: 'agent',
        instructions:
          '### 目标\n让这项工作在主干上可运行、默认关闭、可回滚。\n\n### 产出\n- 代码：短分支 → PR（说明写清改了什么、怎么验证）\n- 测试：覆盖需求澄清里的每条验收标准\n- 证据：门禁命令的实际输出\n\n### 边界\n- 不动需求澄清之外的模块；需要动时先发 ask\n- 参考做法（可合并、可跳过）：小步提交、Conventional Commits、feature flag 默认关闭、单 PR ≤400 行',
        onReject: '需求澄清',
        agentRole: '编码型：能改代码、补测试并跑本地门禁',
      },
      {
        name: '代码评审',
        entryMode: 'agent',
        instructions:
          '### 目标\n判断这次改动能不能进主干，并给出可执行的待改项。\n\n### 产出\n- 评审结论：pass / fail + 依据\n- 待改项：文件与行号、问题、必须怎么改（末项可判定）\n\n### 边界\n- 只看正确性 / 可读性 / 测试 / 安全 / 性能，不纠结风格偏好\n- 不为了过而改测试或降阈值',
        // M34：验收只挂在闸门上——前一条执行阶段（编码实现）的判据搬到这里逐条核对
        acceptance: [
          '`pnpm check` 退出码 0',
          '新增测试覆盖需求澄清里的每条 Given/When/Then',
          '未完成功能被开关包住且默认关闭',
          '每条待改项都带位置与可判定的修复要求',
          '判定 pass 时 `checks` 全部退出码 0',
          '没有 P0 / P1 级未解决问题',
        ],
        gate: { maxFails: 3, onFail: '编码实现' },
        agentRole: '评审型：能按清单评审并给出可执行待改项',
      },
      {
        name: '人工验收',
        entryMode: 'user',
        instructions:
          '### 目标\n确认交付结果符合需求，而不是「测试过了」。\n\n### 产出\n- 逐条核对记录（预期 / 实测 / 结论）\n- 通过则放行；不通过写明缺什么\n\n### 边界\n- 人拍板；不清楚的实现细节回问评审结论，不靠猜',
        onReject: '编码实现',
        agentRole: '人工拍板（需求提出人或产品验收人）',
      },
      {
        name: '合并归档',
        entryMode: 'agent',
        instructions:
          '### 目标\n把改动落到主干并留下可追溯的版本记录。\n\n### 产出\n- 合并记录（squash merge、分支已删）\n- 版本号与 Changelog 条目\n- ADR 归档（有决策时）\n\n### 边界\n- 不改代码逻辑；发现遗留问题写进任务，不顺手改\n- 参考做法（可跳过）：SemVer 判定、按 Keep a Changelog 写条目',
        agentRole: '发布工程型：负责合并、打版本与归档',
      },
    ],
  },
  {
    id: 'testing-qa',
    name: '测试质量',
    description: '智能体跑完测试、人只做最终验收：四个 agent 阶段卡门槛，缺陷修复交给独立流水线。',
    basis:
      'ISO/IEC/IEEE 29119 测试过程 + 测试金字塔/Testing Trophy + SBTM 探索式测试 + 缺陷 triage：设计与执行分离、出口准则可判定；修复与验证权分离，避免修复方自己关单。',
    stages: [
      {
        name: '测试设计',
        entryMode: 'agent',
        instructions:
          '### 目标\n一次定清「测什么、测到什么程度算过」，后续路径自己排。\n\n### 产出\n- 测试范围与风险清单（按影响 × 概率排序）\n- 出口准则：可判定的阈值或清单，附不通过时的处置\n- 用例清单：前置、步骤、预期、优先级、对应的需求或风险项\n\n### 边界\n- 本阶段不写测试代码，也不追求覆盖率数字\n- 参考做法（可合并、可跳过）：等价类 / 边界值 / 状态迁移，挑主要风险即可',
        agentRole: '测试负责型：能划范围、定出口准则与风险策略',
      },
      {
        name: '执行测试',
        entryMode: 'agent',
        instructions:
          '### 目标\n按自己的判断把该跑的都跑完，拿到可核对的结果证据。\n\n### 产出\n- 执行记录：用例 → 结果 → 证据（命令输出 / 截图 / 日志路径）\n- 缺陷候选清单：现象、复现步骤、期望 vs 实测\n- 放行风险初判\n\n### 边界\n- 不为让结果变绿而放宽断言、跳过用例或改测试数据\n- 测试量大就按模块拆子任务并行，小就自己跑完\n- 参考做法（可合并、可跳过）：自动化跑主路径、探索式补边角、手工只验机器判断不了的项',
        spawnPolicy: 'agent',
        onReject: '测试设计',
        agentRole: '测试执行型：能跑自动化、做探索、出证据',
      },
      {
        name: '缺陷定级',
        entryMode: 'agent',
        instructions:
          '### 目标\n把发现变成能排序、能派活、能验收的缺陷单，并决定哪些必须这轮修。\n\n### 产出\n- 缺陷单：编号、严重度 S1–S4、是否阻断发布、关联用例与需求、复现步骤、期望 vs 实测、证据\n- 本轮汇总：阻断项清单与已接受的风险\n- 需修的缺陷派出去：配了交接就产一条「本轮修复」任务；要一条缺陷一张任务，就按缺陷单在本任务下建子任务（挂父任务，rollup 才等得到它们）\n\n### 边界\n- 去重合并：同一根因只留一张单，其余注明关联主单\n- 「已修复」只能由回归验证回写，本阶段不得自己关单\n- 参考做法（可跳过）：按影响面 × 复现概率定级',
        onChildrenSettled: 'wake',
        onComplete: '回归验证',
        agentRole: '缺陷管理型：负责 triage、派单与缺陷单维护',
      },
      {
        name: '回归验证',
        entryMode: 'agent',
        instructions:
          '### 目标\n确认修复真的生效，且没有把别的地方弄坏。\n\n### 产出\n- 回归结果：通过率、新增失败、与基线的对比\n- 缺陷状态回写：哪些从「已修复」升到「已验证」，哪些打回\n- 遗留风险：接受 / 不接受及依据\n\n### 边界\n- 本阶段不改代码；发现问题回缺陷定级再走一轮\n- **关联缺陷还没修完就不写 `verdict`**：只交基线采样与等待项，本阶段会停在原地等缺陷全部关闭，之后被自动唤醒再跑一轮\n- 参考做法（可跳过）：按影响面圈定范围 + 全量冒烟',
        // M34：验收只挂在闸门上——前一条执行阶段（缺陷定级）的判据搬到这里逐条核对
        acceptance: [
          '每条缺陷都有可复现的步骤与期望 / 实测对照',
          'S1/S2 已明确标注是否阻断发布',
          '重复缺陷已合并并注明主单',
          '需修的缺陷都已派出，且每条能反查到对应修复任务',
          '回归命令全部执行过，结果附命令输出或报告路径',
          '每个新增失败都定位到缺陷单或环境原因',
          '每条缺陷都有结论（已验证 / 打回），没有留在「已修复」',
          '遗留风险写明接受或不接受及依据',
        ],
        gate: { maxFails: 2, onFail: '缺陷定级' },
        agentRole: '回归测试型：能跑回归、比对基线、回写缺陷状态',
      },
      {
        name: '验收确认',
        entryMode: 'user',
        instructions:
          '### 目标\n对着出口准则拍板放行或打回，只看证据不看过程。\n\n### 产出\n- 逐条核对记录：预期 / 实测 / 结论\n- 放行签署，或打回并写明缺口\n\n### 边界\n- 人拍板；出口准则之外的争论不改判定',
        onReject: '回归验证',
        agentRole: '人工拍板（测试负责人或产品验收人）',
      },
    ],
  },
  {
    id: 'testing-issue',
    name: '缺陷修复',
    description: '一条缺陷一张任务：定位 → 修复 → 评审 → 回归确认，验证权留在测试方。',
    basis:
      '缺陷生命周期（open → fixed → verified → reopened）+ 先红后绿的回归用例 + 修复方不得自验：状态机的写入权分开，AI 才不会自己关自己的单。',
    stages: [
      {
        name: '定位复现',
        entryMode: 'agent',
        instructions:
          '### 目标\n把「偶发」变成「必然」，并给出可反证的根因假设与影响面。\n\n### 产出\n- 复现步骤，或一条能稳定失败的用例\n- 根因假设：指向具体文件 / 提交 / 配置\n- 影响面：牵动哪些需求、用例、其他缺陷单\n\n### 边界\n- 本阶段不改代码，只读、只跑、只记录\n- 参考做法（可跳过）：二分定位、加临时日志、对比正常路径',
        agentRole: '排查型：能稳定复现并定位到根因所在',
      },
      {
        name: '修复',
        entryMode: 'agent',
        instructions:
          '### 目标\n用最小的改动修好，并留下能防复发的东西。\n\n### 产出\n- 代码改动（范围限于根因所在）\n- 回归用例：修复前红、修复后绿的那条\n- 自测证据：门禁退出码与关键命令输出\n\n### 边界\n- 不顺带重构、不动无关文件；发现别的缺陷另开单\n- 不为让门禁变绿而放宽断言或跳过用例\n- 参考做法（可跳过）：小步提交、提交信息带缺陷单号',
        onReject: '定位复现',
        agentRole: '编码修复型：能定位后小步改对并补回归用例',
      },
      {
        name: '修复评审',
        entryMode: 'agent',
        instructions:
          '### 目标\n判断这次修复能不能合入，以及会不会引出下一个缺陷。\n\n### 产出\n- 判定：pass / fail 与依据\n- fail 时逐条给可执行待改项\n\n### 边界\n- 只审这次修复，不重新设计\n- S1/S2 缺陷通过后仍需人工确认，不能直接关单',
        // M34：验收只挂在闸门上——前一条执行阶段（修复）的判据搬到这里逐条核对
        acceptance: [
          '新增用例在修复前失败、修复后通过',
          '门禁命令退出码 0，或失败明细已逐条说明',
          '提交信息带缺陷单号，能反查到本次修复',
          '改动与缺陷根因对得上，没有越界修改',
          '回归用例能覆盖原始复现步骤',
          'S1/S2 缺陷标注了是否已通知相关方',
        ],
        gate: { maxFails: 2, onFail: '修复' },
        agentRole: '评审型：只看这次修复的正确性与影响面',
      },
      {
        name: '回归确认',
        entryMode: 'user',
        instructions:
          '### 目标\n确认缺陷单可以关闭，或需要送回测试流做回归。\n\n### 产出\n- 缺陷单状态决定：已验证 / 打回\n- 是否需要回到测试工作流做回归，及范围\n\n### 边界\n- 人拍板；修复方不能自己关单',
        onReject: '修复',
        agentRole: '人工拍板（测试负责人或缺陷提出人）',
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
          '### 目标\n让这次发布「可退」——先把回滚路径准备好，再谈上线。\n\n### 产出\n- 发布就绪清单：变更项、依赖、DB 迁移、配置\n- 回滚方案与触发条件（错误率 / 延迟阈值）\n- Changelog / Release Notes\n\n### 边界\n- 不动生产配置；需要人操作的步骤单独列出\n- 参考做法（可跳过）：Keep a Changelog 格式',
        agentRole: '发布工程型：负责发布准备与回滚预案',
      },
      {
        name: '发布评审',
        entryMode: 'user',
        instructions:
          '### 目标\ngo / no-go 拍板。\n\n### 产出\n- 决策与依据（DORA 指标、error budget 余量、风险清单）\n- No-Go 时写明缺什么\n\n### 边界\n- 人拍板；这是不可逆动作前唯一的人工关',
        onReject: '发布准备',
        agentRole: '人工拍板（发布负责人或 on-call lead 主持）',
      },
      {
        name: '灰度发布',
        entryMode: 'agent',
        instructions:
          '### 目标\n用最小流量验证生产行为，拿到放量或回滚的依据。\n\n### 产出\n- canary 放量记录（流量比例、时间窗口）\n- 指标对比：错误率、延迟、SLO、error budget 消耗\n- 放行建议\n\n### 边界\n- 不超过约定的灰度比例；超阈值直接按回滚方案执行并记录',
        acceptance: [
          '灰度窗口内核心指标与发布前对比有数据',
          '任一触发条件命中时有明确处置记录',
          '放行建议能追溯到具体指标',
        ],
        gate: { maxFails: 2, onFail: '发布准备' },
        onReject: '发布准备',
        agentRole: 'SRE 型：负责 canary 放量与指标观察',
      },
      {
        name: '发布确认',
        entryMode: 'user',
        instructions:
          '### 目标\n基于灰度数据拍板是否全量。\n\n### 产出\n- 决策 + 依据\n- 记录决策时间点\n\n### 边界\n- 人拍板；数据不足时按未达成处理',
        onReject: '发布准备',
        agentRole: '人工拍板（发布负责人确认灰度结果）',
      },
      {
        name: '全量发布',
        entryMode: 'agent',
        instructions:
          '### 目标\n把流量安全推到 100%，每一步都可停。\n\n### 产出\n- 分批放量记录（每批比例、时间、指标）\n- 开关推进记录\n\n### 边界\n- 每批之间必须留观察窗口；异常即停',
        onReject: '发布准备',
        agentRole: 'SRE 型：负责分批放量与开关推进',
      },
      {
        name: '发布监控',
        entryMode: 'agent',
        instructions:
          '### 目标\n确认上线后系统回到稳定状态，或及时止损。\n\n### 产出\n- 发布后健康报告（与发布前指标对比）\n- 异常时的回滚记录与触发点\n\n### 边界\n- 观察期内不改代码；只做回滚与降级\n- 参考做法（可跳过）：观察 30–60 分钟 SLO / 告警 / burn rate',
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
          '### 目标\n先止损，再谈原因。\n\n### 产出\n- 影响面、严重级别（P0–P3）、告警时间\n- 止损动作与时间线草稿\n\n### 边界\n- 值班工程师主导；智能体只协助拉上下文\n- 参考做法（可跳过）：回滚 / 降级 / 切流按 runbook 走',
        agentRole: '值班工程师主导；智能体可协助拉取告警上下文',
      },
      {
        name: '恢复确认',
        entryMode: 'user',
        instructions:
          '### 目标\n确认恢复，宣布事故结束。\n\n### 产出\n- 服务恢复证据（SLO / 核心指标）\n- 数据一致性核对结论\n\n### 边界\n- 人拍板；恢复不等于根因清楚',
        agentRole: '人工拍板（事故指挥确认恢复）',
      },
      {
        name: '时间线梳理',
        entryMode: 'agent',
        instructions:
          '### 目标\n把「什么时候发生了什么」变成可核对的事实链。\n\n### 产出\n- 时间线：时间戳对齐的告警 / 动作 / 决策\n- 事实与推测分开写\n\n### 边界\n- 不评判个人；只记录动作与依据\n- 参考做法（可跳过）：从日志 / 告警 / 工单 / 聊天记录交叉校验',
        agentRole: '日志分析型：能重建可核对的时间线',
      },
      {
        name: '根因分析',
        entryMode: 'agent',
        instructions:
          '### 目标\n区分「触发因素」与「系统性根因」，并给出证据链。\n\n### 产出\n- 根因结论 + 证据链\n- 检测与响应快慢的分析\n\n### 边界\n- 不做人事评价；结论必须能被反证\n- 参考做法（可跳过）：5 Whys / 鱼骨图',
        onReject: '时间线梳理',
        agentRole: '可靠性分析型：擅长 RCA 与证据链整理',
      },
      {
        name: '复盘评审',
        entryMode: 'user',
        instructions:
          '### 目标\n确认根因与改进方向，只谈机制不谈个人。\n\n### 产出\n- 复盘会结论\n- 不成立时的打回说明\n\n### 边界\n- 人主持；根因不成立就回上一阶段重分析',
        onReject: '根因分析',
        agentRole: '人工拍板（事故负责人主持）',
      },
      {
        name: '改进跟踪',
        entryMode: 'agent',
        instructions:
          '### 目标\n把改进措施变成能闭环的行动项。\n\n### 产出\n- 行动项：动作、负责人、期限、验收方式\n- 按预防 / 检测 / 响应分类的跟踪表\n\n### 边界\n- 不重复已有行动项；发现重复就合并并注明\n- 参考做法（可跳过）：定期核对闭环率',
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
          '### 目标\n用数据把「感觉慢」变成「哪里慢」。\n\n### 产出\n- flow 指标：吞吐、周期时间、WIP、缺陷数（含环比）\n- 关键事件与阻塞点清单\n\n### 边界\n- 不解释原因，只给数据（解释留给会议）\n- 参考做法（可跳过）：画趋势图，标出异常点',
        agentRole: '数据分析型：负责聚合 flow 指标并做趋势对比',
      },
      {
        name: '回顾会议',
        entryMode: 'user',
        instructions:
          '### 目标\n聚焦可控项，达成 Top 问题共识。\n\n### 产出\n- Start / Stop / Continue 清单\n- Top 问题及共识\n\n### 边界\n- 人主持；智能体不参与拍板\n- 参考做法（可跳过）：先各自写、再投票',
        agentRole: '人工主持（Scrum Master 或团队轮值）',
      },
      {
        name: '行动提炼',
        entryMode: 'agent',
        instructions:
          '### 目标\n把共识变成 2–3 个真的会做的行动项。\n\n### 产出\n- SMART 行动项：负责人、截止迭代、验收标准\n- 可直接建任务的卡片\n\n### 边界\n- 不追求数量；超过 3 个就先砍优先级\n- 参考做法（可跳过）：按「影响 ÷ 成本」排序',
        onReject: '回顾会议',
        agentRole: '敏捷教练型：能把问题转成可跟踪行动项',
      },
      {
        name: '跟踪验证',
        entryMode: 'agent',
        instructions:
          '### 目标\n确认行动项真的改变了行为，而不只是「完成了」。\n\n### 产出\n- 完成率与效果对比\n- 未完成项的原因与顺延 / 撤销决定\n\n### 边界\n- 不做新的改进提案；只核对上一轮\n- 参考做法（可跳过）：用下个迭代的 flow 指标验证效果',
        agentRole: '敏捷教练型：负责行动项闭环跟踪与报告',
      },
    ],
  },
]

/**
 * 模板里的去向（M32）：名字稳定，落成下标；名字对不上就当没配（由内核保存时补缺省）。
 *
 * 判定阶段模板给的是「通过 / 未通过」，非判定阶段是「完成 / 出错」——两套字段并存，
 * 这里按模板实际填了哪些来产出口。
 */
function templateExits(template: SopTemplate, stage: SopStage): StageExitInput[] {
  const exits: StageExitInput[] = []
  const push = (on: StageExitGuard, name: string | null | undefined): void => {
    if (name === null || name === undefined) return
    exits.push({ on, do: 'goto', stageIndex: targetIndex(template.stages, name) })
  }
  if (stage.gate) {
    push('passed', stage.gate.onPass)
    push('failed', stage.gate.onFail)
    return exits
  }
  push('done', stage.onComplete)
  push('errored', stage.onReject)
  return exits
}
