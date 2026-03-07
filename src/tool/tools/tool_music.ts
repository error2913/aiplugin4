import { logger } from "../logger";
import { Tool } from "./tool";

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
    tool.solve = async (ctx, msg, _, args) => {
        const { platform, song_name } = args;

        let api = '';
        switch (platform) {
            case '网易云': {
                api = `http://net.ease.music.lovesealdice.online/search?keywords=${song_name}`;
                break;
            }
            case 'qq': {
                api = `http://qqmusic.lovesealdice.online/search?key=${song_name}`;
                break;
            }
            default: {
                return { content: `不支持的平台: ${platform}`, images: [] };
            }
        }

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
                        return { content: "网易云没找到这首歌", images: [] };
                    }

                    const id = song.id;
                    const name = song.name;
                    const artist = song.artists[0].name;

                    const imgResponse = await fetch(`http://net.ease.music.lovesealdice.online/song/detail?ids=${id}`);
                    const imgData = await imgResponse.json();
                    const img = imgData.songs[0].al.picUrl;

                    const downloadResponse = await fetch(`http://net.ease.music.lovesealdice.online/song/download/url?id=${id}`, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Cookie': "_gid=GA1.2.2048499931.1737983161; _ga_MD3K4WETFE=GS1.1.1737983160.8.1.1737983827.0.0.0; _ga=GA1.1.1845263601.1736600307; MUSIC_U=00C10F470166570C36209E7E3E3649FEE210D3DB5B3C39C25214CFE5678DCC5773C63978903CEBA7BF4292B97ADADB566D96A055DCFDC860847761109F8986373FEC32BE2AFBF3DCFF015894EC61602562BF9D16AD12D76CED169C5052A470677A8D59F7B7D16D9FDE2A4ED237DE5C6956C0ED5F7A9EA151C3FA7367B0C6269FF7A74E6626B4D7F920D524718347659394CBB0DAE362991418070195FEFC730BCCE3CF4B03F24274075679FB4BFC884D099BD3CF679E4F1C9D5CBC2959CD29B0741BD52BCA155480116CE96393663B1A51D88AFDB57680F030CF93A305064A797B99874CA826D6760F616CB756B680591167AEE9AF31C4A187E61A19D7C1175961D4FE64CFD878F0BCEBB322A23E396DC5E8175A50D5E07B9788E4EBE8F8257FF139DB4FD03A89676F5C3DF1B70C101F4568C0A3657C24185218F975368ADB2DEF860760C59E9AFCCB214A4B51029E29ED; __csrf=85f3aa8cedc01f6d50b6b924efbf6f95; NMTID=00OG17oToz2Ne1rikTtgKPqOLaYuP0AAAGUqBEN0A"
                        }
                    });
                    const downloadData = await downloadResponse.json();
                    const url = downloadData.data.url;

                    seal.replyToSender(ctx, msg, `[CQ:music,type=163,url=${url},audio=${url},title=${name},content=${artist},image=${img}]`);
                    return { content: `发送成功，歌名:${name}，歌手:${artist}`, images: [] };
                }
                case 'qq': {
                    const song = data.data.list[0];
                    if (!song) {
                        return { content: "QQ音乐没找到这首歌...", images: [] };
                    }

                    seal.replyToSender(ctx, msg, `[CQ:music,type=qq,id=${song.songid}]`);
                    return { content: '发送成功', images: [] };
                }
                default: {
                    return { content: "不支持的平台", images: [] };
                }
            }
        } catch (error) {
            logger.warning(`音乐搜索请求错误: ${error}`);
            return { content: `音乐搜索请求错误: ${error}`, images: [] };
        }
    };
}