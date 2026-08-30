// 触发配置：默认计数器/计时器/概率/活跃时间/触发正则与令牌桶；打分智能体触发参数（TOML 一条配置）
import { load } from 'js-toml'

import Logger from "../../logger";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";
import { getRegexConfig } from "../config";

/** 打分智能体触发配置（由 TOML 解析，缺省字段并入默认值） */
export interface JudgeConfig {
    /** 得分(归一化 0-1)≥该值直接插话 */
    SPEAK_THRESHOLD: number;
    /** 五维权重（加权平均，归一化到 0-10） */
    WEIGHTS: { relevance: number, willingness: number, social: number, timing: number, continuity: number };
    /** 初始精力 */
    ENERGY_INITIAL: number;
    /** 每次触发会话（含其他方式触发）扣除的精力 */
    ENERGY_REPLY_COST: number;
    /** 精力下限，低于该值 gate 拒绝打分 */
    ENERGY_MIN: number;
    /** 每 5 分钟懒恢复的精力 */
    ENERGY_RECOVER_MIN: number;
    /** 每天懒恢复的精力 */
    ENERGY_RECOVER_DAY: number;
    /** 最小回复间隔（秒）：bot 发言/被其他方式触发后在此间隔内 gate 直接 DROP */
    MIN_REPLY_INTERVAL: number;
    /** 注入给打分智能体的最近上下文条数 */
    CONTEXT_COUNT: number;
    /** 单次打分请求超时（秒） */
    TIMEOUT_SEC: number;
    /** JSON 解析失败重试次数 */
    RETRIES: number;
    /** WAIT 冷却时长（秒）：得分<SPEAK_THRESHOLD 时记冷却，期间 gate 直接 DROP；0 表示不冷却 */
    WAIT_COOLDOWN: number;
    /** 每会话每小时最多打分次数，超出后 gate 直接 DROP */
    MAX_JUDGE_PER_HOUR: number;
}

const JUDGE_TOML_DEFAULT = `# 打分智能体触发参数（.ai on --j 开启后生效；缺省字段使用默认值）
speak_threshold = 0.70          # 得分(归一化)≥该值直接插话
wait_cooldown = 60              # 得分<speak_threshold 时的 WAIT 冷却秒数，期间 gate 直接丢弃；0=不冷却
weights = { relevance = 25, willingness = 20, social = 20, timing = 15, continuity = 20 }  # 五维权重
energy_initial = 1.0            # 初始精力
energy_reply_cost = 0.1         # 每次触发会话(含其他方式触发)扣减精力
energy_min = 0.1                # 精力下限，低于该值不再打分
energy_recover_min = 0.02       # 每 5 分钟懒恢复精力
energy_recover_day = 0.2        # 每天懒恢复精力
min_reply_interval = 120        # 最小回复间隔(秒)，间隔内 gate 直接丢弃
context_count = 10              # 注入给打分智能体的最近上下文条数
timeout_sec = 30                # 单次打分请求超时(秒)
retries = 3                     # 打分返回非 JSON 时的重试次数
max_judge_per_hour = 20         # 每会话每小时最多打分次数`;

class JudgeConfigItem {
    static validKeysMap: { [key in keyof JudgeConfigItem]?: TypeDescriptor<JudgeConfigItem[key]> } = {
        speak_threshold: 'number',
        wait_cooldown: 'number',
        weights: { objectValue: 'number' },
        energy_initial: 'number',
        energy_reply_cost: 'number',
        energy_min: 'number',
        energy_recover_min: 'number',
        energy_recover_day: 'number',
        min_reply_interval: 'number',
        context_count: 'number',
        timeout_sec: 'number',
        retries: 'number',
        max_judge_per_hour: 'number'
    }
    speak_threshold: number;
    wait_cooldown: number;
    weights: { relevance: number, willingness: number, social: number, timing: number, continuity: number };
    energy_initial: number;
    energy_reply_cost: number;
    energy_min: number;
    energy_recover_min: number;
    energy_recover_day: number;
    min_reply_interval: number;
    context_count: number;
    timeout_sec: number;
    retries: number;
    max_judge_per_hour: number;
    constructor() {
        this.speak_threshold = 0.70;
        this.wait_cooldown = 60;
        this.weights = { relevance: 25, willingness: 20, social: 20, timing: 15, continuity: 20 };
        this.energy_initial = 1.0;
        this.energy_reply_cost = 0.1;
        this.energy_min = 0.1;
        this.energy_recover_min = 0.02;
        this.energy_recover_day = 0.2;
        this.min_reply_interval = 120;
        this.context_count = 10;
        this.timeout_sec = 30;
        this.retries = 3;
        this.max_judge_per_hour = 20;
    }
}

