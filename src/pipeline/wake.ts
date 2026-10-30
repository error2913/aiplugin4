// 起轮入口（L4 兼容层）：实现已下沉到 L2 `trigger/wake.ts`（timer 调度层也要用，
// 避免 timer → pipeline 的反向依赖）。这里只做再导出，既有调用点零改动。
export { shouldCommit, wakeSession } from "../trigger/wake";
export type { WakeKind, WakePayload, WakeSessionLike } from "../trigger/wake";
