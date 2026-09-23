"""On-disk project store.

Layout (everything is plain files so it can live in git):

    projects/<project>/project.json
    projects/<project>/references/*.png
    projects/<project>/actions/<action>/action.json
    projects/<project>/actions/<action>/frames/<frame>/v<n>.png
    projects/<project>/exports/*

Frame images are immutable once written: every edit produces a new version
file, and action.json only points at which version is current.
"""
from __future__ import annotations

import io
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from PIL import Image

STUDIO_DIR = Path(__file__).resolve().parents[1]
# STUDIO_PROJECTS_DIR lets tests run against a throwaway copy instead of the real projects.
PROJECTS_DIR = Path(os.environ.get("STUDIO_PROJECTS_DIR", STUDIO_DIR / "projects"))
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class StoreError(ValueError):
    pass


def check_slug(value: str, kind: str) -> str:
    if not SLUG.match(value or ""):
        raise StoreError(f"invalid {kind}: {value!r}")
    return value


def project_dir(pid: str) -> Path:
    return PROJECTS_DIR / check_slug(pid, "project")


def action_dir(pid: str, aid: str) -> Path:
    return project_dir(pid) / "actions" / check_slug(aid, "action")


def frame_path(pid: str, aid: str, fid: str, version: int) -> Path:
    return action_dir(pid, aid) / "frames" / check_slug(fid, "frame") / f"v{int(version)}.png"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    tmp.replace(path)


def list_projects() -> list[dict]:
    if not PROJECTS_DIR.exists():
        return []
    projects = []
    for root in sorted(PROJECTS_DIR.iterdir()):
        if not (root / "project.json").exists():
            continue
        project = read_json(root / "project.json")
        identity = project.get("identityReference")
        projects.append({
            "id": root.name,
            "name": project.get("name", root.name),
            "thumb": f"/files/{root.name}/{identity}" if identity else None,
            "actionCount": len(list((root / "actions").glob("*/action.json"))),
        })
    return projects


REFERENCE_ROLES = {"identity": "identityReference", "design": "designReference"}


def create_project(body: dict) -> dict:
    pid = check_slug(str(body.get("id", "")).strip().lower(), "character id")
    root = project_dir(pid)
    if (root / "project.json").exists():
        raise StoreError(f"人物 {pid} 已经存在")
    name = str(body.get("name") or pid).strip()[:60]
    (root / "actions").mkdir(parents=True, exist_ok=True)
    (root / "references").mkdir(parents=True, exist_ok=True)
    project = {"id": pid, "name": name, "references": [], "actionOrder": [],
               "identityReference": None, "designReference": None}
    write_json(root / "project.json", project)
    return get_project(pid)


def delete_project(pid: str) -> dict:
    """Move a whole character into projects/.trash/ (hidden from the list, recoverable by hand)."""
    root = project_dir(pid)
    if not (root / "project.json").exists():
        raise FileNotFoundError(pid)
    others = [p for p in list_projects() if p["id"] != pid]
    if not others:
        raise StoreError("至少要保留一个人物")
    for job_file in (root / "jobs").glob("*/job.json"):
        if read_json(job_file).get("status") in ("queued", "running"):
            raise StoreError("这个人物还有生成任务在跑，等它完成或取消后再删")
    trash = PROJECTS_DIR / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    target = trash / f"{pid}-{time.strftime('%Y%m%d-%H%M%S')}"
    root.rename(target)
    return {"trashedTo": str(target), "next": others[0]["id"]}


def update_project(pid: str, body: dict) -> dict:
    project_file = project_dir(pid) / "project.json"
    project = read_json(project_file)
    if "name" in body:
        project["name"] = str(body["name"]).strip()[:60] or project.get("name", pid)
    for role, key in REFERENCE_ROLES.items():
        if key in body:
            value = body[key]
            if value is not None and value not in project.get("references", []):
                raise StoreError(f"{value} 不是这个人物的参考图")
            project[key] = value
    write_json(project_file, project)
    return get_project(pid)


