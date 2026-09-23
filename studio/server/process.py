"""Image plumbing between studio frames and Codex image generation."""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageOps

MAGENTA = np.array([255, 0, 255], np.float32)
CANVAS_TARGET = 1024
Rect = tuple[int, int, int, int]


def oriented(image: Image.Image, flip: bool) -> Image.Image:
    image = image.convert("RGBA")
    return ImageOps.mirror(image) if flip else image


def shifted(image: Image.Image, dx: int, dy: int) -> Image.Image:
    canvas = Image.new("RGBA", image.size, (0, 0, 0, 0))
    canvas.alpha_composite(image, dest=(max(0, dx), max(0, dy)), source=(max(0, -dx), max(0, -dy)))
    return canvas


def canvas_factor(cell: int) -> int:
    return max(1, CANVAS_TARGET // cell)


def magenta_canvas(image: Image.Image, cell: int) -> Image.Image:
    """Upscale a cell-sized frame (nearest) and flatten it onto solid magenta for the image model."""
    factor = canvas_factor(cell)
    big = image.resize((cell * factor, cell * factor), Image.NEAREST)
    base = Image.new("RGBA", big.size, (255, 0, 255, 255))
    base.alpha_composite(big)
    return base.convert("RGB")


def guide_canvas(image: Image.Image, cell: int, rect: Rect) -> Image.Image:
    """Same as magenta_canvas but with the region to change outlined in green."""
    factor = canvas_factor(cell)
    base = magenta_canvas(image, cell)
    draw = ImageDraw.Draw(base)
    x0, y0, x1, y1 = (v * factor for v in rect)
    width = max(3, factor * 2)
    draw.rectangle([x0 - width, y0 - width, x1 + width - 1, y1 + width - 1], outline=(0, 255, 64), width=width)
    return base


def extract_alpha(raw: Image.Image) -> Image.Image:
    """Keep real transparency when the model produced it, otherwise key out the magenta background."""
    rgba = raw.convert("RGBA")
    data = np.asarray(rgba).astype(np.float32)
    if (data[..., 3] < 250).mean() > 0.02:
        return rgba
    rgb = data[..., :3]
    distance = np.sqrt(((rgb - MAGENTA) ** 2).sum(-1))
    alpha = np.clip((distance - 70.0) / 90.0, 0.0, 1.0)
    # Un-mix the magenta that bled into anti-aliased edges: observed = a*F + (1-a)*M.
    safe = np.maximum(alpha, 1e-3)[..., None]
    unmixed = np.clip((rgb - (1 - alpha)[..., None] * MAGENTA) / safe, 0, 255)
    rgb = np.where((alpha > 0)[..., None] & (alpha < 1)[..., None], unmixed, rgb)
    out = np.dstack([rgb, alpha * 255]).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def square(image: Image.Image) -> Image.Image:
    if image.width == image.height:
        return image
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def resize_rgba(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Resize in premultiplied space so transparent pixels do not darken the edges.
    return image.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")


def solid_mask(image: Image.Image) -> np.ndarray:
    return np.asarray(image)[..., 3] >= 128


def mass_x(mask: np.ndarray) -> float:
    xs = np.nonzero(mask)[1]
    return float(xs.mean()) if len(xs) else mask.shape[1] / 2


def bottom(mask: np.ndarray) -> int:
    ys = np.nonzero(mask.any(axis=1))[0]
    return int(ys[-1]) if len(ys) else mask.shape[0] - 1


def match_scale(candidate: Image.Image, original: Image.Image) -> Image.Image:
    """Rescale when the model zoomed in or out. Solid area is a pose-independent size measure."""
    area_c = int(solid_mask(candidate).sum())
    area_o = int(solid_mask(original).sum())
    if not area_c or not area_o:
        return candidate
    scale = math.sqrt(area_o / area_c)
    if abs(scale - 1) <= 0.08:
        return candidate
    bbox = candidate.getbbox()
    if not bbox:
        return candidate
    body = candidate.crop(bbox)
    body = resize_rgba(body, (max(1, round(body.width * scale)), max(1, round(body.height * scale))))
    canvas = Image.new("RGBA", candidate.size, (0, 0, 0, 0))
    centre = (bbox[0] + bbox[2]) / 2
    # Keep the feet where they were; paste() clips anything that falls outside the cell.
    canvas.paste(body, (round(centre - body.width / 2), bbox[3] - body.height))
    return canvas


def premultiplied(image: Image.Image) -> np.ndarray:
    data = np.asarray(image).astype(np.float32)
    alpha = data[..., 3:4] / 255.0
    return np.dstack([data[..., :3] * alpha, data[..., 3:4]])


def best_shift(candidate: Image.Image, original: Image.Image, keep: np.ndarray, radius: int = 16) -> tuple[int, int]:
    """Integer shift of `candidate` that best matches `original` on the pixels that must not change."""
    cand = premultiplied(candidate)
    orig = premultiplied(original)
    h, w = keep.shape

    def cost(dx: int, dy: int) -> float:
        ys0, ys1 = max(0, dy), min(h, h + dy)
        xs0, xs1 = max(0, dx), min(w, w + dx)
        moved = np.zeros_like(cand)
        moved[ys0:ys1, xs0:xs1] = cand[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
        region = keep & ((moved[..., 3] > 8) | (orig[..., 3] > 8))
        if not region.any():
            return float("inf")
        return float(np.abs(moved[region] - orig[region]).mean())

    best = min(((cost(dx, dy), dx, dy) for dy in range(-radius, radius + 1, 2) for dx in range(-radius, radius + 1, 2)))
    _, bx, by = best
    refined = min(((cost(dx, dy), dx, dy) for dy in range(by - 2, by + 3) for dx in range(bx - 2, bx + 3)))
    return refined[1], refined[2]


def feather_mask(shape: tuple[int, int], rect: Rect, feather: float = 3.0) -> np.ndarray:
    h, w = shape
    x0, y0, x1, y1 = rect
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    inside = np.minimum.reduce([xs - x0 + 0.5, x1 - 0.5 - xs, ys - y0 + 0.5, y1 - 0.5 - ys])
    return np.clip(inside / feather + 0.5, 0.0, 1.0)


def composite(candidate: Image.Image, original: Image.Image, mask: np.ndarray) -> Image.Image:
    cand = premultiplied(candidate)
    orig = premultiplied(original)
    m = mask[..., None]
    mixed = cand * m + orig * (1 - m)
    alpha = mixed[..., 3:4]
    rgb = np.where(alpha > 0, mixed[..., :3] / np.maximum(alpha, 1e-3) * 255.0, 0)
    out = np.dstack([np.clip(rgb, 0, 255), alpha]).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def drop_faint(image: Image.Image) -> Image.Image:
    data = np.asarray(image).copy()
    data[..., 3][data[..., 3] < 8] = 0
    return Image.fromarray(data, "RGBA")


def prepare(raw: Image.Image, cell: int) -> Image.Image:
    candidate = drop_faint(resize_rgba(square(extract_alpha(raw)), (cell, cell)))
    if not solid_mask(candidate).any():
        raise ValueError("生成的图片里没有找到角色")
    return candidate


def move_to(image: Image.Image, target_x: float, target_bottom: int) -> Image.Image:
    mask = solid_mask(image)
    return shifted(image, round(target_x - mass_x(mask)), target_bottom - bottom(mask))


def normalize_candidate(raw: Image.Image, cell: int, original: Image.Image, kind: str, rect: Rect | None = None) -> Image.Image:
    """Turn a generated image into a cell-sized frame lined up with `original` (both in displayed orientation)."""
    candidate = match_scale(prepare(raw, cell), original)

    if kind == "repair" and rect:
        x0, y0, x1, y1 = rect
        keep = np.ones((cell, cell), bool)
        keep[max(0, y0 - 6):y1 + 6, max(0, x0 - 6):x1 + 6] = False
        dx, dy = best_shift(candidate, original, keep)
        return composite(shifted(candidate, dx, dy), original, feather_mask((cell, cell), rect))

    orig_mask = solid_mask(original)
    if not orig_mask.any():
        return candidate
    return move_to(candidate, mass_x(orig_mask), bottom(orig_mask))
