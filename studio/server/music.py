"""Local lyric-video documents, reusable character frames, and deterministic MP4 rendering."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps
from pydantic import BaseModel, Field, model_validator
from typing import Literal

from . import store, typography
from .exporter import ExportOptions, render_sequence

ROOT = Path(os.environ.get("STUDIO_MUSIC_DIR", store.STUDIO_DIR / "music"))
MEDIA = ROOT / "media"
EXPORTS = ROOT / "exports"
for folder in (ROOT, MEDIA, EXPORTS):
    folder.mkdir(parents=True, exist_ok=True)
LOCK = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=1)
JOBS: dict[str, dict] = {}
CANCEL: dict[str, threading.Event] = {}
LIBRARY: dict | None = None
FPS = 24


class Cue(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    start: float = Field(ge=0, le=600, allow_inf_nan=False)
    end: float = Field(gt=0, le=600, allow_inf_nan=False)
    text: str = Field(max_length=160)
    action: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def timing(self):
        if self.end <= self.start:
            raise ValueError("每句结束时间必须晚于开始时间")
        return self


class Document(BaseModel):
    version: Literal[1] = 1
    title: str = Field(default="雨夜来信", min_length=1, max_length=60)
    duration: float = Field(default=16, ge=0.2, le=600, allow_inf_nan=False)
    aspect: Literal["portrait", "landscape"] = "portrait"
    background: str = "builtin-room"
    character: str = ""
    audio: str = ""
    audioName: str = ""
    characterX: float = Field(default=0.50, ge=0.05, le=0.95, allow_inf_nan=False)
    characterY: float = Field(default=0.73, ge=0.25, le=0.79, allow_inf_nan=False)
    characterScale: float = Field(default=0.42, ge=0.15, le=0.65, allow_inf_nan=False)
    skin: Literal["cream", "night", "pixel", "ornate", "paper"] = "cream"
    reveal: Literal["type", "line", "highlight"] = "type"
    fontSize: int = Field(default=32, ge=20, le=48)
    rain: bool = True
    theme: str = 'moon'
    fontId: str = 'fusion-pixel.ttf'
    letterSpacing: float = Field(default=0, ge=-1, le=8)
    lineHeight: float = Field(default=1.6, ge=1.1, le=2.2)
    textAlign: Literal['left', 'center', 'right'] = 'left'
    textColor: str = Field(default='#f1e5c9', pattern=r'^#[0-9a-fA-F]{6}$')
    highlightColor: str = Field(default='#d9bb79', pattern=r'^#[0-9a-fA-F]{6}$')
    panelColor: str = Field(default='#242a29', pattern=r'^#[0-9a-fA-F]{6}$')
    accentColor: str = Field(default='#bca779', pattern=r'^#[0-9a-fA-F]{6}$')
    strokeColor: str = Field(default='#221b2c', pattern=r'^#[0-9a-fA-F]{6}$')
    textStroke: int = Field(default=0, ge=0, le=3)
    textShadow: bool = False
    textPadding: int = Field(default=30, ge=18, le=70)
    dialogY: float = Field(default=.78, ge=.60, le=.84)
    dialogHeight: float = Field(default=.19, ge=.12, le=.30)
    panelImage: str = ''
    atmosphere: Literal['rain', 'snow', 'fireflies', 'dust', 'none'] = 'rain'
    cameraMotion: bool = False
    lightPulse: bool = True
    motionAmount: float = Field(default=.5, ge=0, le=1)
    cues: list[Cue] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def valid_cues(self):
        if self.dialogY + self.dialogHeight > .99:
            raise ValueError('对话框不能超出画面底部')
        previous = 0.0
        ids = set()
        for cue in self.cues:
            if cue.id in ids:
                raise ValueError("歌词编号重复")
            ids.add(cue.id)
            if cue.start < previous - 0.001:
                raise ValueError("歌词时间不能重叠，请按顺序排列")
            if cue.end > self.duration + 0.001:
                raise ValueError("歌词结束时间不能超过视频时长")
            previous = cue.end
        return self


def media_path(name: str) -> Path:
    # References are opaque filenames returned by the upload/library endpoints.
    if not name or Path(name).name != name or name.startswith("."):
        raise store.StoreError("无效素材路径")
    path = MEDIA / name
    if not path.is_file():
        raise store.StoreError("素材文件不存在，请重新导入")
    return path


def ffmpeg() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise store.StoreError("导出需要 FFmpeg，请先安装 FFmpeg 后重新启动工作台")
    return binary


def probe(path: Path) -> dict:
    binary = shutil.which("ffprobe")
    if not binary:
        raise store.StoreError("导入歌曲需要 FFmpeg（包含 ffprobe）")
    result = subprocess.run([binary, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)], capture_output=True, timeout=20)
    if result.returncode:
        raise store.StoreError("无法读取这首歌曲，请使用 MP3、WAV、M4A、OGG 或 FLAC")
    data = json.loads(result.stdout)
    if not any(s.get("codec_type") == "audio" for s in data.get("streams", [])):
        raise store.StoreError("文件中没有音轨")
    return data


def catalog() -> list:
    path = ROOT / 'catalog.json'
    return store.read_json(path) if path.exists() else []


def register(asset: dict, kind: str) -> dict:
    with LOCK:
        rows = catalog()
        rows.append({**asset, 'kind': kind})
        store.write_json(ROOT / 'catalog.json', rows)
    return asset


def upload(data: bytes, kind: str, name: str) -> dict:
    if kind not in ("audio", "background", "character", "font", "panel"):
        raise store.StoreError("不支持的素材类型")
    uid = uuid.uuid4().hex
    if kind == 'font':
        return register(typography.import_font(data, MEDIA, uid), kind)
    if kind == "audio":
        ext = Path(name).suffix.lower()
        if ext not in (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".webm"):
            raise store.StoreError("请选择 MP3、WAV、M4A、OGG、FLAC 或 AAC 音频")
        path = MEDIA / f"{uid}{ext}"
        path.write_bytes(data)
        try:
            info = probe(path)
            duration = float(info["format"]["duration"])
            if not math.isfinite(duration) or not 0.2 <= duration <= 600:
                raise store.StoreError("首版支持 0.2 秒至 10 分钟的歌曲")
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return {"id": path.name, "name": name, "duration": duration, "url": f"/media/{path.name}"}
    try:
        source = Image.open(io.BytesIO(data))
        if source.width * source.height > 20_000_000:
            raise store.StoreError("图片不能超过 2000 万像素")
        source.load()
        source = ImageOps.exif_transpose(source).convert("RGBA")
    except store.StoreError:
        raise
    except Exception as exc:
        raise store.StoreError("无法读取图片，请使用 PNG、JPEG 或 WebP") from exc
    warning = None
    if kind == "character":
        if source.getextrema()[3][0] == 255:
            warning = "这张人物图没有透明背景，背景也会显示；建议使用透明 PNG。"
        box = source.getbbox()
        if not box:
            raise store.StoreError("人物图片完全透明")
        source = source.crop(box)
    source.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
    path = MEDIA / f"{uid}.png"
    source.save(path)
    return register({"id": path.name, "name": name, "url": f"/media/{path.name}", "warning": warning}, kind)


def make_room() -> None:
    target = MEDIA / "builtin-room.png"
    if target.exists():
        return
    # A code-drawn, reusable pixel scene. Character, rain and dialogue remain separate layers.
    im = Image.new("RGB", (360, 480), "#201c36")
    d = ImageDraw.Draw(im)
    d.rectangle((0, 350, 360, 480), fill="#302139")
    for y in range(358, 480, 20):
        d.line((0, y, 360, y), fill="#473047", width=2)
    d.rectangle((18, 40, 162, 247), fill="#100f21", outline="#665276", width=5)
    d.rectangle((27, 49, 153, 237), fill="#262746")
    d.ellipse((107, 66, 125, 84), fill="#e9dcb7")
    for x, y, w in [(29, 168, 25), (56, 145, 22), (82, 187, 18), (103, 155, 25), (132, 175, 20)]:
        d.rectangle((x, y, x + w, 235), fill="#171627")
        for xx in range(x + 5, x + w - 3, 9):
            for yy in range(y + 10, 227, 16):
                if (xx + yy) % 3:
                    d.rectangle((xx, yy, xx + 3, yy + 5), fill="#d6b678")
    d.rectangle((89, 48, 93, 240), fill="#574567")
    d.rectangle((23, 142, 157, 146), fill="#574567")
    d.rectangle((11, 244, 170, 253), fill="#7d5a77")
    d.rectangle((224, 68, 348, 76), fill="#9a7379")
    for x in (230, 258):
        d.rectangle((x, 43, x + 23, 66), fill="#69576d")
        d.rectangle((x + 3, 48, x + 20, 55), fill="#282034")
        d.line((x + 4, 61, x + 18, 61), fill="#c0a0a0", width=2)
    d.rectangle((312, 46, 328, 66), fill="#c49c8a")
    for x, y in ((304, 36), (318, 27), (324, 37)):
        d.rectangle((x, y, x + 9, y + 13), fill="#718875")
    d.rectangle((258, 117, 306, 176), fill="#765578", outline="#141220", width=4)
    d.rectangle((266, 125, 298, 168), fill="#30233f")
    d.line((270, 156, 281, 140, 291, 151), fill="#b595b2", width=3)
    d.polygon(((297, 244), (248, 322), (350, 322)), fill="#55403e")
    d.rectangle((220, 314, 359, 329), fill="#ac817b")
    d.rectangle((225, 329, 235, 413), fill="#684453")
    d.rectangle((342, 329, 353, 420), fill="#684453")
    d.line((322, 314, 322, 247, 302, 230), fill="#9c8691", width=5)
    d.polygon(((290, 231), (309, 232), (318, 248), (279, 248)), fill="#ddbd85")
    d.rectangle((244, 293, 256, 313), fill="#43364e", outline="#d6ae90", width=2)
    d.rectangle((271, 307, 298, 314), fill="#baa4c9")
    im.save(target)


def character_library() -> dict:
    global LIBRARY
    with LOCK:
        if LIBRARY is not None:
            return LIBRARY
        make_room()
        characters = []
        for project in store.list_projects():
            actions = []
            for summary in store.get_project(project["id"])["actions"]:
                if not summary["frameCount"]:
                    continue
                aid = summary["id"]
                action = store.get_action(project["id"], aid)
                signature = json.dumps(action, sort_keys=True) + project["id"]
                for f in action["frames"]:
                    stat = store.frame_path(project["id"], aid, f["id"], f["version"]).stat()
                    signature += f"{stat.st_mtime_ns}-{stat.st_size}"
                key = hashlib.sha256(signature.encode()).hexdigest()[:20]
                frames, durations, _ = render_sequence(project["id"], aid, ExportOptions(scale=1, padding=0))
                names = []
                for n, frame in enumerate(frames):
                    name = f"sprite-{key}-{n}.png"
                    if not (MEDIA / name).exists():
                        frame.save(MEDIA / name)
                    names.append(name)
                actions.append({"id": f"{project['id']}:{aid}", "label": summary["label"], "frames": names, "durations": durations})
            if not actions:
                metadata = store.get_project(project['id'])
                identity = metadata.get('identityReference')
                reference = store.project_dir(project['id']) / identity if identity else None
                if reference and reference.is_file():
                    key = hashlib.sha256(reference.read_bytes()).hexdigest()[:20]
                    name = f'portrait-{key}.png'
                    if not (MEDIA / name).exists():
                        image = Image.open(reference).convert('RGBA')
                        image.crop(image.getbbox() or (0, 0, *image.size)).save(MEDIA / name)
                    actions.append({'id': project['id'] + ':reference', 'label': '静态立绘', 'frames': [name], 'durations': [1000]})
            if actions:
                characters.append({"id": project["id"], "name": project["name"], "actions": actions})
        LIBRARY = {"characters": characters, "backgrounds": [{"id": "builtin-room", "name": "雨夜 · 小小房间", "file": "builtin-room.png"}], "canExport": bool(shutil.which("ffmpeg")), "fps": FPS}
        return LIBRARY


def library() -> dict:
    global LIBRARY
    # Character workshop edits become visible without restarting the video server.
    signature = [(str(p), p.stat().st_mtime_ns) for pattern in ('*/actions/*/action.json', '*/project.json', '*/references/*') for p in sorted(store.PROJECTS_DIR.glob(pattern)) if p.is_file()]
    current = hashlib.sha256(repr(signature).encode()).hexdigest()
    with LOCK:
        if getattr(library, '_signature', None) != current:
            LIBRARY = None
            library._signature = current
        base = character_library()
    rows = catalog()
    for filename, name, kind in [('moon-study.png', '月下书房 · 配套背景', 'background'), ('moon-panel.png', '月下书房 · 金色花枝对话框', 'panel')]:
        source = store.STUDIO_DIR.parent / 'assets' / 'scenes' / filename
        if source.exists():
            destination = MEDIA / ('theme-' + filename)
            if not destination.exists() or source.stat().st_mtime_ns > destination.stat().st_mtime_ns:
                shutil.copy2(source, destination)
            rows.insert(0, {'id': destination.name, 'name': name, 'kind': kind, 'url': '/media/' + destination.name})
    return {**base, 'assets': rows, 'fonts': typography.BUILTINS + [a for a in rows if a['kind'] == 'font'],
            'themes': store.read_json(store.STUDIO_DIR.parent / 'assets' / 'themes.json')}


def action_map() -> dict:
    return {a["id"]: a for c in library()["characters"] for a in c["actions"]}


def validate_assets(doc: Document) -> None:
    typography.font_path(doc.fontId, MEDIA)
    if doc.panelImage:
        media_path(doc.panelImage)
    if doc.background != "builtin-room":
        media_path(doc.background)
    chars = {c["id"] for c in library()["characters"]}
    if doc.character and doc.character not in chars:
        media_path(doc.character)
    if doc.audio:
        path = media_path(doc.audio)
        source_duration = float(probe(path)["format"]["duration"])
        if doc.duration > source_duration + 0.1:
            raise store.StoreError("视频时长不能超过歌曲时长")
    actions = action_map()
    for cue in doc.cues:
        if cue.action and (cue.action not in actions or not cue.action.startswith(doc.character + ":")):
            raise store.StoreError("歌词引用的动作不属于当前人物，请重新选择")


def default_document() -> Document:
    chars = library()["characters"]
    character = chars[0]["id"] if chars else ""
    return Document(character=character, background='theme-moon-study.png' if (MEDIA / 'theme-moon-study.png').exists() else 'builtin-room', panelImage='theme-moon-panel.png' if (MEDIA / 'theme-moon-panel.png').exists() else '', theme='moon', fontId='noto-serif.ttf', skin='ornate', atmosphere='fireflies', cameraMotion=True, letterSpacing=2, rain=False, cues=[Cue(id=f"cue-{i}", start=i * 4, end=i * 4 + 4, text=s) for i, s in enumerate(["小小房间里，雨声淅沥", "窗外的灯，陪我等你", "把回忆，唱成旋律", "让晚风，把心事带给你"])])


def get_document() -> dict:
    path = ROOT / "document.json"
    if path.exists():
        return Document.model_validate(store.read_json(path)).model_dump()
    return default_document().model_dump()


def save_document(doc: Document) -> dict:
    validate_assets(doc)
    with LOCK:
        store.write_json(ROOT / "document.json", doc.model_dump())
    return {"savedAt": int(time.time())}


class Renderer:
    def __init__(self, doc: Document, size: tuple[int, int] | None = None):
        self.doc = doc
        self.w, self.h = (720, 1280) if doc.aspect == 'portrait' else (1280, 720)
        self.typeset = typography.Typeset(doc.model_dump(), MEDIA)
        self.background = Image.open(media_path('builtin-room.png' if doc.background == 'builtin-room' else doc.background)).convert('RGBA')
        self.panel = Image.open(media_path(doc.panelImage)).convert('RGBA') if doc.panelImage else None
        self.actions = action_map()
        self.images = {}
        for character in library()['characters']:
            if character['id'] == doc.character:
                for action in character['actions']:
                    for name in action['frames']:
                        self.images[name] = Image.open(media_path(name)).convert('RGBA')
        if doc.character and not self.images:
            self.images[doc.character] = Image.open(media_path(doc.character)).convert('RGBA')
        choices = [a for a in self.actions.values() if a['id'].startswith(doc.character + ':')]
        self.default_action = next((a for a in choices if a['id'].endswith(':idle')), None) or next(iter(choices), None)

    def check_text(self):
        if self.typeset.missing:
            raise store.StoreError('所选字体缺少这些字：' + ''.join(self.typeset.missing[:20]) + '。请换一种字体。')
        if self.typeset.overflow:
            raise store.StoreError('部分歌词放不下，请拆句、减小字号或增大对话框。')

    def frame(self, t: float) -> Image.Image:
        from .visual import paint_scene
        return paint_scene(self, t)


def create_export(doc: Document) -> dict:
    ffmpeg()
    validate_assets(doc)
    Renderer(doc).check_text()
    with LOCK:
        if any(j["status"] in ("queued", "running") for j in JOBS.values()):
            raise store.StoreError("已有视频正在导出，请等待完成或先取消")
        jid = uuid.uuid4().hex
        JOBS[jid] = {"id": jid, "status": "queued", "progress": 0, "url": None, "error": None}
        CANCEL[jid] = threading.Event()
    POOL.submit(run_export, jid, doc.model_copy(deep=True))
    return dict(JOBS[jid])


def get_export(jid: str) -> dict:
    with LOCK:
        if jid not in JOBS:
            raise FileNotFoundError("导出任务不存在，服务可能已重启；已完成视频仍保存在 studio/music/exports")
        return dict(JOBS[jid])


def run_export(jid: str, doc: Document) -> None:
    target = EXPORTS / f"mv-{jid}.mp4"
    partial = EXPORTS / f".mv-{jid}.mp4"
    log = EXPORTS / f".mv-{jid}.log"
    proc = None
    try:
        with LOCK:
            JOBS[jid]["status"] = "running"
        renderer = Renderer(doc)
        count = math.ceil(doc.duration * FPS)
        args = [ffmpeg(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{renderer.w}x{renderer.h}", "-r", str(FPS), "-i", "pipe:0"]
        if doc.audio:
            args += ["-i", str(media_path(doc.audio)), "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-t", str(doc.duration), "-movflags", "+faststart", str(partial)]
        with log.open("wb") as stderr:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=stderr)
            for n in range(count):
                if CANCEL[jid].is_set():
                    raise InterruptedError("已取消导出")
                proc.stdin.write(renderer.frame(n / FPS).tobytes())
                if n % 6 == 0:
                    with LOCK:
                        JOBS[jid]["progress"] = round((n + 1) / count * 97)
            proc.stdin.close()
            proc.wait(timeout=90)
        if proc.returncode:
            raise RuntimeError(log.read_text(errors="replace")[-1000:] or "视频编码失败")
        if CANCEL[jid].is_set():
            raise InterruptedError("已取消导出")
        partial.replace(target)
        with LOCK:
            JOBS[jid].update(status="done", progress=100, url=f"/exports/{target.name}")
    except Exception as exc:
        with LOCK:
            JOBS[jid].update(status="cancelled" if isinstance(exc, InterruptedError) else "failed", error=str(exc))
    finally:
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        if proc and proc.stdin and not proc.stdin.closed:
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
        partial.unlink(missing_ok=True)
        log.unlink(missing_ok=True)


def templates() -> list:
    path = ROOT / 'templates.json'
    return store.read_json(path) if path.exists() else []


def save_template(body: dict) -> dict:
    name = str(body.get('name', '')).strip()[:60]
    if not name:
        raise store.StoreError('请为主题起个名字')
    doc = Document.model_validate(body.get('style', {}))
    doc.audio = ''; doc.cues = []
    validate_assets(doc)
    style = doc.model_dump(exclude={'audio', 'audioName', 'cues', 'title', 'duration'})
    item = {'name': name, 'style': style, 'id': uuid.uuid4().hex}
    with LOCK:
        rows = templates(); rows.append(item)
        store.write_json(ROOT / 'templates.json', rows)
    return item