def add_reference(pid: str, data: bytes, role: str | None, filename: str) -> dict:
    """Store an uploaded reference image; the identity image gets its background keyed out."""
    from . import process  # process has no store imports; kept local to avoid loading numpy for every store user
    if role is not None and role not in REFERENCE_ROLES:
        raise StoreError(f"unknown reference role {role!r}")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # Pillow raises a zoo of exception types for bad input
        raise StoreError(f"not a readable image: {exc}") from exc
    warning = None
    if role == "identity":
        image = process.despill_edges(process.extract_alpha(image))
        if image.getextrema()[3][0] == 255:
            warning = "这张图没有透明背景，也不是纯品红底，AI 会把背景也当成人物的一部分参考。最好换一张透明背景的正面全身图。"
        bbox = image.getbbox()
        if bbox:
            pad = round(max(image.size) * 0.04)
            image = image.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                                min(image.width, bbox[2] + pad), min(image.height, bbox[3] + pad)))
    stem = re.sub(r"[^a-z0-9_-]+", "-", Path(filename or "reference").stem.lower()).strip("-") or "reference"
    folder = project_dir(pid) / "references"
    folder.mkdir(parents=True, exist_ok=True)
    name, serial = f"{stem}.png", 1
    while (folder / name).exists():
        serial += 1
        name = f"{stem}-{serial}.png"
    image.save(folder / name)
    rel = f"references/{name}"
    project_file = project_dir(pid) / "project.json"
    project = read_json(project_file)
    project.setdefault("references", []).append(rel)
    if role:
        project[REFERENCE_ROLES[role]] = rel
    write_json(project_file, project)
    return {"reference": rel, "warning": warning, "project": get_project(pid)}


def get_project(pid: str) -> dict:
    root = project_dir(pid)
    if not (root / "project.json").exists():
        raise FileNotFoundError(pid)
    project = read_json(root / "project.json")
    order = project.get("actionOrder", [])
    actions = []
    for path in sorted((root / "actions").glob("*/action.json")):
        action = read_json(path)
        first = action["frames"][0] if action["frames"] else None
        actions.append({
            "id": action["id"],
            "label": action.get("label", action["id"]),
            "cellSize": action["cellSize"],
            "frameCount": len(action["frames"]),
            "duration": sum(f["duration"] for f in action["frames"]),
            "thumb": frame_url(pid, action["id"], first["id"], first["version"]) if first else None,
        })
    actions.sort(key=lambda a: (order.index(a["id"]) if a["id"] in order else len(order), a["id"]))
    return {**project, "actions": actions}


def frame_url(pid: str, aid: str, fid: str, version: int) -> str:
    return f"/files/{pid}/actions/{aid}/frames/{fid}/v{version}.png"


def get_action(pid: str, aid: str) -> dict:
    path = action_dir(pid, aid) / "action.json"
    if not path.exists():
        raise FileNotFoundError(aid)
    return read_json(path)


def save_action(pid: str, aid: str, incoming: dict) -> dict:
    """Validate an edited action coming from the editor and persist it."""
    current = get_action(pid, aid)
    frames = []
    seen = set()
    for raw in incoming.get("frames", []):
        fid = check_slug(str(raw.get("id", "")), "frame")
        if fid in seen:
            raise StoreError(f"duplicate frame id {fid}")
        seen.add(fid)
        versions = sorted({int(v) for v in raw.get("versions", [])})
        version = int(raw.get("version", 0))
        if version not in versions:
            raise StoreError(f"frame {fid} points at missing version {version}")
        for v in versions:
            if not frame_path(pid, aid, fid, v).exists():
                raise StoreError(f"frame {fid} v{v} has no image on disk")
        offset = raw.get("offset", [0, 0])
        frames.append({
            "id": fid,
            "duration": max(10, min(10_000, int(raw.get("duration", 100)))),
            "offset": [int(offset[0]), int(offset[1])],
            "flipX": bool(raw.get("flipX", False)),
            "version": version,
            "versions": versions,
            "note": str(raw.get("note", ""))[:2000],
        })
    playback = incoming.get("playback", current.get("playback", "loop"))
    if playback not in ("loop", "pingpong"):
        raise StoreError(f"invalid playback {playback!r}")
    saved = {
        **current,
        "label": str(incoming.get("label", current.get("label", aid)))[:60],
        "grounded": bool(incoming.get("grounded", current.get("grounded", True))),
        "playback": playback,
        "frames": frames,
        "nextSeq": max(int(current.get("nextSeq", 1)), int(incoming.get("nextSeq", 1))),
        "updatedAt": int(time.time()),
    }
    write_json(action_dir(pid, aid) / "action.json", saved)
    return saved


