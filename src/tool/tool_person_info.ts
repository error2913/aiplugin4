import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";
import { getStrangerInfo, netExists } from "../utils/utils_ob11";

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
    tool.solve = async (ctx, _, ai, args) => {
        const { name } = args;

        if (!netExists()) return { content: `未找到ob11网络连接依赖，请提示用户安装`, images: [] };

        const ui = await ai.context.findUserInfo(ctx, name, true);
        if (ui === null) return { content: `未找到<${name}>`, images: [] };

        const epId = ctx.endPoint.userId;

        const strangerInfo = await getStrangerInfo(epId, ui.id.replace(/^.+:/, ''));
        if (!strangerInfo) return { content: `获取用户${ui.id}信息失败`, images: [] };

        let s = `昵称: ${strangerInfo.nickname}
QQ号: ${strangerInfo.user_id}
性别: ${strangerInfo.sex}
QQ等级: ${strangerInfo.qqLevel}
是否为VIP: ${strangerInfo.is_vip}
是否为年费会员: ${strangerInfo.is_years_vip}`;
        if (strangerInfo.remark) s += `\n备注: ${strangerInfo.remark}`;
        if (strangerInfo.birthday_year && strangerInfo.birthday_year !== 0) s += `\n年龄: ${strangerInfo.age}
生日: ${strangerInfo.birthday_year}-${strangerInfo.birthday_month}-${strangerInfo.birthday_day}
星座: ${constellations[strangerInfo.constellation - 1]}
生肖: ${shengXiao[strangerInfo.shengXiao - 1]}`;
        if (strangerInfo.pos) s += `\n位置: ${strangerInfo.pos}`;
        if (strangerInfo.country) s += `\n所在地: ${strangerInfo.country} ${strangerInfo.province} ${strangerInfo.city}`;
        if (strangerInfo.address) s += `\n地址: ${strangerInfo.address}`;
        if (strangerInfo.eMail) s += `\n邮箱: ${strangerInfo.eMail}`;
        if (strangerInfo.interest) s += `\n兴趣: ${strangerInfo.interest}`;
        if (strangerInfo.labels && strangerInfo.labels.length > 0) s += `\n标签: ${strangerInfo.labels.join(',')}`;
        if (strangerInfo.long_nick) s += `\n个性签名: ${strangerInfo.long_nick}`;

        return { content: s, images: [] };
    }
}