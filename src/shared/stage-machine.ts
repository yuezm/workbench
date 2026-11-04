// 旧路径只保留一个 M0 周期：实现已搬到 src/kernel/workflow/stage-machine.ts。
// M1 删除本文件时，调用方（engine.ts / runner.ts）与测试跟着改指 kernel。
export type { StageEffect, StageEvent } from '../kernel/workflow/stage-machine'
export {
  completeTask,
  enterStage,
  entryEffects,
  moveTask,
  moveTaskToStage,
  resolveNextStage,
  resolveRejectStage,
} from '../kernel/workflow/stage-machine'
