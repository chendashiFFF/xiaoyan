"""Render an action's current frame sequence to GIF / WebP / APNG / sprite sheet."""
from __future__ import annotations

import base64
import io
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .store import StoreError, frame_path, get_action, project_dir

FORMATS = ("gif", "webp", "apng", "sheet")
TRANSPARENT_INDEX = 255


@dataclass
class ExportOptions:
    format: str = "gif"
    scale: float = 1
    pixel_step: float = 1
    patina: str = "none"
    background: str = "transparent"  # "transparent" or "#rrggbb"
    matte: str = "#ffffff"  # GIF only: colour that semi-transparent edges are flattened onto
    alpha_threshold: int = 128  # GIF only: alpha at or above this becomes opaque
    trim: bool = True
    padding: int = 8

    @classmethod
    def parse(cls, raw: dict) -> "ExportOptions":
        # Ignore legacy processing settings, including cached requests from older clients.
        opts = cls(format=str(raw.get("format", "gif")))
        if opts.format not in FORMATS:
            raise StoreError(f"unknown format {opts.format!r}")
        return opts


def parse_hex(value: str) -> tuple[int, int, int]:
    text = value.lstrip("#")
    if len(text) != 6:
        raise StoreError(f"invalid colour {value!r}")
    try:
        return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise StoreError(f"invalid colour {value!r}") from exc


def render_sequence(pid: str, aid: str, opts: ExportOptions) -> tuple[list[Image.Image], list[int], dict]:
    """Render the edited frame positions and playback order without export effects."""
    action = get_action(pid, aid)
    if not action["frames"]:
        raise StoreError("这个动作还没有帧")
    cell = int(action["cellSize"])
    frames: list[Image.Image] = []
    durations: list[int] = []
    for frame in action["frames"]:
        canvas = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
        source = Image.open(frame_path(pid, aid, frame["id"], frame["version"])).convert("RGBA")
        if frame.get("flipX"):
            source = ImageOps.mirror(source)
        dx, dy = frame["offset"]
        canvas.alpha_composite(source, dest=(max(0, dx), max(0, dy)), source=(max(0, -dx), max(0, -dy)))
        frames.append(canvas)
        durations.append(int(frame["duration"]))

    if action.get("playback") == "pingpong" and len(frames) > 2:
        frames += frames[-2:0:-1]
        durations += durations[-2:0:-1]

    box = (0, 0, cell, cell)
    # One shared alpha bounding box preserves motion and never clips a later pose.
    bounds = [b for image in frames if (b := image.getchannel("A").getbbox())]
    if opts.trim and bounds:
        box = (max(0, min(b[0] for b in bounds) - opts.padding),
               max(0, min(b[1] for b in bounds) - opts.padding),
               min(cell, max(b[2] for b in bounds) + opts.padding),
               min(cell, max(b[3] for b in bounds) + opts.padding))
        frames = [image.crop(box) for image in frames]

    meta = {
        "action": aid,
        "label": action.get("label", aid),
        "cellSize": cell,
        "crop": list(box),
        "scale": opts.scale,
        "pixelStep": opts.pixel_step,
        "patina": opts.patina,
        "playback": action.get("playback", "loop"),
    }
    return frames, durations, meta


