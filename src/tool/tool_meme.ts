import { Image, ImageManager } from "../AI/image";
import { ConfigManager } from "../config/config";
import { logger } from "../logger";
import { Tool } from "./tool";

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
    const toolList = new Tool({
        type: "function",
        function: {
            name: "meme_list",
            description: `访问可用表情包列表`,
            parameters: {
                type: "object",
                properties: {
                },
                required: []
            }
        }
    });
    toolList.solve = async (_, __, ___, ____) => {
        try {
            const res = await fetch(baseurl + "get_command");
            const json = await res.json();
            return { content: json.map((item: string[]) => item[0]).join("、"), images: [] };
        } catch (err) {
            return { content: "获取表情包列表失败:" + err.message, images: [] };
        }
    }

    const toolGet = new Tool({
        type: "function",
        function: {
            name: "get_meme_info",
            description: `获取表情包制作信息`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "表情包名字,为 meme_list 返回的结果"
                    }
                },
                required: ["name"]
            }
        }
    });
    toolGet.solve = async (_, __, ___, args) => {
        const { name } = args;

        const { info } = await getInfo(name);
        const { max_images, max_texts, min_images, min_texts } = info.params_type;
        const image_text = min_images === max_images ? `用户数量为 ${min_images} 名` : `用户数量范围为 ${min_images} - ${max_images} 名`;
        const text_text = min_texts === max_texts ? `文字数量为 ${min_texts} 段` : `文字数量范围为 ${min_texts} - ${max_texts} 段`;

        return { content: `该表情包需要：${image_text}，${text_text}`, images: [] };
    }

    const toolGenerator = new Tool({
        type: "function",
        function: {
            name: "meme_generator",
            description: `制作表情包,使用之前需要调用meme_list获取可用表情包列表,调用get_meme_info获取制作信息`,
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
                    save: {
                        type: "boolean",
                        description: "是否保存图片"
                    }
                },
                required: ["name", "text", "members", "save"]
            }
        }
    });
    toolGenerator.solve = async (ctx, msg, ai, args) => {
        const { name, text = [], members = [], save } = args;

        let s = '';

        const { key, info } = await getInfo(name);
        const { max_images, max_texts, min_images, min_texts } = info.params_type;
        const image_text = min_images === max_images ? `用户数量为 ${min_images} 名` : `用户数量范围为 ${min_images} - ${max_images} 名`;
        const text_text = min_texts === max_texts ? `文字数量为 ${min_texts} 段` : `文字数量范围为 ${min_texts} - ${max_texts} 段`;
        if (text.length > max_texts || text.length < min_texts) {
            if (max_texts === 0) {
                text.length = 0;
                s += `该表情包不需要文字信息，已舍弃。`;
            } else {
                return { content: `文字数量错误,${text_text},${image_text}`, images: [] };
            }
        }
        if (members.length > max_images || members.length < min_images) {
            if (max_images === 0) {
                members.length = 0;
                s += `该表情包不需要用户信息，已舍弃。`;
            } else {
                return { content: `用户数量错误,${image_text},${text_text}`, images: [] };
            }
        }

        const image = [];
        for (const name of members) {
            const uid = await ai.context.findUserId(ctx, name);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
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
                const base64 = json.message;
                if (!base64) {
                    logger.error(`生成的base64为空`);
                    return { content: "生成的base64为空", images: [] };
                }

                const file = seal.base64ToImage(base64);

                const newImage = new Image(file);
                newImage.id = ImageManager.generateImageId(ai, name);
                newImage.isUrl = false;
                newImage.scenes = [...text, ...members];
                newImage.base64 = base64;
                newImage.content = `表情包${name}
文字${text.join('，') || '无'}
用户${members.join('，') || '无'}`;

                if (save) {
                    ai.imageManager.updateSavedImages([newImage]);
                }

                seal.replyToSender(ctx, msg, `[CQ:image,file=${file}]`)
                return { content: `${s}发送成功，${save ? `已保存为<|img:${newImage.id}|>` : `可使用<|img:${newImage.id}|>再次调用`}`, images: [newImage] };
            } else {
                throw new Error(json.message);
            }
        } catch (err) {
            return { content: "生成表情包失败:" + err.message, images: [] };
        }
    }
}

// 说实话感觉并不是最完美的状态
// 感觉应该先把meme_list和meme_info本地化
// 然后给出一个选择meme模板的模板配置项，毕竟有的人设并不适合所有的表情包
// 再把选中的meme模板构建prompt，另外我注意到有的模板应该是有默认文本的，这其实也可以提示ai要输入什么文本，而不是牛头不对马嘴
// 这样只需保留meme_generator的实现
// 另外可以把url加进后端配置中，这个的后端是哪个项目啊————