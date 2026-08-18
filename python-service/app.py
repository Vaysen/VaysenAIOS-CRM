"""
vaysen-ai-crm Python 微服务
功能：
  1. POST /remove-bg       - 使用 rembg 去除图片背景
  2. POST /pdf-to-images   - 将 PDF 文件转换为图片列表
端口：5000
"""

import io
import os
import logging
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vaysen-crm-python-service")

app = Flask(__name__)
CORS(app)

MAX_UPLOAD_BYTES = int(os.environ.get("PYTHON_SERVICE_MAX_UPLOAD_BYTES", 16 * 1024 * 1024))
MAX_PDF_PAGES = int(os.environ.get("PYTHON_SERVICE_MAX_PDF_PAGES", 12))
MAX_PDF_DPI = int(os.environ.get("PYTHON_SERVICE_MAX_PDF_DPI", 240))
MAX_TOTAL_PIXELS = int(os.environ.get("PYTHON_SERVICE_MAX_TOTAL_PIXELS", 25_000_000))
MAX_IMAGE_PIXELS = int(os.environ.get("PYTHON_SERVICE_MAX_IMAGE_PIXELS", 16_000_000))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

# 允许的图片格式
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"}
ALLOWED_PDF_EXTENSIONS = {".pdf"}

# rembg session 复用（避免每次请求重新加载模型）
_rembg_session = None


def get_rembg_session():
    """惰性初始化并复用 rembg session，提升处理性能。"""
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        logger.info("初始化 rembg u2net 模型...")
        _rembg_session = new_session("u2net")
        logger.info("rembg 模型加载完成")
    return _rembg_session


def allowed_file(filename, allowed_extensions):
    """检查文件扩展名是否被允许。"""
    return os.path.splitext(filename)[1].lower() in allowed_extensions


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "upload or rendered image budget exceeded"}), 413


# =============================================================================
# 健康检查端点
# =============================================================================
@app.route("/health", methods=["GET"])
def health():
    """健康检查端点，供 Docker HEALTHCHECK 使用。"""
    return jsonify({"status": "ok", "service": "python-service"}), 200


@app.route("/ready", methods=["GET"])
def ready():
    """Readiness includes loading the checksum-pinned ONNX model as appuser."""
    try:
        get_rembg_session()
        return jsonify({"status": "ready", "service": "python-service", "model": "u2net"}), 200
    except Exception:
        logger.exception("u2net readiness failed")
        return jsonify({"status": "not-ready", "service": "python-service"}), 503


# =============================================================================
# 去除图片背景
# =============================================================================
@app.route("/remove-bg", methods=["POST"])
def remove_bg():
    """
    接收上传的图片，使用 rembg 去除背景，返回处理后的 PNG 图片（透明背景）。

    请求：multipart/form-data，字段名 image
    响应：image/png 二进制流
    """
    if "image" not in request.files and "file" not in request.files:
        return jsonify({"error": "缺少 image 文件字段"}), 400

    file = request.files.get("file", request.files.get("image"))
    if file.filename == "":
        return jsonify({"error": "未选择文件"}), 400

    if not allowed_file(file.filename, ALLOWED_IMAGE_EXTENSIONS):
        return jsonify({"error": f"不支持的图片格式，允许：{ALLOWED_IMAGE_EXTENSIONS}"}), 400

    try:
        from rembg import remove

        input_data = file.read()
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with Image.open(io.BytesIO(input_data)) as source_image:
            width, height = source_image.size
            if width * height > MAX_IMAGE_PIXELS:
                return jsonify({"error": "image pixel budget exceeded"}), 413
            source_image.verify()
        logger.info("开始处理图片去背景: %s (%d bytes)", file.filename, len(input_data))

        session = get_rembg_session()
        output_data = remove(input_data, session=session)

        logger.info("图片去背景完成，输出 %d bytes", len(output_data))

        return send_file(
            io.BytesIO(output_data),
            mimetype="image/png",
            as_attachment=True,
            download_name=f"{os.path.splitext(file.filename)[0]}_nobg.png",
        )
    except ImportError:
        logger.error("rembg 未安装")
        return jsonify({"error": "服务端 rembg 未安装"}), 500
    except Exception as e:
        logger.exception("图片去背景失败")
        return jsonify({"error": f"处理失败: {str(e)}"}), 500


# =============================================================================
# PDF 转图片
# =============================================================================
@app.route("/pdf-to-images", methods=["POST"])
def pdf_to_images():
    """
    接收上传的 PDF 文件，将每一页转换为 PNG 图片。

    请求：multipart/form-data，字段名 file
          可选查询参数 dpi=150（默认 150）
    响应：JSON 数组，每项为 base64 编码的图片
          [{ "page": 1, "image": "base64...", "width": 1240, "height": 1754 }, ...]
    """
    if "file" not in request.files:
        return jsonify({"error": "缺少 file 文件字段"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "未选择文件"}), 400

    if not allowed_file(file.filename, ALLOWED_PDF_EXTENSIONS):
        return jsonify({"error": "仅支持 PDF 文件"}), 400

    try:
        from pdf2image import convert_from_bytes, pdfinfo_from_bytes
        import base64

        dpi = int(request.args.get("dpi", 150))
        dpi = max(72, min(dpi, MAX_PDF_DPI))

        pdf_data = file.read()
        logger.info("开始转换 PDF 为图片: %s (%d bytes, dpi=%d)", file.filename, len(pdf_data), dpi)

        info = pdfinfo_from_bytes(pdf_data)
        page_count = int(info.get("Pages", 0))
        if page_count < 1 or page_count > MAX_PDF_PAGES:
            return jsonify({"error": f"PDF page limit exceeded (max {MAX_PDF_PAGES})"}), 413

        results = []
        total_pixels = 0

        # Render one page at a time to bound peak memory.
        for i in range(1, page_count + 1):
            rendered = convert_from_bytes(pdf_data, dpi=dpi, first_page=i, last_page=i)
            if len(rendered) != 1:
                return jsonify({"error": f"failed to render PDF page {i}"}), 500
            img = rendered[0]
            total_pixels += img.width * img.height
            if total_pixels > MAX_TOTAL_PIXELS:
                return jsonify({"error": "PDF rendered pixel budget exceeded"}), 413
            buf = io.BytesIO()
            # 转为 RGB 避免模式问题
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(buf, format="PNG", optimize=True)
            img_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            results.append({
                "page": i,
                "image": img_b64,
                "width": img.width,
                "height": img.height,
            })

        logger.info("PDF 转换完成，共 %d 页", len(results))

        return jsonify({
            "success": True,
            "images": [page["image"] for page in results],
            "pageCount": len(results),
            "dpi": dpi,
            "total_pages": len(results),
            "pages": results,
        })
    except ImportError:
        logger.error("pdf2image 未安装")
        return jsonify({"error": "服务端 pdf2image 未安装"}), 500
    except Exception as e:
        logger.exception("PDF 转图片失败")
        return jsonify({"error": f"处理失败: {str(e)}"}), 500


# =============================================================================
# 应用入口
# =============================================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    logger.info("Python 微服务启动于 0.0.0.0:%d (debug=%s)", port, debug)
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
