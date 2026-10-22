// 本地资源（图片/语音/文件/视频）的「纯路径」解析：读「资源」页模板配置（名=路径），产出条目。
// 不 import Image：需要 Image 实体的调用方用 ./local_images（它负责把图片条目注册进 imageMap）。
// 拆两层的原因：utils/string 只要语音路径，若它 import 带 Image 的模块会形成
// string → local_* → image → string 的环（见 deps:check）。
// 解析结果属于「启动解析一次、重载 JS 才生效」的复杂配置：模块级缓存。
import { ext } from "../config/ext";
import Logger from "../logger";

export interface LocalImageEntry { imageId: string; path: string; }
export interface LocalAudioEntry { audioId: string; path: string; }
export interface LocalFileEntry { fileId: string; path: string; }
export interface LocalVideoEntry { videoId: string; path: string; }

// key = 配置项名（本地图片路径/本地语音路径/本地文件路径/本地视频路径）
const pathMapCache: { [key: string]: { [id: string]: string } } = {};

/** 仅测试用：清空资源路径模块缓存，使下一次读取重新解析当前模板配置。 */
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

export function getLocalImageEntries(): LocalImageEntry[] {
    const pathMap = getPathMapConfig("本地图片路径");
    return Object.keys(pathMap).map(imageId => ({ imageId, path: pathMap[imageId] }));
}

export function getLocalAudios(): LocalAudioEntry[] {
    const pathMap = getPathMapConfig("本地语音路径");
    return Object.keys(pathMap).map(audioId => ({ audioId, path: pathMap[audioId] }));
}

export function getLocalFiles(): LocalFileEntry[] {
    const pathMap = getPathMapConfig("本地文件路径");
    return Object.keys(pathMap).map(fileId => ({ fileId, path: pathMap[fileId] }));
}

export function getLocalVideos(): LocalVideoEntry[] {
    const pathMap = getPathMapConfig("本地视频路径");
    return Object.keys(pathMap).map(videoId => ({ videoId, path: pathMap[videoId] }));
}
