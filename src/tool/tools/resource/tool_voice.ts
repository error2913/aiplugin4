// 音频资源工具：生成音频资源（异步任务，提交即返回）与解析已有音频资源（同步）。
import Config from "../../../config/config";
import { logger } from "../../../logger";
import { MediaTaskManager } from "../../../media/task_queue";
import Model from "../../../model/model";
import { resolveResourceReference } from "../../../utils/resource";
import Tool from "../../tool";
import { buildMediaSubmitReply, buildMediaToolInfo, resolveMediaEntry } from "../media/shared";

const log = logger.withTag('tool');

export function registerAudioTools() {
    const tool = new Tool(buildMediaToolInfo({
        name: "generate_audio",
        description:
            "Generate voice (submits a generation task and returns the task number immediately; when generation completes you are notified automatically, then send the voice to the user). Sending is not automatic."
            + "When path is given, instead resolve an existing local/MCP audio resource and return the record segment synchronously; nothing is generated and nothing is queued.",
        properties: {
            text: { type: "string", description: "Text to synthesize" },
            model: { type: "string", description: "Optional; specify a voice model (from \"API connections\"); defaults to the default model for tts" },
            path: { type: "string", description: "Existing local voice path, file:// URI or mcp:// resource (when path is given nothing is generated; it is resolved and returned directly)" },
            source: { type: "string", enum: ["local", "mcp"], description: "Source of the path resource" },
            server: { type: "string", description: "MCP file server name" },
        },
        required: [],
    }, 'tts'));

    tool.solve = async (_ctx, _msg, _session, args) => {
        const text = args && typeof args.text === "string" ? args.text : "";
        const path = args && typeof args.path === "string" ? args.path : "";
        if (!text && !path) return "必须提供 text 或 path";
        if (text && path) return "text 与 path 不能同时提供";

        try {
            // 已有资源分支：保持同步，不进任务队列
            if (path) {
                const sessionKey = _session && _session.sessionId ? _session.sessionId : '';
                const resource = await resolveResourceReference(path, args.source, args.server, sessionKey);
                return JSON.stringify({ kind: "resource", type: "record", name: resource.name, segment: { type: "record", data: { file: resource.path } } });
            }

            await Model.ensureLoaded();
            const { entry, error } = resolveMediaEntry('tts', args.model);
            if (!entry) return JSON.stringify({ ok: false, code: "MEDIA_MODEL_UNAVAILABLE", message: error });

            // 同步校验（不建任务）：参数越界/类型不符在此直接返回，避免排队后才发现
            const prepared = await entry.prepareTTS(text, args);
            if ('error' in prepared) {
                return JSON.stringify({ ok: false, code: "MEDIA_PARAM_ERROR", message: prepared.error });
            }

            const task = MediaTaskManager.submit({
                ctx: _ctx,
                kind: 'tts',
                origin: 'tool',
                entry,
                text,
                params: args,
                modelLabel: entry.ref,
            });
            const queued = MediaTaskManager.pendingCount(task.sid) - 1;

            // 同步等待窗口：生成够快就当场返回结果，不再走异步通知（省一轮唤醒、也避免撞会话闸门）
            const waitMs = Number(Config.tool.MEDIA_SYNC_WAIT_SECONDS) * 1000;
            const settled = await MediaTaskManager.waitForSettle(task, waitMs);
            if (settled) {
                return buildMediaSubmitReply({
                    mode: 'sync',
                    taskId: task.id,
                    kind: 'tts',
                    modelLabel: entry.ref,
                    queued,
                    recordFile: settled.result?.data,
                    errorText: settled.status === 'failed' ? (settled.error || '未知错误') : undefined,
                });
            }
            return buildMediaSubmitReply({
                mode: 'async',
                taskId: task.id,
                kind: 'tts',
                modelLabel: entry.ref,
                queued,
            });
        } catch (error) {
            log.error(`提交语音生成任务失败：${error instanceof Error ? error.message : String(error)}`);
            return JSON.stringify({ ok: false, code: "AUDIO_GENERATION_ERROR", message: error instanceof Error ? error.message : String(error) });
        }
    };
}
