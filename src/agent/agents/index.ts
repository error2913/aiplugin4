// 智能体注册入口：副作用导入即完成各智能体的初始化
/**
 * 智能体注册入口：initAgents() 在 Config.registerConfig() 之后调用，
 * 因为 Agent.get 依赖 ext（过早初始化会抛 "Value is not object coercible"）。
 */
import { init as initCompress } from "./compress_agent";
import { init as initSummarize } from "./summarize_agent";

export function initAgents() {
    initCompress();
    initSummarize();
}
