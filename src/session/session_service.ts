// 会话服务：会话的创建/复活/保存与 getSession 入口
import Agent from "../agent/agent";
import { ext } from "../config/config";
import { Context } from "../context/context";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";

import { Session, Setting } from "./session";
import { createToolListen } from "./tool_listen";


/**
 * 获取默认 Agent 下某个会话（旧 AIManager.getAI 的替代）
 */
export function getSession(sessionId: string): Session {
    return Agent.get('*').sessionService.getSession(sessionId);
}

export class SessionService {
    static save(session: Session) {
        ext.storageSet(`session_${session.sessionId}`, JSON.stringify(session, (key, value) => key === 'lastCtx' || key === 'running' || key === 'stopVersion' || key === 'steerQueue' ? undefined : value));
    }
    static validKeysMap: { [key in keyof SessionService]?: TypeDescriptor<SessionService[key]> } = {
        agentName: 'string',
        memory: { objectValue: 'any' },
        sessionMap: { objectValue: Session }
    }
    agentName: string;
    memory: any; // 全局记忆服务（新引擎下不再使用旧 MemoryService）
    sessionMap: { [key: string]: Session };

    constructor() {
        this.agentName = '';
        this.sessionMap = {};
        this.memory = {};
    }

    getSession(sessionId: string): Session {
        if (!Object.prototype.hasOwnProperty.call(this.sessionMap, sessionId)) {
            let session = new Session();
            try {
                const data = JSON.parse(ext.storageGet(`session_${sessionId}`) || '{}');
                session = revive(Session, data);
            } catch (error) {
                logger.error(`加载会话${sessionId}失败: ${error}`);
            }
            session.sessionId = sessionId;
            if (sessionId.startsWith('QQ:')) session.sessionType = 'user';
            session.agentName = this.agentName;
            // listen 是运行时对象，函数不会被 JSON 持久化；每次恢复会话都重新创建。
            session.tool.listen = createToolListen();
            // 复活嵌套对象（Context/MemoryItem/Setting）
            session.context = revive(Context, session.context || {});
            session.context.reviveMessages();
            if (session.memory) session.memory.reviveMemoryMap();
            if (session.setting) session.setting = revive(Setting, session.setting);
            // 同步归属字段，确保 context/memory 能解析到正确的 agent/session
            session.context.agentName = session.agentName;
            session.context.sessionId = session.sessionId;
            if (session.memory) {
                session.memory.agentName = session.agentName;
                session.memory.sessionId = session.sessionId;
            }
            this.sessionMap[sessionId] = session;
        }
        return this.sessionMap[sessionId];
    }

}


