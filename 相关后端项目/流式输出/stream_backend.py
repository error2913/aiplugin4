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

def is_balanced(text: str) -> bool:
    """
    检查文本中成对符号是否平衡。
    支持的符号包括：括号、中文括号、单引号、双引号等。
    对于对称符号（如引号），采用栈的方式：如果遇到同样符号则视为闭合。
    """
    pairs = {
        '(': ')',
        '（': '）',
        '"': '"',
        '“': '”',
        "'": "'",
        '‘': '’',
    }
    stack = []
    for ch in text:
        if ch in pairs:
            if ch in ['"', "'", '“', '‘']:
                if stack and stack[-1] == ch:
                    stack.pop()
                else:
                    stack.append(ch)
            else:
                stack.append(ch)
        elif ch in pairs.values():
            if stack:
                top = stack[-1]
                if pairs.get(top) == ch:
                    stack.pop()
                else:
                    return False
            else:
                return False
    return not stack

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
                    candidates = []
                    for sep in split_str_tuple:
                        idx = part.find(sep)
                        if idx != -1:
                            candidates.append((idx, sep))
                    if not candidates:
                        break  

                    candidates.sort(key=lambda x: x[0])
                    found = False
                    for idx, sep in candidates:
                        candidate_segment = part[: idx + len(sep)]
                        if len(candidate_segment) < 10:
                            continue
                        if is_balanced(candidate_segment):
                            with stream_lock:
                                data['parts'].append(candidate_segment)
                            part = part[idx + len(sep):]
                            found = True
                            break 
                    if not found:
                        break

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
