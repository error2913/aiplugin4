# coding: utf-8
VERSION = "1.0.3"  # 版本号更新

import asyncio
from contextlib import asynccontextmanager
import time
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from openai import OpenAI
import uvicorn
from typing import AsyncIterator, Dict, Any, List
import threading
import tiktoken
import logging
import json

CLEANUP_INTERVAL = 24 * 60 * 60 # 清理过期任务的间隔（秒）
SPLIT_STR_TUPLE = (',', '，', '。', '!', '！', '?', '？', ';', '；', ':', '：', '~', '--', '——', '...', '……', '\n', '\t', '\r')
SYM_PAIRS = {
    "(": (")", 11),
    "（": ("）", 11),
    "[": ("]", 11),
    "【": ("】", 11),
    "{": ("}", 30),
    "《": ("》", 7),
    "『": ("』", 7),
    "「": ("」", 7),
    '"': ('"', 30),
    "“": ("”", 30),
    "'": ("'", 11),
    "‘": ("'", 11),
    "<|": ("|>", 22),
    "<｜": ("｜>", 22),
    "<│": ("│>", 22),
    "＜|": ("|＞", 22),
    "＜｜": ("｜＞", 22),
    "＜│": ("│＞", 22),
    "< |": ("| >", 22),
    "< ｜": ("｜ >", 22),
    "< │": ("│ >", 22),
    "＜ |": ("| ＞", 22),
    "＜ ｜": ("｜ ＞", 22),
    "＜ │": ("│ ＞", 22),
    "`": ("`", 11),
    "```": ("```", 60),
    "*": ("*", 11),
    "**": ("**", 11),
}

OPEN_TOKENS = set(SYM_PAIRS.keys())
CLOSE_TOKENS = set([v[0] for v in SYM_PAIRS.values()])
SPLIT_TOKENS = set(SPLIT_STR_TUPLE)
ALL_TOKENS = sorted(OPEN_TOKENS | CLOSE_TOKENS | SPLIT_TOKENS, key=len, reverse=True)

FORCE_THRESHOLD = 150 # 强制分割的阈值

# WebSocket 连接管理器
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.lock = threading.Lock()

    async def connect(self, websocket: WebSocket, stream_id: str):
        await websocket.accept()
        with self.lock:
            self.active_connections[stream_id] = websocket

    def disconnect(self, stream_id: str):
        with self.lock:
            if stream_id in self.active_connections:
                del self.active_connections[stream_id]

    async def send_text(self, stream_id: str, data: Dict[str, Any]):
        with self.lock:
            if stream_id in self.active_connections:
                try:
                    await self.active_connections[stream_id].send_text(json.dumps(data))
                except Exception as e:
                    logger.error(f"发送消息到 {stream_id} 失败: {str(e)}")
                    self.disconnect(stream_id)

manager = ConnectionManager()
encoder = tiktoken.get_encoding("cl100k_base")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("流式处理")

