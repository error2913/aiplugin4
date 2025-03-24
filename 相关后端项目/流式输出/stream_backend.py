# coding: utf-8
import asyncio
from contextlib import asynccontextmanager
import time
import uuid
from fastapi import BackgroundTasks, FastAPI, Query, Request, HTTPException
from openai import OpenAI
import uvicorn
from typing import AsyncIterator, Dict, Any, List
import threading

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
    "`": ("`", 11),
    "```": ("```", 30),
    "**": ("**", 30),
}

OPEN_TOKENS = set(SYM_PAIRS.keys())
CLOSE_TOKENS = set([v[0] for v in SYM_PAIRS.values()])
SPLIT_TOKENS = set(SPLIT_STR_TUPLE)
ALL_TOKENS = sorted(OPEN_TOKENS | CLOSE_TOKENS | SPLIT_TOKENS, key=len, reverse=True)

FORCE_THRESHOLD = 150 # 强制分割的阈值

stream_data: Dict[str, Dict[str, Any]] = {}
stream_lock = threading.Lock() # 线程锁

async def cleanup_stream():
    """
    定期清理过期任务
    """
    while True:
        time = time.time()
        with stream_lock:
            for stream_id, data in list(stream_data.items()):
                if data['time'] + CLEANUP_INTERVAL < time:
                    del stream_data[stream_id]
                    
        await asyncio.sleep(CLEANUP_INTERVAL)
        
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    生命周期管理：启动和关闭逻辑
    """
    # 启动时启动定期清理任务
    cleanup_task = asyncio.create_task(cleanup_stream())
    yield
    
    # 关闭时取消清理任务
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    
app = FastAPI(lifespan=lifespan)

def parse_symbols(text: str, stack: list) -> list:
    """
    解析文本中的符号，并更新栈
    """
    seg_info = [] # 分割信息
    force_threshold = sum([SYM_PAIRS[sym][1] for sym in stack]) # 强制分割的阈值
    text_len = len(text) # 除去成对符号后的文本长度
    i = 0
    while i < len(text):
        matched = False
        for token in ALL_TOKENS:
            if text.startswith(token, i):
                if token in CLOSE_TOKENS and stack and SYM_PAIRS.get(stack[-1])[0] == token:
                    stack.pop()
                    force_threshold -= SYM_PAIRS[token][1]
                    text_len -= i + len(token)
                elif token in OPEN_TOKENS:
                    stack.append(token)
                    force_threshold += SYM_PAIRS[token][1]
                elif token in SPLIT_TOKENS and (force_threshold == 0 or text_len >= force_threshold): # 防止分割掉成对符号
                    seg_info.append((i, token))
                i += len(token)
                matched = True
                break
        if not matched:
            i += 1
            
    if force_threshold > 0 and text_len >= force_threshold: # 如果长度超过阈值，则强制分割
        seg_info.append((text_len - 1, ''))
            
    return seg_info

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
                    seg_info = parse_symbols(part, data['symbols_stack']) # 解析符号，更新栈，并获取分割信息
                    
                    if seg_info:
                        seg_info.sort()
                        for idx, token in seg_info:
                            data['parts'].append(part[: idx + len(token)])
                            part = part[idx + len(token):]

                if len(part) >= FORCE_THRESHOLD: # 如果长度超过阈值，则强制分割
                    with stream_lock:
                        data['symbols_stack'] = []
                        data['parts'].append(part)
                    part = ""
        
        with stream_lock:
            if stream_id in stream_data:
                if part:
                    stream_data[stream_id]['parts'].append(part)
                stream_data[stream_id]['status'] = 'completed'
    except Exception as e:
        with stream_lock:
            if stream_id in stream_data:
                stream_data[stream_id]['status'] = 'failed'
                stream_data[stream_id]['error'] = str(e)

@app.post("/start")
async def start_completion(
    request: Request, 
    background_tasks: BackgroundTasks
):
    try:
        body = await request.json()
        url = body.get("url")
        api_key = body.get("api_key")
        body_obj = body.get("body_obj")

        if not url or not api_key or not body_obj:
            raise HTTPException(400, "Missing required fields")

        body_obj['stream'] = True
        
        # 生成唯一ID
        stream_id = uuid.uuid4().hex
        with stream_lock:
            stream_data[stream_id] = {
                'timestamp': time.time(),
                'parts': [],
                'symbols_stack': [],
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
        raise
    except Exception as e:
        with stream_lock:
            if stream_id in stream_data:
                del stream_data[stream_id]
        raise HTTPException(500, f"Internal error: {str(e)}")

@app.get("/poll")
async def poll_completion(
    id: str = Query(..., description="Stream ID"),
    after: int = Query(0, description="Last received part index")
):
    with stream_lock:
        if id not in stream_data:
            raise HTTPException(404, "Stream not found")
        
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

@app.get("/end")
async def end_completion(id: str = Query(...)):
    with stream_lock:
        if id in stream_data:
            del stream_data[id]
    return {"status": "success"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3010)
