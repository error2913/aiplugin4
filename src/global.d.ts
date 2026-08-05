// SealDice 运行期由其他插件注入的全局对象（ob11 网络连接 / AI 绘图 / AITTS）
/* eslint-disable no-var */
interface NetApi {
    callApi(epId: string, action: string, params?: any): Promise<any>;
}

interface AiDrawingApi {
    sendImageRequest?(prompt: string, negativePrompt?: string): Promise<string>;
    generateImage?(prompt: string, ctx: any, msg: any, negativePrompt?: string): Promise<any>;
}

declare var net: NetApi | undefined;
declare var http: NetApi | undefined;
declare var aiDrawing: AiDrawingApi | undefined;
declare var ttsHandler: { generateSpeech(text: string, ctx: any, msg: any): Promise<any> } | undefined;
