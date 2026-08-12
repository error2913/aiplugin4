// .ai image：图片管理（本地/识别/查找）
import Image from "../../resource/image";
import { transformArrayToContent, transformTextToArray } from "../../utils/string";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdImage() {
    const cmd = new SubCmd('image');
    cmd.desc = '图片相关操作';
    cmd.help = `帮助:
 【.ai img list [lcl]】展示本地图片
 【.ai img itt [图片] (附加提示词)】图片转文字
 【.ai img find <图片ID>】查找图片`;
    cmd.priv = {
        priv: U, args: {
            list: {
                priv: U, args: {
                    local: { priv: M }
                }
            },
            itt: { priv: M },
            find: { priv: I }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, page, ret  } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'list': {
                const type = cmdArgs.getArgN(3);
                switch (aliasToCmd(type)) {
                    case 'local': {
                        seal.replyToSender(ctx, msg, Image.getLocalImageListText(page) || '暂无本地图片');
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, '【.ai img list [lcl]】展示本地图片');
                        return ret;
                    }
                }
            }
            case 'itt': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    seal.replyToSender(ctx, msg, '【.ai img itt [图片] (附加提示词)】图片转文字');
                    return ret;
                }
                const messageArray = transformTextToArray(val3);
                const { images } = await transformArrayToContent(ctx, messageArray);
                if (images.length === 0) seal.replyToSender(ctx, msg, '请附带图片');
                const img = images[0];
                if (!img) return ret;
                await img.imageToText(cmdArgs.getRestArgsFrom(4))
                seal.replyToSender(ctx, msg, img.CQCode + `\n` + img.description);
                return ret;
            }
            case 'find': {
                const id = cmdArgs.getArgN(3);
                if (!id) {
                    seal.replyToSender(ctx, msg, '【.ai img find <图片ID>】查找图片');
                    return ret;
                }
                const img = await session.context.findImage(ctx, id);
                seal.replyToSender(ctx, msg, img ? img.CQCode : '未找到该图片');
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
 【.ai img list [lcl]】展示本地图片
 【.ai img itt [图片] (附加提示词)】图片转文字
 【.ai img find <图片ID>】查找图片`);
                return ret;
            }
        }
    }
}
