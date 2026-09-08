// .ai skill：查看 / 开关 / refresh 技能（按当前平台 + 会话级启用）
import { getSkillNames, getSkillViews, refreshSkills, SKILL_LIST_LIMIT } from "../../tool/skills";
import { matchesPlatform, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function helpText(): string {
    return `帮助: 技能管理
  【.ai skill list】列出当前平台可用的技能及会话开关状态
  【.ai skill on/off <技能名>】开启/关闭指定技能（按会话）
  【.ai skill refresh】重新解析「技能配置」（骰主）
  说明：技能开关按会话保存；平台限制来自技能 frontmatter 的 platform 字段`;
}

export function registerCmdSkill() {
    const cmd = new SubCmd('skill');
    cmd.desc = '技能管理（list/on/off/refresh）';
    cmd.help = helpText();
    cmd.priv = { priv: U, args: { on: { priv: I }, off: { priv: I }, refresh: { priv: M }, '*': { priv: U } } };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const platform = platformOf(ctx);
        const op = aliasToCmd(cmdArgs.getArgN(2));

        switch (op) {
            case '': {
                seal.replyToSender(ctx, msg, helpText());
                return ret;
            }
            case 'list': {
                const views = getSkillViews(
                    s => matchesPlatform(s.platforms, platform),
                    name => session.skillState[name] !== false
                );
                if (views.length === 0) {
                    seal.replyToSender(ctx, msg, '当前平台没有可用技能（未配置或平台不匹配）。配置修改后 .ai skill refresh 生效。');
                    return ret;
                }
                const page = scc.page || 1;
                const size = SKILL_LIST_LIMIT;
                const start = (page - 1) * size;
                const items = views.slice(start, start + size);
                const lines = [`技能列表（共 ${views.length} 个，当前平台）:`];
                items.forEach((v, i) => {
                    const plat = v.platforms && v.platforms.length > 0 ? `（平台：${v.platforms.join('/')}）` : '';
                    lines.push(`${start + i + 1}. ${v.name}${plat}: ${v.description || '(无描述)'}[${v.enabled ? '开' : '关'}]`);
                });
                lines.push(`当前第 ${page} 页，共 ${Math.max(1, Math.ceil(views.length / size))} 页；.ai skill on/off <名称> 切换。`);
                seal.replyToSender(ctx, msg, lines.join('\n'));
                return ret;
            }
            case 'on':
            case 'off': {
                const val3 = cmdArgs.getArgN(3);
                const name = String(val3 || '').trim();
                if (!name) {
                    seal.replyToSender(ctx, msg, `.ai skill ${op} 需要技能名；用 .ai skill list 查看`);
                    return ret;
                }
                const known = getSkillNames();
                if (!known.includes(name)) {
                    seal.replyToSender(ctx, msg, `技能 ${name} 不存在；用 .ai skill list 查看`);
                    return ret;
                }
                if (op === 'on') {
                    delete session.skillState[name];
                    seal.replyToSender(ctx, msg, `已开启技能 ${name}（本会话）`);
                } else {
                    session.skillState[name] = false;
                    seal.replyToSender(ctx, msg, `已关闭技能 ${name}（本会话）`);
                }
                session.save();
                return ret;
            }
            case 'refresh': {
                refreshSkills();
                seal.replyToSender(ctx, msg, `技能配置已重新解析，共 ${getSkillNames().length} 个技能。`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `未知操作: ${op}\n${helpText()}`);
                return ret;
            }
        }
    };
}
