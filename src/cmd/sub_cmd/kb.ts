// .ai kb：知识库查看 / 开关 / refresh（按当前平台 + 会话级启用）
import { knowledgeService } from "../../memory/knowledge";
import { matchesPlatform, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function helpText(): string {
    return `帮助: 知识库管理
  【.ai kb list】列出当前平台可用的知识库及会话开关状态
  【.ai kb on/off <库ID或名称>】开启/关闭指定知识库（按会话；名称唯一匹配时也可用）
  【.ai kb refresh】重新解析「知识库」配置（骰主）
  说明：知识库开关按会话保存；平台限制来自库 frontmatter 的 platform 字段；内容修改后用 refresh 生效`;
}

/** 按库 ID 或唯一名称解析目标库 */
function resolveLibrary(arg: string, libs: { id: string; name: string }[]): { id: string; name: string } | string {
    const exact = libs.find(l => l.id === arg || l.name === arg);
    if (exact) return exact;
    const fuzzy = libs.filter(l => l.name.includes(arg));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length === 0) return `未找到知识库:${arg}；用 .ai kb list 查看`;
    return `名称「${arg}」匹配多个库，请用库 ID：${fuzzy.map(l => l.id).join('、')}`;
}

export function registerCmdKb() {
    const cmd = new SubCmd('kb');
    cmd.desc = '知识库管理（list/on/off/refresh）';
    cmd.help = helpText();
    cmd.priv = { priv: U, args: { on: { priv: I }, off: { priv: I }, refresh: { priv: M }, '*': { priv: U } } };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret, page } = scc;
        const platform = platformOf(ctx);
        const op = aliasToCmd(cmdArgs.getArgN(2));

        switch (op) {
            case '': {
                seal.replyToSender(ctx, msg, helpText());
                return ret;
            }
            case 'list': {
                await knowledgeService.init();
                const all = knowledgeService.getLibraries();
                const libs = all.filter(l =>
                    matchesPlatform(l.platforms, platform) && session.kbState[l.id] !== false
                );
                if (libs.length === 0) {
                    seal.replyToSender(ctx, msg, '当前平台没有可用知识库（未配置或平台不匹配）。配置修改后 .ai kb refresh 生效。');
                    return ret;
                }
                const size = 100;
                const start = (page - 1) * size;
                const items = libs.slice(start, start + size);
                const lines = [`知识库列表（共 ${libs.length} 个，当前平台）:`];
                items.forEach((l, i) => {
                    const plat = l.platforms && l.platforms.length > 0 ? `（平台：${l.platforms.join('/')}）` : '';
                    lines.push(`${start + i + 1}. [${l.id}] ${l.name}${plat}: ${l.description || '(无描述)'}[开]`);
                });
                lines.push(`当前第 ${page} 页，共 ${Math.max(1, Math.ceil(libs.length / size))} 页；.ai kb on/off <ID或名称> 切换，knowledge_* 工具只读检索。`);
                seal.replyToSender(ctx, msg, lines.join('\n'));
                return ret;
            }
            case 'on':
            case 'off': {
                const val3 = cmdArgs.getArgN(3);
                const arg = String(val3 || '').trim();
                if (!arg) {
                    seal.replyToSender(ctx, msg, `.ai kb ${op} 需要库 ID 或名称；用 .ai kb list 查看`);
                    return ret;
                }
                await knowledgeService.init();
                const all = knowledgeService.getLibraries();
                const target = resolveLibrary(arg, all);
                if (typeof target === 'string') {
                    seal.replyToSender(ctx, msg, target);
                    return ret;
                }
                if (op === 'on') {
                    delete session.kbState[target.id];
                    seal.replyToSender(ctx, msg, `已开启知识库 ${target.name}（本会话）`);
                } else {
                    session.kbState[target.id] = false;
                    seal.replyToSender(ctx, msg, `已关闭知识库 ${target.name}（本会话）`);
                }
                session.save();
                return ret;
            }
            case 'refresh': {
                const result = await knowledgeService.refresh();
                seal.replyToSender(ctx, msg, `知识库配置已重新解析：${result.libraries} 个库，${result.chunks} 个分块。`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `未知操作: ${op}\n${helpText()}`);
                return ret;
            }
        }
    };
}
