# =============================================================================
# vaysen-ai-crm Python 微服务 Dockerfile
# 功能：rembg 去除背景 + PDF 转图片
# =============================================================================

ARG PYTHON_IMAGE=python:3.11-slim
FROM ${PYTHON_IMAGE}

WORKDIR /app
ENV U2NET_HOME=/app/.u2net

# 安装系统依赖：
# - libglib2.0-0 / libgl1：rembg (onnxruntime) 运行所需
# - libgomp1：OpenMP 多线程
# - poppler-utils：PDF 转图片所需
# - curl：健康检查
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
        poppler-utils \
        curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
# - rembg：AI 去除图片背景
# - pillow：图像处理
# - flask：Web 框架
# - flask-cors：跨域支持
# - pdf2image：PDF 转图片（依赖 poppler-utils）
# - gunicorn：生产级 WSGI 服务器
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY app.py test_contract.py ./
RUN python -m unittest -v test_contract.py && rm test_contract.py

# 模型内容由 SHA256 钉死；URL 即使被替换也无法进入镜像。
# Official rembg release asset. The target Linux host can reach GitHub release
# storage while Hugging Face is blocked; the pinned SHA below remains the
# authoritative supply-chain check.
ARG U2NET_MODEL_URL=https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
ARG U2NET_SHA256=8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491
RUN groupadd -r appuser \
    && useradd -r -m -g appuser appuser \
    && mkdir -p "$U2NET_HOME" \
    && curl -fL --retry 3 --connect-timeout 20 -o "$U2NET_HOME/u2net.onnx" "$U2NET_MODEL_URL" \
    && printf '%s  %s\n' "$U2NET_SHA256" "$U2NET_HOME/u2net.onnx" | sha256sum -c - \
    && chown -R appuser:appuser /app /home/appuser
ENV HOME=/home/appuser
USER appuser

EXPOSE 5000

# 健康检查
HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:5000/ready || exit 1

# 使用 gunicorn 启动（生产级，4 worker 进程）
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--worker-class", "gthread", "--workers", "1", "--threads", "2", "--timeout", "180", "--max-requests", "200", "--max-requests-jitter", "20", "app:app"]