CELL_SIZES = (256, 512)


def create_action(pid: str, body: dict) -> dict:
    aid = check_slug(str(body.get("id", "")).strip().lower(), "action")
    target = action_dir(pid, aid)
    if (target / "action.json").exists():
        raise StoreError(f"动作 {aid} 已经存在")
    cell = int(body.get("cellSize", 512))
    if cell not in CELL_SIZES:
        raise StoreError(f"cellSize must be one of {CELL_SIZES}")
    playback = body.get("playback", "loop")
    if playback not in ("loop", "pingpong"):
        raise StoreError(f"invalid playback {playback!r}")
    action = {
        "id": aid,
        "label": str(body.get("label") or aid)[:60],
        "cellSize": cell,
        "grounded": bool(body.get("grounded", True)),
        "playback": playback,
        "frames": [],
        "nextSeq": 1,
        "updatedAt": int(time.time()),
    }
    write_json(target / "action.json", action)
    project_file = project_dir(pid) / "project.json"
    project = read_json(project_file)
    order = project.setdefault("actionOrder", [])
    if aid not in order:
        order.append(aid)
    write_json(project_file, project)
    return action


def delete_action(pid: str, aid: str) -> dict:
    """Move an action into projects/<project>/trash/ instead of deleting it outright."""
    source = action_dir(pid, aid)
    if not (source / "action.json").exists():
        raise FileNotFoundError(aid)
    trash = project_dir(pid) / "trash"
    trash.mkdir(parents=True, exist_ok=True)
    target = trash / f"{aid}-{time.strftime('%Y%m%d-%H%M%S')}"
    source.rename(target)
    project_file = project_dir(pid) / "project.json"
    project = read_json(project_file)
    project["actionOrder"] = [a for a in project.get("actionOrder", []) if a != aid]
    write_json(project_file, project)
    return {"trashedTo": str(target.relative_to(PROJECTS_DIR.parent.parent))}


def allocate_frame_id(pid: str, aid: str) -> str:
    """Reserve a new frame id; the counter lives in action.json so ids never repeat."""
    action = get_action(pid, aid)
    frames_dir = action_dir(pid, aid) / "frames"
    seq = int(action.get("nextSeq", 1))
    while (frames_dir / f"f{seq:03d}").exists():
        seq += 1
    action["nextSeq"] = seq + 1
    write_json(action_dir(pid, aid) / "action.json", action)
    return f"f{seq:03d}"


def duplicate_frame(pid: str, aid: str, fid: str, version: int) -> dict:
    source = frame_path(pid, aid, fid, version)
    if not source.exists():
        raise FileNotFoundError(str(source))
    new_id = allocate_frame_id(pid, aid)
    target = frame_path(pid, aid, new_id, 1)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())
    return {"id": new_id, "version": 1, "versions": [1]}


def add_frame_from_file(pid: str, aid: str, source: Path) -> str:
    """Create a brand-new frame whose v1 is a copy of `source`."""
    fid = allocate_frame_id(pid, aid)
    target = frame_path(pid, aid, fid, 1)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())
    return fid


def fit_to_cell(image: Image.Image, cell: int) -> Image.Image:
    """Place an arbitrary image into a cell x cell canvas, bottom-centered."""
    image = image.convert("RGBA")
    if image.size == (cell, cell):
        return image
    bbox = image.getbbox()
    if bbox:
        image = image.crop(bbox)
    scale = min(1.0, (cell * 0.95) / max(image.width, image.height))
    if scale < 1.0:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((cell - image.width) // 2, cell - image.height - round(cell * 0.05)))
    return canvas


def add_frame_version(pid: str, aid: str, fid: str, data: bytes) -> int:
    action = get_action(pid, aid)
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # Pillow raises a zoo of exception types for bad input
        raise StoreError(f"not a readable image: {exc}") from exc
    image = fit_to_cell(image, int(action["cellSize"]))
    folder = action_dir(pid, aid) / "frames" / check_slug(fid, "frame")
    existing = [int(p.stem[1:]) for p in folder.glob("v*.png") if p.stem[1:].isdigit()]
    version = max(existing, default=0) + 1
    folder.mkdir(parents=True, exist_ok=True)
    image.save(folder / f"v{version}.png")
    return version
