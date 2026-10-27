// AuxLlm 端口的真实实现：把调用转给 Agent 主链（经 Agent.get，保持既有测试桩语义）。
// 只由组合根（src/index.ts、scripts/test-host.ts）导入，因此不会把 agent 主链重新连回
// context / memory / judge（见 core/ports/aux_llm.ts 的说明）。
import { setAuxLlm } from "../core/ports/aux_llm";

import Agent from "./agent";

export function installAuxLlm(): void {
    setAuxLlm({
        // 摘要/压缩/评分/记忆等辅助调用一律不解析图片（20 号方案 D3/INV-9）：
        // prompt 里渲染出的 [img:ID] 只作为文本，避免 20+ 张图被打包进 aux 请求。
        chat: (agentName, prompt) => Agent.get(agentName).chat(prompt, { allowImages: false }),
        chatMessages: (agentName, messages) => Agent.get(agentName).chatMessages(messages, { allowImages: false }),
    });
}
