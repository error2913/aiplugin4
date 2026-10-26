// 图片识别默认提示词（资源层叶子）：不属于 system prompt 段注册表，放在 resource 域避免 prompt 模块被下层反向依赖。
import Handlebars from "handlebars";

const IMAGE_PROMPT_TEMPLATE_TEXT =
    'Describe this image briefly: its type, scene, main subject and any visible text. Output all visible text verbatim.';

/** 图片识别默认提示词模板（兼容旧调用：无变量） */
export const IMAGE_PROMPT_TEMPLATE = Handlebars.compile(IMAGE_PROMPT_TEMPLATE_TEXT);

/** 纯文本形式（需要直接拼接时使用） */
export const IMAGE_PROMPT_TEXT = IMAGE_PROMPT_TEMPLATE_TEXT;
