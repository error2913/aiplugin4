import { ConfigManager } from "../config/config";
import { Tool, ToolInfo, ToolManager } from "./tool";

const baseurl = "http://meme.lovesealdice.online/";

interface MemeInfo {
    params_type: {
        min_texts: number,
        max_texts: number,
        min_images: number,
        max_images: number,
    }
}

async function getInfo(name: string): Promise<{ key: string, info: MemeInfo }> {
    try {
        const res1 = await fetch(baseurl + name + "/key");
        const json1 = await res1.json();
        const key = json1.result;
        const res2 = await fetch(baseurl + key + "/info");
        const json2 = await res2.json();
        return { key, info: json2 };
    } catch (err) {
        throw new Error("获取表情包信息失败");
    }
}

export function registerMeme() {
    const list_info: ToolInfo = {
        type: "function",
        function: {
            name: "meme_list",
            description: `访问可用表情包列表`,
            parameters: {
                type: "object",
                properties: {
                },
                required: [] // 必需参数
            }
        }
    }

    const tool_list = new Tool(list_info); // 创建一个新tool
    tool_list.solve = async (_, __, ___, ____) => { // 实现方法，返回字符串提供给AI
        try {
            const res = await fetch(baseurl + "get_command");
            const json = await res.json();
            return json.map((item: string[]) => item[0]).join("、");
        } catch (err) {
            return "获取表情包列表失败:" + err.message;
        }
    }

    const generator_info: ToolInfo = {
        type: "function",
        function: {
            name: "meme_generator",
            description: `制作表情包,使用之前需要调用 meme_list获取可用表情包列表`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "表情包名字,为 meme_list 返回的结果"
                    },
                    text: {
                        type: "array",
                        items: { type: "string" },
                        description: "文字列表"
                    },
                    members: {
                        type: "array",
                        items: { type: "string" },
                        description: '被用来绘制meme的用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                },
                required: ["name", "text", "members"] // 必需参数
            }
        }
    }

    const tool_generator = new Tool(generator_info); // 创建一个新tool
    tool_generator.solve = async (ctx, msg, ai, args) => { // 实现方法，返回字符串提供给AI
        const { name, text = [], members = [] } = args;

        const { key, info: limit } = await getInfo(name);
        if (text.length > limit.params_type.max_texts || text.length < limit.params_type.min_texts) {
            return `文字数量错误,该表情包文字范围为 ${limit.params_type.min_texts} - ${limit.params_type.max_texts} 段,用户范围为 ${limit.params_type.min_images} - ${limit.params_type.max_images} 名`;
        }
        if (members.length > limit.params_type.max_images || members.length < limit.params_type.min_images) {
            return `用户数量错误,该表情包文字范围为 ${limit.params_type.min_texts} - ${limit.params_type.max_texts} 段,用户范围为 ${limit.params_type.min_images} - ${limit.params_type.max_images} 名`;
        }

        const image = [];
        for (const name of members) {
            const uid = await ai.context.findUserId(ctx, name);
            if (uid === null) {
                return `未找到<${name}>`;
            }
            image.push(`https://q.qlogo.cn/headimg_dl?dst_uin=${uid.replace(/\D/g, "")}&spec=640&img_type=jpg`);
        }

        try {
            const res = await fetch(baseurl + "meme_generate", {
                method: "POST",
                body: JSON.stringify({
                    key,
                    text,
                    image,
                    args: {}
                }),
            });

            const json = await res.json();
            if (json.status == "success") {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${seal.base64ToImage(json.message)}]`)
                return "发送成功";
            } else {
                throw new Error(json.message);
            }
        } catch (err) {
            return "生成表情包失败:" + err.message;
        }
    }

    // 注册到toolMap中
    ToolManager.toolMap[list_info.function.name] = tool_list;
    ToolManager.toolMap[generator_info.function.name] = tool_generator;
}