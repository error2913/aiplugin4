// 图片配置：识别条件/base64转换/识别 prompt
import { ext } from "../config";
export default class ImageConfig {
    static getPathMapConfig(ext: seal.ExtInfo, key: string): { [id: string]: string } {
        const map: { [id: string]: string } = {};
        seal.ext.getTemplateConfig(ext, key).forEach(s => {
            const [id, ...rest] = s.split(/[,?]/);
            if (id && rest.length > 0) map[id.trim()] = rest.join(',').trim();
            else if (id) map[id.trim()] = id.trim();
        });
        return map;
    }
    static register() {
        seal.ext.registerStringConfig(ext, "图片全局识别豹语条件", '0', "0 不自动识别；1 所有图片自动识别转文字；也可填豹语表达式（如 $t群号_RAW=='2001'）按群启用", "图片");
        seal.ext.registerOptionConfig(ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题", "图片");
        seal.ext.registerStringConfig(ext, "图片识别默认prompt", "请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题、主体等信息，如果有文字，请全部输出", "图片转文字使用的提示词，留空使用内置默认", "图片");
    }

    static get() {
        return {
            IMAGE_CONDITION: seal.ext.getStringConfig(ext, "图片全局识别豹语条件"),
            URL_TO_BASE64: seal.ext.getOptionConfig(ext, "识别图片时将url转换为base64"),
            LOCAL_IMAGE_PATH_MAP: ImageConfig.getPathMapConfig(ext, "本地图片路径"),
            IMAGE_DEFAULT_PROMPT: seal.ext.getStringConfig(ext, "图片识别默认prompt")
        }
    }
}
