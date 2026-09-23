"""Render an action's current frame sequence to GIF / WebP / APNG / sprite sheet."""
from __future__ import annotations

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
    scale: int = 2
    background: str = "transparent"  # "transparent" or "#rrggbb"
    matte: str = "#ffffff"  # GIF only: colour that semi-transparent edges are flattened onto
    alpha_threshold: int = 128  # GIF only: alpha at or above this becomes opaque
    trim: bool = True
    padding: int = 8

    @classmethod
    def parse(cls, raw: dict) -> "ExportOptions":
        opts = cls(
            format=str(raw.get("format", "gif")),
            scale=int(raw.get("scale", 2)),
            background=str(raw.get("background", "transparent")),
            matte=str(raw.get("matte", "#ffffff")),
            alpha_threshold=int(raw.get("alphaThreshold", 128)),
            trim=bool(raw.get("trim", True)),
            padding=int(raw.get("padding", 8)),
        )
        if opts.format not in FORMATS:
            raise StoreError(f"unknown format {opts.format!r}")
        if not 1 <= opts.scale <= 8:
            raise StoreError("scale must be between 1 and 8")
        if opts.background != "transparent":
            parse_hex(opts.background)
        parse_hex(opts.matte)
        opts.alpha_threshold = max(1, min(255, opts.alpha_threshold))
        opts.padding = max(0, min(128, opts.padding))
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
    """Composite every frame with its offset, apply pingpong, trim, and scale."""
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
    if opts.trim:
        union = None
        for image in frames:
            bbox = image.getbbox()
            if bbox:
                union = bbox if union is None else (
                    min(union[0], bbox[0]), min(union[1], bbox[1]), max(union[2], bbox[2]), max(union[3], bbox[3]))
        if union:
            pad = opts.padding
            box = (max(0, union[0] - pad), max(0, union[1] - pad), min(cell, union[2] + pad), min(cell, union[3] + pad))
    frames = [image.crop(box) for image in frames]
    if opts.scale != 1:
        size = (frames[0].width * opts.scale, frames[0].height * opts.scale)
        frames = [image.resize(size, Image.NEAREST) for image in frames]

    if opts.background != "transparent":
        color = parse_hex(opts.background)
        flattened = []
        for image in frames:
            base = Image.new("RGBA", image.size, (*color, 255))
            base.alpha_composite(image)
            flattened.append(base)
        frames = flattened

    meta = {
        "action": aid,
        "label": action.get("label", aid),
        "cellSize": cell,
        "crop": list(box),
        "scale": opts.scale,
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
