// 回复配置：引用/最大字数/去空白/复读检测（回复过滤规则已内置硬编码，见 src/utils/string.ts filterString）
import { ext } from "../config";

export default class ReplyConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "回复引用", false, "开启将会引用触发该条回复的消息", "回复");
        seal.ext.registerIntConfig(ext, "回复最大字数", 5000, "回复的最大字数，防止 max_tokens 限制不起效", "回复");
        seal.ext.registerBoolConfig(ext, "回复文本去除首尾空白字符", true, "发送前去除回复首尾空白", "回复");
        seal.ext.registerBoolConfig(ext, "分段发送延时", true, "流式/非流式输出共用，消息间隔是否开启延时防止乱序", "回复");
        seal.ext.registerIntConfig(ext, "分段发送基础延时/ms", 350, "流式/非流式输出共用，从第二条消息开始每条发送前等待的毫秒数", "回复");
        seal.ext.registerIntConfig(ext, "分段发送含图额外延时/ms", 250, "流式/非流式输出共用，当消息包含图片时额外增加的等待毫秒数", "回复");
        seal.ext.registerBoolConfig(ext, "禁止回复复读", false, "检测到复读时停止回复", "回复");
        seal.ext.registerFloatConfig(ext, "视作复读的最低相似度", 0.8, "与上一条回复的相似度达到该值视为复读", "回复");
    }

    static get() {
        return {
            QUOTE_REPLY: seal.ext.getBoolConfig(ext, "回复引用"),
            MAX_CHARS: seal.ext.getIntConfig(ext, "回复最大字数"),
            TRIM: seal.ext.getBoolConfig(ext, "回复文本去除首尾空白字符"),
            SEGMENT_DELAY_ENABLED: seal.ext.getBoolConfig(ext, "分段发送延时"),
            SEGMENT_DELAY_MS: seal.ext.getIntConfig(ext, "分段发送基础延时/ms"),
            SEGMENT_IMAGE_EXTRA_DELAY_MS: seal.ext.getIntConfig(ext, "分段发送含图额外延时/ms"),
            STOP_REPEAT: seal.ext.getBoolConfig(ext, "禁止回复复读"),
            REPEAT_SIMILARITY: seal.ext.getFloatConfig(ext, "视作复读的最低相似度")
        }
    }
}
