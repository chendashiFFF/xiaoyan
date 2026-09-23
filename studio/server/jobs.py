"""AI generation jobs: each job asks Codex for N candidates.

Kinds:
    redraw    redraw one frame, candidates become new versions of it
    repair    redraw a rectangle of one frame, composited back onto the original
    inbetween a new frame halfway between a frame and the next one
    keyposes  a grid of key poses for an action, each candidate becomes a set of new frames
    master    a clean front-view master reference drawn from loose source images (character-level)
    turnaround a front / side / back design sheet built from the master reference (character-level)

    projects/<project>/jobs/<job>/job.json          status, prompt inputs, candidates
    projects/<project>/jobs/<job>/input-*.png       images sent to Codex
    projects/<project>/jobs/<job>/raw-<n>.png       what Codex produced
    projects/<project>/jobs/<job>/cand-<n>.png      normalized frame (redraw/repair: frame's raw orientation)
    projects/<project>/jobs/<job>/cand-<n>-<k>.png  keyposes: pose k of candidate n
    projects/<project>/jobs/<job>/cand-<n>.log      Codex event log
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
from .store import (StoreError, action_dir, add_frame_from_file, check_slug, frame_path, get_action, project_dir,
                    read_json, write_json)

FRAME_KINDS = ("redraw", "repair", "inbetween")
REFERENCE_KINDS = ("master", "turnaround")
STYLES = {
    "pixel": "polished HD-2D pixel-art game sprite: crisp pixel clusters, clean dark outline, rich but controlled palette, soft highlights",
    "source": "the same art style as the attached source images",
}
TERMINAL = ("done", "failed", "cancelled")
MAX_CANDIDATES = 4
SHEET_LAYOUTS = {4: (2, 2), 6: (2, 3)}
FACINGS = {
    "front": "facing the viewer (front view), like the reference",
    "right": "turned to the viewer's right (3/4 side view)",
    "left": "turned to the viewer's left (3/4 side view)",
}
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
    design = project.get("designReference")
    settings = project.get("codex", {})
    return {
        "identity": project_dir(pid) / identity if identity else None,
        "design": project_dir(pid) / design if design else None,
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


# ---- prompts --------------------------------------------------------------------

DESIGN_LABEL = ("the character design sheet: front, side and back views plus close-ups of face, hair accessories and "
                "embroidery (identity reference only; ignore its background, text and layout).")

REPLY = "When the image has been generated, reply with only its absolute file path."
TOOL = "Call your built-in image generation tool exactly once. Do not run shell commands and do not write any files yourself."
BACKGROUND = "Background: perfectly flat solid #FF00FF magenta. No shadow, no ground, no scenery, no text, no border."
IDENTITY = ("same character identity as the reference: face, eye colour, hair colour and length, hair accessories on the same "
            "side of the head, same outfit and colours, same pixel-art rendering")


def _listing(labels: list[str]) -> str:
    return "\n".join(f"- Image {i + 1}: {label}" for i, label in enumerate(labels))


def build_prompt(kind: str, instruction: str, character: str, labels: list[str], extra: dict | None = None) -> str:
    extra = extra or {}
    instruction = instruction.strip()
    head = f'You are working on a 2D sprite animation of the character "{character}".\n{TOOL}\n\nAttached images, in order:\n{_listing(labels)}\n\n'
    if kind == "repair":
        change = instruction or "Fix any drawing errors so it matches the character reference."
        return head + f"""Edit Image 1. Only change what is inside the green box shown in Image 2. Change requested: {change}

Everything outside the green box must stay exactly as in Image 1: same pose, same pixels, same position and scale.
Keep the {IDENTITY}. Do not draw the green box. {BACKGROUND}

{REPLY}"""

    if kind == "inbetween":
        change = f"\nExtra direction: {instruction}" if instruction else ""
        return head + f"""Draw the single in-between frame that comes exactly halfway between Image 1 and Image 2 in time.
Use Image 1 as the base canvas: same canvas size, same camera, same scale. Every body part, hair strand and piece of clothing should sit halfway between where it is in Image 1 and where it is in Image 2, so that playing Image 1 → new frame → Image 2 looks smooth.{change}
Keep the {IDENTITY}; same facing direction as Image 1 and Image 2.
{BACKGROUND} Full body visible, nothing touching the canvas edge. Draw only one character — never a double exposure of the two poses.