def to_gif_frames(frames: list[Image.Image], opts: ExportOptions) -> list[Image.Image]:
    """Quantize with one shared palette so colours do not flicker between frames."""
    matte = parse_hex(opts.matte)
    rgb_frames, masks = [], []
    for image in frames:
        rgba = np.asarray(image, dtype=np.uint8)
        alpha = rgba[..., 3:4].astype(np.float32) / 255.0
        flat = rgba[..., :3].astype(np.float32) * alpha + np.array(matte, np.float32) * (1 - alpha)
        rgb_frames.append(Image.fromarray(flat.round().astype(np.uint8), "RGB"))
        masks.append(rgba[..., 3] < opts.alpha_threshold)

    # Build the palette only from pixels that will stay opaque.
    samples = np.concatenate([np.asarray(img)[~mask] for img, mask in zip(rgb_frames, masks)] or [np.zeros((1, 3), np.uint8)])
    if len(samples) == 0:
        samples = np.zeros((1, 3), np.uint8)
    strip = Image.fromarray(samples.reshape(1, -1, 3), "RGB")
    palette_image = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = palette_image.getpalette()[:255 * 3]
    palette += [0] * (255 * 3 - len(palette)) + list(matte)
    palette_image.putpalette(palette)

    result = []
    for image, mask in zip(rgb_frames, masks):
        indexed = image.quantize(palette=palette_image, dither=Image.Dither.NONE)
        pixels = np.asarray(indexed, dtype=np.uint8).copy()
        pixels[mask] = TRANSPARENT_INDEX
        frame = Image.fromarray(pixels, "P")
        frame.putpalette(palette)
        result.append(frame)
    return result


def preview_action(pid: str, aid: str, raw_options: dict) -> dict:
    opts = ExportOptions.parse(raw_options)
    frames, _, _ = render_sequence(pid, aid, opts)
    original = frames
    image = frames[0]
    if opts.format == "gif":
        indexed = to_gif_frames(frames, opts)[0]
        if opts.background == "transparent":
            indexed.info["transparency"] = TRANSPARENT_INDEX
        image = indexed.convert("RGBA")
    def url(frame):
        buffer = io.BytesIO()
        frame.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"original": url(original[0]), "preview": url(image), "width": image.width, "height": image.height}


def export_action(pid: str, aid: str, raw_options: dict) -> dict:
    opts = ExportOptions.parse(raw_options)
    frames, durations, meta = render_sequence(pid, aid, opts)
    out_dir = project_dir(pid) / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    stem = f"{aid}-{stamp}-x{opts.scale}"
    serial = 1
    while list(out_dir.glob(f"{stem}.*")) or list(out_dir.glob(f"{stem}-sheet.*")):
        serial += 1
        stem = f"{aid}-{stamp}-{serial}-x{opts.scale}"
    transparent = opts.background == "transparent"

    if opts.format == "gif":
        path = out_dir / f"{stem}.gif"
        gif_frames = to_gif_frames(frames, opts)
        extra = {"transparency": TRANSPARENT_INDEX, "disposal": 2} if transparent else {"disposal": 1}
        gif_frames[0].save(path, save_all=True, append_images=gif_frames[1:], duration=durations,
                           loop=0, optimize=False, **extra)
    elif opts.format == "webp":
        path = out_dir / f"{stem}.webp"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0,
                       lossless=True, quality=100, method=4, background=(0, 0, 0, 0))
    elif opts.format == "apng":
        path = out_dir / f"{stem}.png"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0,
                       disposal=1, blend=0, default_image=False)
    else:
        path = out_dir / f"{stem}-sheet.png"
        cols = min(len(frames), 8)
        rows = -(-len(frames) // cols)
        w, h = frames[0].size
        sheet = Image.new("RGBA", (cols * w, rows * h), (0, 0, 0, 0))
        cells = []
        for index, (image, duration) in enumerate(zip(frames, durations)):
            x, y = (index % cols) * w, (index // cols) * h
            sheet.alpha_composite(image, (x, y))
            cells.append({"index": index, "x": x, "y": y, "w": w, "h": h, "duration": duration})
        sheet.save(path)
        write_meta = {**meta, "image": path.name, "frameWidth": w, "frameHeight": h, "frames": cells}
        path.with_suffix(".json").write_text(json.dumps(write_meta, ensure_ascii=False, indent=2) + "\n", "utf-8")

    rel = path.relative_to(project_dir(pid))
    return {
        "file": str(Path("studio/projects") / pid / rel),
        "url": f"/files/{pid}/{rel.as_posix()}",
        "bytes": path.stat().st_size,
        "frames": len(frames),
        "width": frames[0].width,
        "height": frames[0].height,
        "totalDuration": sum(durations),
    }
