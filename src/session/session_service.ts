// 会话服务：会话的创建/复活/保存与 getSession 入口
import Agent from "../agent/agent";
import { ext } from "../config/config";
import { Context } from "../context/context";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/utils";

import { Session, SESSION_RUNTIME_KEYS, Setting } from "./session";
import { createToolListen } from "./tool_listen";


/**
 * 获取默认 Agent 下某个会话（旧 AIManager.getAI 的替代）
 */
export function getSession(sessionId: string): Session {
    return Agent.get('*').sessionService.getSession(sessionId);
}

export class SessionService {
    static save(session: Session) {
        ext.storageSet(`session_${session.sessionId}`, JSON.stringify(session, (key, value) => SESSION_RUNTIME_KEYS.has(key) ? undefined : value));
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
            // 群 ID 统一带 -Group: 标记（海豹通用），其余视为私聊用户会话，不再只认 QQ: 前缀
            session.sessionType = sessionId.includes('-Group:') ? 'group' : 'user';
            // 恢复挂起队列轻量分片：ctx/msg 是运行时对象，重载后由续跑时按 epId/isPrivate 重建（失败则只入库不续跑）
            try {
                const pendingRaw = JSON.parse(ext.storageGet(`session_${sessionId}:pending`) || '[]');
                if (Array.isArray(pendingRaw) && pendingRaw.length > 0) {
                    session.pendingQueue = pendingRaw as any;
                }
            } catch (error) {
                logger.error(`加载会话${sessionId}的挂起队列失败: ${error}`);
            }
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

    /** 枚举当前已加载（惰性加载进内存）的全部会话；不含从未触达过的会话 */
    listSessions(): Session[] {
        return Object.values(this.sessionMap);
    }

}


