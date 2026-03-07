import { ConfigManager } from "../configManager";

export class ModelConfig {
    static ext: seal.ExtInfo;

    static register() {
        ModelConfig.ext = ConfigManager.getExt('aiplugin4:模型');

        seal.ext.registerTemplateConfig(ModelConfig.ext, "对话模型", [""], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "图片模型", [""], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "嵌入模型", [""], '');
    }

    static get() {
        return {
            enabled: seal.ext.getBoolConfig(ModelConfig.ext, "是否启用"),
        }
    }
}