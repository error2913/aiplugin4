// .ai kb：知识库只读查询（list/search/read）
import { knowledgeService } from "../../memory/knowledge";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdKB() {
    const cmd = new SubCmd('kb');
    cmd.desc = '知识库相关操作';
    cmd.help = `帮助:
     【.ai kb list】列出知识库条目索引
     【.ai kb search <关键词>】搜索知识库
     【.ai kb read <ID>】按 ID 读取知识库条目`;
    cmd.priv = {
        priv: U, args: {
            list: { priv: U },
            search: { priv: U, args: { "*": { priv: U } } },
            read: { priv: U, args: { "*": { priv: U } } }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;
        const val2 = aliasToCmd(cmdArgs.getArgN(2));
        switch (val2) {
            case 'list': {
                await knowledgeService.init();
                const index = knowledgeService.formatIndex();
                seal.replyToSender(ctx, msg, index ? index : '知识库为空');
                return ret;
            }
            case 'search': {
                const query = cmdArgs.getRestArgsFrom(3);
                if (!query) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai kb search <关键词>】搜索知识库');
                    return ret;
                }
                await knowledgeService.init();
                const chunks = await knowledgeService.search(query, 5);
                seal.replyToSender(ctx, msg, chunks.length > 0
                    ? chunks.map((c, i) => `${i + 1}. ${knowledgeService.formatChunk(c)}`).join('\n\n')
                    : '未找到相关知识库条目');
                return ret;
            }
            case 'read': {
                const id = cmdArgs.getArgN(3);
                if (!id) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai kb read <ID>】读取知识库条目');
                    return ret;
                }
                await knowledgeService.init();
                const chunk = knowledgeService.read(id);
                seal.replyToSender(ctx, msg, chunk ? knowledgeService.formatChunk(chunk) : `未找到知识库条目:${id}`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
     【.ai kb list】列出知识库条目索引
     【.ai kb search <关键词>】搜索知识库
     【.ai kb read <ID>】按 ID 读取知识库条目`);
                return ret;
            }
        }
    };
}
