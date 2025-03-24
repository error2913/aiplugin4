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

stream_data: Dict[str, Dict[str, Any]] = {}
# 线程锁
stream_lock = threading.Lock()

# 清理过期任务的间隔（秒）
CLEANUP_INTERVAL = 24 * 60 * 60  # 24小时

# 分隔符元组，用于检查结尾
split_str_tuple = (',', '，', '。', '!', '！', '?', '？', ';', '：', '——', '...', '……', '\n', '\t', '\r')

async def periodic_cleanup():
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
    cleanup_task = asyncio.create_task(periodic_cleanup())
    yield
    # 关闭时取消清理任务
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    
app = FastAPI(lifespan=lifespan)

NON_SYM_PAIRS = {
    "(": ")",
    "（": "）",
    "[": "]",
    "【": "】",
    "{": "}",
    "《": "》",
    "『": "』",
    "「": "」",
    '"': '"',
    "“": "”",
    "'": "'",
    "‘": "’",
    "<|": "|>",
    "<｜": "｜>",
}

OPEN_TOKENS = set(NON_SYM_PAIRS.keys())
CLOSE_TOKENS = set(NON_SYM_PAIRS.values())

ALL_TOKENS = sorted(OPEN_TOKENS | CLOSE_TOKENS, key=len, reverse=True)

def parse_symbols(text: str) -> list:
    stack = []
    i = 0
    while i < len(text):
        matched = False
        for token in ALL_TOKENS:
            if text.startswith(token, i):
                if token in OPEN_TOKENS:
                    stack.append(token)
                elif token in CLOSE_TOKENS:
                    if stack and NON_SYM_PAIRS.get(stack[-1]) == token:
                        stack.pop()
                    else:
                        stack.append(token)
                i += len(token)
                matched = True
                break
        if not matched:
            i += 1
    return stack

def is_balanced(text: str) -> bool:
    """
    检查文本中成对符号是否平衡。
    """
    return len(parse_symbols(text)) == 0

def get_unbalanced_depth(text: str) -> int:
    """
    返回最终栈中剩余的符号个数。
    """
    return len(parse_symbols(text))

BASE_FORCE_THRESHOLD = 60
FORCE_THRESHOLD_INCREMENT = 20

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

                while len(part) >= 10:
                    candidates = [(idx, sep) for sep in split_str_tuple if (idx := part.find(sep)) != -1]
                    if not candidates:
                        break

                    candidates.sort()
                    found = False
                    for idx, sep in candidates:
                        candidate_segment = part[: idx + len(sep)]
                        if len(candidate_segment) < 10:
                            continue
                        if is_balanced(candidate_segment):
                            if candidate_segment.endswith(',') or candidate_segment.endswith('，'):
                                candidate_segment = candidate_segment.rstrip(',，')
                            with stream_lock:
                                data['parts'].append(candidate_segment)
                            part = part[idx + len(sep):]
                            found = True
                            break
                    if not found:
                        break

                effective_threshold = BASE_FORCE_THRESHOLD + get_unbalanced_depth(part) * FORCE_THRESHOLD_INCREMENT
                if len(part) > effective_threshold:
                    segment = part.rstrip(',，')
                    with stream_lock:
                        data['parts'].append(segment)
                    part = ""
        
        with stream_lock:
            if stream_id in stream_data:
                if part:
                    stream_data[stream_id]['parts'].append(part.rstrip(',，'))
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
