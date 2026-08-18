// 资源工具：本地文件/视频发送（走 ob11 网络连接依赖）
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { netExists, sendGroupFile, sendGroupMsg, sendPrivateFile, sendPrivateMsg } from "../../../utils/ob11";
import { resolveResourceReference } from "../../../utils/resource";
import Tool from "../../tool";

type ResourceEntry = { [key: string]: string | undefined };

/** 按“资源名=路径”映射构建 名称->路径 表，key 为 id 字段名（imageId/fileId/videoId） */
function buildPathMap(items: ResourceEntry[], key: string): { [key: string]: string } {
    const pathMap: { [key: string]: string } = {};
    for (const item of items || []) {
        const id = item[key];
        if (id && item.path) pathMap[id] = item.path;
    }
    return pathMap;
}

function buildResourceList(type: string): string {
    const sections: Array<[string, string[]]> = [];
    if (type === 'all' || type === 'image') {
        sections.push(['本地图片', (Config.resource.LOCAL_IMAGES || []).map(img => img.imageId)]);
    }
    if (type === 'all' || type === 'audio') {
        sections.push(['本地音频', (Config.resource.LOCAL_AUDIOS || []).map(a => a.audioId)]);
    }
    if (type === 'all' || type === 'file') {
        sections.push(['本地文件', (Config.resource.LOCAL_FILES || []).map(f => f.fileId)]);
    }
    if (type === 'all' || type === 'video') {
        sections.push(['本地视频', (Config.resource.LOCAL_VIDEOS || []).map(v => v.videoId)]);
    }
    return sections.map(([label, names]) => `${label}:${names.length > 0 ? names.join('、') : '暂无'}`).join('\n');
}

function getConfiguredResources(key: 'imageId' | 'fileId' | 'videoId'): ResourceEntry[] {
    if (key === 'imageId') {
        return (Config.resource.LOCAL_IMAGES || []).map(item => ({ [key]: item.imageId, path: item.path }));
    }
    if (key === 'fileId') {
        return (Config.resource.LOCAL_FILES || []).map(item => ({ [key]: item.fileId, path: item.path }));
    }
    return (Config.resource.LOCAL_VIDEOS || []).map(item => ({ [key]: item.videoId, path: item.path }));
}

function registerResourceTool(
    name: string,
    desc: string,
    key: 'imageId' | 'fileId' | 'videoId',
    segmentType: 'image' | 'file' | 'video'
) {
    const tool = new Tool({
        type: 'function',
        function: {
            name,
            description: `${desc}。可传 name（已登记资源，先通过 list_resources 查询可用名称）或 path（本地绝对路径、相对 SealDice 目录的路径、file:// URI，或 mcp://服务器名/沙箱路径）；也可用 source=mcp、server、path 调用 MCP 文件服务器`,
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '资源名称（已登记资源）'
                    },
                    path: {
                        type: 'string',
                        description: '文件路径：本地绝对路径、相对 SealDice 目录的路径、file:// URI，或 mcp://服务器名/沙箱相对路径'
                    },
                    source: {
                        type: 'string',
                        enum: ['local', 'mcp'],
                        description: '资源来源；使用 MCP 文件服务器时填 mcp'
                    },
                    server: {
                        type: 'string',
                        description: 'MCP 服务器名称，source=mcp 时使用，默认 mcp-files-exec'
                    }
                },
                required: []
            }
        }
    });
    tool.sensitive = true; // 发送文件/视频属敏感操作
    tool.solve = async (ctx, _, __, args) => {
        const { name, path, source, server } = args;

        // 每次调用实时读取配置，保证修改配置后无需重载即可生效
        const items = getConfiguredResources(key);
        const pathMap = buildPathMap(items, key);
        const nameList = Object.keys(pathMap);

        let rawPath = '';
        if (name && path) {
            return `name 与 path 不能同时提供，请二选一：name（已登记资源）或 path（直接传路径）`;
        }
        if (name) {
            if (!Object.prototype.hasOwnProperty.call(pathMap, name)) {
                logger.error(`${desc}${name}不存在`);
                return `${desc}${name}不存在${nameList.length !== 0 ? `，可发送的资源名有:${nameList.join('、')}` : ''}`;
            }
            rawPath = pathMap[name];
        } else if (path) {
            rawPath = path;
        } else {
            return `必须提供 name（已登记资源）或 path（直接传路径）中的一项`;
        }

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        try {
            const resource = await resolveResourceReference(rawPath, source, server);
            const epId = ctx.endPoint.userId;
            let result = null;
            const peerId = ctx.isPrivate
                ? ctx.player!.userId.replace(/^.+:/, '')
                : ctx.group!.groupId.replace(/^.+:/, '');
            if (segmentType === 'file') {
                result = ctx.isPrivate
                    ? await sendPrivateFile(epId, peerId, resource.path, resource.name)
                    : await sendGroupFile(epId, peerId, resource.path, resource.name);
            } else {
                const segment = { type: segmentType, data: { file: resource.path } };
                result = ctx.isPrivate
                    ? await sendPrivateMsg(epId, peerId, [segment])
                    : await sendGroupMsg(epId, peerId, [segment]);
            }

            if (result === null || result === undefined) return `${desc}发送失败，请查看ob11网络连接依赖日志`;
            return `${desc}发送成功`;
        } catch (e) {
            logger.error(`${desc}失败：${e instanceof Error ? e.message : String(e)}`);
            return `${desc}失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };
}

export function registerResourceTools() {
    registerResourceTool('send_image', '发送本地图片', 'imageId', 'image');
    registerResourceTool('send_file', '发送本地文件', 'fileId', 'file');
    registerResourceTool('send_video', '发送本地视频', 'videoId', 'video');

    const tool = new Tool({
        type: 'function',
        function: {
            name: 'list_resources',
            description: '查询当前已配置的本地资源名称。type 可选 image/audio/file/video/all。图片和音频分别使用 [img:名称] 和 [audio:名称]；文件和视频使用 send_file/send_video 的 name 参数。',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['all', 'image', 'audio', 'file', 'video'],
                        description: '资源类型，默认 all'
                    }
                },
                required: []
            }
        }
    });
    tool.solve = async (_, __, ___, args) => {
        const type = args && typeof args.type === 'string' ? args.type : 'all';
        if (!['image', 'audio', 'file', 'video', 'all'].includes(type)) {
            return `未知资源类型:${type}，可选值为 image/audio/file/video/all`;
        }
        return buildResourceList(type);
    };
}