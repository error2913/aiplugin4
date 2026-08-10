// 论坛工具：帖子列表/详情/搜索/发帖/评论/动态通知/帖子管理
import Config from "../../config/config";
import { logger } from "../../logger";
import Image from "../../resource/image";
import { parseSpecialTokens } from "../../utils/string";
import Tool from "../tool";

/**
 * FNV-1a 签名算法
 */
function simpleSign(secretKey: string, message: string): string {
    let hash = 0x811c9dc5;
    const combined = secretKey + '|' + message;
    for (let i = 0; i < combined.length; i++) {
        hash ^= combined.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) & 0xFFFFFFFF;
    }
    for (let i = combined.length - 1; i >= 0; i--) {
        hash ^= combined.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) & 0xFFFFFFFF;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 生成随机 nonce
 */
let _nonceCounter = 0;
function generateNonce(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    _nonceCounter++;
    return result + Date.now().toString(36) + _nonceCounter.toString(36);
}

/**
 * 带鉴权的 fetch 封装
 */
async function forumAuthFetch(url: string, method: string, body?: any): Promise<any> {
    const { FORUM_API_TOKEN, FORUM_SECRET_KEY } = Config.backend;

    if (!FORUM_API_TOKEN || !FORUM_SECRET_KEY) {
        throw new Error('论坛API Token或Secret Key未配置，请在后端配置中填写');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = generateNonce();

    let bodyStr = '';
    if (body && typeof body === 'object') {
        bodyStr = JSON.stringify(body);
    }
    const bodyPreview = bodyStr.substring(0, 128);
    const message = timestamp + ':' + nonce + ':' + bodyPreview;
    const signature = simpleSign(FORUM_SECRET_KEY, message);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FORUM_API_TOKEN}`,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Signature': signature
    };

    const options: any = {
        method: method,
        headers: headers
    };

    if (body && (method === 'POST' || method === 'PUT')) {
        options.body = bodyStr;
    }

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
        throw new Error(`论坛请求失败(${response.status}): ${JSON.stringify(data)}`);
    }

    return data;
}

/**
 * 根据 Image 对象的 format 推断 MIME 类型
 */
function getMimeType(image: Image): string {
    const format = image.format?.toLowerCase() || '';
    const mimeMap: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml',
    };
    return mimeMap[format] || 'image/png';
}

/**
 * 将 Image 对象转换为论坛 API 所需的图片格式
 * 确保图片为 base64 格式，并返回 { name, mime_type, data } 结构
 */
async function imageToForumFormat(image: Image): Promise<{ name: string, mime_type: string, data: string } | null> {
    try {
        if (image.type === 'url') {
            await image.urlToBase64();
        }

        const base64Data = image.base64;
        if (!base64Data) {
            logger.warning(`图片 ${image.imageId} 无法获取 base64 数据`);
            return null;
        }
        const pureBase64 = base64Data.replace(/^data:image\/[^;]+;base64,/, '');

        const format = image.format || 'png';
        const mimeType = getMimeType(image);
        const fileName = `${image.imageId}.${format === 'unknown' ? 'png' : format}`;

        return {
            name: fileName,
            mime_type: mimeType,
            data: pureBase64
        };
    } catch (error) {
        logger.error(`转换图片 ${image.imageId} 为论坛格式失败:`, error);
        return null;
    }
}

/**
 * 从内容中提取 [img:xxx]（兼容历史 <|img:xxx|>）引用的图片 ID，通过 Image.get 查找
 */
function extractImagesFromContent(content: string): Image[] {
    const segs = parseSpecialTokens(content);
    const images: Image[] = [];
    for (const seg of segs) {
        if (seg.type === 'img') {
            const id = seg.content;
            // 兼容 [img:imageId:描述]：整体找不到时取首个冒号前作为图片 id
            const image = Image.get(id) || (id.includes(':') ? Image.get(id.split(':')[0]) : null);
            if (image) {
                images.push(image);
            } else {
                logger.warning(`论坛发帖：无法找到图片 ${id}`);
            }
        }
    }
    return images;
}

/**
 * 从内容中移除 [img:xxx]（兼容历史 <|img:xxx|>）标记，保留纯文本/Markdown
 */
function stripImageTokens(content: string): string {
    return content.replace(/<\|img:[^|]*\|>|\[img:[^\]]*\]/g, '').trim();
}

export function registerForum() {
    // ========== forum_get_posts ==========
    const toolGetPosts = new Tool({
        type: "function",
        function: {
            name: "forum_get_posts",
            description: "获取aiplugin论坛的帖子列表",
            parameters: {
                type: "object",
                properties: {
                    sort: {
                        type: "string",
                        description: "排序方式",
                        enum: ["newest", "hot", "most_comments", "most_viewed"]
                    },
                    page: {
                        type: "integer",
                        description: "页码，默认1"
                    },
                    limit: {
                        type: "integer",
                        description: "每页数量，默认20，最大50"
                    }
                },
                required: []
            }
        }
    });
    toolGetPosts.solve = async (_, __, ___, args) => {
        const { sort = 'newest', page = 1, limit = 20 } = args;
        const { FORUM_URL } = Config.backend;

        try {
            const url = `${FORUM_URL}/api/public/posts?sort=${sort}&page=${page}&limit=${limit}`;
            logger.info(`获取论坛帖子列表: ${url}`);

            const response = await fetch(url, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(`请求失败: ${JSON.stringify(data)}`);
            }

            if (!data.posts || data.posts.length === 0) {
                return '论坛暂无帖子';
            }

            return `论坛帖子列表 (共${data.pagination.total}篇，第${data.pagination.page}/${data.pagination.total_pages}页):\n` +
                data.posts.map((post: any, index: number) => {
                    const tags = post.tags?.map((t: any) => t.name).join(', ') || '无';
                    return `${index + 1}. [ID:${post.id}] ${post.title}\n` +
                        `   作者: ${post.display_name || post.username} | 👍${post.upvotes} 👎${post.downvotes} | 💬${post.comment_count} | 👁${post.view_count}\n` +
                        `   标签: ${tags}\n` +
                        `   预览: ${post.content_preview || ''}`;
                }).join('\n');
        } catch (error) {
            logger.error("在forum_get_posts中请求出错：", error);
            return `获取论坛帖子列表失败: ${error}`;
        }
    };

    // ========== forum_get_post_detail ==========
    const toolGetPostDetail = new Tool({
        type: "function",
        function: {
            name: "forum_get_post_detail",
            description: "获取论坛帖子的详细内容和评论",
            parameters: {
                type: "object",
                properties: {
                    post_id: {
                        type: "integer",
                        description: "帖子ID"
                    }
                },
                required: ["post_id"]
            }
        }
    });
    toolGetPostDetail.solve = async (_, __, ___, args) => {
        const { post_id } = args;
        const { FORUM_URL } = Config.backend;

        try {
            logger.info(`获取论坛帖子详情: post_id=${post_id}`);

            const postResponse = await fetch(`${FORUM_URL}/api/public/posts/${post_id}`, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            const postData = await postResponse.json();

            if (!postResponse.ok) {
                throw new Error(`获取帖子失败: ${JSON.stringify(postData)}`);
            }

            const post = postData.post;
            const tags = post.tags?.map((t: any) => t.name).join(', ') || '无';

            let result = `帖子详情 [ID:${post.id}]\n` +
                `标题: ${post.title}\n` +
                `作者: ${post.display_name || post.username}\n` +
                `标签: ${tags}\n` +
                `赞：${post.upvotes} 踩：${post.downvotes} | 评论：${post.comment_count} | 浏览：${post.view_count}\n` +
                `创建时间: ${post.created_at}\n` +
                `---\n${post.content}\n---`;

            // 获取评论
            const commentResponse = await fetch(`${FORUM_URL}/api/public/posts/${post_id}/comments`, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            const commentData = await commentResponse.json();

            if (commentResponse.ok && commentData.comments && commentData.comments.length > 0) {
                result += `\n\n评论 (${commentData.total}条):\n`;

                const formatComment = (comment: any, depth: number = 0): string => {
                    const indent = '  '.repeat(depth);
                    let s = `${indent}[评论ID:${comment.id}] ${comment.display_name || comment.username}: ${comment.content}\n`;
                    if (comment.replies && comment.replies.length > 0) {
                        for (const reply of comment.replies) {
                            s += formatComment(reply, depth + 1);
                        }
                    }
                    return s;
                };

                for (const comment of commentData.comments) {
                    result += formatComment(comment);
                }
            } else {
                result += '\n\n暂无评论';
            }

            return result;
        } catch (error) {
            logger.error("在forum_get_post_detail中请求出错：", error);
            return `获取论坛帖子详情失败: ${error}`;
        }
    };

    // ========== forum_search ==========
    const toolSearch = new Tool({
        type: "function",
        function: {
            name: "forum_search",
            description: "搜索论坛帖子",
            parameters: {
                type: "object",
                properties: {
                    q: {
                        type: "string",
                        description: "搜索关键词"
                    },
                    user: {
                        type: "string",
                        description: "按用户名筛选"
                    },
                    tag: {
                        type: "string",
                        description: "按标签筛选"
                    },
                    sort: {
                        type: "string",
                        description: "排序方式",
                        enum: ["newest", "hot", "most_comments"]
                    },
                    page: {
                        type: "integer",
                        description: "页码"
                    }
                },
                required: []
            }
        }
    });
    toolSearch.solve = async (_, __, ___, args) => {
        const { q = '', user = '', tag = '', sort = 'newest', page = 1 } = args;
        const { FORUM_URL } = Config.backend;

        try {
            const params: string[] = [];
            if (q) params.push(`q=${encodeURIComponent(q)}`);
            if (user) params.push(`user=${encodeURIComponent(user)}`);
            if (tag) params.push(`tag=${encodeURIComponent(tag)}`);
            if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
            if (page) params.push(`page=${encodeURIComponent(page.toString())}`);

            const url = `${FORUM_URL}/api/public/search?${params.join('&')}`;
            logger.info(`搜索论坛: ${url}`);

            const response = await fetch(url, {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(`搜索失败: ${JSON.stringify(data)}`);
            }

            if (!data.posts || data.posts.length === 0) {
                return '未搜索到相关帖子';
            }

            return `搜索结果 (共${data.pagination.total}条，第${data.pagination.page}/${data.pagination.total_pages}页):\n` +
                data.posts.map((post: any, index: number) => {
                    const tags = post.tags?.map((t: any) => t.name).join(', ') || '无';
                    return `${index + 1}. [ID:${post.id}] ${post.title}\n` +
                        `   作者: ${post.display_name || post.username} | 👍${post.upvotes} 👎${post.downvotes} | 💬${post.comment_count}\n` +
                        `   标签: ${tags}\n` +
                        `   预览: ${post.content_preview || ''}`;
                }).join('\n');
        } catch (error) {
            logger.error("在forum_search中请求出错：", error);
            return `搜索论坛失败: ${error}`;
        }
    };

    // ========== forum_create_post ==========
    const toolCreatePost = new Tool({
        type: "function",
        function: {
            name: "forum_create_post",
            description: "在论坛创建新帖子。" +
                "图片可通过 image_ids 参数传入图片ID列表，也可在 content 中使用 [img:图片ID] 引用。",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "帖子标题，不超过200字符"
                    },
                    content: {
                        type: "string",
                        description: "帖子内容，支持Markdown格式。可以在内容中使用[img:图片ID]引用图片，图片会自动上传并嵌入到帖子中"
                    },
                    tags: {
                        type: "array",
                        description: "帖子标签列表",
                        items: {
                            type: "string"
                        }
                    },
                    image_ids: {
                        type: "array",
                        description: "要附带的图片ID列表，图片会自动转换为base64上传",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["title", "content"]
            }
        }
    }, true);
    toolCreatePost.solve = async (_, __, ___, args) => {
        const { title, content, tags = [], image_ids = [] } = args;
        const { FORUM_URL } = Config.backend;

        try {
            logger.info(`创建论坛帖子: ${title}`);

            const allImages: Image[] = [];

            // 通过 image_ids 参数查找图片
            if (image_ids && image_ids.length > 0) {
                for (const imgId of image_ids) {
                    const image = Image.get(imgId);
                    if (image) {
                        allImages.push(image);
                        logger.info(`论坛发帖：通过 image_ids 找到图片 ${imgId}`);
                    } else {
                        logger.warning(`论坛发帖：无法通过 image_ids 找到图片 ${imgId}`);
                    }
                }
            }

            // 从内容中提取图片引用
            const contentImages = extractImagesFromContent(content);
            for (const img of contentImages) {
                if (!allImages.find(existing => existing.imageId === img.imageId)) {
                    allImages.push(img);
                    logger.info(`论坛发帖：从内容中提取到图片 ${img.imageId}`);
                }
            }

            const cleanContent = stripImageTokens(content);

            const body: any = { title, content: cleanContent };
            if (tags && tags.length > 0) {
                body.tags = tags;
            }

            if (allImages.length > 0) {
                const forumImages: { name: string, mime_type: string, data: string }[] = [];
                for (const image of allImages) {
                    const forumImage = await imageToForumFormat(image);
                    if (forumImage) {
                        forumImages.push(forumImage);
                        logger.info(`论坛发帖：成功转换图片 ${image.imageId}，大小: ${forumImage.data.length} 字符`);
                    }
                }
                if (forumImages.length > 0) {
                    body.images = forumImages;
                }
            }

            const data = await forumAuthFetch(`${FORUM_URL}/api/posts`, 'POST', body);

            let resultMsg = `帖子创建成功！\n帖子ID: ${data.post?.id}\n标题: ${data.post?.title}`;
            if (data.post?.image_ids && data.post.image_ids.length > 0) {
                resultMsg += `\n上传图片数: ${data.post.image_ids.length}`;
            }
            resultMsg += `\n状态: ${data.moderation || '待审核'}`;

            return resultMsg;
        } catch (error) {
            logger.error("在forum_create_post中请求出错：", error);
            return `创建论坛帖子失败: ${error}`;
        }
    };

    // ========== forum_manage_comment ==========
    const toolManageComment = new Tool({
        type: "function",
        function: {
            name: "forum_manage_comment",
            description: "管理论坛评论（支持创建、更新或删除操作）",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description: "操作类型（create、update或delete）",
                        enum: ["create", "update", "delete"]
                    },
                    post_id: {
                        type: "integer",
                        description: "【仅用于create】目标帖子ID"
                    },
                    comment_id: {
                        type: "integer",
                        description: "【仅用于update和delete】目标评论ID"
                    },
                    content: {
                        type: "string",
                        description: "【仅用于create和update】评论内容，支持Markdown格式"
                    },
                    parent_id: {
                        type: "integer",
                        description: "【仅用于create】父评论ID，回复某条具体评论时使用"
                    }
                },
                required: ["action"]
            }
        }
    }, true);
    toolManageComment.solve = async (_, __, ___, args) => {
        const { action, post_id, comment_id, content, parent_id } = args;
        const { FORUM_URL } = Config.backend;

        try {
            if (action === "create") {
                if (!post_id || !content) return "创建评论需要提供 post_id 和 content";
                logger.info(`创建论坛评论: post_id=${post_id}`);
                const body: any = { content };
                if (parent_id) body.parent_id = parent_id;
                const data = await forumAuthFetch(`${FORUM_URL}/api/posts/${post_id}/comments`, 'POST', body);
                return `评论成功！\n评论ID: ${data.comment?.id}\n内容: ${data.comment?.content}`;
            } else if (action === "update") {
                if (!comment_id || !content) return "更新评论需要提供 comment_id 和 content";
                logger.info(`更新论坛评论: comment_id=${comment_id}`);
                await forumAuthFetch(`${FORUM_URL}/api/comments/${comment_id}`, 'PUT', { content });
                return `评论 [ID:${comment_id}] 更新成功！`;
            } else if (action === "delete") {
                if (!comment_id) return "删除评论需要提供 comment_id";
                logger.info(`删除论坛评论: comment_id=${comment_id}`);
                await forumAuthFetch(`${FORUM_URL}/api/comments/${comment_id}`, 'DELETE');
                return `评论 [ID:${comment_id}] 已成功删除！`;
            } else {
                return `未知的操作类型: ${action}`;
            }
        } catch (error) {
            logger.error(`论坛评论操作（${action}）中出错：`, error);
            return `论坛评论操作失败: ${error}`;
        }
    };

    // ========== forum_get_activity ==========
    const toolGetActivity = new Tool({
        type: "function",
        function: {
            name: "forum_get_activity",
            description: "获取论坛动态通知（新的点赞、评论、回复等）",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    });
    toolGetActivity.solve = async (_, __, ___, ____) => {
        const { FORUM_URL } = Config.backend;

        try {
            logger.info('获取论坛动态');

            const data = await forumAuthFetch(`${FORUM_URL}/api/activity`, 'GET');

            if (!data.changes || data.changes.length === 0) {
                return '暂无新动态';
            }

            const summary = data.summary;
            let result = `论坛动态通知：\n` +
                `新点赞: ${summary.total_new_votes || 0} | 新评论: ${summary.total_new_comments || 0} | 新回复: ${summary.total_new_replies || 0}\n` +
                `涉及帖子: ${summary.posts_affected?.join(', ') || '无'}\n\n` +
                `详细动态：\n`;

            result += data.changes.map((change: any, index: number) => {
                const typeMap: Record<string, string> = {
                    'vote': '收到点赞',
                    'new_comment': '收到评论',
                    'new_reply': '收到回复'
                };
                return `${index + 1}. ${typeMap[change.type] || change.type} | 帖子ID:${change.post_id || '无'} | ${change.timestamp}`;
            }).join('\n');

            if (data.has_more) {
                result += '\n\n还有更多未读动态';
            }

            return result;
        } catch (error) {
            logger.error("在forum_get_activity中请求出错：", error);
            return `获取论坛动态失败: ${error}`;
        }
    };

    // ========== forum_manage_post ==========
    const toolManagePost = new Tool({
        type: "function",
        function: {
            name: "forum_manage_post",
            description: "管理自己发布的论坛帖子（支持更新或删除操作，注意只能管理自己发过的帖子）",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        description: "操作类型（update或delete）",
                        enum: ["update", "delete"]
                    },
                    post_id: {
                        type: "integer",
                        description: "目标帖子ID"
                    },
                    title: {
                        type: "string",
                        description: "【仅用于update】新的标题 (可选)"
                    },
                    content: {
                        type: "string",
                        description: "【仅用于update】新的内容，支持Markdown格式 (可选)"
                    },
                    tags: {
                        type: "array",
                        description: "【仅用于update】新的标签列表 (可选)",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["action", "post_id"]
            }
        }
    }, true);
    toolManagePost.solve = async (_, __, ___, args) => {
        const { action, post_id, title, content, tags } = args;
        const { FORUM_URL } = Config.backend;

        try {
            if (action === "update") {
                logger.info(`更新论坛帖子: post_id=${post_id}`);
                const body: any = {};
                if (title !== undefined) body.title = title;
                if (content !== undefined) body.content = content;
                if (tags !== undefined) body.tags = tags;

                if (Object.keys(body).length === 0) {
                    return "请求无效：没有提供任何需要更新的字段";
                }

                const data = await forumAuthFetch(`${FORUM_URL}/api/posts/${post_id}`, 'PUT', body);
                return `帖子 [ID:${post_id}] 更新成功！\n标题: ${data.post?.title || title}\n状态: ${data.moderation || '待审核'}`;
            } else if (action === "delete") {
                logger.info(`删除论坛帖子: post_id=${post_id}`);
                await forumAuthFetch(`${FORUM_URL}/api/posts/${post_id}`, 'DELETE');
                return `帖子 [ID:${post_id}] 已成功删除！`;
            } else {
                return `未知的操作类型: ${action}`;
            }
        } catch (error) {
            logger.error(`论坛帖子操作（${action}）中出错：`, error);
            return `修改论坛帖子失败: ${error}`;
        }
    };
}
