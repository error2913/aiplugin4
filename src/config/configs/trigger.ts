// 触发配置（页签「触发」）：默认计数器/计时器/概率/活跃时间/触发正则与令牌桶；评分触发参数（TOML）；
// 事件触发规则（JSON v1，事件先按现有接收链路进上下文，再按规则触发）。
import { load } from 'js-toml'

import {
    EVENT_TRIGGER_DEFAULT_JSON,
    type EventTriggerConfig,
    parseEventTriggerConfig,
} from "../../event/trigger";
import { getJudgeConfigState, JUDGE_TOML_DEFAULT } from "../../judge/config";
import Logger from "../../logger";
import { parseTimeSegments } from "../../utils/time_window";
import { validateTimerSpec } from "../../utils/timer_spec";
import type { NormalizedTimerSpec } from "../../utils/timer_spec";
import { ext } from "../ext";
import { getRegexConfig } from "../regex";

import { GENERATOR_CONFIG_HINT } from "./generator_hint";

// 评分触发参数（String TOML v2）：解析/默认值/有效性在 judge/config.ts（L2 唯一事实源），
// 本文件只负责从 seal 配置读取原文并暴露给 Config.trigger。

export { resetJudgeConfigCacheForTest } from "../../judge/config";

/** 读取并缓存判定配置状态（v2；空/非法 ⇒ valid=false，判定入口直接不发起） */
function getJudgeState() {
    return getJudgeConfigState(seal.ext.getStringConfig(ext, "评分触发参数"));
}

/** 事件触发规则：启动解析一次、重载 JS 才生效（对齐评分触发配置的缓存口径） */
let eventTriggerConfigCache: EventTriggerConfig | null = null;

