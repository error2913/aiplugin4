import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerMeme() {
    const list_info: ToolInfo = {
        type: "function",
        function: {
            name: "meme_list",
            description: `访问可用表情包列表，配合 meme_key 使用,将返回的结果选择其中一个用于调用 meme_key 的 name 参数`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "随便输入一个，输入该参数防止输入内容不被解析为 json 而报错"
                    }

                },
                required: ["name"] // 必需参数
            }
        }
    }

    const tool_list = new Tool(list_info); // 创建一个新tool
    const baseurl = "http://meme.lovesealdice.online/";
    tool_list.solve = async (_, __, ___, ____) => { // 实现方法，返回字符串提供给AI
        return await fetch(baseurl + "get_command").then(res => res.json())
            .then(json => { return JSON.stringify(json) }).catch(_ => { return "api 失效，请等待修复。" });
    }

    const get_key = async (name: string) => {
        return await fetch(baseurl + name + "/key").then(res => res.json())
            .then(json => { return json }).catch(err => { return "Error: " + err.message });
    }

    const get_info = async (key: string) => {
        return await fetch(baseurl + key + "/info").then(res => res.json())
            .then(json => { return json }).catch(err => { return "Error: " + err.message });
    }

    const generator_info: ToolInfo = {
        type: "function",
        function: {
            name: "meme_generotor",
            description: `制作表情包,使用之前需要必须调用 meme_list`,
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
                    image: {
                        type: "array",
                        items: { type: "string" },
                        description: "使用群友的头像作为参数,格式为 [CQ:at,qq=${QQ号}]"
                    },
                },
                required: ["name"] // 必需参数
            }
        }
    }

    const tool_generator = new Tool(generator_info); // 创建一个新tool
    tool_generator.solve = async (ctx, msg, _, args) => { // 实现方法，返回字符串提供给AI
        let { text, image } = args;
        const key = await get_key(args.name).then(res => { return res.result }).catch(err => { return "Error: " + err.message });
        const limit = await get_info(key).then(res => { return res }).catch(err => { return "Error: " + err.message });
        if (text?.length == undefined) text = []; if (image?.length == undefined) image = [];  // 该段内容防止 ai 传参时为 null 导致报错
        if (text.length > limit.params_type.max_texts) return `Error: 文字数量过多,该表情包最多支持 ${limit.params_type.max_texts} 段文字`;
        if (image.length > limit.params_type.max_images) return `Error: 图片数量过多,该表情包最多支持 ${limit.params_type.max_images} 张图片`;
        if (text.length < limit.params_type.min_texts) return `Error: 文字数量过少,该表情包最少需要 ${limit.params_type.min_texts} 段文字`;
        if (image.length < limit.params_type.min_images) return `Error: 图片数量过少,该表情包最少需要 ${limit.params_type.min_images} 张图片`;

        const request = { key: key, text: text, image: image, args: {} }

        console.log(JSON.stringify(request))
        await fetch(baseurl + "meme_generate", {
            method: "POST",
            body: JSON.stringify(request),
        }).then(res => res.json())
            .then(json => {
                if (json.status == "success") {
                    seal.replyToSender(ctx, msg, `[CQ:image,file=${seal.base64ToImage(json.message)}]`)
                    return "发送成功";
                } else {
                    return "Error: " + json.message;
                }
            })

        return ""
    }

    // 注册到toolMap中
    ToolManager.toolMap[list_info.function.name] = tool_list;
    ToolManager.toolMap[generator_info.function.name] = tool_generator;
}