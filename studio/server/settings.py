"""Machine-local studio settings (image generator choice, API endpoint and key).

Stored in studio/settings.local.json, which is git-ignored because it holds an API key.
The key is never sent back to the browser; only a masked hint is.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .store import STUDIO_DIR, StoreError

SETTINGS_FILE = Path(os.environ.get("STUDIO_SETTINGS_FILE", STUDIO_DIR / "settings.local.json"))
PROVIDERS = ("codex", "api")
QUALITIES = ("auto", "low", "medium", "high", "xhigh", "max")
DEFAULTS = {
    "provider": "codex",
    "api": {
        "base": "",
        "key": "",
        "model": "gpt-image-2.5-flare",
        "quality": "auto",
        "timeout": 600,
    },
}

_lock = threading.Lock()


def load() -> dict:
    data = json.loads(SETTINGS_FILE.read_text("utf-8")) if SETTINGS_FILE.exists() else {}
    api = {**DEFAULTS["api"], **data.get("api", {})}
    return {"provider": data.get("provider", DEFAULTS["provider"]), "api": api}


def _save(settings: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(SETTINGS_FILE)


def key_hint(key: str) -> str:
    return f"…{key[-4:]}" if len(key) > 8 else ("已设置" if key else "")


def public(settings: dict | None = None) -> dict:
    settings = settings or load()
    api = settings["api"]
    return {
        "provider": settings["provider"],
        "api": {
            "base": api["base"],
            "model": api["model"],
            "quality": api["quality"],
            "timeout": api["timeout"],
            "hasKey": bool(api["key"]),
            "keyHint": key_hint(api["key"]),
        },
    }


def update(patch: dict) -> dict:
    with _lock:
        settings = load()
        if "provider" in patch:
            if patch["provider"] not in PROVIDERS:
                raise StoreError(f"unknown provider {patch['provider']!r}")
            settings["provider"] = patch["provider"]
        api_patch = patch.get("api") or {}
        api = settings["api"]
        if "base" in api_patch:
            base = str(api_patch["base"]).strip().rstrip("/")
            if base and not base.startswith(("http://", "https://")):
                raise StoreError("接口地址要以 http:// 或 https:// 开头")
            api["base"] = base
        # An empty key in the form means "keep the stored one"; clearing is explicit.
        if api_patch.get("key"):
            api["key"] = str(api_patch["key"]).strip()
        if api_patch.get("clearKey"):
            api["key"] = ""
        if "model" in api_patch:
            api["model"] = str(api_patch["model"]).strip() or DEFAULTS["api"]["model"]
        if "quality" in api_patch:
            if api_patch["quality"] not in QUALITIES:
                raise StoreError(f"quality must be one of {QUALITIES}")
            api["quality"] = api_patch["quality"]
        if "timeout" in api_patch:
            api["timeout"] = max(60, min(1800, int(api_patch["timeout"])))
        _save(settings)
        return public(settings)
