// image.ts 子目录工具注册统一入口
import Tool from "../../tool";

import { registerImage } from "./tool_image";
import { registerMeme } from "./tool_meme";

/** 注册 image.ts 下全部图片工具（分类：图片） */
export function registerImageTools() {
    Tool.withCategory('图片', () => {
        registerImage();
        registerMeme();
    });
}
