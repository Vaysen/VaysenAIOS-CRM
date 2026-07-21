"""
Image Processor Microservice (TASK-013)
=======================================
FastAPI microservice for the packaging customizer system.

Endpoints:
  GET  /health            - Health check
  POST /remove-bg         - Remove image background using rembg (u2net model)
  POST /pdf-to-images     - Convert PDF pages to PNG images using PyMuPDF (300 DPI)

The service runs on port 5001 and is stateless (all processing in memory).
"""

import base64
import io
import logging
from typing import List

import fitz  # PyMuPDF
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from rembg import remove, new_session

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("image-processor")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Image Processor Microservice",
    description="Background removal and PDF-to-image conversion for the packaging customizer.",
    version="1.0.0",
)

# CORS — allow the NestJS backend to call this service
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pre-initialise the rembg u2net session so the model is loaded once at startup.
# On first run this will download the u2net model (~176 MB) into the cache.
logger.info("Initializing rembg u2net session ...")
try:
    _REMBG_SESSION = new_session("u2net")
    logger.info("rembg u2net session ready.")
except Exception as exc:  # pragma: no cover
    logger.error("Failed to initialize rembg session: %s", exc)
    _REMBG_SESSION = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "rembg": "ready" if _REMBG_SESSION else "unavailable"}


# ---------------------------------------------------------------------------
# POST /remove-bg
# ---------------------------------------------------------------------------
@app.post("/remove-bg")
async def remove_bg(file: UploadFile = File(...)):
    """Accept an image (PNG/JPG/WebP), remove the background with rembg (u2net),
    and return a transparent PNG."""
    if _REMBG_SESSION is None:
        return JSONResponse(
            status_code=503,
            content={"detail": "rembg model is not available"},
        )

    # Validate content type
    allowed_types = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
    if file.content_type and file.content_type not in allowed_types:
        return JSONResponse(
            status_code=400,
            content={
                "detail": f"Unsupported file type: {file.content_type}. "
                f"Allowed: {', '.join(sorted(allowed_types))}"
            },
        )

    try:
        contents = await file.read()
        if not contents:
            return JSONResponse(
                status_code=400,
                content={"detail": "Empty file"},
            )

        logger.info("remove-bg: processing %s (%d bytes)", file.filename, len(contents))

        # rembg remove — pass the pre-loaded u2net session
        result = remove(contents, session=_REMBG_SESSION)

        # Ensure the result is a valid PNG with alpha channel
        img = Image.open(io.BytesIO(result)).convert("RGBA")
        out_buf = io.BytesIO()
        img.save(out_buf, format="PNG", optimize=True)
        png_bytes = out_buf.getvalue()

        logger.info("remove-bg: done, output %d bytes", len(png_bytes))

        return Response(content=png_bytes, media_type="image/png")

    except Exception as exc:
        logger.exception("remove-bg error")
        return JSONResponse(
            status_code=500,
            content={"detail": f"Background removal failed: {str(exc)}"},
        )


# ---------------------------------------------------------------------------
# POST /pdf-to-images
# ---------------------------------------------------------------------------
@app.post("/pdf-to-images")
async def pdf_to_images(file: UploadFile = File(...), dpi: int = 300):
    """Accept a PDF file, render every page to PNG at the given DPI (default 300),
    and return a JSON object with base64-encoded images."""
    if file.content_type and file.content_type != "application/pdf":
        # Also accept generic binary octet-stream (some clients send this)
        if file.content_type != "application/octet-stream":
            return JSONResponse(
                status_code=400,
                content={
                    "detail": f"Unsupported file type: {file.content_type}. "
                    f"Expected: application/pdf"
                },
            )

    try:
        contents = await file.read()
        if not contents:
            return JSONResponse(
                status_code=400,
                content={"detail": "Empty file"},
            )

        logger.info(
            "pdf-to-images: processing %s (%d bytes) at %d DPI",
            file.filename,
            len(contents),
            dpi,
        )

        doc = fitz.open(stream=contents, filetype="pdf")
        images: List[str] = []
        zoom = dpi / 72.0  # 72 is the PDF base DPI
        mat = fitz.Matrix(zoom, zoom)

        for page_index, page in enumerate(doc):
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            images.append(base64.b64encode(img_bytes).decode("ascii"))
            logger.info("pdf-to-images: page %d rendered (%dx%d)",
                        page_index, pix.width, pix.height)

        doc.close()

        logger.info("pdf-to-images: done, %d pages", len(images))

        return JSONResponse(
            content={
                "images": images,
                "pageCount": len(images),
                "dpi": dpi,
            }
        )

    except Exception as exc:
        logger.exception("pdf-to-images error")
        return JSONResponse(
            status_code=500,
            content={"detail": f"PDF conversion failed: {str(exc)}"},
        )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=5001,
        reload=False,
        log_level="info",
    )
