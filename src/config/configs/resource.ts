// 资源配置：本地图片/语音/文件/视频路径
// 供 list_resources 查询资源 ID、get_resource_path 查询实际路径/URI
import Logger from "../../logger";
import Image from "../../resource/image";
import { ext } from "../config";
export default class ResourceConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "本地图片路径", [''], "如不需要可以不填写；每行一个本地图片路径，示例：data/images/sealdice.png；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地语音路径", [''], "每行一个本地语音：语音名=路径（省略语音名时默认用文件名），示例：早安=records/早安.mp3；发送语音需要配置ffmpeg到环境变量中；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地文件路径", [''], "每行一个本地文件：文件名=路径（省略文件名时默认用文件名），示例：规则书=data/files/规则书.pdf；发送文件需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
        seal.ext.registerTemplateConfig(ext, "本地视频路径", [''], "每行一个本地视频：视频名=路径（省略视频名时默认用文件名），示例：开场动画=data/videos/开场.mp4；发送视频需安装ob11网络连接依赖；修改后需重载 JS 生效", "资源");
    }

    static get() {
        return {
            LOCAL_IMAGES: getLocalImagesConfig(),
            LOCAL_AUDIOS: getLocalAudiosConfig(),
            LOCAL_FILES: getLocalFilesConfig(),
            LOCAL_VIDEOS: getLocalVideosConfig()
        }
    }
}

// 本地资源路径属于启动解析一次、重载 JS 才生效的复杂配置（名=路径 解析）：模块级缓存
const pathMapCache: { [key: string]: { [id: string]: string } } = {};

/** 仅测试用：清空资源路径模块缓存，使下一次 get() 重新读取当前模板配置。 */
export function resetResourceConfigCacheForTest(): void {
    for (const key of Object.keys(pathMapCache)) delete pathMapCache[key];
}
function getPathMapConfig(key: string): { [id: string]: string } {
    if (pathMapCache[key]) return pathMapCache[key];
    const paths = seal.ext.getTemplateConfig(ext, key).filter(x => x);
    const pathMap: { [id: string]: string } = paths.reduce((acc: { [id: string]: string }, line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return acc;
        try {
            // 支持“资源名=路径”，省略资源名时默认用文件名（去扩展名）
            const eq = trimmed.indexOf('=');
            let id = trimmed;
            let path = trimmed;
            if (eq > 0) {
                id = trimmed.slice(0, eq).trim();
                path = trimmed.slice(eq + 1).trim();
            } else {
                id = (trimmed.split(/[\\/]/).pop() || '').replace(/\.[^/.]+$/, '');
            }
            if (!id || !path) throw new Error(`本地路径格式错误:${line}`);
            acc[id] = path;
        } catch (e) {
            Logger.error(`本地路径格式错误:${line}，错误信息:${e instanceof Error ? e.message : String(e)}`);
        }
        return acc;
    }, {});
    pathMapCache[key] = pathMap;
    return pathMap;
}

function getLocalImagesConfig(): Image[] {
    const pathMap = getPathMapConfig("本地图片路径");
    return Object.keys(pathMap).map(id => Image.createLocalImage(id, pathMap[id]));
}

function getLocalAudiosConfig(): { audioId: string, path: string }[] {
    const pathMap = getPathMapConfig("本地语音路径");
    return Object.keys(pathMap).map(audioId => ({ audioId, path: pathMap[audioId] }));
}

function getLocalFilesConfig(): { fileId: string, path: string }[] {
    const pathMap = getPathMapConfig("本地文件路径");
    return Object.keys(pathMap).map(fileId => ({ fileId, path: pathMap[fileId] }));
}

function getLocalVideosConfig(): { videoId: string, path: string }[] {
    const pathMap = getPathMapConfig("本地视频路径");
    return Object.keys(pathMap).map(videoId => ({ videoId, path: pathMap[videoId] }));
}
