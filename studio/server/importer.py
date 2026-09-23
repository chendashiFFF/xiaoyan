"""Import the desktop pet's existing frames into a studio project.

    studio/.venv/bin/python -m studio.server.importer [--force]
"""
from __future__ import annotations

import argparse
import re
import shutil
import time

from .store import PROJECTS_DIR, STUDIO_DIR, action_dir, write_json

REPO_DIR = STUDIO_DIR.parent
ACTIONS_SRC = REPO_DIR / "assets" / "actions"
REFERENCES_SRC = REPO_DIR / "assets" / "references"
APP_JS = REPO_DIR / "src" / "renderer" / "app.js"
PROJECT_ID = "xiaoyan"
AIRBORNE = {"jump"}
ACTION_ROW = re.compile(r"(\w+): \{ label: '([^']+)', frames: (\d+), fps: (\d+), loop: (true|false)")


def read_action_table() -> dict[str, dict]:
    table = {}
    for name, label, frames, fps, loop in ACTION_ROW.findall(APP_JS.read_text("utf-8")):
        table[name] = {"label": label, "frames": int(frames), "fps": int(fps), "loop": loop == "true"}
    return table


def import_assets(force: bool = False) -> list[str]:
    table = read_action_table()
    project_root = PROJECTS_DIR / PROJECT_ID
    refs = project_root / "references"
    refs.mkdir(parents=True, exist_ok=True)
    for ref in sorted(REFERENCES_SRC.glob("*.png")):
        shutil.copyfile(ref, refs / ref.name)
    write_json(project_root / "project.json", {
        "id": PROJECT_ID,
        "name": "Xiaoyan",
        "references": [f"references/{p.name}" for p in sorted(refs.glob("*.png"))],
        "identityReference": "references/master.png",
        "actionOrder": list(table),
    })

    imported = []
    for name, meta in table.items():
        target = action_dir(PROJECT_ID, name)
        if (target / "action.json").exists() and not force:
            continue
        if target.exists():
            shutil.rmtree(target)
        duration = round(1000 / meta["fps"])
        frames = []
        for index in range(1, meta["frames"] + 1):
            source = ACTIONS_SRC / name / f"{name}-{index}.png"
            fid = f"f{index:03d}"
            dest = target / "frames" / fid / "v1.png"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
            frames.append({"id": fid, "duration": duration, "offset": [0, 0], "flipX": False, "version": 1, "versions": [1], "note": ""})
        write_json(target / "action.json", {
            "id": name,
            "label": meta["label"],
            "cellSize": 256,
            "grounded": name not in AIRBORNE,
            "playback": "loop",
            "frames": frames,
            "nextSeq": len(frames) + 1,
            "source": f"assets/actions/{name}",
            "updatedAt": int(time.time()),
        })
        imported.append(name)
    return imported


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="overwrite actions that were already imported")
    args = parser.parse_args()
    imported = import_assets(force=args.force)
    print(f"imported {len(imported)} actions: {', '.join(imported) or '(none, already present)'}")


if __name__ == "__main__":
    main()
