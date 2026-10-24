// 子代理模块公共出口（独立模块，位于 src/subagent/）。
//
// 对外只应通过本文件访问子代理能力：
// - 机制层（可独立单测，不依赖 seal）：types / rules / store / jobs / service / child_system / wake / limits / providers；
// - 独立上下文：context（本地消息叠加 + 上限压缩，不接主 ContextStore）；
// - 运行时接线：child（headless 激活循环）与 wiring（ext KV、provider、notice、唤醒、checkpoint）。
//
// 依赖边界：本模块不得 import `src/context/**`；上下文/记忆与子代理完全分离。
export * from './types';
export * from './rules';
export * from './store';
export * from './jobs';
export * from './service';
export * from './child_system';
export * from './wake';
export * from './limits';
export * from './providers';
export * from './context';
export * from './child';
export * from './wiring';
