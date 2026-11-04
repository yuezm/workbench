// M0 过渡桥接：kernel 需要的实体类型暂由 shared 转发。
// M1 拆出 protocol/entities.ts 后删除本文件，kernel 改为直接依赖实体定义。
export type { StageInput, Task, WorkflowStage, WorkflowWithStages } from '../shared/ai-workflow-api'
