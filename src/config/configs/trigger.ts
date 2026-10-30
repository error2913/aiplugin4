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

/** 「默认定时器」TOML 默认示例：多 [[timer]]，参数与 set_timer / 链 timer 门完全一致（含 prompts） */
const TIMER_TOML_DEFAULT = `# 默认定时器（.ai trg timer on 后按此计划触发；可写多个 [[timer]]）
# 参数与 set_timer 完全一致：types(timer 型) / years / months / days / hours / minutes / count / prompts
# [[timer]]
# types = "interval"
# hours = 12
# count = -1
# prompts = ["该休息一下了", "提醒你喝水"]`;

/** 「默认定时器」解析结果；VALID=false 时 `trg timer on` 应拒绝开启 */
export interface TimerTomlConfig {
    VALID: boolean;
    SPECS: NormalizedTimerSpec[];
    ERRORS: string[];
}

let timerTomlCache: TimerTomlConfig | null = null;

/** 解析「默认定时器」多 [[timer]]：单条非法 WARN 跳过；整份非法报错且拒绝 */
function getTimerTomlConfig(): TimerTomlConfig {
    if (timerTomlCache) return timerTomlCache;
    const text = seal.ext.getStringConfig(ext, "默认定时器") || '';
    if (!text.trim()) {
        timerTomlCache = { VALID: true, SPECS: [], ERRORS: [] };
        return timerTomlCache;
    }
    const errors: string[] = [];
    const specs: NormalizedTimerSpec[] = [];
    try {
        const doc = load(text) as Record<string, unknown>;
        const rawList = doc.timer;
        const list = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
        list.forEach((entry, index) => {
            const result = validateTimerSpec(entry);
            if (!result.ok || !result.spec) {
                const message = `默认定时器第 ${index + 1} 条：${result.errors.join('；')}`;
                Logger.warning(`${message}（已跳过）`);
                errors.push(message);
                return;
            }
            specs.push(result.spec);
        });
    } catch (e) {
        const message = `默认定时器 TOML 解析失败：${e instanceof Error ? e.message : String(e)}`;
        Logger.error(message);
        timerTomlCache = { VALID: false, SPECS: [], ERRORS: [message] };
        return timerTomlCache;
    }
    timerTomlCache = { VALID: true, SPECS: specs, ERRORS: errors };
    return timerTomlCache;
}

/** 仅供单元测试使用：清空「默认定时器」缓存 */
export function resetTimerTomlConfigCacheForTest(): void {
    timerTomlCache = null;
}

export default class TriggerConfig {
    static register() {
        // 触发页顺序（= TRIGGER_CONFIG_KEYS）：3 个全局键 + 按模式 token 字母序（active/counter/delay/event/judge/prob/regex/timer）
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
        seal.ext.registerStringConfig(ext, "评分触发参数", JUDGE_TOML_DEFAULT, "评分触发（.ai trg judge on）的参数，TOML 分段格式（[scoring]/[weights]/[energy]/[gate]/[model]），缺省段或字段使用默认值。修改后需重载 JS 生效", "触发");
        seal.ext.registerFloatConfig(ext, "默认概率", 10, "概率模式下每条消息触发回复的概率（%）", "触发");
        // 默认正则不再包含 at CQ：@ 触发由独立的 at 模式（默认开）判定
        seal.ext.registerTemplateConfig(ext, "触发正则表达式", [
            "^正确.*[。？！?!]$"
        ], "每框一个正则，任一命中即触发回复（不含 @，@ 由 at 模式处理）；示例：^你好.*；修改后需重载 JS 生效", "触发");
        seal.ext.registerStringConfig(ext, "默认定时器", TIMER_TOML_DEFAULT, "timer 模式的计划表：可写多个 [[timer]]，参数与 set_timer 完全一致（types/years/months/days/hours/minutes/count/prompts）。.ai trg timer on 后按此表为每个会话注册定时器", "触发");
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
