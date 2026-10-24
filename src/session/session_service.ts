// 会话服务：会话的创建/复活/保存与 getSession 入口
import { Context } from "../context/context";
import { ConversationEvent } from "../context/events";
import { isMigrated, migrateLegacySession } from "../context/migrate/persist";
import { attachV2Mirror } from "../context/mirror";
import { ContextService } from "../context/service";
import { getHost } from "../core/host";
import { getAgent } from "../core/ports/agent_registry";
import { logger } from "../logger";
import { revive, TypeDescriptor } from "../utils/revive";

import { pendingKey, sessionStorageKey, writeSessionRecord } from "./persistence";
import { Session } from "./session";
import { Setting } from "./setting";
import { createToolListen } from "./tool_listen";


/**
 * 获取默认 Agent 下某个会话（旧 AIManager.getAI 的替代）
 */
export function getSession(sessionId: string): Session {
    return getAgent('*').sessionService.getSession(sessionId);
}

export class SessionService {
    static save(session: Session) {
        writeSessionRecord(session.sessionId, session);
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
                const data = JSON.parse(getHost().storage.get(sessionStorageKey(sessionId)) || '{}');
                session = revive(Session, data);
            } catch (error) {
                logger.error(`加载会话${sessionId}失败: ${error}`);
            }
            session.sessionId = sessionId;
            // 群 ID 统一带 -Group: 标记（海豹通用），其余视为私聊用户会话，不再只认 QQ: 前缀
            session.sessionType = sessionId.includes('-Group:') ? 'group' : 'user';
            // 恢复挂起队列轻量分片：ctx/msg 是运行时对象，重载后由续跑时按 epId/isPrivate 重建（失败则只入库不续跑）
            try {
                const pendingRaw = JSON.parse(getHost().storage.get(pendingKey(sessionId)) || '[]');
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
            // Context v2：旧会话首次打开时惰性迁移（只写新键，不改旧 messages）；随后挂载只读门面。
            // 旧 Context 仍是本轮行为的权威；P2 切换后逐步改为直接写 v2。
            try {
                if (!session.sessionId) {
                    session.contextV2 = null;
                } else {
                    if (session.context.messages.length > 0 && !isMigrated(session.sessionId)) {
                        migrateLegacySession(session.sessionId, {
                            messages: session.context.messages as unknown as import("../context/migrate/v1").LegacyContextLike['messages'],
                            archiveSeq: (session.context as unknown as { archiveSeq?: number }).archiveSeq,
                            rawSeq: (session.context as unknown as { rawSeq?: number }).rawSeq,
                            settledSeq: (session.context as unknown as { settledSeq?: number }).settledSeq,
                        }, {
                            parseText: (text) => {
                                // 迁移期保留标签文本即可；内容解析在 P2 接线时走 content/text_parse
                                return [{ type: 'text', text }];
                            },
                            estimateEventTokens: (event: ConversationEvent) => {
                                const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts;
                                if (!parts) return 8;
                                let chars = 0;
                                for (const part of parts) if (part.type === 'text') chars += String(part.text || '').length;
                                return Math.max(1, Math.ceil(chars / 3));
                            },
                        });
                        logger.info(`会话${session.sessionId}已迁移到 Context v2（旧 messages 保留）`);
                    }
                    session.contextV2 = ContextService.openSync(session.sessionId);
                }
            } catch (error) {
                session.contextV2 = null;
                logger.error(`初始化会话${session.sessionId}的 Context v2 失败（旧上下文继续可用）: ${error}`);
            }
            // 受控镜像：默认关闭；开启后旧写入会同步为 v2 事件（切换前校验用）
            attachV2Mirror(session.context, session.contextV2);
            this.sessionMap[sessionId] = session;
        }
        return this.sessionMap[sessionId];
    }

    /** 枚举当前已加载（惰性加载进内存）的全部会话；不含从未触达过的会话 */
    listSessions(): Session[] {
        return Object.values(this.sessionMap);
    }

}