/** 读「事件触发规则」；解析失败整份回退空规则集（**永不抛**，Config.trigger 在消息热路径被读取） */
function getEventTriggerConfig(): EventTriggerConfig {
    if (eventTriggerConfigCache) return eventTriggerConfigCache;
    try {
        const text = seal.ext.getStringConfig(ext, "事件触发规则") ?? '';
        const result = parseEventTriggerConfig(text);
        for (const warning of result.warnings) {
            Logger.warning(`事件触发规则 ${warning.path} ${warning.msg}`);
        }
        if (!result.config) {
            Logger.error(`「事件触发规则」校验失败（共 ${result.issues.length} 处），本次整份不生效：`);
            for (const issue of result.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
            Logger.error('提示：可用配置生成器 https://error2913.github.io/aiplugin4-config/ 的「事件触发」页生成后粘贴。');
            eventTriggerConfigCache = { version: 1, rules: [] };
            return eventTriggerConfigCache;
        }
        eventTriggerConfigCache = result.config;
    } catch (e) {
        Logger.error(`读取/解析「事件触发规则」失败，本次不生效: ${e instanceof Error ? e.message : String(e)}`);
        eventTriggerConfigCache = { version: 1, rules: [] };
    }
    return eventTriggerConfigCache;
}

/** 仅供单元测试使用：清空事件触发规则缓存 */
export function resetEventTriggerConfigCacheForTest(): void {
    eventTriggerConfigCache = null;
}

/**
 * 「默认定时器」Template 默认示例：**每框一个定时器**，框内是单条 TimerSpec 的 TOML
 * （参数与 set_timer / 链 timer 门完全一致，含 prompts）。多个框 = 多个定时器。
 */
const TIMER_SPEC_TOML_DEFAULT = `types = "interval"
hours = 12
count = -1
prompts = ["该休息一下了", "提醒你喝水"]`;

/** 「默认定时器」解析结果；VALID=false 时 `trg timer on` 应拒绝开启 */
export interface TimerTomlConfig {
    VALID: boolean;
    SPECS: NormalizedTimerSpec[];
    ERRORS: string[];
}

/**
 * 解析「默认定时器」Template：逐个非空框解析为 TOML → validateTimerSpec。
 * - 单框非法：WARN 跳过（其余框仍生效）；
 * - 所有非空框都非法：VALID=false（trg timer on 拒绝，避免"开着但不触发"的错觉）；
 * - 全空：VALID=true、SPECS=[]（trg timer on 会提示为空）。
 *
 * 不做模块级缓存：target 型 spec 的 targetAt 是"解析时刻的绝对时间"，
 * 缓存会让过期时刻在进程内被冻结（重载/开启后立刻迟到唤醒）。Config 层已有 60s 缓存，开销可接受。
 */
function getTimerTomlConfig(): TimerTomlConfig {
    const entries = (seal.ext.getTemplateConfig(ext, "默认定时器") || []).filter(text => text && text.trim() !== '');
    if (entries.length === 0) {
        return { VALID: true, SPECS: [], ERRORS: [] };
    }
    const errors: string[] = [];
    const specs: NormalizedTimerSpec[] = [];
    entries.forEach((text, index) => {
        let doc: Record<string, unknown>;
        try {
            doc = load(text.trim()) as Record<string, unknown>;
        } catch (e) {
            const message = `默认定时器第 ${index + 1} 框 TOML 解析失败：${e instanceof Error ? e.message : String(e)}`;
            Logger.warning(`${message}（已跳过）`);
            errors.push(message);
            return;
        }
        const result = validateTimerSpec(doc);
        if (!result.ok || !result.spec) {
            const message = `默认定时器第 ${index + 1} 框：${result.errors.join('；')}`;
            Logger.warning(`${message}（已跳过）`);
            errors.push(message);
            return;
        }
        specs.push(result.spec);
    });
    // 有配置但一个有效条目都没有 → 整份视为非法（拒绝开启）
    const valid = specs.length > 0 || errors.length === 0;
    if (!valid) Logger.error('「默认定时器」没有任何有效条目，timer 模式将拒绝开启');
    return { VALID: valid, SPECS: specs, ERRORS: errors };
}

/** 兼容旧测试调用：解析已不再走模块级缓存，保留空实现避免调用点改动 */
export function resetTimerTomlConfigCacheForTest(): void {
    // no-op
}

export default class TriggerConfig {
    static register() {
        // 触发页顺序（= TRIGGER_CONFIG_KEYS）：被@触发第一个，其后 3 个全局键 + 活跃时间 + 各模式配置
        seal.ext.registerBoolConfig(ext, "被@触发", true, "群聊中有人 @ 机器人即直接触发回复（默认开；私聊不触发）。关闭后 @ 不会再单独触发，仍可被正则/其他模式命中", "触发");
        seal.ext.registerStringConfig(ext, "触发需要满足的条件", '1', "额外的豹语表达式条件，命中为 1 才触发；示例：$t群号_RAW=='2001'，不需要额外条件时填 1", "触发");
        seal.ext.registerIntConfig(ext, "触发次数上限", 3, "消息触发令牌桶容量，达到上限后需等待补充", "触发");
        seal.ext.registerIntConfig(ext, "触发次数补充间隔", 3, "令牌桶补充间隔（秒）", "触发");
        seal.ext.registerTemplateConfig(ext, "触发活跃时间", [
            "10:00-20:00-5"
        ], "每框一段活跃时间：HH:mm-HH:mm-次数（时段内最多触发次数）；可多段，示例 09:00-12:00-3；空=不限。修改后即时生效", "触发");
        seal.ext.registerIntConfig(ext, "默认计数器", 10, "计数器模式下达到该条数触发回复", "触发");
        seal.ext.registerFloatConfig(ext, "默认计时器", 60, "延迟模式（旧计时器）下最后一条消息后多少秒触发", "触发");
        // 事件触发（v1）：事件先按「事件接收」页的开关/白名单/录入，命中本规则后再触发回复（链事件规则不读本开关）
        seal.ext.registerStringConfig(
            ext,
            "事件触发规则",
            EVENT_TRIGGER_DEFAULT_JSON,
            "JSON v1：{\"version\":1,\"rules\":[{\"on\":\"group_increase\",\"scope\":{...},\"match\":[...],\"prompt\":\"...\"}]}。一条规则只绑一个事件；事件先由「事件接收」页录入上下文，再按本规则触发；空规则=关闭。"
                + GENERATOR_CONFIG_HINT,
            "触发",
        );
        seal.ext.registerStringConfig(ext, "评分触发参数", JUDGE_TOML_DEFAULT, "评分触发（.ai trg judge on）的参数，TOML v2；消息立即评分，WAIT 结果/回复后进入 30s WAIT，期间只挂起最新一条，WAIT 到点才评。非法值会使判定不可用；默认模板可用 .ai trg judge default 查看；修改后需重载 JS 生效", "触发");
        seal.ext.registerFloatConfig(ext, "默认概率", 10, "概率模式下每条消息触发回复的概率（%）", "触发");
        // 默认正则不再包含 at CQ：@ 触发由「被@触发」配置开关判定
        seal.ext.registerTemplateConfig(ext, "触发正则表达式", [
            "^正确.*[。？！?!]$"
        ], "每框一个正则，任一命中即触发回复（不含 @，@ 由「被@触发」开关处理）；示例：^你好.*；修改后需重载 JS 生效", "触发");
        seal.ext.registerTemplateConfig(ext, "默认定时器", [
            TIMER_SPEC_TOML_DEFAULT
        ], "每框一个定时器（TOML，单条 TimerSpec）：types/years/months/days/hours/minutes/count/prompts（参数与 set_timer 完全一致，prompts 1~10 必填）；可多框=多个定时器。.ai trg timer on 后按此表为每个会话注册定时器", "触发");
    }

    static get() {
        const activeTimeList = (seal.ext.getTemplateConfig(ext, "触发活跃时间") || []).filter(item => item && item.trim() !== '');
        return {
            COUNTER: seal.ext.getIntConfig(ext, "默认计数器"),
            TIMER: seal.ext.getFloatConfig(ext, "默认计时器"),
            PROBABILITY: seal.ext.getFloatConfig(ext, "默认概率"),
            // 兼容旧读法：单条活跃时间字符串；多段请用 ACTIVE_TIME_SEGMENTS
            ACTIVE_TIME: activeTimeList[0] || '',
            ACTIVE_TIME_SEGMENTS: parseTimeSegments(activeTimeList).segments,
            AT_TRIGGER: seal.ext.getBoolConfig(ext, "被@触发"),
            TRIGGER_REGEX: getRegexConfig(ext, "触发正则表达式"),
            TRIGGER_CONDITION: seal.ext.getStringConfig(ext, "触发需要满足的条件"),
            BUCKET_LIMIT: seal.ext.getIntConfig(ext, "触发次数上限"),
            FILL_INTERVAL: seal.ext.getIntConfig(ext, "触发次数补充间隔"),
            JUDGE: getJudgeState().config,
            JUDGE_VALID: getJudgeState().valid,
            JUDGE_ERRORS: getJudgeState().errors,
            TIMER_SPECS: getTimerTomlConfig(),
            EVENT_TRIGGER: {
                CONFIG: getEventTriggerConfig(),
            },
        }
    }
}
