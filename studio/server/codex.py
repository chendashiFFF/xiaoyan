"""Run the user's Codex CLI non-interactively to generate one image.

Codex saves built-in image_gen output under ~/.codex/generated_images/<thread id>/,
and `--json` reports the thread id in its first event, so that directory is how we
find the result (the agent itself often cannot see the saved path).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

GENERATED_DIR = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "generated_images"
DEFAULT_MODEL = os.environ.get("STUDIO_CODEX_MODEL", "gpt-6-luna")
DEFAULT_EFFORT = os.environ.get("STUDIO_CODEX_EFFORT", "low")
TIMEOUT_SECONDS = int(os.environ.get("STUDIO_CODEX_TIMEOUT", "600"))


class CodexError(RuntimeError):
    pass


class Cancelled(CodexError):
    pass


@dataclass
class CodexResult:
    thread_id: str
    images: list[Path]
    messages: list[str] = field(default_factory=list)


def codex_binary() -> str | None:
    return shutil.which("codex")


def codex_version() -> str | None:
    binary = codex_binary()
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() or None


def generate_image(
    prompt: str,
    images: list[Path],
    workdir: Path,
    log_path: Path,
    cancel: threading.Event,
    model: str = DEFAULT_MODEL,
    effort: str = DEFAULT_EFFORT,
    timeout: int = TIMEOUT_SECONDS,
) -> CodexResult:
    binary = codex_binary()
    if not binary:
        raise CodexError("找不到 codex 命令，请先安装并登录 Codex CLI")
    workdir.mkdir(parents=True, exist_ok=True)
    cmd = [
        binary, "exec", "--skip-git-repo-check", "--json",
        "-s", "read-only",
        "-m", model,
        "-c", f'model_reasoning_effort="{effort}"',
        "-C", str(workdir),
    ]
    for image in images:
        cmd += ["--image", str(image)]
    cmd += ["--", prompt]

    thread_id = ""
    messages: list[str] = []
    failures: list[str] = []
    with open(log_path, "w", encoding="utf-8") as log:
        log.write("$ " + " ".join(cmd[:-1]) + " <prompt>\n\n" + prompt + "\n\n")
        log.flush()
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, cwd=workdir)
        lines: list[str] = []

        def pump() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.append(line)

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        seen = 0
        try:
            while True:
                while seen < len(lines):
                    line = lines[seen]
                    seen += 1
                    log.write(line)
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    kind = event.get("type")
                    item = event.get("item") or {}
                    if kind == "thread.started":
                        thread_id = event.get("thread_id", "")
                    elif item.get("type") == "agent_message" and item.get("text"):
                        messages.append(item["text"])
                    elif item.get("type") == "error" and "configuration setting" not in item.get("message", ""):
                        failures.append(item.get("message", ""))
                    elif kind in ("turn.failed", "error"):
                        failures.append(json.dumps(event.get("error") or event, ensure_ascii=False))
                log.flush()
                if proc.poll() is not None and not reader.is_alive():
                    break
                if cancel.is_set():
                    raise Cancelled("已取消")
                if time.monotonic() > deadline:
                    raise CodexError(f"超过 {timeout} 秒没有完成")
                time.sleep(0.2)
        except CodexError:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise
        log.write(f"\n[exit {proc.returncode}]\n")

    found = sorted((GENERATED_DIR / thread_id).glob("*.png"), key=lambda p: p.stat().st_mtime) if thread_id else []
    if not found:
        reason = "；".join(failures + messages[-1:]) or f"codex 退出码 {proc.returncode}"
        raise CodexError(f"没有生成图片：{reason}")
    return CodexResult(thread_id=thread_id, images=found, messages=messages)
