// 图片配置：识别条件/base64转换/本地图片/发送概率/偷取上限
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
        seal.ext.registerStringConfig(ext, "图片全局识别豹语条件", '0', "使用豹语表达式，例如：$t群号_RAW=='2001'。若要开启所有图片自动识别转文字，请填写'1'", "图片");
        seal.ext.registerOptionConfig(ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题", "图片");
        seal.ext.registerIntConfig(ext, "图片转文字最大字符数", 500, "图片");
        seal.ext.registerTemplateConfig(ext, "本地图片路径", ['data/images/sealdice.png'], "如不需要可以不填写，修改完需要重载js", "图片");
        seal.ext.registerIntConfig(ext, "发送图片的概率/%", 0, "在回复后发送本地图片或偷取图片的概率", "图片");
        seal.ext.registerStringConfig(ext, "图片识别默认prompt", "请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题、主体等信息，如果有文字，请全部输出", "", "图片");
        seal.ext.registerIntConfig(ext, "偷取图片存储上限", 50, "每个群聊或私聊单独储存", "图片");
    }

    static get() {
        return {
            IMAGE_CONDITION: seal.ext.getStringConfig(ext, "图片全局识别豹语条件"),
            URL_TO_BASE64: seal.ext.getOptionConfig(ext, "识别图片时将url转换为base64"),
            MAX_CHARS: seal.ext.getIntConfig(ext, "图片转文字最大字符数"),
            LOCAL_IMAGE_PATH_MAP: ImageConfig.getPathMapConfig(ext, "本地图片路径"),
            P: seal.ext.getIntConfig(ext, "发送图片的概率/%"),
            IMAGE_DEFAULT_PROMPT: seal.ext.getStringConfig(ext, "图片识别默认prompt"),
            MAX_STOLEN_IMAGE_NUM: seal.ext.getIntConfig(ext, "偷取图片存储上限")
        }
    }
}
