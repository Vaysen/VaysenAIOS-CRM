import base64
import io
import sys
import types
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from app import app


class PythonServiceContractTest(unittest.TestCase):
    def setUp(self):
        app.testing = True
        self.client = app.test_client()

    def test_remove_background_accepts_backend_file_field(self):
        fake_rembg = types.SimpleNamespace(remove=lambda data, session=None: b"processed-png")
        source = io.BytesIO()
        Image.new("RGB", (2, 2), "white").save(source, format="PNG")
        with patch.dict(sys.modules, {"rembg": fake_rembg}), patch("app.get_rembg_session", return_value=object()):
            response = self.client.post(
                "/remove-bg",
                data={"file": (io.BytesIO(source.getvalue()), "logo.png")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"processed-png")
        self.assertEqual(response.mimetype, "image/png")

    def test_readiness_loads_the_pinned_model_session(self):
        with patch("app.get_rembg_session", return_value=object()) as load:
            response = self.client.get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["model"], "u2net")
        load.assert_called_once()

    def test_pdf_response_matches_backend_shape(self):
        image = Image.new("RGB", (2, 3), "white")
        fake_pdf2image = types.SimpleNamespace(
            pdfinfo_from_bytes=lambda data: {"Pages": 1},
            convert_from_bytes=lambda data, dpi, first_page, last_page: [image],
        )
        with patch.dict(sys.modules, {"pdf2image": fake_pdf2image}):
            response = self.client.post(
                "/pdf-to-images?dpi=144",
                data={"file": (io.BytesIO(b"%PDF-test"), "test.pdf")},
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["pageCount"], 1)
        self.assertEqual(payload["dpi"], 144)
        self.assertEqual(len(payload["images"]), 1)
        self.assertTrue(base64.b64decode(payload["images"][0]).startswith(b"\x89PNG"))
        self.assertEqual(payload["pages"][0]["width"], 2)
        self.assertEqual(payload["pages"][0]["height"], 3)

    def test_pdf_page_bomb_is_rejected_before_rendering(self):
        render = Mock(return_value=[])
        fake_pdf2image = types.SimpleNamespace(
            pdfinfo_from_bytes=lambda data: {"Pages": 999},
            convert_from_bytes=render,
        )
        with patch.dict(sys.modules, {"pdf2image": fake_pdf2image}):
            response = self.client.post(
                "/pdf-to-images",
                data={"file": (io.BytesIO(b"%PDF-test"), "bomb.pdf")},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 413)
        render.assert_not_called()


if __name__ == "__main__":
    unittest.main()
