"""OpenAI-compatible Images API client (/v1/images/edits), e.g. a self-hosted sub2api gateway.

Every studio job sends reference images, so all calls go through the edits endpoint with the
images as multipart `image[]` parts in the order the prompt numbers them.
"""
from __future__ import annotations

import base64
import json
import threading
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")
import requests  # noqa: E402  (after the LibreSSL warning filter)

from .codex import Cancelled, CodexError  # noqa: E402


class ImageApiError(CodexError):
    """Same base as Codex failures so the job runner reports both the same way."""


def endpoint(base: str, path: str) -> str:
    base = base.rstrip("/")
    return f"{base}{path}" if base.endswith("/v1") else f"{base}/v1{path}"


def _error_text(response: requests.Response) -> str:
    try:
        body = response.json()
        error = body.get("error", body)
        message = error.get("message") if isinstance(error, dict) else str(error)
    except ValueError:
        message = response.text[:300]
    return f"HTTP {response.status_code}：{message}"


def list_models(api: dict) -> list[str]:
    if not api["base"] or not api["key"]:
        raise ImageApiError("先填写接口地址和 API Key")
    try:
        response = requests.get(endpoint(api["base"], "/models"), headers={"Authorization": f"Bearer {api['key']}"}, timeout=20)
    except requests.RequestException as exc:
        raise ImageApiError(f"连不上接口：{exc}") from exc
    if not response.ok:
        raise ImageApiError(_error_text(response))
    return sorted(m.get("id", "") for m in response.json().get("data", []) if m.get("id"))


def generate_image(prompt: str, images: list[Path], out_dir: Path, log_path: Path, cancel: threading.Event,
                   api: dict, size: str = "auto") -> Path:
    if not api["base"] or not api["key"]:
        raise ImageApiError("图片 API 还没配置：在「生图设置」里填写接口地址和 API Key")
    out_dir.mkdir(parents=True, exist_ok=True)
    url = endpoint(api["base"], "/images/edits")
    fields = {"model": api["model"], "prompt": prompt, "n": "1", "size": size, "output_format": "png"}
    if api.get("quality") and api["quality"] != "auto":
        fields["quality"] = api["quality"]
    files = [("image[]", (path.name, path.read_bytes(), "image/png")) for path in images]

    outcome: dict = {}

    def call() -> None:
        try:
            outcome["response"] = requests.post(url, headers={"Authorization": f"Bearer {api['key']}"},
                                                data=fields, files=files, timeout=(30, int(api.get("timeout", 600))))
        except requests.RequestException as exc:
            outcome["error"] = exc

    with open(log_path, "w", encoding="utf-8") as log:
        log.write(f"POST {url}\nmodel={fields['model']} size={size} quality={fields.get('quality', 'auto')}\n")
        log.write("images: " + ", ".join(p.name for p in images) + "\n\n" + prompt + "\n\n")
        log.flush()
        started = time.monotonic()
        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        while worker.is_alive():
            if cancel.is_set():
                # requests cannot be aborted mid-flight; the reply is simply ignored when it arrives.
                log.write("[cancelled]\n")
                raise Cancelled("已取消")
            worker.join(0.3)
        log.write(f"[{time.monotonic() - started:.1f}s]\n")
        if "error" in outcome:
            log.write(f"error: {outcome['error']}\n")
            raise ImageApiError(f"请求失败：{outcome['error']}")
        response: requests.Response = outcome["response"]
        if not response.ok:
            log.write(response.text[:2000] + "\n")
            raise ImageApiError(_error_text(response))
        try:
            body = response.json()
        except ValueError as exc:
            raise ImageApiError(f"接口返回的不是 JSON：{response.text[:200]}") from exc
        items = body.get("data") or []
        summary = {k: v for k, v in body.items() if k != "data"}
        log.write("response: " + json.dumps(summary, ensure_ascii=False)[:2000] + "\n")
        if not items:
            raise ImageApiError("接口没有返回图片")
        item = items[0]
        if item.get("b64_json"):
            data = base64.b64decode(item["b64_json"])
        elif item.get("url"):
            download = requests.get(item["url"], timeout=120)
            if not download.ok:
                raise ImageApiError(f"下载生成的图片失败：HTTP {download.status_code}")
            data = download.content
        else:
            raise ImageApiError("接口返回里既没有 b64_json 也没有 url")
        path = out_dir / "api-output.png"
        path.write_bytes(data)
        log.write(f"saved {len(data)} bytes\n")
        return path
