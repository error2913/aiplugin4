# coding: utf-8
VERSION = "1.0.2"

import asyncio
from contextlib import asynccontextmanager
import time
import uuid
from fastapi import BackgroundTasks, FastAPI, Query, Request, HTTPException
from openai import OpenAI
import uvicorn
from typing import AsyncIterator, Dict, Any, List
import threading
import tiktoken
import logging

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
    "‘": ("’", 11),
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

stream_data: Dict[str, Dict[str, Any]] = {}
stream_lock = threading.Lock() # 线程锁

encoder = tiktoken.get_encoding("cl100k_base")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("流式处理")

async def cleanup_stream():
    """
    定期清理过期任务
    """
    while True:
        current_time = time.time()
        logger.info(f"开始清理过期任务，当前任务数：{len(stream_data)}，当前时间：{current_time}")
        with stream_lock:
            for stream_id, data in list(stream_data.items()):
                if data['time'] + CLEANUP_INTERVAL < current_time:
                    del stream_data[stream_id]
        logger.info(f"清理完成，剩余任务数：{len(stream_data)}")
        await asyncio.sleep(CLEANUP_INTERVAL)
        
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    生命周期管理：启动和关闭逻辑
    """
    logger.info("启动定期清理任务")
    cleanup_task = asyncio.create_task(cleanup_stream())
    yield
    
    logger.info("关闭定期清理任务")
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

def process_stream(response, stream_id: str):
    try:
        part = ""
        for chunk in response:
            with stream_lock:
                if stream_id not in stream_data:
                    return
                data = stream_data[stream_id]
                if data['status'] != 'processing':
                    return

            if chunk.choices and chunk.choices[0].delta.content:
                content = chunk.choices[0].delta.content
                part += content
                
                with stream_lock:
                    seg = parse_symbols(part) # 解析符号，并获取分割信息
                    
                    if seg:
                        (idx, token) = seg
                        data['parts'].append(part[: idx + len(token)])
                        part = part[idx + len(token):]

                    if cal_len(part) >= FORCE_THRESHOLD: # 如果长度超过阈值，则强制分割
                        data['parts'].append(part)
                        part = ""
        
        with stream_lock:
            if stream_id in stream_data:
                if part:
                    stream_data[stream_id]['parts'].append(part)
                stream_data[stream_id]['status'] = 'completed'
                logger.info(f"任务{stream_id}处理完成")
    except Exception as e:
        logger.error(f"任务{stream_id}处理失败：{str(e)}")
        with stream_lock:
            if stream_id in stream_data:
                stream_data[stream_id]['status'] = 'failed'
                stream_data[stream_id]['error'] = str(e)

@app.post("/start")
async def start_completion(
    request: Request, 
    background_tasks: BackgroundTasks
):
    stream_id = None
    try:
        body = await request.json()
        url = body.get("url")
        api_key = body.get("api_key")
        body_obj = body.get("body_obj")

        if not url or not api_key or not body_obj:
            raise HTTPException(400, "Missing required fields")

        body_obj['stream'] = True
        
        # 计算输入tokens
        prompt_tokens = sum(len(encoder.encode(message['content'])) for message in body_obj['messages'])
        logger.info(f"输入tokens：{prompt_tokens}")
        
        # 生成唯一ID
        stream_id = uuid.uuid4().hex
        logger.info(f"生成的ID：{stream_id}")
        
        with stream_lock:
            stream_data[stream_id] = {
                'timestamp': time.time(),
                'model': body_obj['model'],
                'prompt_tokens': prompt_tokens,
                'parts': [],
                'status': 'processing',
                'error': None
            }
        
        # 创建OpenAI客户端
        base_url = url.replace("/chat/completions", "")
        client = OpenAI(api_key=api_key, base_url=base_url)
        
        # 启动后台任务处理流
        response = client.chat.completions.create(**body_obj)
        background_tasks.add_task(process_stream, response, stream_id)
        
        return {"id": stream_id}
    
    except HTTPException as he:
        logger.error(f"HTTP异常：{str(he)}")
        raise
    except Exception as e:
        logger.error(f"内部错误：{str(e)}")
        with stream_lock:
            if stream_id in stream_data:
                del stream_data[stream_id]
        raise HTTPException(500, f"Internal error: {str(e)}")

@app.get("/poll")
async def poll_completion(
    id: str = Query(..., description="Stream ID"),
    after: int = Query(0, description="Last received part index")
):
    try:
        if id not in stream_data:
            raise HTTPException(404, "Stream not found")
        with stream_lock:
            data = stream_data[id]
            parts = data['parts']
            
            if after >= len(parts):
                return {
                    "status": data['status'],
                    "results": [],
                    "next_after": after
                }
            
            results = parts[after:]
            return {
                "status": data['status'],
                "results": results,
                "next_after": len(parts)
            }
    except HTTPException as he:
        logger.error(f"HTTP异常：{str(he)}")
        raise
    except Exception as e:
        logger.error(f"内部错误：{str(e)}")
        raise HTTPException(500, f"Internal error: {str(e)}")

@app.get("/end")
async def end_completion(id: str = Query(...)):
    try:
        if id not in stream_data:
            raise HTTPException(404, "Stream not found")
        with stream_lock:
            model = stream_data[id]['model']
            completion_tokens = sum(len(encoder.encode(part)) for part in stream_data[id]['parts'])
            usage = {
                "prompt_tokens": stream_data[id]['prompt_tokens'],
                "completion_tokens": completion_tokens,
                "total_tokens": stream_data[id]['prompt_tokens'] + completion_tokens
            }
            
            del stream_data[id]
            logger.info(f"任务{id}结束成功")
            return {
                "status": "success",
                "model": model,
                "usage": usage
            }
    except Exception as e:
        logger.error(f"内部错误：{str(e)}")
        with stream_lock:
            if id in stream_data:
                del stream_data[id]
        raise HTTPException(500, f"Internal error: {str(e)}")

if __name__ == "__main__":
    logger.info(f"服务开始启动，版本号：{VERSION}")
    uvicorn.run(app, host="0.0.0.0", port=3010)
    logger.info("服务退出成功")
