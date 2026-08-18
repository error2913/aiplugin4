// 音乐资源工具：搜索并返回 music 消息段，不直接发送。
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Tool from "../../tool";

interface MusicServiceConfig { api: string; cookie: string; }

function getMusicConfig(platform: string): MusicServiceConfig | null {
    for (const line of Config.tool.MUSIC || []) {
        try {
            const item = JSON.parse(line || "");
            if (item && String(item.platform || "").trim() === platform && String(item.api || "").trim()) {
                return { api: String(item.api).trim(), cookie: String(item.cookie || "").trim() };
            }
        } catch (error) {
            logger.error(`音乐服务配置解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return null;
}

export function registerMusicPlay() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "search_music",
            description: "搜索音乐并返回可交给 call_ob11_api 的 music 消息段，不会自动发送。",
            parameters: {
                type: "object",
                properties: {
                    platform: { type: "string", enum: ["网易云", "qq"], description: "音乐平台" },
                    song_name: { type: "string", description: "歌曲名称" }
                },
                required: ["platform", "song_name"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const platform = String(args.platform || "");
        const songName = String(args.song_name || "");
        if (!songName) return "歌曲名称不能为空";
        const config = getMusicConfig(platform);
        if (!config) return `未配置 ${platform} 的音乐服务`;

        try {
            const api = platform === "网易云"
                ? `${config.api}/search?keywords=${encodeURIComponent(songName)}`
                : `${config.api}/search?key=${encodeURIComponent(songName)}`;
            const response = await fetch(api, { headers: { "Content-Type": "application/json" } });
            if (!response.ok) throw new Error(`${platform} API 失效`);
            const data: any = await response.json();

            if (platform === "网易云") {
                const song = data.result?.songs?.[0];
                if (!song) return "网易云没找到这首歌";
                const id = song.id;
                const detail = await (await fetch(`${config.api}/song/detail?ids=${id}`)).json() as any;
                const headers: Record<string, string> = { "User-Agent": "aiplugin4" };
                if (config.cookie) headers.Cookie = config.cookie;
                const download = await (await fetch(`${config.api}/song/download/url?id=${id}`, { headers })).json() as any;
                const audio = download.data?.url || "";
                return JSON.stringify({ kind: "message_segment", segment: { type: "music", data: { type: "custom", url: audio, audio, title: song.name, content: song.artists?.[0]?.name || "", image: detail.songs?.[0]?.al?.picUrl || "" } } });
            }

            const song = data.data?.list?.[0];
            if (!song) return "QQ音乐没找到这首歌";
            return JSON.stringify({ kind: "message_segment", segment: { type: "music", data: { type: "qq", id: String(song.songid) } } });
        } catch (error) {
            logger.warning(`音乐搜索请求错误：${error instanceof Error ? error.message : String(error)}`);
            return `音乐搜索请求错误：${error instanceof Error ? error.message : String(error)}`;
        }
    };
}