async def cleanup_connections():
    """
    定期清理过期连接
    """
    while True:
        current_time = time.time()
        # 这里可以添加连接超时检查逻辑
        await asyncio.sleep(CLEANUP_INTERVAL)
        
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    生命周期管理：启动和关闭逻辑
    """
    logger.info("启动连接清理任务")
    cleanup_task = asyncio.create_task(cleanup_connections())
    yield
    
    logger.info("关闭连接清理任务")
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    
app = FastAPI(lifespan=lifespan)

def cal_len(text: str) -> float:
    """
    计算文本长度，半角字符算0.5，全角字符算1
    """
    return round(sum(0.5 if ord(c) < 256 else 1 for c in text), 1)

def parse_symbols(text: str) -> tuple[int, str]:
    """
    解析文本中的符号，并返回分割信息
    """
    stack: List[tuple[int, str]] = [] # 符号栈
    seg = None # 分割信息
    force_threshold = 0 # 强制分割的阈值
    text_len = 0 # 除去成对符号后的文本长度，从第一个左符号后开始计算
    i = 0
    while i < len(text):
        for token in ALL_TOKENS:
            if text.startswith(token, i):
                if token in CLOSE_TOKENS and stack and SYM_PAIRS.get(stack[-1][1])[0] == token:
                    text_len -= cal_len(text[stack[-1][0]: i + len(token)]) # 减去成对符号的长度
                    stack.pop()
                    force_threshold -= [SYM_PAIRS[key][1] for key in OPEN_TOKENS if SYM_PAIRS[key][0] == token][0]
                    if not stack:
                        text_len = 0 # 没有左符号，重置长度
                elif token in OPEN_TOKENS:
                    if seg and stack:
                        seg = None # 两个左符号之间，分割信息失效
                    stack.append((i, token))
                    force_threshold += SYM_PAIRS[token][1]
                    if not stack:
                        text_len = cal_len(text) - i - len(token) # 记录第一个左符号后的长度
                elif token in SPLIT_TOKENS and (force_threshold == 0 or text_len >= force_threshold): # 防止分割掉成对符号
                    seg = (i, token)
                i += len(token) - 1
                break
        if force_threshold > 0 and text_len >= force_threshold: # 如果长度超过阈值，则强制分割
            seg = (i, '')
        i += 1
            
    return seg

async def process_stream_with_ws(response, stream_id: str, model: str, prompt_tokens: int):
    """
    处理流式响应并通过WebSocket发送
    """
    try:
        part = ""
        completion_tokens = 0
        
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                content = chunk.choices[0].delta.content
                part += content
                
                seg = parse_symbols(part) # 解析符号，并获取分割信息
                
                if seg:
                    (idx, token) = seg
                    segment_text = part[: idx + len(token)]
                    completion_tokens += len(encoder.encode(segment_text))
                    
                    # 通过WebSocket发送数据
                    await manager.send_text(stream_id, {
                        "type": "content",
                        "content": segment_text,
                        "status": "processing"
                    })
                    part = part[idx + len(token):]

                if cal_len(part) >= FORCE_THRESHOLD: # 如果长度超过阈值，则强制分割
                    completion_tokens += len(encoder.encode(part))
                    await manager.send_text(stream_id, {
                        "type": "content", 
                        "content": part,
                        "status": "processing"
                    })
                    part = ""
        
        # 发送剩余内容
        if part:
            completion_tokens += len(encoder.encode(part))
            await manager.send_text(stream_id, {
                "type": "content",
                "content": part,
                "status": "processing"
            })
        
        # 发送完成消息
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens
        }
        
        await manager.send_text(stream_id, {
            "type": "completed",
            "status": "completed",
            "model": model,
            "usage": usage
        })
        
        logger.info(f"任务{stream_id}处理完成")
        
    except Exception as e:
        logger.error(f"任务{stream_id}处理失败：{str(e)}")
        await manager.send_text(stream_id, {
            "type": "error",
            "status": "failed",
            "error": str(e)
        })
    finally:
        # 清理连接
        manager.disconnect(stream_id)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket端点，处理流式对话
    """
    stream_id = None
    try:
        # 等待客户端发送初始化数据
        data = await websocket.receive_text()
        request_data = json.loads(data)
        
        url = request_data.get("url")
        api_key = request_data.get("api_key")
        body_obj = request_data.get("body_obj")

        if not url or not api_key or not body_obj:
            await websocket.send_text(json.dumps({
                "type": "error",
                "error": "Missing required fields"
            }))
            return

        body_obj['stream'] = True
        
        # 计算输入tokens
        prompt_tokens = sum(len(encoder.encode(message['content'])) for message in body_obj['messages'])
        logger.info(f"输入tokens：{prompt_tokens}")
        
        # 生成唯一ID
        stream_id = uuid.uuid4().hex
        logger.info(f"生成的ID：{stream_id}")
        
        # 连接WebSocket
        await manager.connect(websocket, stream_id)
        
        # 发送连接确认
        await manager.send_text(stream_id, {
            "type": "connected",
            "stream_id": stream_id
        })
        
        # 创建OpenAI客户端
        base_url = url.replace("/chat/completions", "")
        client = OpenAI(api_key=api_key, base_url=base_url)
        
        # 启动流式处理
        response = client.chat.completions.create(**body_obj)
        asyncio.create_task(process_stream_with_ws(response, stream_id, body_obj['model'], prompt_tokens))
        
        # 保持连接直到客户端断开或处理完成
        try:
            while True:
                # 等待客户端消息或连接关闭
                message = await websocket.receive_text()
                # 可以处理客户端发送的控制消息，如取消请求
                msg_data = json.loads(message)
                if msg_data.get("type") == "cancel":
                    logger.info(f"客户端取消任务: {stream_id}")
                    break
        except WebSocketDisconnect:
            logger.info(f"客户端断开连接: {stream_id}")
            
    except Exception as e:
        logger.error(f"WebSocket处理错误：{str(e)}")
        if stream_id:
            await manager.send_text(stream_id, {
                "type": "error",
                "error": f"Internal error: {str(e)}"
            })
            manager.disconnect(stream_id)

# 保留原有的HTTP端点用于兼容性，但可以标记为弃用
@app.post("/start")
async def start_completion_deprecated():
    raise HTTPException(410, "This endpoint is deprecated. Please use WebSocket instead.")

@app.get("/poll")
async def poll_completion_deprecated():
    raise HTTPException(410, "This endpoint is deprecated. Please use WebSocket instead.")

@app.get("/end")
async def end_completion_deprecated():
    raise HTTPException(410, "This endpoint is deprecated. Please use WebSocket instead.")

if __name__ == "__main__":
    logger.info(f"服务开始启动，版本号：{VERSION}")
    uvicorn.run(app, host="0.0.0.0", port=3010)
    logger.info("服务退出成功")