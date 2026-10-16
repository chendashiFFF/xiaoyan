"""AI suggestions for new actions: name, id, step-by-step description and settings.

Uses the configured generator: Codex CLI with a JSON output schema, or the image API's
chat-completions endpoint with a text model.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import warnings
from pathlib import Path

from . import codex, imageapi
from . import settings as generator_settings
from .store import StoreError, get_project

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")
import requests  # noqa: E402

FIELDS = {
    "id": {"type": "string", "description": "short lowercase English slug with hyphens, e.g. eat-icecream"},
    "label": {"type": "string", "description": "Chinese name, 2-6 characters"},
    "description": {"type": "string", "description": "Chinese, the key poses in time order, one short sentence each"},
    "keyframes": {"type": "integer", "enum": [4, 6]},
    "facing": {"type": "string", "enum": ["front", "right", "left"]},
    "grounded": {"type": "boolean"},
    "playback": {"type": "string", "enum": ["loop", "pingpong"]},
    "duration": {"type": "integer", "description": "milliseconds per frame, 100-200"},
}
SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {"type": "object", "properties": FIELDS, "required": list(FIELDS), "additionalProperties": False},
        }
    },
    "required": ["suggestions"],
    "additionalProperties": False,
}
SLUG = re.compile(r"[^a-z0-9-]+")


def build_prompt(character: str, existing: list[str], idea: str, count: int) -> str:
    goal = (f"用户想做的动作：{idea}。围绕这个想法给出 {count} 个不同的版本（节奏、情绪或细节不同）。"
            if idea else
            f"推荐 {count} 个适合桌面宠物的新动作：日常小动作、情绪反应、和用户互动的动作都可以，彼此不要太像。")
    return f"""你在为桌面宠物角色「{character}」设计新的 2D 帧动画动作。这个角色平时站在用户的桌面上。
已有动作（不要重复）：{'、'.join(existing) or '（还没有）'}。
{goal}

每个动作给出：
- id：简短的小写英文，单词之间用连字符，比如 eat-icecream，不能和已有动作重复；
- label：中文名称，2–6 个字；
- description：中文编号列表，格式是"1. …\n2. …"，一行写一个关键姿势，按时间顺序，写清楚手、身体、头和表情，AI 会照着它一次画出这些关键姿势；行数必须正好等于 keyframes；循环动作的最后一个姿势要能自然接回第一个；
- keyframes：4 或 6（动作简单用 4，过程多用 6）；
- facing：front（正面，绝大多数用这个）、right 或 left（只有走、跑这类需要侧身的动作才用）；
- grounded：跳起来、飞起来的动作为 false，其余为 true；
- playback：loop（首尾相接循环）或 pingpong（正着播完再倒着播回来，适合"举手-放下"这种来回的动作）；
- duration：每帧毫秒数，100–200，动作越舒缓越长。

只输出符合格式的 JSON。"""


def _normalize(raw: list[dict], existing_ids: set[str]) -> list[dict]:
    taken = set(existing_ids)
    result = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        slug = SLUG.sub("-", str(item.get("id", "")).lower()).strip("-")[:48] or "action"
        base, n = slug, 2
        while slug in taken:
            slug, n = f"{base}-{n}", n + 1
        taken.add(slug)
        description = str(item.get("description", "")).strip()[:800]
        steps = [line for line in description.splitlines() if re.match(r"\s*\d+[.、)）]", line)]
        keyframes = int(item.get("keyframes", 4))
        if len(steps) in (4, 6):
            keyframes = len(steps)  # the numbered poses are what the key-pose prompt will actually draw
        result.append({
            "id": slug,
            "label": str(item.get("label", slug)).strip()[:20] or slug,
            "description": description,
            "keyframes": keyframes if keyframes in (4, 6) else 4,
            "facing": item.get("facing") if item.get("facing") in ("front", "right", "left") else "front",
            "grounded": bool(item.get("grounded", True)),
            "playback": item.get("playback") if item.get("playback") in ("loop", "pingpong") else "loop",
            "duration": max(80, min(250, int(item.get("duration", 150)))),
        })
    return result


def _via_codex(prompt: str, model: str) -> list[dict]:
    binary = codex.codex_binary()
    if not binary:
        raise StoreError("找不到 codex 命令，请先安装并登录 Codex CLI，或者在「生图设置」里改用图片 API")
    with tempfile.TemporaryDirectory(prefix="studio-suggest-") as tmp:
        schema = Path(tmp) / "schema.json"
        out = Path(tmp) / "out.json"
        schema.write_text(json.dumps(SCHEMA), "utf-8")
        cmd = [binary, "exec", "--skip-git-repo-check", "-s", "read-only", "-m", model,
               "-c", 'model_reasoning_effort="low"', "-C", tmp,
               "--output-schema", str(schema), "-o", str(out), "--", prompt]
        try:
            proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired as exc:
            raise StoreError("AI 超过 3 分钟没有回应，稍后再试") from exc
        if not out.exists():
            raise StoreError(f"AI 没有给出结果：{(proc.stderr or proc.stdout)[-300:]}")
        return json.loads(out.read_text("utf-8")).get("suggestions", [])


def _via_api(prompt: str, api: dict) -> list[dict]:
    if not api["base"] or not api["key"]:
        raise StoreError("图片 API 还没配置：在「生图设置」里填写接口地址和 API Key")
    body = {
        "model": api.get("textModel") or "gpt-5.6-luna",
        "messages": [
            {"role": "system", "content": "You design sprite animations. Reply with JSON only, matching this schema: "
                                          + json.dumps(SCHEMA, ensure_ascii=False)},
            {"role": "user", "content": prompt},
        ],
        "response_format": {"type": "json_object"},
    }
    try:
        response = requests.post(imageapi.endpoint(api["base"], "/chat/completions"),
                                 headers={"Authorization": f"Bearer {api['key']}"}, json=body, timeout=180)
    except requests.RequestException as exc:
        raise StoreError(f"连不上接口：{exc}") from exc
    if not response.ok:
        raise StoreError(imageapi._error_text(response))
    content = response.json()["choices"][0]["message"]["content"]
    match = re.search(r"\{.*\}", content, re.S)
    return json.loads(match.group(0) if match else content).get("suggestions", [])


def suggest_actions(pid: str, idea: str = "", count: int = 6) -> list[dict]:
    project = get_project(pid)
    existing = [f"{a['label']}（{a['id']}）" for a in project["actions"]]
    count = max(1, min(8, int(count)))
    prompt = build_prompt(project.get("name", pid), existing, idea.strip()[:200], count)
    generator = generator_settings.load()
    try:
        raw = _via_api(prompt, generator["api"]) if generator["provider"] == "api" else _via_codex(prompt, codex.DEFAULT_MODEL)
    except (ValueError, KeyError, IndexError) as exc:
        raise StoreError(f"AI 返回的格式不对：{exc}") from exc
    return _normalize(raw, {a["id"] for a in project["actions"]})[:count]
