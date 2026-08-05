// 智能体注册入口：副作用导入即完成各智能体的初始化
/**
 * 智能体注册入口：导入即完成各智能体的初始化（Agent.get + save）。
 * 在 index.ts 顶部以副作用方式引用，确保启动时全部可用。
 */
import "./compress_agent";
import "./samples";
import "./summarize_agent";
