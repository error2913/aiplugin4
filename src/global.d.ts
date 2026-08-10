// SealDice 运行期跨插件共享的全局对象：
// 由其他插件注入的依赖（ob11 网络连接 / AI 绘图 / AITTS），
// 以及本插件暴露给其他插件的智能体 API（aiplugin4，见 src/agent/api.ts）
/* eslint-disable no-var */
interface NetApi {
    callApi(epId: string, action: string, params?: any): Promise<any>;
    /** 订阅依赖的事件分发（ob11 网络连接依赖：milky → OB11 转接的额外消息段） */
    getEventDispatcher?(ext: any, key?: string): Promise<any>;
    /** milky 消息引用 <-> OB11 唯一 message_id 双向转换（本地计算） */
    messageId?(input: { scene?: string, id?: number | string, peer_id?: number | string, msgid?: number | string, message_seq?: number | string, message_id?: number | string }): number | { scene: string, id: number, msgid: number };
}

interface AiDrawingApi {
    sendImageRequest?(prompt: string, negativePrompt?: string): Promise<string>;
    generateImage?(prompt: string, ctx: any, msg: any, negativePrompt?: string): Promise<any>;
}

declare var net: NetApi | undefined;
declare var http: NetApi | undefined;
declare var aiDrawing: AiDrawingApi | undefined;
declare var ttsHandler: { generateSpeech(text: string, ctx: any, msg: any): Promise<any> } | undefined;

// 本插件在启动时通过 registerAgentApi() 注入，其他插件可调用 globalThis.aiplugin4 驱动智能体
declare var aiplugin4: import("./agent/api").AgentGlobalApi | undefined;
