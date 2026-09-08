// .ai balance：查询全部（非忽略）api连接的账户余额（只读、不持久化、密钥不进回复/日志）
import { BalanceEntry, describeBalanceError, fetchBalance, resolveBalanceEndpoint } from "../../model/balance";
import Model from "../../model/model";
import { M } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 已知但未开放 API 余额查询的平台 → 控制台入口（host 简化展示） */
const CONSOLE_LINKS: { [provider: string]: string } = {
    openai: 'platform.openai.com/usage',
    anthropic: 'console.anthropic.com',
    google: 'ai.google.dev',
    zhipu: 'open.bigmodel.cn',
    alibaba: 'bailian.console.aliyun.com',
    xai: 'console.x.ai',
    mistral: 'console.mistral.ai',
};

/** 去尾零的小数（10.50 → 10.5；0.00 → 0） */
function trimNum(s: string): string {
    return s.replace(/\.(\d*?)0+$/, (_m, d: string) => (d ? `.${d}` : '')).replace(/\.$/, '');
}

/** 金额展示：CNY ¥ / USD $，其余无符号时附币种名 */
function fmtMoney(v: number, currency: string): string {
    const neg = v < 0;
    const s = trimNum(Math.abs(v).toFixed(2));
    const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
    const tail = sym ? '' : currency ? ` ${currency}` : '';
    return `${neg ? '-' : ''}${sym}${s}${tail}`;
}

function fmtAmount(v: number): string {
    const s = trimNum(Math.abs(v).toFixed(2));
    return v < 0 ? `-${s}` : s;
}

/** 单条余额：可用 + 拆分明细 + 告警 */
function formatEntry(e: BalanceEntry): string {
    const parts = (e.parts ?? [])
        .filter(p => p.amount !== 0)
        .map(p => `${p.label} ${fmtAmount(p.amount)}`);
    const warn = e.availableFlag === false ? '（余额不足）' : e.available < 0 ? '（欠费）' : '';
    return `    可用 ${fmtMoney(e.available, e.currency)}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}${warn}`;
}

/** 无接口文案：已知平台给控制台入口，其余提示自定义配置 */
function unsupportedText(provider: string): string {
    const p = (provider || '').toLowerCase();
    const link = CONSOLE_LINKS[p];
    if (link) return `无余额查询接口（可在控制台查看：${link}）`;
    if (p) return `${provider} 未开放余额查询接口（可在连接 [request] 配置 balance_url 后查询）`;
    return '自定义地址无余额接口（可在连接 [request] 配置 balance_url 后查询）';
}

export function registerCmdBalance() {
    const cmd = new SubCmd('balance');
    cmd.desc = '查询全部 API 连接余额';
    cmd.help = `帮助:
【.ai balance】并发查询全部（非忽略）api连接的账户余额并展示
说明: deepseek / moonshot / siliconflow 内置余额接口，无需配置；其余平台仅提示控制台入口。
      one-api/new-api 等网关可在连接 [request] 配置 balance_url + balance_json_path 后查询。
      单条失败不影响其他连接；超时默认 10s/连接。`;
    cmd.priv = { priv: M };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;
        const conns = Model.balanceConns();
        if (conns.length === 0) {
            seal.replyToSender(ctx, msg, '（未配置任何 api连接）');
            return ret;
        }
        const blocks = await Promise.all(conns.map(async (c) => {
            const head = `[${c.connIndex}] ${c.provider || '(未知)'} · ${c.baseUrl}`;
            const endpoint = resolveBalanceEndpoint(c);
            if (!endpoint) {
                return `${head}\n    ${unsupportedText(c.provider)}`;
            }
            try {
                const entries = await fetchBalance(c);
                if (entries.length === 0) {
                    return `${head}\n    （接口未返回余额数据）`;
                }
                return `${head}\n${entries.map(formatEntry).join('\n')}`;
            } catch (e) {
                const d = describeBalanceError(e);
                return `${head}\n    查询失败：${d.text}`;
            }
        }));
        seal.replyToSender(ctx, msg, `各连接余额（${conns.length} 条）:\n${blocks.join('\n')}`);
        return ret;
    }
}
