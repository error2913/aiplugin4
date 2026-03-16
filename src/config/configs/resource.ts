import Logger from "../../logger";
import Image from "../../resource/image";
import Config from "../config";

export default class ResourceConfig {
    static ext: seal.ExtInfo;

    static register() {
        ResourceConfig.ext = Config.getExt('资源');

        seal.ext.registerTemplateConfig(ResourceConfig.ext, "本地图片路径", ['data/images/sealdice.png'], "如不需要可以不填写，修改完需要重载js");
        seal.ext.registerTemplateConfig(ResourceConfig.ext, "本地语音路径", ['data/records/钢管落地.mp3'], "如不需要可以不填写，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
    }

    static get() {
        return {
            LOCAL_IMAGES: getLocalImagesConfig(),
            LOCAL_AUDIOS: null // 整个audio类 wip
        }
    }
}

function getPathMapConfig(key: string): { [id: string]: string } {
    const paths = seal.ext.getTemplateConfig(ResourceConfig.ext, key).filter(x => x);
    const pathMap: { [id: string]: string } = paths.reduce((acc: { [id: string]: string }, path: string) => {
        if (path.trim() === '') return acc;
        try {
            const id = path.split('/').pop().replace(/\.[^/.]+$/, '');
            if (!id) throw new Error(`本地路径格式错误:${path}`);
            acc[id] = path;
        } catch (e) {
            Logger.error(`本地路径格式错误:${path}，错误信息:${e.message}`);
        }
        return acc;
    }, {});
    return pathMap;
}

function getLocalImagesConfig(): Image[] {
    const pathMap = getPathMapConfig("本地图片路径");
    return Object.keys(pathMap).map(id => Image.createLocalImage(id, pathMap[id]));
}