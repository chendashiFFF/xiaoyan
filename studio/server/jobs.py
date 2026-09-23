"""AI generation jobs: each job asks Codex for N candidate redraws of one frame.

    projects/<project>/jobs/<job>/job.json      status, prompt inputs, candidates
    projects/<project>/jobs/<job>/input-*.png   images sent to Codex
    projects/<project>/jobs/<job>/raw-<n>.png   what Codex produced
    projects/<project>/jobs/<job>/cand-<n>.png  normalized frame, stored in the frame's raw orientation
    projects/<project>/jobs/<job>/cand-<n>.log  Codex event log
"""
from __future__ import annotations

import os
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

from . import codex, process
from .store import (StoreError, action_dir, check_slug, frame_path, get_action, project_dir, read_json,
                    write_json)

KINDS = ("redraw", "repair")
TERMINAL = ("done", "failed", "cancelled")
MAX_CANDIDATES = 4
WORKERS = int(os.environ.get("STUDIO_CODEX_WORKERS", "2"))

_executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="codex")
_lock = threading.Lock()
_cancels: dict[str, threading.Event] = {}


def jobs_dir(pid: str) -> Path:
    return project_dir(pid) / "jobs"


def job_dir(pid: str, jid: str) -> Path:
    return jobs_dir(pid) / check_slug(jid, "job")


def _read(pid: str, jid: str) -> dict:
    path = job_dir(pid, jid) / "job.json"
    if not path.exists():
        raise FileNotFoundError(jid)
    return read_json(path)


def _update(pid: str, jid: str, mutate) -> dict:
    with _lock:
        job = _read(pid, jid)
        mutate(job)
        states = [c["status"] for c in job["candidates"]]
        if all(s in TERMINAL for s in states):
            job["status"] = "done" if "done" in states else ("cancelled" if "cancelled" in states else "failed")
            job.setdefault("finishedAt", int(time.time()))
        elif "running" in states:
            job["status"] = "running"
        write_json(job_dir(pid, jid) / "job.json", job)
        return job


def _project_settings(pid: str) -> dict:
    project = read_json(project_dir(pid) / "project.json")
    refs = project.get("references", [])
    identity = project.get("identityReference") or next((r for r in refs if r.endswith("master.png")), refs[0] if refs else None)
    settings = project.get("codex", {})
    return {
        "identity": project_dir(pid) / identity if identity else None,
        "character": project.get("name", pid),
        "model": settings.get("model", codex.DEFAULT_MODEL),
        "effort": settings.get("effort", codex.DEFAULT_EFFORT),
    }


def _displayed(pid: str, aid: str, frame: dict, relative_to: list[int] | None = None) -> Image.Image:
    """A frame as the editor shows it (mirrored if flipped); optionally offset relative to another frame."""
    image = process.oriented(Image.open(frame_path(pid, aid, frame["id"], frame["version"])), bool(frame.get("flipX")))
    if relative_to is not None:
        image = process.shifted(image, frame["offset"][0] - relative_to[0], frame["offset"][1] - relative_to[1])
    return image


def build_prompt(kind: str, instruction: str, character: str, images: list[str]) -> str:
    listing = "\n".join(f"- Image {i + 1}: {label}" for i, label in enumerate(images))
    instruction = instruction.strip()
    if kind == "repair":
        change = instruction or "Fix any drawing errors so it matches the character reference."
        return f"""You are repairing part of ONE frame of a 2D sprite animation of the character "{character}".
Use your built-in image generation tool to EDIT Image 1. Call it exactly once. Do not run shell commands and do not write any files yourself.

Attached images, in order:
{listing}

Only change what is inside the green box shown in Image 2. Change requested: {change}

Everything outside the green box must stay exactly as in Image 1: same pose, same pixels, same position and scale.
Keep the character identity from the reference: face, eye colour, hair, hair accessories on the same side, outfit, colours, pixel-art rendering.
Do not draw the green box. Background: perfectly flat solid #FF00FF magenta, no shadow, no ground, no text, no border.

When the image has been generated, reply with only its absolute file path."""

    change = instruction or "Redraw this frame cleanly: fix anything inconsistent with the character reference and make the pose flow smoothly between the previous and next frames."
    return f"""You are redrawing ONE frame of a 2D sprite animation of the character "{character}".
Use your built-in image generation tool to EDIT Image 1. Call it exactly once. Do not run shell commands and do not write any files yourself.

Attached images, in order:
{listing}

Change requested: {change}

Keep everything else identical to Image 1:
- same character identity: face, eye colour, hair colour and length, hair accessories on the same side of the head, same outfit and colours, same pixel-art rendering;
- same canvas size, same camera, same scale; feet on the same ground line; body at the same horizontal position; same facing direction;
- the pose must read as a natural in-between of the previous and next frames when played as an animation.
Background: perfectly flat solid #FF00FF magenta. No shadow, no ground, no scenery, no text, no border. Full body visible, nothing touching the canvas edge.

When the image has been generated, reply with only its absolute file path."""


