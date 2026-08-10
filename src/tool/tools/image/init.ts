// image.ts 子目录工具注册统一入口
import { registerImage } from "./tool_image";
import { registerMeme } from "./tool_meme";
import { registerRender } from "./tool_render";

/** 注册 image.ts 下全部图片工具 */
export function registerImageTools() {
    registerImage();
    registerMeme();
    registerRender();
}
