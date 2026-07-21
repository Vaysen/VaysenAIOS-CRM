# Image Processor Microservice (TASK-013)
# Python FastAPI service for background removal (rembg) and PDF-to-image (PyMuPDF)

FROM python:3.11-slim

# System dependencies required by rembg (onnxruntime) and Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgl1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the rembg u2net model (~176 MB) so it is ready at runtime
RUN python -c "from rembg import new_session; new_session('u2net')"

# Copy application code
COPY . .

EXPOSE 5001

# Healthcheck — curl the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -f http://localhost:5001/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5001"]
