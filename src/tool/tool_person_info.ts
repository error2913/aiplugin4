import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool } from "./tool";

const constellations = ["水瓶座", "双鱼座", "白羊座", "金牛座", "双子座", "巨蟹座", "狮子座", "处女座", "天秤座", "天蝎座", "射手座", "摩羯座"];
const shengXiao = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];

export function registerGetPersonInfo() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'get_person_info',
            description: '获取用户信息',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    }
                },
                required: ['name']
            }
        }
    });
    tool.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };
        }

        const uid = await ai.context.findUserId(ctx, name, true);
        if (uid === null) {
            return { content: `未找到<${name}>`, images: [] };
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        try {
            const epId = ctx.endPoint.userId;
            const user_id = ctx.player.userId.replace(/^.+:/, '');
            const data = await net.callApi(epId, `get_stranger_info?user_id=${user_id}`);

            let s = `昵称: ${data.nickname}
QQ号: ${data.user_id}
性别: ${data.sex}
QQ等级: ${data.qqLevel}
是否为VIP: ${data.is_vip}
是否为年费会员: ${data.is_years_vip}`;

            if (data.remark) s += `\n备注: ${data.remark}`;
            if (data.birthday_year && data.birthday_year !== 0) {
                s += `\n年龄: ${data.age}
生日: ${data.birthday_year}-${data.birthday_month}-${data.birthday_day}
星座: ${constellations[data.constellation - 1]}
生肖: ${shengXiao[data.shengXiao - 1]}`;
            }
            if (data.pos) s += `\n位置: ${data.pos}`;
            if (data.country) s += `\n所在地: ${data.country} ${data.province} ${data.city}`;
            if (data.address) s += `\n地址: ${data.address}`;
            if (data.eMail) s += `\n邮箱: ${data.eMail}`;
            if (data.interest) s += `\n兴趣: ${data.interest}`;
            if (data.labels && data.labels.length > 0) s += `\n标签: ${data.labels.join(',')}`;
            if (data.long_nick) s += `\n个性签名: ${data.long_nick}`;

            return { content: s, images: [] };
        } catch (e) {
            logger.error(e);
            return { content: `获取用户信息失败`, images: [] };
        }
    }
}