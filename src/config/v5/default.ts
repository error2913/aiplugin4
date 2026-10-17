// v5 出厂默认配置（最小可用示例）。
//
// 单独成文件的原因：它是**纯数据**，不依赖 seal。
// 这样集成联测（scripts/integration-config-generator.mjs）可以直接打包引用，
// 而不必为了拿到一个常量去 stub 整个 seal 环境。
//
// 设计取舍（方案 12.2）：
//   - apiKey 用占位符 `sk-xxxx` 而非空串 —— 空串过不了校验（apiKey 必填），
//     用户看到的第一眼就会是报错。占位符的表现与 v4 出厂默认一致（请求会 401，提示去填真 key）。
//   - provider 不写：由 baseURL 反查（方案 2.3.2），避免冗余字段。
//   - **两个默认模型都显式声明 kind**。这里推翻过初版的"不写 kind"：
//       · catalog.ts:86-91 起，视觉**不再靠命名猜测**（原 GENERIC_VISION_PATTERNS 已删除），
//         所以不声明就只能指望接口自报能力位 —— 而模型列表**拉取失败**（CORS/离线/对方不报）
//         时 flash 会掉成 text，视觉能力直接没了。
//       · 初版担心的"钉一个 text 会把多模态废掉"依然成立，但那是**猜**错的情况；
//         现在 flash=vision / pro=text 是**确定事实**，显式声明只会更稳。
//     （配置里的 kind 是 `manual`，在 catalog.ts:110 里绝对优先 —— 所以声明了就一定生效。）
//   - 只钉住两个对话系模型；媒体/嵌入仍需用户自己配并声明 kind。
//
// 默认模型（用户确认的事实）：
//   deepseek-flash → vision（可进对话与 image-understanding 候选）
//   deepseek-pro   → text
// 用途**全部绑 flash**；pro 作为可用模型摆在候选池里（用户可自行改绑）。

import { PROVIDER_MAP } from "../static_config/providers";

export const DEFAULT_V5_CONFIG = JSON.stringify({
    version: 5,
    providers: [{
        api: 'openai-completions',
        baseURL: PROVIDER_MAP['deepseek'],
        apiKey: 'sk-xxxx',
        models: [
            { id: 'flash', name: 'deepseek-flash', kind: 'vision' },
            { id: 'pro', name: 'deepseek-pro', kind: 'text' },
        ],
    }],
    // 用途绑定用**数组**（形状统一，插件侧不必区分单字符串与数组两种写法）。
    // 单字符串仍被接受（手写配置容错），但出厂示例就用规范形态。
    purposes: { chat: ['flash'], compression: ['flash'], summarization: ['flash'], judge: ['flash'] },
    groups: [{
        purposes: ['chat', 'compression', 'summarization', 'judge'],
        body: { temperature: 1, top_p: 1, max_tokens: 8192, stop: null, stream: false },
    }],
});
