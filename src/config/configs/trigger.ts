// 触发配置：默认计数器/计时器/概率/活跃时间/触发正则与令牌桶；评分触发参数（TOML 一条配置）
import { load } from 'js-toml'

import Logger from "../../logger";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";
import { getRegexConfig } from "../config";

/** 评分触发配置（TOML 分段解析，缺省段/字段并入默认值） */
export interface JudgeConfig {
    /** 判定：得分(0-1)≥该值直接插话；WAIT 冷却秒数（0=不冷却） */
    SCORING: { speak_threshold: number; wait_cooldown: number };
    /** 五维权重（加权平均，归一化到 0-10） */
    WEIGHTS: { relevance: number; willingness: number; social: number; timing: number; continuity: number };
    /** 精力（0-100）：仅 SPEAK 插话成功扣减；每 5 分钟懒恢复 */
    ENERGY: { initial: number; reply_cost: number; recover_min: number };
    /** 门禁限额 */
    GATE: { min_reply_interval: number; max_judge_per_hour: number };
    /** 评分小模型调用 */
    MODEL: { context_count: number; timeout_sec: number; retries: number };
}

const JUDGE_TOML_DEFAULT = `# 评分触发参数（.ai on --j 开启后生效；缺省段/字段使用默认值）
[scoring]                       # 判定
speak_threshold = 0.70          # 得分(0-1)≥该值直接插话
wait_cooldown = 60              # 得分<speak_threshold 时的 WAIT 冷却秒数，期间 gate 直接丢弃；0=不冷却

[weights]                       # 五维权重
relevance = 25
willingness = 20
social = 20
timing = 15
continuity = 20

[energy]                        # 精力(0-100)
initial = 100                   # 初始精力
reply_cost = 5                  # 每次 SPEAK 插话成功扣减精力（0.05×100，精力为 0-100 整数）
recover_min = 4                 # 每 5 分钟懒恢复精力

[gate]                          # 门禁限额
min_reply_interval = 120        # 最小回复间隔(秒)，间隔内 gate 直接丢弃
max_judge_per_hour = 20         # 每会话每小时最多评分次数

[model]                         # 评分小模型调用
context_count = 10              # 注入给评分智能体的最近上下文条数
timeout_sec = 30                # 单次评分请求超时(秒)
retries = 3                     # 评分返回非 JSON 时的重试次数`;

class JudgeConfigItem {
    static validKeysMap: { [key in keyof JudgeConfigItem]?: TypeDescriptor<JudgeConfigItem[key]> } = {
        scoring: { object: { speak_threshold: 'number', wait_cooldown: 'number' } },
        weights: { object: { relevance: 'number', willingness: 'number', social: 'number', timing: 'number', continuity: 'number' } },
        energy: { object: { initial: 'number', reply_cost: 'number', recover_min: 'number' } },
        gate: { object: { min_reply_interval: 'number', max_judge_per_hour: 'number' } },
        model: { object: { context_count: 'number', timeout_sec: 'number', retries: 'number' } }
    }
    scoring: { speak_threshold: number; wait_cooldown: number };
    weights: { relevance: number, willingness: number, social: number, timing: number, continuity: number };
    energy: { initial: number; reply_cost: number; recover_min: number };
    gate: { min_reply_interval: number; max_judge_per_hour: number };
    model: { context_count: number; timeout_sec: number; retries: number };
    constructor() {
        this.scoring = { speak_threshold: 0.70, wait_cooldown: 60 };
        this.weights = { relevance: 25, willingness: 20, social: 20, timing: 15, continuity: 20 };
        this.energy = { initial: 100, reply_cost: 5, recover_min: 4 };
        this.gate = { min_reply_interval: 120, max_judge_per_hour: 20 };
        this.model = { context_count: 10, timeout_sec: 30, retries: 3 };
    }
}

/** 解析评分智能体 TOML 配置；解析失败或缺省段/字段时并入默认值，不因缺字段报错 */
function getJudgeConfig(): JudgeConfig {
    const tomlList = seal.ext.getTemplateConfig(ext, "评分触发配置");
    const tomlString = (tomlList || []).find(s => s && s.trim() !== '') || JUDGE_TOML_DEFAULT;
    const d = new JudgeConfigItem();
    try {
        const mc = revive(JudgeConfigItem, load(tomlString));
        // 每段都是部分覆盖：TOML 里只写了部分键时，其余并入默认值
        return {
            SCORING: { ...d.scoring, ...(mc.scoring || {}) },
            WEIGHTS: { ...d.weights, ...(mc.weights || {}) },
            ENERGY: { ...d.energy, ...(mc.energy || {}) },
            GATE: { ...d.gate, ...(mc.gate || {}) },
            MODEL: { ...d.model, ...(mc.model || {}) }
        };
    } catch (e) {
        Logger.error(`评分触发配置解析错误，已使用默认值:${e instanceof Error ? e.message : String(e)}`);
        return {
            SCORING: { speak_threshold: 0.70, wait_cooldown: 60 },
            WEIGHTS: { relevance: 25, willingness: 20, social: 20, timing: 15, continuity: 20 },
            ENERGY: { initial: 100, reply_cost: 5, recover_min: 4 },
            GATE: { min_reply_interval: 120, max_judge_per_hour: 20 },
            MODEL: { context_count: 10, timeout_sec: 30, retries: 3 }
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
        seal.ext.registerTemplateConfig(ext, "评分触发配置", [
            JUDGE_TOML_DEFAULT
        ], "评分触发（.ai on --j）的参数，TOML 分段格式（[scoring]/[weights]/[energy]/[gate]/[model]），缺省段或字段使用默认值。修改后自动生效（缓存最多 1 分钟）", "消息触发");
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
