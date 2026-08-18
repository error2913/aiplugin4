// 资源查询工具：只负责列出可用资源，不直接发送消息。
import Config from "../../../config/config";
import Tool from "../../tool";

function buildResourceList(type: string): string {
    const sections: Array<[string, string[]]> = [];
    if (type === "all" || type === "image") sections.push(["本地图片", (Config.resource.LOCAL_IMAGES || []).map(item => item.imageId)]);
    if (type === "all" || type === "audio") sections.push(["本地音频", (Config.resource.LOCAL_AUDIOS || []).map(item => item.audioId)]);
    if (type === "all" || type === "file") sections.push(["本地文件", (Config.resource.LOCAL_FILES || []).map(item => item.fileId)]);
    if (type === "all" || type === "video") sections.push(["本地视频", (Config.resource.LOCAL_VIDEOS || []).map(item => item.videoId)]);
    return sections.map(([label, names]) => `${label}:${names.length > 0 ? names.join("、") : "暂无"}`).join("\n");
}

export function registerResourceTools() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "list_resources",
            description: "查询当前已配置的本地资源名称。发送资源请使用 call_ob11_api 的 image/record/video/file 消息段，并将 file 写成 resource:资源名。",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["all", "image", "audio", "file", "video"],
                        description: "资源类型，默认 all"
                    }
                },
                required: []
            }
        }
    });
    tool.solve = async (_, __, ___, args) => {
        const type = args && typeof args.type === "string" ? args.type : "all";
        if (!["image", "audio", "file", "video", "all"].includes(type)) {
            return `未知资源类型:${type}，可选值为 image/audio/file/video/all`;
        }
        return buildResourceList(type);
    };
}
