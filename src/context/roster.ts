// 上下文名册（用户/群/图片）：按 ID 取档案、自动改名、引用解析。
// 从 context.ts 拆出——这些是「用户/群资料 + 图片引用」的查询与网络补全，
// 与消息窗口/归档逻辑无关；context.ts 保留同名方法委派，外部调用点零改动。
import Config from "../config/config";
import Logger from "../logger";
import Image from "../resource/image";
import Group from "../session/group";
import type { Session } from "../session/session";
import User from "../session/user";
import { callOb11Api } from "../utils/ob11";
import { getPlatform, normalizeGroupId, normalizeUserId } from "../utils/target_id";
import { withTimeout } from "../utils/timeout";

const log = Logger.withTag('context');

/** roster 只需这三项宿主信息（结构化匹配 Context，无需 import Context 实现） */
export interface RosterHost {
    sessionId: string;
    session: Session;
    autoNameMod: number;
}

export function getUserById(host: RosterHost, userId: string | number): User | null {
    const normalizedId = normalizeUserId(userId, getPlatform(host.sessionId));
    if (!normalizedId || host.session.checkIgnoredUserId(normalizedId)) return null;
    return User.get(normalizedId);
}

export function userInfoList(host: RosterHost & { messages: any[] }): { isPrivate: true, id: string, name: string }[] {
    const userMap: { [key: string]: { isPrivate: true, id: string, name: string } } = {};
    for (const m of host.messages) {
        if (m.role !== 'user' || !(m as any).contentItems) continue;
        for (const item of (m as any).contentItems) {
            if (!item.userId) continue;
            if (!userMap[item.userId]) {
                const u = User.get(item.userId);
                userMap[item.userId] = {
                    isPrivate: true,
                    id: item.userId,
                    name: u.userName || item.userId
                };
            }
        }
    }
    return Object.values(userMap);
}

export async function setName(host: RosterHost, epId: string, gid: string, uid: string, mod: 'nickname' | 'card'): Promise<void> {
    let name = '';
    switch (mod) {
        case 'nickname': {
            const strangerInfo = await callOb11Api(epId, "get_stranger_info", { user_id: uid.replace(/^.+:/, ""), no_cache: true });
            if (!strangerInfo || !strangerInfo.nickname) {
                log.warning(`未找到用户<${uid}>的昵称`);
                break;
            }
            name = strangerInfo.nickname;
            break;
        }
        case 'card': {
            if (!gid) break;
            const memberInfo = await callOb11Api(epId, "get_group_member_info", { group_id: gid.replace(/^.+:/, ""), user_id: uid.replace(/^.+:/, ""), no_cache: true });
            if (!memberInfo) {
                log.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
                await setName(host, epId, gid, uid, 'nickname');
                return;
            }
            name = memberInfo.card || memberInfo.nickname;
            if (!name) {
                await setName(host, epId, gid, uid, 'nickname');
                return;
            }
            break;
        }
    }
    if (!name) {
        log.warning(`用户<${uid}>未设置昵称或群名片`);
        return;
    }
    const u = User.get(uid);
    u.userName = name;
    User.save(u);
}

export function getGroupById(host: RosterHost, groupId: string | number): Group | null {
    const normalizedId = normalizeGroupId(groupId, getPlatform(host.sessionId));
    if (!normalizedId) return null;
    return Group.get(normalizedId);
}

export async function findImage(host: RosterHost, _ctx: seal.MsgContext, id: string): Promise<Image | null> {
    const img = Image.resolveRef(id);
    if (img) return img;
    const { LOCAL_IMAGE_PATH_MAP } = Config.image as any;
    if (LOCAL_IMAGE_PATH_MAP && Object.prototype.hasOwnProperty.call(LOCAL_IMAGE_PATH_MAP, id)) {
        return Image.createLocalImage(id, LOCAL_IMAGE_PATH_MAP[id]);
    }
    return host.session.memory.findImage(id);
}

export async function updateName(host: RosterHost, epId: string, gid: string, uid: string): Promise<void> {
    switch (host.autoNameMod) {
        case 1: {
            try {
                await withTimeout(() => setName(host, epId, gid, uid, 'nickname'), 5000);
            } catch (e) {
                log.warning(`自动改名（昵称）失败: ${e instanceof Error ? e.message : String(e)}`);
            }
            break;
        }
        case 2: {
            try {
                await withTimeout(() => setName(host, epId, gid, uid, 'card'), 5000);
            } catch (e) {
                log.warning(`自动改名（群名片）失败: ${e instanceof Error ? e.message : String(e)}`);
            }
            break;
        }
    }
}
