"""Shared raster typography: preview and MP4 use the very same glyph sheet and positions."""
from __future__ import annotations
import base64
import io
import math
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from .store import STUDIO_DIR, StoreError

FONTS = STUDIO_DIR.parent / 'assets' / 'fonts'
BUILTINS = [
    {'id': 'fusion-pixel.ttf', 'name': '融合像素', 'label': '像素 · 游戏里的温柔', 'family': 'StudioPixel'},
    {'id': 'noto-serif.ttf', 'name': '思源宋体', 'label': '宋体 · 像读一封旧信', 'family': 'StudioSerif'},
]


def font_path(font_id: str, media: Path) -> Path:
    if Path(font_id).name != font_id or font_id.startswith('.'):
        raise StoreError('无效字体')
    path = FONTS / font_id if font_id in {f['id'] for f in BUILTINS} else media / font_id
    if not path.is_file():
        raise StoreError('字体文件不存在，请重新导入')
    return path


@lru_cache(maxsize=32)
def coverage(path: str) -> frozenset:
    with TTFont(path) as font:
        return frozenset(font.getBestCmap() or {})


def import_font(data: bytes, media: Path, uid: str) -> dict:
    try:
        font = TTFont(io.BytesIO(data))
        if 'fvar' in font:
            from fontTools.varLib.instancer import instantiateVariableFont
            instantiateVariableFont(font, {axis.axisTag: axis.defaultValue for axis in font['fvar'].axes}, inplace=True)
        font.flavor = None
        name = font['name'].getDebugName(4) or '自选字体'
        target = media / f'font-{uid}.ttf'
        font.save(target)
        ImageFont.truetype(str(target), 32)
    except Exception as exc:
        raise StoreError('无法读取字体，请使用 TTF / OTF 字体文件') from exc
    return {'id': target.name, 'name': name[:80], 'url': f'/media/{target.name}', 'kind': 'font'}


class Typeset:
    def __init__(self, doc: dict, media: Path):
        self.doc = doc
        w, h = (720, 1280) if doc['aspect'] == 'portrait' else (1280, 720)
        size, padding = doc['fontSize'], doc.get('textPadding', 28)
        self.font_id = doc.get('fontId', 'fusion-pixel.ttf')
        path = font_path(self.font_id, media)
        font = ImageFont.truetype(str(path), size)
        texts = {cue['id']: cue['text'] for cue in doc['cues']}
        texts['__interlude'] = doc['title'] + ' · 间奏'
        texts['__title'] = doc['title']
        chars = list(dict.fromkeys(''.join(texts.values()).replace('\n', '')))
        self.missing = [ch for ch in chars if not ch.isspace() and ord(ch) not in coverage(str(path))]
        stroke = doc.get('textStroke', 0)
        shadow = doc.get('textShadow', False)
        rim = max(6, stroke + 4)
        self.cell = size * 2 + rim * 2
        self.columns = 24
        rows = max(1, math.ceil(len(chars) / self.columns))
        self.variant_y = rows * self.cell
        self.atlas = Image.new('RGBA', (self.columns * self.cell, self.variant_y * 2))
        draw = ImageDraw.Draw(self.atlas)
        self.source = {}
        for i, ch in enumerate(chars):
            x, y = (i % self.columns) * self.cell, (i // self.columns) * self.cell
            self.source[ch] = (x, y)
            for variant, color in enumerate([doc.get('textColor', '#f1e5c9'), doc.get('highlightColor', '#d9bb79')]):
                origin = (x + rim, y + rim + variant * self.variant_y)
                if shadow:
                    draw.text((origin[0] + 2, origin[1] + 3), ch, font=font, fill='#00000099', anchor='lt')
                draw.text(origin, ch, font=font, fill=color, anchor='lt', stroke_width=stroke, stroke_fill=doc.get('strokeColor', '#221b2c'))
        self.layouts = {}
        self.overflow = []
        box_y = h * doc.get('dialogY', .78)
        box_h = h * doc.get('dialogHeight', .19)
        box_x, box_w = w * .035, w * .93
        inner_w = box_w - 2 * padding
        step_y = size * doc.get('lineHeight', 1.6)
        spacing = doc.get('letterSpacing', 1)
        for key, text in texts.items():
            rows_text, line, line_width = [], '', 0
            for ch in text:
                advance = font.getlength(ch) + spacing if ch != '\n' else 0
                if ch == '\n' or (line and line_width + advance - spacing > inner_w):
                    rows_text.append((line, max(0, line_width - spacing)))
                    line, line_width = '', 0
                if ch != '\n':
                    line += ch
                    line_width += advance
            rows_text.append((line, max(0, line_width - spacing)))
            if key not in ('__title', '__interlude') and len(rows_text) * step_y - (step_y - size) > box_h - 2 * padding:
                self.overflow.append(key)
            glyphs = []
            for row, (line, row_width) in enumerate(rows_text):
                align = doc.get('textAlign', 'left')
                x = box_x + padding + (inner_w - row_width) * ({'left': 0, 'center': .5, 'right': 1}[align])
                y = box_y + padding + row * step_y
                for ch in line:
                    sx, sy = self.source[ch]
                    glyphs.append({'sx': sx, 'sy': sy, 'x': round(x - rim), 'y': round(y - rim)})
                    x += font.getlength(ch) + spacing
            self.layouts[key] = glyphs
        # Render the project title from the same exact font; this is a separate strip in the atlas.
        self.title = Image.new('RGBA', (w, 60))
        ImageDraw.Draw(self.title).text((0, 0), doc['title'], font=ImageFont.truetype(str(path), 24), fill=doc.get('accentColor', '#d9bb79'), anchor='lt')

    def public(self) -> dict:
        buf = io.BytesIO(); self.atlas.save(buf, format='PNG')
        title = io.BytesIO(); self.title.save(title, format='PNG')
        return {'atlas': 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode(),
                'title': 'data:image/png;base64,' + base64.b64encode(title.getvalue()).decode(),
                'cell': self.cell, 'variantY': self.variant_y, 'layouts': self.layouts,
                'missing': self.missing[:40], 'overflow': self.overflow}

    def paint(self, canvas: Image.Image, key: str, count: int, mode: str) -> None:
        for i, g in enumerate(self.layouts[key]):
            if mode == 'type' and i >= count:
                continue
            sy = g['sy'] + (self.variant_y if mode == 'highlight' and i < count else 0)
            tile = self.atlas.crop((g['sx'], sy, g['sx'] + self.cell, sy + self.cell))
            canvas.alpha_composite(tile, (g['x'], g['y']))
