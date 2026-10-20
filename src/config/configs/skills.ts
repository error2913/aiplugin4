// 技能配置：整份 JSON（v1），AI 通过 use_skill 按需调用。
//
// 新键名 `技能列表`；旧的 `技能配置` 模板键不再注册/读取（不做迁移）。
import Logger from "../../logger";
import { ext } from "../config";
import { DEFAULT_SKILLS, DEFAULT_SKILLS_JSON } from "../domain/defaults";
import { parseSkillsConfig } from "../domain/parse";
import { SkillEntry } from "../domain/types";

import { GENERATOR_CONFIG_HINT } from "./generator_hint";

export const SKILLS_CONFIG_KEY = '技能列表';

export interface SkillsConfigData {
    SKILLS: SkillEntry[];
    /** 原始配置文本，供技能缓存做变化检测 */
    RAW: string;
    /** 本次原始文本是否解析成功（false = 保留上一份可用技能） */
    VALID: boolean;
}

function fallbackSkills(): SkillEntry[] {
    return DEFAULT_SKILLS.map(s => ({ ...s, platforms: [...s.platforms] }));
}

/** 直接读取原始配置文本：绕过 60 秒 Config 缓存，供技能配置自动重载比对用 */
export function readSkillsConfigRaw(): string | null {
    try {
        return seal.ext.getStringConfig(ext, SKILLS_CONFIG_KEY) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${SKILLS_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

function readSkills(): SkillsConfigData {
    const text = readSkillsConfigRaw();
    if (text === null) {
        return { SKILLS: [], RAW: '', VALID: false };
    }
    if (!text.trim()) {
        Logger.warning(`「${SKILLS_CONFIG_KEY}」为空，已载入出厂技能。`);
        return { SKILLS: fallbackSkills(), RAW: '', VALID: true };
    }
    const result = parseSkillsConfig(text);
    for (const issue of result.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
    for (const warning of result.warnings) Logger.warning(`  ${warning.path} ${warning.msg}`);
    if (!result.config) {
        Logger.error(`「${SKILLS_CONFIG_KEY}」校验失败（共 ${result.issues.length} 处），本次不采用该配置（有上一份时保留）。`);
        Logger.error('提示：可用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「技能」页）。');
        return { SKILLS: [], RAW: text, VALID: false };
    }
    return {
        SKILLS: result.config.skills,
        RAW: text,
        VALID: true,
    };
}

export default class SkillsConfig {
    static register() {
        seal.ext.registerStringConfig(
            ext,
            SKILLS_CONFIG_KEY,
            DEFAULT_SKILLS_JSON,
            GENERATOR_CONFIG_HINT,
            '技能',
        );
    }

    static get(): SkillsConfigData {
        return readSkills();
    }
}
