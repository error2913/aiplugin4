// 图片配置：识别条件/base64转换/模型图源/角色与预算
import { ext } from "../ext";
export default class ImageConfig {
    // 本地资源路径属于启动解析一次、重载 JS 才生效的复杂配置：模块级缓存
    private static pathMapCache: { [key: string]: { [id: string]: string } } = {};
    static getPathMapConfig(ext: seal.ExtInfo, key: string): { [id: string]: string } {
        if (ImageConfig.pathMapCache[key]) return ImageConfig.pathMapCache[key];
        const map: { [id: string]: string } = {};
        seal.ext.getTemplateConfig(ext, key).forEach(s => {
            const [id, ...rest] = s.split(/[,?]/);
            if (id && rest.length > 0) map[id.trim()] = rest.join(',').trim();
            else if (id) map[id.trim()] = id.trim();
        });
        ImageConfig.pathMapCache[key] = map;
        return map;
    }
    static resetCacheForTest(): void {
        ImageConfig.pathMapCache = {};
    }

    static register() {
        seal.ext.registerStringConfig(ext, "图片全局识别豹语条件", '0', "0 不自动识别；1 所有图片自动识别转文字；也可填豹语表达式（如 $t群号_RAW=='2001'）按群启用", "图片");
        seal.ext.registerOptionConfig(ext, "识别图片时将url转换为base64", "永不", ["永不", "自动", "总是"], "解决大模型无法正常获取QQ图床图片的问题", "图片");
        seal.ext.registerIntConfig(ext, "图片识别展示截断字数", 5000, "图片识别转文字结果超过该字数时不再压缩，改为仅展示开头部分，并保留完整识别原文（read_raw kind=image 可按图片 ID 阅读）；0 为不截断不保留", "图片");
        seal.ext.registerIntConfig(ext, "图片清理天数", 30, "超过该天数未使用的图片记录会被清理（配置了图床时同时通知图床释放引用）；0 = 不清理。建议 7~90 天", "图片");
        seal.ext.registerBoolConfig(ext, "工具产出图片自动类型标签", true, "工具（生图/表情包/MCP 图片等）产出的新图片入库时，按产出者自动打英文类型标签（ai-generated/meme/mcp-image/tool-image）；不调用识图模型", "图片");
        seal.ext.registerIntConfig(ext, "自动类型标签每图上限", 2, "每张工具产出图片最多自动打几个类型标签（1~4）", "图片");
        // ---- 模型图源与预算（方案：.dev/docs-archive/19、20 号）----
        seal.ext.registerIntConfig(ext, "模型图片单边上限", 8192, "模型能接受的图片最大单边像素（0=不检查）。超过的图不作为图片块交给模型，只保留 [img:ID] 文本标签；实测 deepseek-flash 为 8192", "图片");
        seal.ext.registerIntConfig(ext, "模型图片目标长边", 2048, "图片交给模型前缩放到的长边（0=不缩放）。图床后端生成/缓存该尺寸的模型变体；长截图建议不低于 1536", "图片");
        seal.ext.registerIntConfig(ext, "每轮最多图片数", 8, "单次模型请求最多携带多少张图片块（0=不限）；超出部分只保留 [img:ID] 文本标签，防一轮几十张图（20 号方案 D6）", "图片");
        seal.ext.registerIntConfig(ext, "每条工具结果最多升格图片数", 4, "工具结果文本里的 [img:] 最多升格为多少张图片块（0=不限）。image_search 一次可回几十张，全部升格既贵又易踩线（D6）", "图片");
        seal.ext.registerIntConfig(ext, "单张内联上限KB", 1024, "下载失败等异常路径改为内联 base64 时，单张图允许的最大字节（0=不限）；超限只保留文本标签（防 413）", "图片");
        seal.ext.registerIntConfig(ext, "每轮内联总字节KB", 4096, "单次请求内联图片的总字节预算（0=不限）；超限的图只保留文本标签（20 号方案 P0-C）", "图片");
        seal.ext.registerIntConfig(ext, "每轮最多内联图片数", 4, "单次请求最多内联多少张图（0=不限，与「每轮最多图片数」独立；内联走模型变体，见 P0-C）", "图片");
        seal.ext.registerBoolConfig(ext, "模型工具结果图片", true, "是否允许 tool 消息携带图片块（实测 deepseek-flash 允许；部分网关不支持 tool 图，可关掉改为文本标签）", "图片");
        seal.ext.registerBoolConfig(ext, "图片被模型拒绝时自动降级", true, "模型报「不支持的图片」时定位并标记该图为「模型不可用」，改为文本标签重发本轮；不再让整个会话卡死", "图片");
        seal.ext.registerBoolConfig(ext, "图片降级通知", false, "图片被模型拒绝并自动降级时，用 ctx.notice 告知骰主", "图片");
    }

    static get() {
        return {
            IMAGE_CONDITION: seal.ext.getStringConfig(ext, "图片全局识别豹语条件"),
            URL_TO_BASE64: seal.ext.getOptionConfig(ext, "识别图片时将url转换为base64"),
            IMAGE_TEXT_TRUNCATE_CHARS: seal.ext.getIntConfig(ext, "图片识别展示截断字数"),
            IMAGE_GC_DAYS: seal.ext.getIntConfig(ext, "图片清理天数"),
            AUTO_TYPE_TAGS: seal.ext.getBoolConfig(ext, "工具产出图片自动类型标签"),
            AUTO_TYPE_TAG_MAX: seal.ext.getIntConfig(ext, "自动类型标签每图上限"),
            MODEL_MAX_SIDE: seal.ext.getIntConfig(ext, "模型图片单边上限"),
            MODEL_TARGET_SIDE: seal.ext.getIntConfig(ext, "模型图片目标长边"),
            MAX_IMAGES_PER_REQUEST: seal.ext.getIntConfig(ext, "每轮最多图片数"),
            MAX_IMAGES_PER_TOOL_RESULT: seal.ext.getIntConfig(ext, "每条工具结果最多升格图片数"),
            INLINE_MAX_BYTES_KB: seal.ext.getIntConfig(ext, "单张内联上限KB"),
            INLINE_TOTAL_BYTES_KB: seal.ext.getIntConfig(ext, "每轮内联总字节KB"),
            INLINE_MAX_IMAGES: seal.ext.getIntConfig(ext, "每轮最多内联图片数"),
            TOOL_RESULT_IMAGES: seal.ext.getBoolConfig(ext, "模型工具结果图片"),
            IMAGE_DEGRADE_ENABLED: seal.ext.getBoolConfig(ext, "图片被模型拒绝时自动降级"),
            IMAGE_DEGRADE_NOTICE: seal.ext.getBoolConfig(ext, "图片降级通知"),
            LOCAL_IMAGE_PATH_MAP: ImageConfig.getPathMapConfig(ext, "本地图片路径")
        }
    }
}
export function resetImageConfigCacheForTest(): void {
    ImageConfig.resetCacheForTest();
}
