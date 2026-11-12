// `kind:'mcp'` 内置注入 provider（#163 D3 / D4-05）。
//
// 语义：
// 1. 粒度：**每个 MCP 服务器一个条目**，去重键 `mcp:<server>`（正文变化时由框架按 `r` 判 `updated`）；
// 2. 来源：`src/prompt/sections/mcp.ts` 的 instructions provider（装配时由 tool/mcp 注册；
//    未注册 ⇒ 返回空，不发起任何网络请求）；
// 3. 正文：直接复用 legacy 段的 `renderMcpInstructions` 渲染（含单服务器 1000 字符截断与
//    外部内容防注入提示），保证 D3 注入块与旧 runtime 段文本一致；
// 4. 按 `k` 拒发：已存在同 key 的活跃块时返回空，避免正文微变导致每轮重写（与 time 同类）。
import type { InjectionItem } from "../../context/injections";
import { platformOf } from "../../utils/target_id";
import { getMcpInstructionsProvider, renderMcpInstructions } from "../sections/mcp";
import type { InjectionContext, InjectionProvider } from "../types";

import { makeItem } from "./keys";

/** 构造 mcp provider（order 300：同 anchor 的渲染顺序 time → memory → mcp） */
export function createMcpProvider(): InjectionProvider {
    return {
        name: 'core:mcp',
        kind: 'mcp',
        order: 300,
        // MCP 只是可选背景信息：provider 抛错/未装配都不能让整轮请求失败
        optional: true,
        build(c: InjectionContext): InjectionItem[] {
            const provider = getMcpInstructionsProvider();
            if (!provider) return [];
            // provider 只按平台过滤并返回已缓存的文本，不发起网络请求
            const entries = provider(platformOf(c.ctx));
            if (!Array.isArray(entries) || entries.length === 0) return [];
            const activeKeys = c.listActiveKeys();
            const items: InjectionItem[] = [];
            const seen = new Set<string>();
            for (const entry of entries) {
                const server = String(entry?.server ?? '').trim();
                if (!server) continue;
                const key = `mcp:${server}`;
                // 同一 server 重复出现只取第一条（provider 实现错误时也不产生重复条目）
                if (seen.has(key)) continue;
                seen.add(key);
                if (activeKeys.has(key)) continue;
                const text = renderMcpInstructions([entry]);
                if (!text.trim()) continue;
                items.push(makeItem(key, text));
            }
            return items;
        },
    };
}
