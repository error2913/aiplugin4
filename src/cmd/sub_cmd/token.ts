// .ai token：查看/清除 token 用量记录 + 查看用量限制（配额）状态
import { QuotaManager } from "../../quota/manager";
import type { WindowKey } from "../../quota/types";
import { windowBoundsOf } from "../../quota/window";
import { chartImageCQ, get_chart_url, UsageManager } from "../../usage";
import { aliasToCmd } from "../../utils/alias";
import { M, S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

const WIN_LABEL: Record<WindowKey, string> = { h: '5小时', w: '本周', m: '本月' };
const WIN_ORDER: WindowKey[] = ['h', 'w', 'm'];
const PURPOSE_LABEL: Record<string, string> = {
    summarization: '摘要',
    judge: '判定',
    'image-understanding': '识图',
    'text-embedding': '嵌入',
};
const PURPOSE_ORDER = ['summarization', 'judge', 'image-understanding', 'text-embedding'];

/** 千分位（goja 无 `toLocaleString`，手写） */
const comma = (n: number): string => String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** `0` 与 `Infinity` 都表示不限（配置 0 在判定处折算为 Infinity，渲染时统一走这里） */
const unlimited = (l: number): boolean => !Number.isFinite(l) || l <= 0;
const fmtTokens = (n: number): string => (unlimited(n) ? '不限' : comma(n));
/** 绝不除零：不限时返回 `-` */
const fmtPct = (u: number, l: number): string => (unlimited(l) ? '-' : `${Math.floor((u * 100) / l)}%`);
/** 「预算（≈N万，N%）」；不限时只写「不限」 */
const fmtBudget = (u: number, l: number): string => unlimited(l)
    ? '不限'
    : `${comma(l)}（${l >= 1_000_000 ? `≈${Math.round(l / 10_000)}万，` : ''}${fmtPct(u, l)}）`;
const fmtLeft = (u: number, l: number): string => (unlimited(l) ? '不限' : l - u <= 0 ? '已超限' : comma(l - u));

/** 窗口边界文案：必须复用 P0 的 `windowBoundsOf`（末段 5h 桶实际 4h、周一/月初边界只写一份） */
function fmtReset(w: WindowKey, now: number): string {
    const { start, end } = windowBoundsOf(w, now);
    const p = (n: number) => (n < 10 ? '0' + n : String(n));
    const d = (t: number) => new Date(t);
    if (w === 'h') {
        const m = Math.max(0, Math.floor((end - now) / 60000));
        return `窗口 ${p(d(start).getHours())}:${p(d(start).getMinutes())}-${p(d(end).getHours())}:${p(d(end).getMinutes())}（剩余 ${Math.floor(m / 60)}h${m % 60}m）`;
    }
    const md = (t: number) => `${p(d(t).getMonth() + 1)}-${p(d(t).getDate())}`;
    return `窗口 ${md(start)} 00:00 ~ ${md(end)} 00:00`;
}

const HELP = `帮助:
       【.ai tk lst】查看所有模型
       【.ai tk sum】查看所有模型的token使用记录总和
       【.ai tk all】查看所有模型的token使用记录
       【.ai tk [y/m] (chart)】查看所有模型今年/这个月的token使用记录
       【.ai tk <模型名称>】查看模型的token使用记录
       【.ai tk <模型名称> [y/m] (chart)】查看模型今年/这个月的token使用记录
       【.ai tk use】按用途查看用量（chat/summarization/judge…）+ 当前窗口各用途用量/上限
       【.ai tk quota】查看用量限制状态（三窗口/时段/会话/本人/用途；未启用时显示「仅统计」）
       【.ai tk me】查看本人三窗口用量与个人上限
       【.ai tk rank [5h|week|month] [n]】当前窗口会话用量排行（默认 5h、Top10、n≤50；仅骰主）
       【.ai tk clr】清除token使用记录
       【.ai tk clr <模型名称>】清除token使用记录
       【.ai tk quota clear】清零用量限制计数（不清历史用量记录；仅骰主）`;

/** `.ai tk quota`：三窗口/时段/会话/本人/用途快照；首行四态 */
function doQuotaView({ ctx, msg, sid, uid, ret }: SubCmdContext): seal.CmdExecuteResult {
    const st = QuotaManager.status({ sessionId: sid, userId: uid });
    const k = (w: WindowKey) => st.windows[w];
    const over = WIN_ORDER.find(w => !unlimited(k(w).limit) && k(w).used >= k(w).limit);
    // 注意：`limitOf` 把配置 0 折算成 `Infinity`（`0=不限`），所以这里用 `unlimited` 判，不能比对 `=== 0`
    const allUnlimited = WIN_ORDER.every(w => unlimited(k(w).limit));
    const lines = [st.enabled
        ? (over ? `【用量限制】已启用，当前超限：${WIN_LABEL[over]}窗口`
            : allUnlimited ? '【用量限制】已启用（三个总限制均为 0=不限，不会拦截）' : '【用量限制】已启用')
        : '【用量限制】未启用（仅统计，不拦截）'];
    for (const w of WIN_ORDER) {
        const { used, limit } = k(w);
        lines.push(`${WIN_LABEL[w]}  已用 ${fmtTokens(used)} / ${fmtBudget(used, limit)}  剩余 ${fmtLeft(used, limit)}  ${fmtReset(w, st.now)}`);
    }
    lines.push(st.peakSegment
        ? `时段   命中「${st.peakSegment}」，系数 ${st.peakPercent}（有效预算 = 总限制 × ${Math.round(st.peakPercent * 100)}%）`
        : '时段   未命中，系数 1（有效预算 = 总限制）');
    // 私聊时会话档与个人档同源，合并成一行
    if (st.session && st.user && st.session.used === st.user.used && st.session.limit === st.user.limit) {
        lines.push(`会话   已用 ${fmtTokens(st.session.used)} / ${fmtBudget(st.session.used, st.session.limit)}（私聊：与本人同源）`);
    } else {
        if (st.session) lines.push(`会话   已用 ${fmtTokens(st.session.used)} / ${fmtBudget(st.session.used, st.session.limit)}`);
        if (st.user) lines.push(`本人   已用 ${fmtTokens(st.user.used)} / ${fmtBudget(st.user.used, st.user.limit)}`);
    }
    const cells = PURPOSE_ORDER
        .map(u => (st.purposes[u] ? `${PURPOSE_LABEL[u]} ${fmtTokens(st.purposes[u].used)}/${fmtBudget(st.purposes[u].used, st.purposes[u].limit)}` : ''))
        .filter(Boolean);
    if (cells.length) {
        const sum = PURPOSE_ORDER.reduce((n, u) => n + (st.purposes[u]?.used ?? 0), 0);
        lines.push(`用途   ${cells.slice(0, 2).join('  ')}`);
        if (cells.length > 2) lines.push(`       ${cells.slice(2).join('  ')}`);
        lines.push(`       用途合计 ${fmtTokens(sum)} / ${fmtBudget(sum, k('h').limit)}`);
    }
    seal.replyToSender(ctx, msg, lines.join('\n'));
    return ret;
}

/** `.ai tk me`：本人三窗口（与 status().windows 同源） */
function doQuotaMe({ ctx, msg, uid, ret }: SubCmdContext): seal.CmdExecuteResult {
    if (!uid) {
        seal.replyToSender(ctx, msg, '无法确定你的用户 ID，个人配额不适用');
        return ret;
    }
    const st = QuotaManager.status({ userId: uid });
    const w = QuotaManager.meWindows(uid);
    const lines = [`【本人用量】${st.enabled ? '已启用' : '未启用（仅统计）'}`];
    for (const k of WIN_ORDER) {
        lines.push(`${WIN_LABEL[k]}  已用 ${fmtTokens(w[k].used)} / ${fmtBudget(w[k].used, w[k].limit)}  剩余 ${fmtLeft(w[k].used, w[k].limit)}  ${fmtReset(k, st.now)}`);
    }
    lines.push(ctx.isPrivate
        ? '私聊：会话档与个人档同源，实际预算取两者较小值'
        : '群聊：仅统计你触发的轮次；定时器/事件等无触发者轮次不计入本档');
    seal.replyToSender(ctx, msg, lines.join('\n'));
    return ret;
}

/** `.ai tk rank [5h|week|month] [n]`：会话用量排行（排除子代理） */
function doQuotaRank({ ctx, msg, ret }: SubCmdContext, a3: string, a4: string): seal.CmdExecuteResult {
    const raw = aliasToCmd(a3);
    const win: WindowKey = raw === 'week' || raw === 'w' ? 'w' : raw === 'month' ? 'm' : 'h';
    const n = Math.min(50, Math.max(1, parseInt(a4, 10) || 10));
    const all = QuotaManager.rank(win, 50).filter(r => r.sessionId && !r.sessionId.startsWith('sub:'));
    if (!all.length) {
        seal.replyToSender(ctx, msg, '暂无会话用量记录');
        return ret;
    }
    const limit = QuotaManager.status().windows[win].limit;
    const rows = all.slice(0, n).map((r, i) => `#${i + 1}  ${r.sessionId}  ${comma(r.used)}  ${r.percent === null ? '-' : `${r.percent.toFixed(1)}%`}`);
    rows.push(`（共 ${all.length} 个会话；当前 ${WIN_LABEL[win]}预算 ${fmtTokens(limit)}；仅显示前 ${Math.min(n, all.length)}）`);
    seal.replyToSender(ctx, msg, rows.join('\n'));
    return ret;
}

/** `.ai tk quota clear`：只清配额计数，不动 usageMap（历史用量记录） */
function doQuotaClear({ ctx, msg, ret }: SubCmdContext): seal.CmdExecuteResult {
    QuotaManager.reset();
    seal.replyToSender(ctx, msg, '已清零用量限制计数（quotaUsage）。历史用量记录（usageMap / .ai tk）未变动。');
    return ret;
}

export function registerCmdToken() {
    const cmd = new SubCmd('token');
    cmd.desc = 'token相关操作';
    cmd.help = HELP;
    cmd.priv = {
        priv: S, args: {
            list: { priv: U },
            sum: { priv: U },
            all: { priv: U },
            use: { priv: U },
            year: {
                priv: U, args: {
                    chart: { priv: U }
                }
            },
            month: {
                priv: U, args: {
                    chart: { priv: U }
                }
            },
            clear: { priv: U },
            // 嵌套 args 必需：checkPriv 只在 args 存在时递归，否则 `quota clear` 会按 U 放行
            quota: { priv: U, args: { clear: { priv: M }, "*": { priv: U } } },
            rank: { priv: M },
            me: { priv: U },
            help: { priv: U },
            "*": { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        // 配额子命令必须前置：`default` 分支承担「按模型名查看」，否则 quota 会被当模型名回「没有这个模型」
        const arg2 = aliasToCmd(val2);
        if (arg2 === 'quota') {
            const arg3 = aliasToCmd(cmdArgs.getArgN(3));      // clr → clear
            if (arg3 === 'clear') return doQuotaClear(scc);
            if (arg3 && arg3 !== 'help') {
                seal.replyToSender(ctx, msg, '用法：.ai tk quota | .ai tk quota clear');
                return ret;
            }
            return doQuotaView(scc);
        }
        if (arg2 === 'me') return doQuotaMe(scc);
        if (arg2 === 'rank') return doQuotaRank(scc, cmdArgs.getArgN(3), cmdArgs.getArgN(4));
        switch (arg2) {
            case 'list': {
                const s = Object.keys(UsageManager.usageMap).join('\n');
                seal.replyToSender(ctx, msg, `有使用记录的模型:\n${s}`);
                return ret;
            }
            case 'sum': {
                const usage = {
                    prompt_tokens: 0,
                    completion_tokens: 0
                };

                for (const model in UsageManager.usageMap) {
                    const modelUsage = UsageManager.getModelUsage(model);
                    usage.prompt_tokens += modelUsage.prompt_tokens;
                    usage.completion_tokens += modelUsage.completion_tokens;
                }

                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                }

                const s = `输入token:${usage.prompt_tokens}
       输出token:${usage.completion_tokens}
       总token:${usage.prompt_tokens + usage.completion_tokens}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            case 'all': {
                const s = Object.keys(UsageManager.usageMap).map((model, index) => {
                    const usage = UsageManager.getModelUsage(model);

                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                        return `${index + 1}. ${model}: 没有使用记录`;
                    }

                    return `${index + 1}. ${model}:
         输入token:${usage.prompt_tokens}
         输出token:${usage.completion_tokens}
         总token:${usage.prompt_tokens + usage.completion_tokens}`;
                }).join('\n');

                if (!s) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                }

                seal.replyToSender(ctx, msg, `全部使用记录如下:\n${s}`);
                return ret;
            }
            case 'year': {
                const obj: {
                    [key: string]: {
                        prompt_tokens: number;
                        completion_tokens: number;
                    }
                } = {};
                const now = new Date();
                const currentYear = now.getFullYear();
                const currentMonth = now.getMonth() + 1;
                const currentYM = currentYear * 12 + currentMonth;
                for (const model in UsageManager.usageMap) {
                    const modelUsage = UsageManager.usageMap[model];
                    for (const key in modelUsage) {
                        const usage = modelUsage[key];
                        const [year, month, _] = key.split('-').map(v => parseInt(v));
                        const ym = year * 12 + month;

                        if (ym >= currentYM - 11 && ym <= currentYM) {
                            const key = `${year}-${month}`;
                            if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                                obj[key] = {
                                    prompt_tokens: 0,
                                    completion_tokens: 0
                                };
                            }

                            obj[key].prompt_tokens += usage.prompt_tokens;
                            obj[key].completion_tokens += usage.completion_tokens;
                        }
                    }
                }

                const val3 = cmdArgs.getArgN(3);
                if (val3 === 'chart') {
                    const chart = await get_chart_url('year', obj);
                    seal.replyToSender(ctx, msg, chartImageCQ(chart) || `图表生成失败${chart.error ? `：${chart.error}` : ''}`);
                    return ret;
                }

                const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA] = a.split('-').map(v => parseInt(v));
                    const [yearB, monthB] = b.split('-').map(v => parseInt(v));
                    return (yearA * 12 + monthA) - (yearB * 12 + monthB);
                });

                const s = keys.map(key => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                        return ``;
                    }

                    return `${key}:
         输入token:${usage.prompt_tokens}
         输出token:${usage.completion_tokens}
         总token:${usage.prompt_tokens + usage.completion_tokens}`;
                }).join('\n');

                if (!s) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                }

                seal.replyToSender(ctx, msg, `最近12个月使用记录如下:\n${s}`);
                return ret;
            }
            case 'month': {
                const obj: {
                    [key: string]: {
                        prompt_tokens: number;
                        completion_tokens: number;
                    }
                } = {};
                const now = new Date();
                const currentYear = now.getFullYear();
                const currentMonth = now.getMonth() + 1;
                const currentDay = now.getDate();
                const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
                for (const model in UsageManager.usageMap) {
                    const modelUsage = UsageManager.usageMap[model];
                    for (const key in modelUsage) {
                        const usage = modelUsage[key];
                        const [year, month, day] = key.split('-').map(v => parseInt(v));
                        const ymd = year * 12 * 31 + month * 31 + day;

                        if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                            const key = `${year}-${month}-${day}`;
                            if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                                obj[key] = {
                                    prompt_tokens: 0,
                                    completion_tokens: 0
                                };
                            }

                            obj[key].prompt_tokens += usage.prompt_tokens;
                            obj[key].completion_tokens += usage.completion_tokens;
                        }
                    }
                }

                const val3 = cmdArgs.getArgN(3);
                if (val3 === 'chart') {
                    const chart = await get_chart_url('month', obj);
                    seal.replyToSender(ctx, msg, chartImageCQ(chart) || `图表生成失败${chart.error ? `：${chart.error}` : ''}`);
                    return ret;
                }

                const keys = Object.keys(obj).sort((a, b) => {
                    const [yearA, monthA, dayA] = a.split('-').map(v => parseInt(v));
                    const [yearB, monthB, dayB] = b.split('-').map(v => parseInt(v));
                    return (yearA * 12 * 31 + monthA * 31 + dayA) - (yearB * 12 * 31 + monthB * 31 + dayB);
                });

                const s = keys.map(key => {
                    const usage = obj[key];
                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                        return ``;
                    }

                    return `${key}:
         输入token:${usage.prompt_tokens}
         输出token:${usage.completion_tokens}
         总token:${usage.prompt_tokens + usage.completion_tokens}`;
                }).join('\n');

                seal.replyToSender(ctx, msg, `最近31天使用记录如下:\n${s}`);
                return ret;
            }
            case 'clear': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    UsageManager.clearUsageMap();
                    seal.replyToSender(ctx, msg, '已清除token使用记录');
                    UsageManager.saveUsageMap();
                    return ret;
                }

                if (!Object.prototype.hasOwnProperty.call(UsageManager.usageMap, val3)) {
                    seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                    return ret;
                }

                delete UsageManager.usageMap[val3];
                seal.replyToSender(ctx, msg, `已清除 ${val3} 的token使用记录`);
                UsageManager.saveUsageMap();
                return ret;
            }
            case 'use': {
                // 按用途维度查看用量（P2-4）：purposeUsage 由 updateUsage 的第三参写入
                const purposes = Object.keys(UsageManager.purposeUsage);
                if (purposes.length === 0) {
                    seal.replyToSender(ctx, msg, '暂无按用途的使用记录（旧记录可能只有模型维度）');
                    return ret;
                }
                const rows = purposes.map(use => {
                    const u = UsageManager.getPurposeUsage(use);
                    const total = u.prompt_tokens + u.completion_tokens;
                    return `${use}: 输入 ${u.prompt_tokens} · 输出 ${u.completion_tokens} · 合计 ${total}`;
                });
                const sum = purposes.reduce((n, use) => {
                    const u = UsageManager.getPurposeUsage(use);
                    return n + u.prompt_tokens + u.completion_tokens;
                }, 0);
                let text = `按用途使用记录：\n${rows.join('\n')}\n——\n总计 ${sum} token`;
                // 追加当前窗口的配额用量/上限（媒体用途本就不在 purposes 里，无需过滤）
                const st = QuotaManager.status();
                const cur = PURPOSE_ORDER
                    .map(u => (st.purposes[u] ? `${PURPOSE_LABEL[u]} ${fmtTokens(st.purposes[u].used)}/${fmtBudget(st.purposes[u].used, st.purposes[u].limit)}` : ''))
                    .filter(Boolean);
                if (cur.length) text += `\n——\n当前窗口（${WIN_LABEL.h}）：${cur.join('  ')}`;
                seal.replyToSender(ctx, msg, text);
                return ret;
            }
            case '':
            case 'help': {
                seal.replyToSender(ctx, msg, HELP);
                return ret;
            }
            default: {
                if (!Object.prototype.hasOwnProperty.call(UsageManager.usageMap, val2)) {
                    seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                    return ret;
                }

                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'year': {
                        const obj: {
                            [key: string]: {
                                prompt_tokens: number;
                                completion_tokens: number;
                            }
                        } = {};
                        const now = new Date();
                        const currentYear = now.getFullYear();
                        const currentMonth = now.getMonth() + 1;
                        const currentYM = currentYear * 12 + currentMonth;
                        const model = val2;

                        const modelUsage = UsageManager.usageMap[model];
                        for (const key in modelUsage) {
                            const usage = modelUsage[key];
                            const [year, month, _] = key.split('-').map(v => parseInt(v));
                            const ym = year * 12 + month;

                            if (ym >= currentYM - 11 && ym <= currentYM) {
                                const key = `${year}-${month}`;
                                if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                                    obj[key] = {
                                        prompt_tokens: 0,
                                        completion_tokens: 0
                                    };
                                }

                                obj[key].prompt_tokens += usage.prompt_tokens;
                                obj[key].completion_tokens += usage.completion_tokens;
                            }
                        }

                        const val4 = cmdArgs.getArgN(4);
                        if (val4 === 'chart') {
                            const chart = await get_chart_url('year', obj);
                            seal.replyToSender(ctx, msg, chartImageCQ(chart) || `图表生成失败${chart.error ? `：${chart.error}` : ''}`);
                            return ret;
                        }

                        const keys = Object.keys(obj).sort((a, b) => {
                            const [yearA, monthA] = a.split('-').map(v => parseInt(v));
                            const [yearB, monthB] = b.split('-').map(v => parseInt(v));
                            return (yearA * 12 + monthA) - (yearB * 12 + monthB);
                        });

                        const s = keys.map(key => {
                            const usage = obj[key];
                            if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                                return ``;
                            }

                            return `${key}:
             输入token:${usage.prompt_tokens}
             输出token:${usage.completion_tokens}
             总token:${usage.prompt_tokens + usage.completion_tokens}`;
                        }).join('\n');

                        if (!s) {
                            seal.replyToSender(ctx, msg, `没有使用记录`);
                            return ret;
                        }

                        seal.replyToSender(ctx, msg, `最近12个月使用记录如下:\n${s}`);
                        return ret;
                    }
                    case 'month': {
                        const obj: {
                            [key: string]: {
                                prompt_tokens: number;
                                completion_tokens: number;
                            }
                        } = {};
                        const now = new Date();
                        const currentYear = now.getFullYear();
                        const currentMonth = now.getMonth() + 1;
                        const currentDay = now.getDate();
                        const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;
                        const model = val2;

                        const modelUsage = UsageManager.usageMap[model];
                        for (const key in modelUsage) {
                            const usage = modelUsage[key];
                            const [year, month, day] = key.split('-').map(v => parseInt(v));
                            const ymd = year * 12 * 31 + month * 31 + day;

                            if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                                const key = `${year}-${month}-${day}`;
                                if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                                    obj[key] = {
                                        prompt_tokens: 0,
                                        completion_tokens: 0
                                    };
                                }

                                obj[key].prompt_tokens += usage.prompt_tokens;
                                obj[key].completion_tokens += usage.completion_tokens;
                            }
                        }

                        const val4 = cmdArgs.getArgN(4);
                        if (val4 === 'chart') {
                            const chart = await get_chart_url('month', obj);
                            seal.replyToSender(ctx, msg, chartImageCQ(chart) || `图表生成失败${chart.error ? `：${chart.error}` : ''}`);
                            return ret;
                        }

                        const keys = Object.keys(obj).sort((a, b) => {
                            const [yearA, monthA, dayA] = a.split('-').map(v => parseInt(v));
                            const [yearB, monthB, dayB] = b.split('-').map(v => parseInt(v));
                            return (yearA * 12 * 31 + monthA * 31 + dayA) - (yearB * 12 * 31 + monthB * 31 + dayB);
                        });

                        const s = keys.map(key => {
                            const usage = obj[key];
                            if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                                return ``;
                            }

                            return `${key}:
             输入token:${usage.prompt_tokens}
             输出token:${usage.completion_tokens}
             总token:${usage.prompt_tokens + usage.completion_tokens}`;
                        }).join('\n');

                        seal.replyToSender(ctx, msg, `最近31天使用记录如下:\n${s}`);
                        return ret;
                    }
                    default: {
                        const usage = UsageManager.getModelUsage(val2);

                        if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                            seal.replyToSender(ctx, msg, `没有使用记录`);
                            return ret;
                        }

                        const s = `输入token:${usage.prompt_tokens}
       输出token:${usage.completion_tokens}
       总token:${usage.prompt_tokens + usage.completion_tokens}`;
                        seal.replyToSender(ctx, msg, s);
                        return ret;
                    }
                }
            }
        }
    }
}
