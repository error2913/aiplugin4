// 记忆目标会话解析：统一按「当前会话所属 agent」定位目标会话。
// 工具/总结写入与 prompt 检索必须落在同一个 agent 的 sessionMap 上，
// 避免写入走 '*' agent 而检索走当前 agent 导致的跨 agent 记忆不可见。
import { Session } from "../session/session";
import { getPlatform, normalizeGroupId, normalizeUserId } from "../utils/target_id";

/**
 * 解析记忆归属的目标会话。
 * @param session 调用方会话（决定使用哪个 agent 的 sessionService）
 * @param memoryType 'private' | 'group'
 * @param targetId 目标用户 ID 或群 ID
 * @returns 目标会话；ID 格式非法时返回 null（不存在也会按需创建，与 getSession 语义一致）
 */
export function resolveTargetSession(
    session: Session,
    memoryType: string,
    targetId: string | number | undefined
): Session | null {
    if (!session || !targetId) return null;
    const svc = session.agent.sessionService;
    if (memoryType === 'private') {
        const id = normalizeUserId(targetId, getPlatform(session.sessionId));
        return id ? svc.getSession(id) : null;
    }
    if (memoryType === 'group') {
        const id = normalizeGroupId(targetId, getPlatform(session.sessionId));
        return id ? svc.getSession(id) : null;
    }
    return null;
}
