// 工具组批量开关：.ai tool on/off <组名> 与 .ai mcp on/off <服务器> 共用同一实现，
// 保证「跳过禁用名单 / 跳过核心常驻工具 / 计数口径」两条命令完全一致。
import Config from "../config/config";
import { Session } from "../session/session";

import { CORE_TOOL_NAMES } from "./tool";

export interface GroupToggleOptions {
    /** 跳过「禁止调用的函数」（on 用，与 .ai mcp on 语义一致） */
    skipBlocked?: boolean;
    /** 跳过核心常驻工具（off 用；避免一键关掉 AI 的工具发现/执行入口） */
    skipCore?: boolean;
}

export interface GroupToggleResult {
    /** 实际发生变化的工具数 */
    changed: number;
    /** 已经是目标状态的工具数 */
    unchanged: number;
    /** 因「禁止调用的函数」跳过的工具数 */
    skippedBlocked: number;
    /** 因核心常驻工具跳过的工具数 */
    skippedCore: number;
}

/**
 * 批量设置一组工具的会话开关。写入 session.tool.state（稀疏持久化），有实际变更时落盘。
 * 计数只反映真实状态变化；被跳过的工具单独计数，供命令侧如实回报。
 */
export function setToolGroupState(session: Session, names: string[], enable: boolean, options: GroupToggleOptions = {}): GroupToggleResult {
    const { skipBlocked = false, skipCore = false } = options;
    const blocked = Config.tool.BLOCKED;
    const result: GroupToggleResult = { changed: 0, unchanged: 0, skippedBlocked: 0, skippedCore: 0 };

    for (const name of names) {
        if (skipBlocked && blocked.includes(name)) {
            result.skippedBlocked++;
            continue;
        }
        if (skipCore && CORE_TOOL_NAMES.includes(name)) {
            result.skippedCore++;
            continue;
        }
        if (!!session.tool.state[name] === enable) {
            result.unchanged++;
            continue;
        }
        session.tool.state[name] = enable;
        result.changed++;
    }

    if (result.changed > 0) session.save();
    return result;
}

/** 批量开关的回复文案（组级与全量共用；0 变更且因核心工具跳过时给出 --force 提示） */
export function formatGroupToggleReply(scope: string, enable: boolean, result: GroupToggleResult): string {
    const parts = [`实际变更 ${result.changed} 个`];
    if (result.unchanged > 0) parts.push(`已是该状态 ${result.unchanged} 个`);
    if (result.skippedBlocked > 0) parts.push(`跳过禁用名单 ${result.skippedBlocked} 个`);
    if (result.skippedCore > 0) parts.push(`跳过核心常驻工具 ${result.skippedCore} 个`);
    let text = `已${enable ? '开启' : '关闭'}${scope}：${parts.join('，')}。`;
    if (!enable && result.changed === 0 && result.skippedCore > 0) {
        text += `\n（命中项全部是核心常驻工具，关掉后 AI 将无法发现/执行其余工具；如确需关闭请加 --force）`;
    }
    return text;
}
