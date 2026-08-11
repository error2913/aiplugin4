// 资源工具：本地文件/视频发送（走 ob11 网络连接依赖）
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { netExists, sendGroupMsg, sendPrivateMsg } from "../../../utils/ob11";
import { resolveLocalPath } from "../../../utils/utils";
import Tool from "../../tool";

/** 按“资源名=路径”映射构建 名称->路径 表，key 为 id 字段名（fileId/videoId） */
function buildPathMap(items: { [key: string]: string }[], key: string): { [key: string]: string } {
    const pathMap: { [key: string]: string } = {};
    for (const item of items || []) {
        const id = item[key];
        if (id && item.path) pathMap[id] = item.path;
    }
    return pathMap;
}

function registerResourceTool(
    name: string,
    desc: string,
    key: 'fileId' | 'videoId',
    segmentType: 'file' | 'video'
) {
    const tool = new Tool({
        type: 'function',
        function: {
            name,
            description: `${desc}。可传 name（已登记资源，资源名以调用时的报错提示为准）或 path（本地绝对路径，或相对海豹 data 目录的路径）`,
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '资源名称（已登记资源）'
                    },
                    path: {
                        type: 'string',
                        description: '文件路径：本地绝对路径，或相对海豹 data 目录的路径'
                    }
                },
                required: []
            }
        }
    });
    tool.sensitive = true; // 发送文件/视频属敏感操作
    tool.solve = async (ctx, _, __, args) => {
        const { name, path } = args;

        // 每次调用实时读取配置，保证修改配置后无需重载即可生效
        const items = key === 'fileId' ? (Config.resource.LOCAL_FILES || []) : (Config.resource.LOCAL_VIDEOS || []);
        const pathMap = buildPathMap(items, key);
        const nameList = Object.keys(pathMap);

        let filePath = '';
        if (name && path) {
            return `name 与 path 不能同时提供，请二选一：name（已登记资源）或 path（直接传路径）`;
        }
        if (name) {
            if (!Object.prototype.hasOwnProperty.call(pathMap, name)) {
                logger.error(`${desc}${name}不存在`);
                return `${desc}${name}不存在${nameList.length !== 0 ? `，可发送的资源名有:${nameList.join('、')}` : ''}`;
            }
            filePath = resolveLocalPath(pathMap[name]);
        } else if (path) {
            filePath = resolveLocalPath(path);
        } else {
            return `必须提供 name（已登记资源）或 path（直接传路径）中的一项`;
        }

        if (!netExists()) return `未找到ob11网络连接依赖，请提示用户安装`;

        const epId = ctx.endPoint.userId;
        const segment = { type: segmentType, data: { file: filePath } };
        let result = null;
        if (ctx.isPrivate) {
            result = await sendPrivateMsg(epId, ctx.player!.userId.replace(/^.+:/, ''), [segment]);
        } else {
            result = await sendGroupMsg(epId, ctx.group!.groupId.replace(/^.+:/, ''), [segment]);
        }

        if (result === null || result === undefined) return `${desc}发送失败，请查看ob11网络连接依赖日志`;
        return `${desc}发送成功`;
    }
}

export function registerResourceTools() {
    registerResourceTool('send_file', '发送本地文件', 'fileId', 'file');
    registerResourceTool('send_video', '发送本地视频', 'videoId', 'video');
}