{REPLY}"""

    if kind == "keyposes":
        rows, cols = extra["grid"]
        count = rows * cols
        loop = ("The last pose must lead naturally back into the first, because the animation loops."
                if extra.get("playback") == "loop" else "The animation plays forward and then backward.")
        ground = ("Feet stay on the same ground line as in the template in every cell, unless the motion itself leaves the ground."
                  if extra.get("grounded", True) else "Poses may leave the ground; keep the body size of the template.")
        return head + f"""Create the KEY POSES of a new animation: {instruction}

Edit Image 1 into a {rows} × {cols} grid ({rows} rows, {cols} columns) with exactly {count} poses in reading order (left to right, then top to bottom), one pose per cell, together describing the whole motion. {loop}
Image 1 only fixes the grid, the body size and the feet position in each cell — the poses and the facing must follow the description, not the template.
- Every pose: {IDENTITY}; same body size in every cell as in the template.
- Facing: {FACINGS[extra.get("facing", "front")]}, the same in every cell.
- {ground}
- Each pose centred in its own cell. Nothing may cross into a neighbouring cell or touch the canvas edge.
- {BACKGROUND} No grid lines, no numbers, no labels.

{REPLY}"""

    change = instruction or "Redraw this frame cleanly: fix anything inconsistent with the character reference and make the pose flow smoothly between the previous and next frames."
    return head + f"""Edit Image 1 (redraw this ONE frame). Change requested: {change}

Keep everything else identical to Image 1:
- {IDENTITY};
- same canvas size, same camera, same scale; feet on the same ground line; body at the same horizontal position; same facing direction;
- the pose must read as a natural in-between of the previous and next frames when played as an animation.
{BACKGROUND} Full body visible, nothing touching the canvas edge.

{REPLY}"""


def build_reference_prompt(kind: str, character: str, instruction: str, labels: list[str], style: str) -> str:
    head = f'You are preparing reference art for the character "{character}" in a 2D sprite animation project.\n{TOOL}\n\nAttached images, in order:\n{_listing(labels)}\n\n'
    notes = f"\nNotes from the user about the character: {instruction}" if instruction else ""
    if kind == "turnaround":
        return head + f"""Create a character turnaround sheet from Image 1: three full-body views side by side, left to right — front view, side view facing right, back view.{notes}
- Exactly the same character as Image 1 in every view: face, eyes, hair colour, length and style, every accessory on the correct side, outfit layers, colours and patterns.
- Same scale and the same ground line for all three; standing straight, arms relaxed; nothing overlapping or touching the canvas edge.
- Art style: {style}.
- Background: perfectly flat solid #FF00FF magenta. No shadow, no floor, no text, no labels, no frames.
- Wide landscape canvas.

{REPLY}"""
    return head + f"""Create the official MASTER REFERENCE of this character: a single full-body front view that every animation will be drawn from.{notes}
- The source images may show different poses, angles or art styles; combine them into one consistent design and keep every identity detail: face and eye colour, hair colour, length and style, each accessory and which side it is on, every outfit layer, colours and patterns.
- Pose: standing straight, facing the viewer, arms relaxed at the sides, feet slightly apart and fully visible, calm friendly expression.
- Framing: exactly one character, centred, the whole body from the top of the hair to the shoes, about 80% of the canvas height, with margin on every side.
- Art style: {style}.
- Background: perfectly flat solid #FF00FF magenta. No shadow, no floor, no text, no border, no other objects.
- Square canvas.

