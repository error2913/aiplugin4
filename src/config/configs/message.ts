// 对话配置：角色设定/示例对话/轮数/插入间隔/压缩阈值
import { logger } from "../../logger";
import { ext } from "../config";
export default class MessageConfig {

    static register() {

        seal.ext.registerTemplateConfig(ext, "角色扮演设定", [
            `测试机器人
你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。`
        ], '每行一个角色的扮演设定，第一行为角色设定名称（超过20字符自动截断），其余为设定内容；通过豹语变量 $gSYSPROMPT 选择，.ai role 可切换；修改后需重载 JS 生效', "对话")
        seal.ext.registerTemplateConfig(ext, "示例对话", [""], "每行一条示例对话，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "对话");
        seal.ext.registerIntConfig(ext, "对话保存轮数", 5, "上下文超过最大 token 后保留的最近真实用户轮数；更早消息会先归档总结再删除", "对话");
        seal.ext.registerIntConfig(ext, "上下文最大token", 500000, "持久化上下文 token 上限；0/负数视为无效并回退默认 500000", "对话");
        seal.ext.registerIntConfig(ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，示例对话不计入轮数", "对话");
        seal.ext.registerIntConfig(ext, "消息压缩阈值", 2000, "用户消息（含连续多条合并后）超过该字符数时，使用压缩智能体压缩后存入上下文", "对话");
    }

    static get() {
        // 角色扮演设定属于启动解析一次、重载 JS 才生效的复杂配置（首行截断+split 解析）：模块级缓存
        const roleParse = getRoleParse();
        const MAX_ROUNDS = seal.ext.getIntConfig(ext, "对话保存轮数");
        const INSERT_COUNT = normalizeInsertCount(seal.ext.getIntConfig(ext, "插入system message间隔轮数"), MAX_ROUNDS);
        const rawMaxTokens = seal.ext.getIntConfig(ext, "上下文最大token");
        const MAX_CONTEXT_TOKENS = rawMaxTokens > 0 ? rawMaxTokens : 500000;
        if (rawMaxTokens <= 0) {
            logger.warning(`「上下文最大token」不能为 0，已自动使用默认值 500000`);
        }
        return {
            INSTRUCTIONS: roleParse.instructions,
            ROLE_NAMES: roleParse.names,
            ROLE_SETTINGS: roleParse.settings,
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "示例对话"),
            MAX_ROUNDS,
            MAX_CONTEXT_TOKENS,
            INSERT_COUNT,
            COMPRESS_THRESHOLD: seal.ext.getIntConfig(ext, "消息压缩阈值")
        }
    }
}

const ROLE_NAME_MAX_LENGTH = 20;

interface RoleParseResult {
    instructions: string[];
    names: string[];
    settings: string[];
}
let roleParseCache: RoleParseResult | null = null;

/** 角色扮演设定整体快照：原始条目 + 解析出的名称/设定，启动解析一次、重载 JS 后重新解析 */
function getRoleParse(): RoleParseResult {
    if (roleParseCache) return roleParseCache;
    const instructions = seal.ext.getTemplateConfig(ext, "角色扮演设定");
    roleParseCache = {
        instructions,
        names: parseRoleNames(instructions),
        settings: parseRoleSettings(instructions),
    };
    return roleParseCache;
}

/**
 * 插入 system message 间隔轮数校验：必须 > 0 且小于「对话保存轮数」的一半才生效，
 * 否则按关闭（0）处理并告警，避免插入频率超过历史窗口导致 system 消息占满上下文。
 */
function normalizeInsertCount(raw: number, maxRounds: number): number {
    if (raw <= 0) return 0;
    if (maxRounds > 0 && raw * 2 >= maxRounds) {
        logger.warning(`「插入system message间隔轮数」${raw} 未小于「对话保存轮数」${maxRounds} 的二分之一，已按关闭处理`);
        return 0;
    }
    return raw;
}

/**
 * 解析单个角色设定条目：第一行为角色设定名称（超过 20 字符自动截断），其余为设定内容。
 * 兼容旧格式：整条只有一行时，整条内容作为设定，首行截断作为名称。
 */
export function parseRoleEntry(entry: string): { name: string; setting: string } {
    const text = String(entry ?? '');
    const lines = text.split('\n');
    const name = (lines[0] || '').trim().slice(0, ROLE_NAME_MAX_LENGTH);
    const setting = lines.slice(1).join('\n').trim();
    return { name, setting: setting || text };
}

export function parseRoleNames(instructions: string[]): string[] {
    return (instructions || []).map(entry => parseRoleEntry(entry).name);
}

export function parseRoleSettings(instructions: string[]): string[] {
    return (instructions || []).map(entry => parseRoleEntry(entry).setting);
}
