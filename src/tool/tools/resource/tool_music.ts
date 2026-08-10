// 点歌工具
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Tool from "../../tool";

interface MusicServiceConfig {
    api: string;
    cookie: string;
}

/** 从「音乐服务配置」模板配置中解析指定平台的 域名/Cookie；未配置时返回 null */
function getMusicConfig(platform: string): MusicServiceConfig | null {
    const list = Config.tool.MUSIC || [];
    for (const line of list) {
        const parts = (line || '').split('|');
        if ((parts[0] || '').trim() !== platform) continue;
        const api = (parts[1] || '').trim();
        if (!api) continue;
        return { api, cookie: parts.slice(2).join('|').trim() };
    }
    return null;
}

export function registerMusicPlay() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "music_play",
            description: `搜索并播放音乐`,
            parameters: {
                type: "object",
                properties: {
                    platform: {
                        type: "string",
                        description: "音乐平台",
                        enum: ["网易云", "qq"]
                    },
                    song_name: {
                        type: "string",
                        description: "歌曲名称"
                    }
                },
                required: ["platform", "song_name"]
            }
        }
    });
    tool.sensitive = true; // 发送点歌属敏感操作
    tool.solve = async (ctx, msg, _, args) => {
        const { platform, song_name } = args;

        if (platform !== '网易云' && platform !== 'qq') {
            return `不支持的平台: ${platform}`;
        }
        const config = getMusicConfig(platform);
        if (!config) {
            return `未配置 ${platform} 的音乐服务：请在「工具」配置的「音乐服务配置」中添加 平台|域名|Cookie 条目`;
        }

        const api = platform === '网易云'
            ? `${config.api}/search?keywords=${song_name}`
            : `${config.api}/search?key=${song_name}`;

        try {
            logger.info(`搜索音乐: ${api}`);
            const response = await fetch(api, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`${platform}API失效`);
            }

            const data = await response.json();

            switch (platform) {
                case '网易云': {
                    const song = data.result.songs[0];
                    if (!song) {
                        return "网易云没找到这首歌";
                    }

                    const id = song.id;
                    const name = song.name;
                    const artist = song.artists[0].name;

                    const imgResponse = await fetch(`${config.api}/song/detail?ids=${id}`);
                    const imgData = await imgResponse.json();
                    const img = imgData.songs[0].al.picUrl;

                    const headers: { [key: string]: string } = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    };
                    if (config.cookie) headers['Cookie'] = config.cookie;
                    const downloadResponse = await fetch(`${config.api}/song/download/url?id=${id}`, { headers });
                    const downloadData = await downloadResponse.json();
                    const url = downloadData.data.url;

                    seal.replyToSender(ctx, msg, `[CQ:music,type=163,url=${url},audio=${url},title=${name},content=${artist},image=${img}]`);
                    return `发送成功，歌名:${name}，歌手:${artist}`;
                }
                case 'qq': {
                    const song = data.data.list[0];
                    if (!song) {
                        return "QQ音乐没找到这首歌...";
                    }

                    seal.replyToSender(ctx, msg, `[CQ:music,type=qq,id=${song.songid}]`);
                    return '发送成功';
                }
                default: {
                    return "不支持的平台";
                }
            }
        } catch (error) {
            logger.warning(`音乐搜索请求错误: ${error}`);
            return `音乐搜索请求错误: ${error}`;
        }
    };
}