{REPLY}"""


def create_reference_job(pid: str, body: dict) -> dict:
    """Character-level jobs: a clean master reference, or a turnaround sheet from it."""
    kind = body.get("kind", "master")
    if kind not in REFERENCE_KINDS:
        raise StoreError(f"unknown job kind {kind!r}")
    _require_codex()
    count = max(1, min(MAX_CANDIDATES, int(body.get("candidates", 2))))
    instruction = str(body.get("instruction", "")).strip()[:2000]
    project = read_json(project_dir(pid) / "project.json")
    settings = _project_settings(pid)
    known = set(project.get("references", []))
    sources = [str(s) for s in body.get("sources", []) if str(s) in known][:6]

    labels: list[str] = []
    inputs: list[Path] = []
    if kind == "turnaround":
        if not settings["identity"] or not settings["identity"].exists():
            raise StoreError("先设置主参考图，再生成三视图")
        inputs.append(settings["identity"])
        labels.append("the master reference (front view) — the character to draw.")
    elif not sources:
        raise StoreError("至少选一张参考图")
    for rel in sources:
        inputs.append(project_dir(pid) / rel)
        labels.append("a source image of the character (identity; pose, angle and art style may differ).")

    style_key = body.get("style", "pixel")
    style = STYLES.get(style_key, STYLES["pixel"])
    style_from = body.get("styleFrom")
    if style_from:
        other = _project_settings(check_slug(str(style_from), "character"))
        if other["identity"] and other["identity"].exists():
            inputs.append(other["identity"])
            labels.append("an art-style reference from another character in the same game (copy only its rendering style, NOT its identity).")
            style = "exactly the rendering style of the art-style reference image"

    jid, folder = _new_job_folder(pid)
    job = _base_job(jid, kind, None, 0, instruction, count, settings)  # type: ignore[arg-type]
    job.update({
        "sources": sources,
        "style": style_key if not style_from else f"from:{style_from}",
        "prompt": build_reference_prompt(kind, settings["character"], instruction, labels, style),
        "inputs": [str(p) for p in inputs],
    })
    return _start(pid, job, settings)


# ---- job creation ---------------------------------------------------------------

def _new_job_folder(pid: str) -> tuple[str, Path]:
    jid = f"j{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
    folder = job_dir(pid, jid)
    folder.mkdir(parents=True)
    return jid, folder


def _start(pid: str, job: dict, settings: dict) -> dict:
    write_json(job_dir(pid, job["id"]) / "job.json", job)
    _cancels[job["id"]] = threading.Event()
    for candidate in job["candidates"]:
        _executor.submit(_run_candidate, pid, job["id"], candidate["index"], settings)
    return job


def _base_job(jid: str, kind: str, aid: str, cell: int, instruction: str, count: int, settings: dict) -> dict:
    return {
        "id": jid,
        "kind": kind,
        "action": aid,
        "frame": None,
        "cellSize": cell,
        "instruction": instruction,
        "model": settings["model"],
        "status": "queued",
        "reviewed": False,
        "createdAt": int(time.time()),
        "candidates": [{"index": n, "status": "queued", "image": None, "error": None} for n in range(1, count + 1)],
        "accepted": [],
    }


def _require_codex() -> None:
    if not codex.codex_binary():
        raise StoreError("找不到 codex 命令，请先安装并登录 Codex CLI")


def create_job(pid: str, aid: str, fid: str, body: dict) -> dict:
    """Frame-level jobs: redraw, repair, inbetween."""
    kind = body.get("kind", "redraw")
    if kind not in FRAME_KINDS:
        raise StoreError(f"unknown job kind {kind!r}")
    _require_codex()
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

    after = None
    if kind == "inbetween":
        j = index + 1
        if j >= len(frames):
            if action.get("playback", "loop") != "loop" or len(frames) < 2:
                raise StoreError("最后一帧后面没有下一帧，没法补中间帧")
            j = 0
        after = frames[j]
        if after["id"] == fid:
            raise StoreError("至少要有两帧才能补中间帧")

    jid, folder = _new_job_folder(pid)
    settings = _project_settings(pid)
    current = _displayed(pid, aid, frame)
    current.save(folder / "original.png")
    process.magenta_canvas(current, cell).save(folder / "input-1.png")
    inputs = [folder / "input-1.png"]
    if kind == "repair":
        process.guide_canvas(current, cell, tuple(rect)).save(folder / "input-2.png")
        inputs.append(folder / "input-2.png")
        labels = ["the frame to edit (character on solid magenta).",
                  "the same frame with the region to change outlined in green (guide only)."]
    elif kind == "inbetween":
        other = _displayed(pid, aid, after, frame["offset"])
        other.save(folder / "after.png")
        process.magenta_canvas(other, cell).save(folder / "input-2.png")
        inputs.append(folder / "input-2.png")
        labels = ["the earlier frame (base canvas).", "the later frame."]
    else:
        labels = ["the frame to edit (character on solid magenta)."]
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
    if settings["design"] and settings["design"].exists():
        inputs.append(settings["design"])
        labels.append(DESIGN_LABEL)

    job = _base_job(jid, kind, aid, cell, instruction, count, settings)
    job.update({
        "frame": fid,
        "frameB": after["id"] if after else None,
        "sourceVersion": frame["version"],
        "flipX": bool(frame.get("flipX")),
        "offset": list(frame["offset"]),
        "rect": rect,
        "prompt": build_prompt(kind, instruction, settings["character"], labels),
        "inputs": [str(p) for p in inputs],
    })
    return _start(pid, job, settings)


def create_action_job(pid: str, aid: str, body: dict) -> dict:
    """Action-level jobs: keyposes."""
    kind = body.get("kind", "keyposes")
    if kind != "keyposes":
        raise StoreError(f"unknown job kind {kind!r}")
    _require_codex()
    description = str(body.get("instruction", "")).strip()[:2000]
    if not description:
        raise StoreError("请描述这个动作")
    keyframes = int(body.get("keyframes", 4))
    if keyframes not in SHEET_LAYOUTS:
        raise StoreError(f"关键姿势数量只支持 {', '.join(map(str, SHEET_LAYOUTS))}")
    facing = body.get("facing", "front")
    if facing not in FACINGS:
        raise StoreError(f"invalid facing {facing!r}")
    count = max(1, min(MAX_CANDIDATES, int(body.get("candidates", 2))))
    action = get_action(pid, aid)
    settings = _project_settings(pid)
    if not settings["identity"] or not settings["identity"].exists():
        raise StoreError("项目没有角色设定图（project.json 的 identityReference）")

    rows, cols = SHEET_LAYOUTS[keyframes]
    jid, folder = _new_job_folder(pid)
    process.anchor_sheet(Image.open(settings["identity"]), rows, cols).save(folder / "input-1.png")
    inputs = [folder / "input-1.png", settings["identity"]]
    labels = [f"layout template: a {rows} × {cols} grid on magenta; each cell shows the body size and feet position to use.",
              "the official character reference (identity only; ignore its background and pose)."]
    if settings["design"] and settings["design"].exists():
        inputs.append(settings["design"])
        labels.append(DESIGN_LABEL)
    extra = {"grid": [rows, cols], "facing": facing, "grounded": action.get("grounded", True), "playback": action.get("playback", "loop")}
    job = _base_job(jid, kind, aid, int(action["cellSize"]), description, count, settings)
    job.update({
        "keyframes": keyframes,
        "grid": [rows, cols],
        "facing": facing,
        "grounded": bool(action.get("grounded", True)),
        "duration": max(10, min(10_000, int(body.get("duration", 120)))),
        "prompt": build_prompt(kind, description, settings["character"], labels, extra),
        "inputs": [str(p) for p in inputs],
    })
    return _start(pid, job, settings)


# ---- running --------------------------------------------------------------------

def _finish_candidate(job: dict, folder: Path, n: int, raw_path: Path) -> dict:
    """Post-process one Codex image; returns the fields to store on the candidate."""
    cell = int(job["cellSize"])
    raw = Image.open(raw_path)
    if job["kind"] in REFERENCE_KINDS:
        image = process.despill_edges(process.extract_alpha(raw))
        bbox = image.getbbox()
        if bbox:
            pad = round(max(image.size) * 0.04)
            image = image.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                                min(image.width, bbox[2] + pad), min(image.height, bbox[3] + pad)))
        image.save(folder / f"cand-{n}.png")
        return {"image": f"cand-{n}.png"}
    if job["kind"] == "keyposes":
        rows, cols = job["grid"]
        names = []
        for k, image in enumerate(process.split_sheet(raw, rows, cols, cell, job.get("grounded", True)), start=1):
            name = f"cand-{n}-{k}.png"
            image.save(folder / name)
            names.append(name)
        return {"image": names[0], "frames": names}
    original = Image.open(folder / "original.png").convert("RGBA")
    if job["kind"] == "inbetween":
        after = Image.open(folder / "after.png").convert("RGBA")
        process.normalize_inbetween(raw, cell, original, after).save(folder / f"cand-{n}.png")
        return {"image": f"cand-{n}.png"}
    rect = tuple(job["rect"]) if job.get("rect") else None
    displayed = process.normalize_candidate(raw, cell, original, job["kind"], rect)
    # Store in the frame's own orientation so the frame's flip flag still applies on top.
    stored = ImageOps.mirror(displayed) if job.get("flipX") else displayed
    stored.save(folder / f"cand-{n}.png")
    return {"image": f"cand-{n}.png"}


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
        fields = _finish_candidate(job, folder, n, raw_path)
        set_candidate(status="done", finishedAt=int(time.time()), **fields)
    except codex.Cancelled:
        set_candidate(status="cancelled", error="已取消", finishedAt=int(time.time()))
    except Exception as exc:  # surface every failure on the candidate instead of killing the worker
        set_candidate(status="failed", error=str(exc)[:500], finishedAt=int(time.time()))
    finally:
        shutil.rmtree(folder / f"work-{n}", ignore_errors=True)


# ---- queries and actions --------------------------------------------------------

def list_jobs(pid: str, aid: str | None = None, limit: int = 60, kinds: tuple[str, ...] | None = None) -> list[dict]:
    root = jobs_dir(pid)
    if not root.exists():
        return []
    jobs = []
    for path in sorted(root.glob("*/job.json"), reverse=True):
        job = read_json(path)
        if aid and job.get("action") != aid:
            continue
        if kinds and job.get("kind") not in kinds:
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


def _new_frame(fid: str, offset: list[int], duration: int) -> dict:
    return {"id": fid, "duration": duration, "offset": offset, "flipX": False, "version": 1, "versions": [1], "note": ""}


def accept_candidate(pid: str, jid: str, n: int) -> dict:
    job = _read(pid, jid)
    candidate = next((c for c in job["candidates"] if c["index"] == n), None)
    if not candidate or candidate["status"] != "done":
        raise StoreError("这张候选还没有生成好")
    folder = job_dir(pid, jid)
    aid = job["action"]
    result: dict = {"kind": job["kind"], "action": aid}

    if job["kind"] in REFERENCE_KINDS:
        from .store import add_reference
        role = "identity" if job["kind"] == "master" else "design"
        name = f"{'master' if role == 'identity' else 'turnaround'}-ai.png"
        added = add_reference(pid, (folder / candidate["image"]).read_bytes(), role, name)
        _update(pid, jid, lambda j: (j["accepted"].append({"index": n, "reference": added["reference"]}), j.update(reviewed=True)))
        return {"kind": job["kind"], "reference": added["reference"], "project": added["project"]}

    if job["kind"] == "keyposes":
        frames = [_new_frame(add_frame_from_file(pid, aid, folder / name), [0, 0], int(job.get("duration", 120)))
                  for name in candidate["frames"]]
        result["frames"] = frames
        record = {"index": n, "frames": [f["id"] for f in frames]}
    elif job["kind"] == "inbetween":
        fid = add_frame_from_file(pid, aid, folder / candidate["image"])
        result.update(frame=_new_frame(fid, list(job.get("offset", [0, 0])), 100), after=job["frame"])
        record = {"index": n, "frames": [fid]}
    else:
        frame_folder = action_dir(pid, aid) / "frames" / check_slug(job["frame"], "frame")
        existing = [int(p.stem[1:]) for p in frame_folder.glob("v*.png") if p.stem[1:].isdigit()]
        version = max(existing, default=0) + 1
        shutil.copyfile(folder / candidate["image"], frame_folder / f"v{version}.png")
        result.update(version=version, frame=job["frame"])
        record = {"index": n, "version": version}

    _update(pid, jid, lambda j: (j["accepted"].append(record), j.update(reviewed=True)))
    return result


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
