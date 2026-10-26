// 资源查询工具：只负责列出可用资源，不直接发送消息。
import { getLocalImages } from "../../../resource/local_images";
import { getLocalAudios, getLocalFiles, getLocalVideos } from "../../../resource/local_paths";
import Tool from "../../tool";

function buildResourceList(type: string): string {
    const sections: Array<[string, string[]]> = [];
    if (type === "all" || type === "image") sections.push(["本地图片", getLocalImages().map(item => item.imageId)]);
    if (type === "all" || type === "audio") sections.push(["本地音频", getLocalAudios().map(item => item.audioId)]);
    if (type === "all" || type === "file") sections.push(["本地文件", getLocalFiles().map(item => item.fileId)]);
    if (type === "all" || type === "video") sections.push(["本地视频", getLocalVideos().map(item => item.videoId)]);
    return sections.map(([label, names]) => `${label}:${names.length > 0 ? names.join("、") : "暂无"}`).join("\n");
}

export function registerResourceTools() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "list_resources",
            description: "List currently configured local resource names. To send an image, prefer [img:image ID] in the current reply; to send voice/video/files, or to send resources to a specific session via call_ob11_api, write file as resource:resource name. For a resource's actual path/URI, use get_resource_path.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["all", "image", "audio", "file", "video"],
                        description: "Resource type; default all"
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
