# coding: utf-8

import datetime
import io
import logging
import os
import time
from dateutil.relativedelta import relativedelta
import uuid
from fastapi import BackgroundTasks, FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import matplotlib.pyplot as plt
import uvicorn

app = FastAPI()

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 创建临时目录
TEMP_DIR = "temp_images"
os.makedirs(TEMP_DIR, exist_ok=True)

# 挂载静态文件目录，用于提供临时图片访问
app.mount("/temp_images", StaticFiles(directory=TEMP_DIR), name="temp_images")

# 文件过期时间（秒）
FILE_EXPIRE_TIME = 120

def cleanup_temp_files():
    now = time.time()
    for filename in os.listdir(TEMP_DIR):
        filepath = os.path.join(TEMP_DIR, filename)
        if os.path.isfile(filepath):
            file_creation_time = os.path.getctime(filepath)
            if now - file_creation_time > FILE_EXPIRE_TIME:
                try:
                    os.remove(filepath)
                    logger.info(f"Deleted expired file: {filename}")
                except Exception as e:
                    logger.error(f"Failed to delete file {filename}: {e}")

def draw_year_chart(data):
    try:
        # 将日期转换为 datetime 对象
        data = {
            datetime.datetime.strptime(date, "%Y-%m"): data[date]
            for date in data
        }
        
        dates = sorted(list(data.keys()))
        cutoff_date = dates[-1] - relativedelta(months=12)  # 12 个月前的日期
        data = {
            date: data[date]
            for date in data if date >= cutoff_date
        }
        
        dates = sorted(list(data.keys()))
        prompt_tokens = [data[date]["prompt_tokens"] for date in dates]
        completion_tokens = [data[date]["completion_tokens"] for date in dates]
        dates = [date.strftime("%Y-%m") for date in dates]

        # 创建堆叠直方图
        fig, ax = plt.subplots(figsize=(10, 6))

        # 绘制堆叠直方图
        ax.bar(dates, prompt_tokens, label="prompt tokens", color="blue")
        ax.bar(dates, completion_tokens, bottom=prompt_tokens, label="completion tokens", color="orange")
        ax.legend()
        fig.autofmt_xdate()  # 自动旋转日期标签

        # 将图表保存到内存缓冲区
        buf = io.BytesIO()
        plt.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)

        # 清理图表状态
        plt.clf()
        plt.close()

        return buf
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error drawing chart: {e}")

def draw_month_chart(data):
    try:
        # 将日期转换为 datetime 对象
        data = {
            datetime.datetime.strptime(date, "%Y-%m-%d"): data[date]
            for date in data
        }
        
        dates = sorted(list(data.keys()))
        cutoff_date = dates[-1] - datetime.timedelta(days=31)  # 31 天前的日期
        data = {
            date: data[date]
            for date in data if date >= cutoff_date
        }
        
        dates = sorted(list(data.keys()))
        prompt_tokens = [data[date]["prompt_tokens"] for date in dates]
        completion_tokens = [data[date]["completion_tokens"] for date in dates]

        # 创建堆叠直方图
        fig, ax = plt.subplots(figsize=(10, 6))

        # 绘制堆叠直方图
        ax.bar(dates, prompt_tokens, label="prompt tokens", color="blue")
        ax.bar(dates, completion_tokens, bottom=prompt_tokens, label="completion tokens", color="orange")
        ax.legend()
        fig.autofmt_xdate()  # 自动旋转日期标签

        # 将图表保存到内存缓冲区
        buf = io.BytesIO()
        plt.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)

        # 清理图表状态
        plt.clf()
        plt.close()

        return buf
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error drawing chart: {e}")

@app.post("/chart")
async def get_chart_url(request: Request, background_tasks: BackgroundTasks):
    try:
        body = await request.json()
        chart_type = body.get("chart_type")
        data = body.get("data")

        if not chart_type or not data:
            raise HTTPException(status_code=400, detail="Missing 'type' or 'data' in request body")
        
        if chart_type == "year":
            buf = draw_year_chart(data)
        elif chart_type == "month":
            buf = draw_month_chart(data)
        else:
            raise HTTPException(status_code=400, detail="Invalid type")

        # 生成临时文件名
        temp_filename = f"{uuid.uuid4()}.png"
        temp_filepath = os.path.join(TEMP_DIR, temp_filename)
        
        # 保存图片到临时目录
        with open(temp_filepath, "wb") as f:
            f.write(buf.getvalue())
            
        # 添加后台任务，清理过期文件
        background_tasks.add_task(cleanup_temp_files)

        # 返回临时图片 URL
        base_url = str(request.base_url)
        image_url = f"{base_url}temp_images/{temp_filename}"
        return JSONResponse(content={"image_url": image_url})
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail="Internal server error")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3009)