def create_job(pid: str, aid: str, fid: str, body: dict) -> dict:
    kind = body.get("kind", "redraw")
    if kind not in KINDS:
        raise StoreError(f"unknown job kind {kind!r}")
    if not codex.codex_binary():
        raise StoreError("找不到 codex 命令，请先安装并登录 Codex CLI")
    count = max(1, min(MAX_CANDIDATES, int(body.get("candidates", 2))))
    instruction = str(body.get("instruction", ""))[:2000]
    action = get_action(pid, aid)
    cell = int(action["cellSize"])
    frames = action["frames"]
    index = next((i for i, f in enumerate(frames) if f["id"] == fid), -1)
    if index < 0:
        raise StoreError(f"frame {fid} is not in {aid}")
    frame = frames[index]

    rect = None
    if kind == "repair":
        raw_rect = body.get("rect")
        if not raw_rect or len(raw_rect) != 4:
            raise StoreError("局部修补需要先框选区域")
        x0, y0, x1, y1 = (int(round(v)) for v in raw_rect)
        x0, x1 = sorted((max(0, min(cell, x0)), max(0, min(cell, x1))))
        y0, y1 = sorted((max(0, min(cell, y0)), max(0, min(cell, y1))))
        if x1 - x0 < 4 or y1 - y0 < 4:
            raise StoreError("框选区域太小")
        rect = [x0, y0, x1, y1]

    jid = f"j{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
    folder = job_dir(pid, jid)
    folder.mkdir(parents=True)
    settings = _project_settings(pid)
    current = _displayed(pid, aid, frame)
    current.save(folder / "original.png")
    process.magenta_canvas(current, cell).save(folder / "input-1.png")
    inputs = [folder / "input-1.png"]
    labels = ["the frame to edit (character on solid magenta). Edit this image."]
    if kind == "repair":
        process.guide_canvas(current, cell, tuple(rect)).save(folder / "input-2.png")
        inputs.append(folder / "input-2.png")
        labels.append("the same frame with the region to change outlined in green (guide only).")
    else:
        loop = action.get("playback", "loop") == "loop"
        for delta, name, label in ((-1, "prev", "the previous animation frame (pose continuity only)."),
                                   (1, "next", "the next animation frame (pose continuity only).")):
            j = index + delta
            if not 0 <= j < len(frames):
                if not loop or len(frames) < 3:
                    continue
                j %= len(frames)
            if j == index:
                continue
            path = folder / f"input-{name}.png"
            process.magenta_canvas(_displayed(pid, aid, frames[j], frame["offset"]), cell).save(path)
            inputs.append(path)
            labels.append(label)
    if settings["identity"] and settings["identity"].exists():
        inputs.append(settings["identity"])
        labels.append("the official character reference (identity only; ignore its background and pose).")

    job = {
        "id": jid,
        "kind": kind,
        "action": aid,
        "frame": fid,
        "cellSize": cell,
        "sourceVersion": frame["version"],
        "flipX": bool(frame.get("flipX")),
        "instruction": instruction,
        "rect": rect,
        "model": settings["model"],
        "prompt": build_prompt(kind, instruction, settings["character"], labels),
        "inputs": [str(p) for p in inputs],
        "status": "queued",
        "reviewed": False,
        "createdAt": int(time.time()),
        "candidates": [{"index": n, "status": "queued", "image": None, "error": None} for n in range(1, count + 1)],
        "accepted": [],
    }
    write_json(folder / "job.json", job)
    _cancels[jid] = threading.Event()
    for n in range(1, count + 1):
        _executor.submit(_run_candidate, pid, jid, n, settings)
    return job