/** 解析打分智能体 TOML 配置；解析失败或缺省字段时并入默认值，不因缺字段报错 */
function getJudgeConfig(): JudgeConfig {
    const tomlList = seal.ext.getTemplateConfig(ext, "打分智能体触发配置");
    const tomlString = (tomlList || []).find(s => s && s.trim() !== '') || JUDGE_TOML_DEFAULT;
    try {
        const mc = revive(JudgeConfigItem, load(tomlString));
        // weights 是部分覆盖：TOML 里只写了部分维度时，其余并入默认值
        const weights = { ...new JudgeConfigItem().weights, ...(mc.weights || {}) };
        return {
            SPEAK_THRESHOLD: mc.speak_threshold,
            WAIT_COOLDOWN: mc.wait_cooldown,
            WEIGHTS: weights,
            ENERGY_INITIAL: mc.energy_initial,
            ENERGY_REPLY_COST: mc.energy_reply_cost,
            ENERGY_MIN: mc.energy_min,
            ENERGY_RECOVER_MIN: mc.energy_recover_min,
            ENERGY_RECOVER_DAY: mc.energy_recover_day,
            MIN_REPLY_INTERVAL: mc.min_reply_interval,
            CONTEXT_COUNT: mc.context_count,
            TIMEOUT_SEC: mc.timeout_sec,
            RETRIES: mc.retries,
            MAX_JUDGE_PER_HOUR: mc.max_judge_per_hour
        };
    } catch (e) {
        Logger.error(`打分智能体触发配置解析错误，已使用默认值:${e instanceof Error ? e.message : String(e)}`);
        return {
            SPEAK_THRESHOLD: 0.70,
            WAIT_COOLDOWN: 60,
            WEIGHTS: { relevance: 25, willingness: 20, social: 20, timing: 15, continuity: 20 },
            ENERGY_INITIAL: 1.0,
            ENERGY_REPLY_COST: 0.1,
            ENERGY_MIN: 0.1,
            ENERGY_RECOVER_MIN: 0.02,
            ENERGY_RECOVER_DAY: 0.2,
            MIN_REPLY_INTERVAL: 120,
            CONTEXT_COUNT: 10,
            TIMEOUT_SEC: 30,
            RETRIES: 3,
            MAX_JUDGE_PER_HOUR: 20
        };
    }
}

export default class TriggerConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "触发正则表达式", [
            "\\[CQ:at,qq=3893625976\\]",
            "^正确.*[。？！?!]$"
        ], "每行一个正则，任一命中即触发回复（如 @机器人 或包含关键词）；示例：^你好.*；修改后自动生效（缓存最多 1 分钟）", "消息触发");
        seal.ext.registerIntConfig(ext, "默认计数器", 10, "计数器模式下达到该条数触发回复", "消息触发");
        seal.ext.registerFloatConfig(ext, "默认计时器", 60, "计时器模式下间隔多少秒触发回复", "消息触发");
        seal.ext.registerFloatConfig(ext, "默认概率", 10, "概率模式下每条消息触发回复的概率（%）", "消息触发");
        seal.ext.registerStringConfig(ext, "默认触发活跃时间", "10:00-20:00-5", "格式：HH:mm-HH:mm-次数，示例 10:00-20:00-5 表示 10:00-20:00 之间最多触发 5 次", "消息触发");
        seal.ext.registerStringConfig(ext, "触发需要满足的条件", '1', "额外的豹语表达式条件，命中为 1 才触发；示例：$t群号_RAW=='2001'，不需要额外条件时填 1", "消息触发");
        seal.ext.registerIntConfig(ext, "触发次数上限", 3, "消息触发令牌桶容量，达到上限后需等待补充", "消息触发");
        seal.ext.registerIntConfig(ext, "触发次数补充间隔", 3, "令牌桶补充间隔（秒）", "消息触发");
        seal.ext.registerTemplateConfig(ext, "打分智能体触发配置", [
            JUDGE_TOML_DEFAULT
        ], "打分智能体触发（.ai on --j）的参数，TOML 格式，缺省字段使用默认值。修改后自动生效（缓存最多 1 分钟）", "消息触发");
    }

    static get() {
        return {
            COUNTER: seal.ext.getIntConfig(ext, "默认计数器"),
            TIMER: seal.ext.getFloatConfig(ext, "默认计时器"),
            PROBABILITY: seal.ext.getFloatConfig(ext, "默认概率"),
            ACTIVE_TIME: seal.ext.getStringConfig(ext, "默认触发活跃时间"),
            TRIGGER_REGEX: getRegexConfig(ext, "触发正则表达式"),
            TRIGGER_CONDITION: seal.ext.getStringConfig(ext, "触发需要满足的条件"),
            BUCKET_LIMIT: seal.ext.getIntConfig(ext, "触发次数上限"),
            FILL_INTERVAL: seal.ext.getIntConfig(ext, "触发次数补充间隔"),
            JUDGE: getJudgeConfig()
        }
    }
}
