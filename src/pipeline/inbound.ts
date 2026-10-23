// ob11 入站消息段渲染（叶子）：卡片/语音/文件/视频/音乐/商城表情/XML/Markdown/消息节点/合并转发 → MessageSegment[]。
// 从 pipeline.ts 拆出——段渲染只依赖 utils（special_id/ob11/string），与触发/命令/事件分发管线解耦；
// pipeline.ts 保留静态方法委派（MessagePipeline 外部 API 不变）。
import { expandForwardMessage } from "../utils/ob11";
import { registerSpecialResource } from "../utils/special_id";
import { formatMediaSegmentText, MessageSegment, parseCardToText, parseMusicToText, truncateText } from "../utils/string";

/** 消息节点/合并转发展开的最大嵌套深度，防止恶意或异常嵌套导致无限递归 */
const MAX_FORWARD_DEPTH = 5;

/** ob11 数组消息段 → MessageSegment[]：把卡片/视频/音乐/文件/消息节点/合并转发展开为文本段，其余段保留 */
export async function expandOb11Segments(ctx: seal.MsgContext, segs: any[], depth: number = 0): Promise<MessageSegment[]> {
    if (depth > MAX_FORWARD_DEPTH) {
        return [{ type: 'text', data: { text: '[消息嵌套过深，已截断]' } }];
    }
    const result: MessageSegment[] = [];
    const epId = ctx.endPoint.userId;
    for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        const data = seg.data || {};
        switch (seg.type) {
            case 'json': {
                // QQ 卡片消息：转为上下文专用闭合标签 [card]...[/card]，AI 可读标题/描述/链接
                result.push({ type: 'text', data: { text: parseCardToText(data.data), __system: '1' } });
                break;
            }
            case 'record': {
                // milky 适配器会丢弃语音段，这里由 ob11 转接事件补收：登记句柄并渲染 [record:句柄]摘要[/record]，
                // AI 可通过 resolve_special_id(type=record, id=句柄) 获取原始文件字段。
                const recordHandle = registerSpecialResource('record', data);
                result.push({ type: 'text', data: { text: formatMediaSegmentText('语音', data, recordHandle), __system: '1' } });
                break;
            }
            case 'file': {
                // 登记句柄并渲染 [file:句柄]文件名[/file]，AI 可通过 resolve_special_id(type=file, id=句柄) 查询或下载
                const fileHandle = registerSpecialResource('file', data);
                result.push({ type: 'text', data: { text: formatMediaSegmentText('文件', data, fileHandle), __system: '1' } });
                break;
            }
            case 'video': {
                // 登记句柄并渲染 [video:句柄]摘要[/video]，AI 可通过 resolve_special_id(type=video, id=句柄) 查询
                const videoHandle = registerSpecialResource('video', data);
                result.push({ type: 'text', data: { text: formatMediaSegmentText('视频', data, videoHandle), __system: '1' } });
                break;
            }
            case 'music': {
                result.push({ type: 'text', data: { text: parseMusicToText(data), __system: '1' } });
                break;
            }
            case 'market_face': {
                // 商城表情/超级表情：milky 转接只透传元数据，转为 [face]表情名[/face] 占位避免段静默丢失
                result.push({ type: 'text', data: { text: `[face]${data.summary ? String(data.summary) : '未知商城表情'}[/face]`, __system: '1' } });
                break;
            }
            case 'xml': {
                // XML 卡片/公众号消息：转为 [xml]...[/xml]，过长时截断避免污染上下文
                result.push({ type: 'text', data: { text: `[xml]${data.data ? truncateText(String(data.data), 500) : '未知XML消息'}[/xml]`, __system: '1' } });
                break;
            }
            case 'markdown': {
                // Markdown 消息：milky 转接成 OB11 markdown 段，转为 [markdown]...[/markdown] 进入上下文
                result.push({ type: 'text', data: { text: `[markdown]${data.content ? truncateText(String(data.content), 500) : '未知Markdown'}[/markdown]`, __system: '1' } });
                break;
            }
            case 'node': {
                const nodeText = await parseNodeToText(ctx, data, depth + 1);
                result.push({ type: 'text', data: { text: `[node]${nodeText}[/node]`, __system: '1' } });
                break;
            }
            case 'forward': {
                const text = await expandForwardMessage(epId, data.id || data.file || '', depth + 1);
                result.push({
                    type: 'text',
                    data: { text: text ? `[forward]\n${text}\n[/forward]` : '[forward]合并转发展开失败[/forward]', __system: '1' }
                });
                break;
            }
            default: result.push(seg as MessageSegment);
        }
    }
    return result;
}

/** 消息节点（node）转可读文本：完整节点递归内容，仅 id 时走 ob11 获取 */
export async function parseNodeToText(ctx: seal.MsgContext, data: any, depth: number = 0): Promise<string> {
    const name = (data && (data.nickname || data.name)) || (data && data.user_id ? `用户${data.user_id}` : '');
    if (depth > MAX_FORWARD_DEPTH) {
        return `${name}（嵌套过深，已截断）`;
    }
    if (data && typeof data.content === 'string') {
        return `${name}: ${data.content}`;
    }
    if (data && Array.isArray(data.content)) {
        const segs = await expandOb11Segments(ctx, data.content, depth + 1);
        let text = '';
        for (const s of segs) {
            text += s.type === 'text' ? ((s.data && s.data.text) || '') : `[${s.type}]`;
        }
        return `${name}: ${text}`;
    }
    if (data && data.id) {
        const text = await expandForwardMessage(ctx.endPoint.userId, String(data.id), depth + 1);
        return text ? `${name}:\n${text}` : `${name}`;
    }
    return name || '未知消息节点';
}
