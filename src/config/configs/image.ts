import Config from "../config";

export default class ImageConfig {
    static ext: seal.ExtInfo;

    static register() {
        ImageConfig.ext = Config.getExt('图片');

        seal.ext.registerStringConfig(ImageConfig.ext, "图片全局识别豹语条件", '0', "使用豹语表达式，例如：$t群号_RAW=='2001'。若要开启所有图片自动识别转文字，请填写'1'");
        seal.ext.registerOptionConfig(ImageConfig.ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题");
        seal.ext.registerIntConfig(ImageConfig.ext, "图片转文字最大字符数", 500);
    }

    static get() {
        return {
            IMAGE_CONDITION: seal.ext.getStringConfig(ImageConfig.ext, "图片全局识别豹语条件"),
            URL_TO_BASE64: seal.ext.getOptionConfig(ImageConfig.ext, "识别图片时将url转换为base64"),
            MAX_CHARS: seal.ext.getIntConfig(ImageConfig.ext, "图片转文字最大字符数")
        }
    }
}