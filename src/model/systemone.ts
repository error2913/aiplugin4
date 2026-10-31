// System One 决策模型请求（model 层）：endpoint 固定 {baseURL}/systemone，Bearer 鉴权。
//
// 与聊天模型共用 requestModel 的超时/重试/错误分类/用量上报；区别只有 URL 与 body：
//   { model, state, questions } → { answers, usage }。
// 由 agent 层实现 AuxLlm.systemOne 时调用；judge 只依赖 L0 端口。
import type { ModelEntry } from './entry';
import { requestModel } from './provider';

/** 去尾斜杠后拼 /systemone（Alibaba 的 baseURL 已含 /compatible-mode/v1；Jev 填 https://jevmodel.org/v1）。 */
export function systemOneUrl(baseUrl: string): string {
    return String(baseUrl ?? '').trim().replace(/\/+$/, '') + '/systemone';
}

export type SystemOneQuestions = Record<string, { type: 'score'; instructions: string; criteria: string[] }>;

/** 发起一次 System One 决策请求；返回原始 JSON（由 judge 侧归一化）。 */
export async function requestSystemOne(
    model: ModelEntry,
    state: unknown,
    questions: SystemOneQuestions,
): Promise<unknown> {
    return requestModel(
        systemOneUrl(model.baseUrl),
        model.apiKey,
        { model: model.name, state, questions },
        {
            provider: model.provider,
            // 固定按 OpenAI 兼容鉴权（Bearer）；decision 不参与连接 api 的协议分派
            api: 'openai-completions',
            modelName: model.name,
            use: 'judge',
        },
    );
}
