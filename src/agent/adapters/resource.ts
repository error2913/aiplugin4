// 资源来源适配器（L3）：内置图片索引 + 本地资源配置 → 主对话 `core:resources` 提示片段。
//
// 数据边界（方案 §10.4）：
// - 内置图片：`ImageIndex.all()` 只存 `u`（最后使用时间）/`h`（图床 blob id），没有标签；
//   这里只给「数量 + 最近 N 张 ID」，标签从图片实体存档里只读取 `description`，**不调用 Image.get**
//   （Image.get 会刷新 lastUsedAt/落盘，注入提示词不应改变图片清理计时）。
// - 本地资源：`resource:<name>` 清单来自资源页配置（local_images/local_paths），
//   不是抓取图索引 —— 与 `list_resources` 工具列的是同一批名字。
// - 不碰图床：图床规则在 image-host 适配器，避免资源段越权展示 h<sha> 规则。
import { getHost } from '../../core/host';
import type { AuxCapabilityAdapter, AuxSnippetDescriptor } from '../../core/ports/aux_tools';
import { ImageIndex } from '../../resource/image_index';
import type { ImageIndexEntry } from '../../resource/image_index';
import { getLocalAudios, getLocalFiles, getLocalVideos } from '../../resource/local_paths';
import { getLocalImageEntries } from '../../resource/local_paths';

/** 提示词里最多列出的最近内置图片数（预算 600 字符内够用，又不至于刷屏） */
const RECENT_IMAGE_LIMIT = 8;
/** 单条图片说明的最大字符数 */
const LABEL_MAX_CHARS = 40;

export interface ResourceAdapterDeps {
    listIndex?: () => Array<{ id: string; entry: ImageIndexEntry }>;
    /** 读取图片实体存档里的简短说明（不刷新使用时间）；无说明返回空串 */
    readLabel?: (imageId: string) => string;
    /** 本地资源名清单（默认读资源页配置） */
    listLocalResources?: () => string[];
}

/** 从图片存档 JSON 里取 description（只读，不触发 Image.get 的使用时间刷新） */
function readStoredLabel(imageId: string): string {
    try {
        const raw = getHost().storage.get(`image_${imageId}`);
        if (!raw) return '';
        const data = JSON.parse(raw);
        return typeof data?.description === 'string' ? data.description : '';
    } catch {
        return '';
    }
}

function cleanLabel(raw: string): string {
    return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/\[img:[^\]]+\]/g, '')
        .trim()
        .slice(0, LABEL_MAX_CHARS);
}

function defaultLocalResources(): string[] {
    const ids = [
        ...getLocalImageEntries().map(item => item.imageId),
        ...getLocalAudios().map(item => item.audioId),
        ...getLocalFiles().map(item => item.fileId),
        ...getLocalVideos().map(item => item.videoId),
    ];
    return ids.map(id => `resource:${id}`);
}

export function createResourceAdapter(deps: ResourceAdapterDeps = {}): AuxCapabilityAdapter {
    const listIndex = deps.listIndex || (() => ImageIndex.all());
    const readLabel = deps.readLabel || readStoredLabel;
    const listLocalResources = deps.listLocalResources || defaultLocalResources;

    const buildSnippet = (): AuxSnippetDescriptor | null => {
        let entries: Array<{ id: string; entry: ImageIndexEntry }> = [];
        try {
            entries = listIndex();
        } catch {
            entries = [];
        }
        const sorted = entries
            .filter(item => item && item.id)
            .slice()
            .sort((a, b) => (b.entry?.u || 0) - (a.entry?.u || 0));
        const recent = sorted.slice(0, RECENT_IMAGE_LIMIT).map(item => {
            const label = cleanLabel(readLabel(item.id));
            return label ? `${item.id} (${label})` : item.id;
        });
        let resources: string[] = [];
        try {
            resources = listLocalResources().slice(0, 30);
        } catch {
            resources = [];
        }
        if (sorted.length === 0 && resources.length === 0) return null;
        return {
            kind: 'resource',
            data: {
                builtinImageCount: sorted.length,
                recentImages: recent,
                localResources: resources,
            },
        };
    };

    return {
        id: 'resource',
        kind: 'resource',
        displayName: 'Built-in images & local resources',
        tools(): [] {
            return [];
        },
        snippet(): AuxSnippetDescriptor | null {
            return buildSnippet();
        },
        handler() {
            return null;
        },
        /** 索引条目数 + 本地资源名数：任何增减都会使提示词缓存失效（动态 ID 列表不允许被缓存住） */
        revision(): number {
            const count = listIndex().length + listLocalResources().length;
            return count;
        },
    };
}
