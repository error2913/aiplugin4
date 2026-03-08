import { Config } from "../config/config";
import { logger } from "../logger";
import { ToolCall, toolMap, ToolName, ToolState } from "../tool/tool";
import { ToolListen } from "../tool/types";
import { revive, TypeDescriptor } from "../utils/utils";
import { Context } from "./context";
import { MemoryService } from "./memory";

export class State {
    [key: string]: any;
}

export interface RequestMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export class Session {
    static validKeysMap: { [key in keyof Session]?: TypeDescriptor<Session[key]> } = {
        isPrivate: 'boolean',
        sessionId: 'string',
        state: 'any',
        context: Context,
        memory: MemoryService,
        tool: {
            object: {
                state: { objectValue: 'boolean' }
            }
        },
        ignoredUserIdList: { array: 'string' },
    }
    isPrivate: boolean;
    sessionId: string;
    state: State;
    context: Context;
    memory: MemoryService;
    tool: {
        state: ToolState,
        callCount: number, // 单次触发调用函数计数
        listen: ToolListen // 监听调用函数发送的内容
    }
    ignoredUserIdList: string[];

    constructor() {
        this.isPrivate = false;
        this.sessionId = '';
        this.state = {};
        this.context = new Context();
        this.memory = new MemoryService();
        this.tool = {
            state: Object.keys(toolMap).reduce((acc, key) => {
                acc[key as ToolName] = false;
                return acc;
            }, {} as ToolState),
            callCount: 0,
            listen: {
                timeoutId: null,
                resolve: null,
                reject: null,
                cleanup: () => {
                    if (this.tool.listen.timeoutId) clearTimeout(this.tool.listen.timeoutId);
                    this.tool.listen.timeoutId = null;
                    this.tool.listen.resolve = null;
                    this.tool.listen.reject = null;
                }
            }
        }
        this.ignoredUserIdList = [];
    }

    // wip
    getMessages(): RequestMessage[] {
        return [];
    }

    // wip
    getImageMessages(): RequestMessage[] {
        return [];
    }
}

export class SessionService {
    static validKeysMap: { [key in keyof SessionService]?: TypeDescriptor<SessionService[key]> } = {
        sessionMap: { objectValue: Session },
    }
    sessionMap: { [key: string]: Session };

    constructor() {
        this.sessionMap = {};
    }

    getSession(sessionId: string): Session {
        if (!this.sessionMap.hasOwnProperty(sessionId)) {
            let session = new Session();
            try {
                const data = JSON.parse(Config.ext.storageGet(`session_${sessionId}`) || '{}');
                session = revive(Session, data);
            } catch (error) {
                logger.error(`加载会话${sessionId}失败: ${error}`);
            }
            session.sessionId = sessionId;
            this.sessionMap[sessionId] = session;
        }
        return this.sessionMap[sessionId];
    }
}