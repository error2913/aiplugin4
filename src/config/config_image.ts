import { ConfigManager } from "./config";

export class ImageConfig {
    static ext: seal.ExtInfo;

    static register() {
        ImageConfig.ext = ConfigManager.getExt('aiplugin4_5:图片');

        seal.ext.registerTemplateConfig(ImageConfig.ext, "本地图片路径", ['<海豹>data/images/sealdice.png'], "如不需要可以不填写，尖括号内是图片的名称，便于AI调用，修改完需要重载js");
        seal.ext.registerStringConfig(ImageConfig.ext, "图片识别需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerIntConfig(ImageConfig.ext, "发送图片的概率/%", 100);
        seal.ext.registerStringConfig(ImageConfig.ext, "图片大模型URL", "https://open.bigmodel.cn/api/paas/v4/chat/completions");
        seal.ext.registerStringConfig(ImageConfig.ext, "图片API key", "yours");
        seal.ext.registerTemplateConfig(ImageConfig.ext, "图片body", [
            `"messages":null`,
            `"model":"glm-4v"`,
            `"max_tokens":20`,
            `"stop":null`,
            `"stream":false`,
        ], "messages将会自动替换")
        seal.ext.registerOptionConfig(ImageConfig.ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题");
        seal.ext.registerIntConfig(ImageConfig.ext, "图片最大回复字符数", 100);
        seal.ext.registerIntConfig(ImageConfig.ext, "偷取图片存储上限", 30, "每个群聊或私聊单独储存");
    }

    static get() {
        return {
            localImagesTemplate: seal.ext.getTemplateConfig(ImageConfig.ext, "本地图片路径"),
            condition: seal.ext.getStringConfig(ImageConfig.ext, "图片识别需要满足的条件"),
            p: seal.ext.getIntConfig(ImageConfig.ext, "发送图片的概率/%"),
            url: seal.ext.getStringConfig(ImageConfig.ext, "图片大模型URL"),
            apiKey: seal.ext.getStringConfig(ImageConfig.ext, "图片API key"),
            bodyTemplate: seal.ext.getTemplateConfig(ImageConfig.ext, "图片body"),
            urlToBase64: seal.ext.getOptionConfig(ImageConfig.ext, "识别图片时将url转换为base64"),
            maxChars: seal.ext.getIntConfig(ImageConfig.ext, "图片最大回复字符数"),
            maxImageNum: seal.ext.getIntConfig(ImageConfig.ext, "偷取图片存储上限")
        }
    }
}