def _run_candidate(pid: str, jid: str, n: int, settings: dict) -> None:
    cancel = _cancels.setdefault(jid, threading.Event())
    folder = job_dir(pid, jid)

    def set_candidate(**fields) -> None:
        _update(pid, jid, lambda job: job["candidates"][n - 1].update(fields))

    if cancel.is_set():
        set_candidate(status="cancelled", error="已取消")
        return
    set_candidate(status="running", startedAt=int(time.time()))
    try:
        job = _read(pid, jid)
        result = codex.generate_image(
            job["prompt"], [Path(p) for p in job["inputs"]], folder / f"work-{n}", folder / f"cand-{n}.log",
            cancel, model=settings["model"], effort=settings["effort"])
        raw_path = folder / f"raw-{n}.png"
        shutil.copyfile(result.images[-1], raw_path)
        original = Image.open(folder / "original.png").convert("RGBA")
        rect = tuple(job["rect"]) if job["rect"] else None
        displayed = process.normalize_candidate(Image.open(raw_path), int(job["cellSize"]), original, job["kind"], rect)
        # Store in the frame's own orientation so the frame's flip flag still applies on top.
        stored = ImageOps.mirror(displayed) if job["flipX"] else displayed
        stored.save(folder / f"cand-{n}.png")
        set_candidate(status="done", image=f"cand-{n}.png", finishedAt=int(time.time()))
    except codex.Cancelled:
        set_candidate(status="cancelled", error="已取消", finishedAt=int(time.time()))
    except Exception as exc:  # surface every failure on the candidate instead of killing the worker
        set_candidate(status="failed", error=str(exc)[:500], finishedAt=int(time.time()))
    finally:
        shutil.rmtree(folder / f"work-{n}", ignore_errors=True)


def list_jobs(pid: str, aid: str | None = None, limit: int = 60) -> list[dict]:
    root = jobs_dir(pid)
    if not root.exists():
        return []
    jobs = []
    for path in sorted(root.glob("*/job.json"), reverse=True):
        job = read_json(path)
        if aid and job.get("action") != aid:
            continue
        job.pop("prompt", None)
        job.pop("inputs", None)
        jobs.append(job)
        if len(jobs) >= limit:
            break
    return jobs


def get_job(pid: str, jid: str) -> dict:
    return _read(pid, jid)


def cancel_job(pid: str, jid: str) -> dict:
    _cancels.setdefault(jid, threading.Event()).set()

    def mark(job: dict) -> None:
        for candidate in job["candidates"]:
            if candidate["status"] == "queued":
                candidate.update(status="cancelled", error="已取消")

    return _update(pid, jid, mark)


def set_reviewed(pid: str, jid: str, reviewed: bool = True) -> dict:
    return _update(pid, jid, lambda job: job.update(reviewed=reviewed))


def accept_candidate(pid: str, jid: str, n: int) -> dict:
    job = _read(pid, jid)
    candidate = next((c for c in job["candidates"] if c["index"] == n), None)
    if not candidate or candidate["status"] != "done":
        raise StoreError("这张候选还没有生成好")
    folder = action_dir(pid, job["action"]) / "frames" / check_slug(job["frame"], "frame")
    existing = [int(p.stem[1:]) for p in folder.glob("v*.png") if p.stem[1:].isdigit()]
    version = max(existing, default=0) + 1
    shutil.copyfile(job_dir(pid, jid) / candidate["image"], folder / f"v{version}.png")
    _update(pid, jid, lambda j: (j["accepted"].append({"index": n, "version": version}), j.update(reviewed=True)))
    return {"version": version, "frame": job["frame"], "action": job["action"]}


def recover_interrupted() -> None:
    """Jobs cannot survive a server restart; mark whatever was in flight as failed."""
    from .store import PROJECTS_DIR
    for path in PROJECTS_DIR.glob("*/jobs/*/job.json"):
        job = read_json(path)
        changed = False
        for candidate in job["candidates"]:
            if candidate["status"] in ("queued", "running"):
                candidate.update(status="failed", error="服务重启，任务中断")
                changed = True
        if changed:
            states = [c["status"] for c in job["candidates"]]
            job["status"] = "done" if "done" in states else "failed"
            write_json(path, job)
