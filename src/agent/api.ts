// 对外 API：把智能体暴露到 globalThis，供其他海豹插件调用
import Config from "../config/config";
import { NAME, VERSION } from "../config/static_config";
import { logger } from "../logger";
import Model from "../model/model";
import Image from "../resource/image";
import { Session } from "../session/session";
import { SessionType } from "../session/types";
import Tool, { toolMap } from "../tool/tool";
import { ToolInfo } from "../tool/types";

import Agent from "./agent";

/** globalThis 上暴露的全局名称，其他插件通过 globalThis.aiplugin4 访问 */
export const AGENT_GLOBAL_NAME = "aiplugin4";

/** 外部插件触发完整对话编排时的可选参数 */
export interface AgentRunOptions {
    /** 使用的智能体名，缺省为默认智能体 '*' */
    agentName?: string;
    /** 触发原因（日志/上下文展示），缺省为「外部插件调用」 */
    reason?: string;
    /** 强制指定工具选择策略（auto/none/工具名），缺省交给模型自行决定 */
    toolChoice?: string;
}

/** 外部插件注册工具时的可选项 */
export interface RegisterToolOptions {
    /** 敏感工具（发送消息/封禁/改名等），调用会显著记录 */
    sensitive?: boolean;
    /** 可使用的会话类型，缺省 any（群聊/私聊均可用） */
    sessionType?: "any" | SessionType;
    /** 是否回调对话：工具结果写回上下文并继续生成，缺省 true；false 时工具静默执行、结果不回调 */
    callBack?: boolean;
    /** 工具执行函数，返回给 AI 的文本 */
    solve?: (ctx: seal.MsgContext, msg: seal.Message, session: Session, args: { [key: string]: any }) => string | Promise<string>;
}

/** 暴露给其他插件的智能体 API */
export interface AgentGlobalApi {
    readonly name: string;
    readonly version: string;
    /** Agent 类：需要更底层操作时可自行 get/save 智能体 */
    readonly Agent: typeof Agent;
    /** 获取智能体实例（name 缺省为默认智能体 '*'） */
    getAgent(name?: string): Agent;
    /** 获取指定智能体的会话 */
    getSession(agentName: string, sessionId: string): Session;
    /** 单轮对话：不经过会话上下文与工具，直接返回模型回复文本（无可用模型时返回空串） */
    chat(prompt: string, agentName?: string): Promise<string>;
    /** 对话：直接发送 OpenAI 风格 messages 数组到对话模型，返回回复文本（无可用模型时返回空串） */
    chatMessages(messages: { role: string, content: string }[], agentName?: string): Promise<string>;
    /** 识图：对图片 id 或 http(s) 图片地址调用图片识别模型，返回描述文本；未开启图片模型/未配置模型/找不到图片时返回错误说明 */
    imageToText(source: string, prompt?: string): Promise<string>;
    /** 嵌入：调用嵌入模型返回文本向量；未配置嵌入模型时返回空数组 */
    embed(text: string): Promise<number[]>;
    /** 在当前聊天中触发一次完整对话编排（上下文/工具/回复发送），等价于该会话收到一次触发 */
    run(ctx: seal.MsgContext, msg: seal.Message, options?: AgentRunOptions): Promise<void>;
    /** 注册一个工具，供 AI 通过函数调用/提示词工程使用；同名内置工具不可覆盖，成功返回 true */
    registerTool(info: ToolInfo, options?: RegisterToolOptions): boolean;
}

/** 把智能体 API 挂载到 globalThis；JS 重载时直接覆盖为新版本对象，避免外部插件拿到旧 API */
export function registerAgentApi(): void {
    const api: AgentGlobalApi = {
        name: NAME,
        version: VERSION,
        Agent,
        getAgent: (name?: string) => Agent.get(name || '*'),
        getSession: (agentName: string, sessionId: string) => Agent.get(agentName).sessionService.getSession(sessionId),
        chat: async (prompt: string, agentName?: string) => Agent.get(agentName || '*').chat(prompt),
        chatMessages: async (messages: { role: string, content: string }[], agentName?: string) => Agent.get(agentName || '*').chatMessages(messages),
        imageToText: async (source: string, prompt?: string) => {
            if (!Config.model.IMAGE_MODEL_ENABLED) return '图片模型开关未开启';
            if (!Model.getImageModel('image-understanding')) return '未找到支持 image-understanding 的图片模型';
            let img = Image.get(source);
            if (!img && /^https?:\/\//i.test(source)) {
                img = Image.createUrlImage('', source);
            }
            if (!img) return `未找到图片 ${source}（支持图片 id 或 http(s) 图片地址）`;
            await img.imageToText(prompt);
            return img.description || `图片 ${source} 识别失败`;
        },
        embed: async (text: string) => {
            const model = Model.getEmbeddingModel('text-embedding');
            if (!model) {
                logger.warning('外部调用 embed 失败：未找到嵌入模型');
                return [];
            }
            return await model.callEmbedding(text);
        },
        run: async (ctx: seal.MsgContext, msg: seal.Message, options: AgentRunOptions = {}) => {
            const agent = Agent.get(options.agentName || '*');
            const sessionId = ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId;
            const session = agent.sessionService.getSession(sessionId);
            await session.chat(ctx, msg, options.reason || '外部插件调用', options.toolChoice);
        },
        registerTool: (info: ToolInfo, options: RegisterToolOptions = {}) => {
            const name = info?.function?.name;
            if (!name) {
                logger.warning('注册工具失败：缺少函数名');
                return false;
            }
            const existing = toolMap[name];
            if (existing && !(existing as any).apiRegistered) {
                logger.warning(`注册工具失败：工具 ${name} 已存在（内置或其他插件注册）`);
                return false;
            }
            try {
                const tool = new Tool(info, options.sensitive || false);
                (tool as any).apiRegistered = true; // 允许同名 API 工具在 JS 重载后重新注册
                tool.sessionType = options.sessionType || 'any';
                if (options.callBack !== undefined) tool.callBack = options.callBack;
                tool.solve = async (ctx, msg, session, args) => options.solve ? await options.solve(ctx, msg, session, args) : '函数未实现';
                logger.info(`外部插件注册工具: ${name}`);
                return true;
            } catch (e) {
                logger.error(`注册工具 ${name} 失败: ${e instanceof Error ? e.message : String(e)}`);
                return false;
            }
        }
    };

    (globalThis as any)[AGENT_GLOBAL_NAME] = api;
    logger.info(`已暴露智能体 API: globalThis.${AGENT_GLOBAL_NAME} (v${VERSION})`);
}
