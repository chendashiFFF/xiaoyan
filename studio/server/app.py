from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import music, characters, store, art, typography
from .store import STUDIO_DIR, StoreError

WEB_DIST = STUDIO_DIR / "web" / "dist"
app = FastAPI(title="Xiaoyan Lyric Studio")
app.include_router(characters.app)
store.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=store.PROJECTS_DIR), name="character-files")


@app.exception_handler(StoreError)
async def store_error(_request: Request, exc: StoreError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def not_found(_request: Request, exc: FileNotFoundError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.get("/api/music/library")
def library() -> dict:
    return music.library()


@app.get("/api/music/document")
def document() -> dict:
    return music.get_document()


@app.put("/api/music/document")
def save_document(doc: music.Document) -> dict:
    return music.save_document(doc)


@app.post("/api/music/uploads/{kind}")
async def upload(kind: str, request: Request, name: str = "upload.png") -> dict:
    limit = (64 if kind == "audio" else 30 if kind == "font" else 12) * 1024 * 1024
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(413, f"文件过大，上限 {limit // 1024 // 1024} MB")
    if not data:
        raise HTTPException(400, "文件为空")
    # Image decoding and ffprobe must not block the async server loop.
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(music.upload, bytes(data), kind, name)


@app.post("/api/music/exports")
def create_export(doc: music.Document) -> dict:
    return music.create_export(doc)


@app.get("/api/music/exports/{jid}")
def export_status(jid: str) -> dict:
    return music.get_export(jid)


@app.post("/api/music/exports/{jid}/cancel")
def cancel_export(jid: str) -> dict:
    music.get_export(jid)
    music.CANCEL[jid].set()
    return music.get_export(jid)


@app.get('/api/music/templates')
def list_templates():
    return music.templates()


@app.post('/api/music/templates')
def save_template(body: dict):
    return music.save_template(body)


@app.post('/api/music/typography')
def typeset(doc: music.Document):
    return typography.Typeset(doc.model_dump(), music.MEDIA).public()


@app.post('/api/music/art')
def create_art(body: dict):
    return art.create(body)


@app.get('/api/music/art/{jid}')
def art_status(jid: str):
    return art.get(jid)


@app.get('/api/music/waveform/{name}')
def waveform(name: str):
    import subprocess
    import array
    source = music.media_path(name)
    music.probe(source)
    result = subprocess.run([music.ffmpeg(), '-v', 'error', '-i', str(source), '-vn', '-ac', '1', '-ar', '2000', '-f', 'f32le', 'pipe:1'], capture_output=True, timeout=30, check=True)
    samples = array.array('f'); samples.frombytes(result.stdout)
    step = max(1, len(samples) // 400)
    peaks = [max(abs(v) for v in samples[i:i+step]) for i in range(0,len(samples),step)]
    peak = max(peaks, default=1) or 1
    return {'peaks': [round(v/peak,3) for v in peaks]}


app.mount('/fonts', StaticFiles(directory=typography.FONTS), name='fonts')
app.mount("/media", StaticFiles(directory=music.MEDIA), name="media")
app.mount("/exports", StaticFiles(directory=music.EXPORTS), name="exports")
if (WEB_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")


@app.get("/", include_in_schema=False)
def index():
    if not (WEB_DIST / "index.html").exists():
        return JSONResponse({"detail": "请先运行 npm run build，或使用 npm run dev 启动开发预览"}, status_code=503)
    return FileResponse(WEB_DIST / "index.html")


@app.get("/characters/", include_in_schema=False)
def character_workshop():
    return FileResponse(WEB_DIST / "characters" / "index.html")


@app.get('/favicon.svg', include_in_schema=False)
def favicon():
    return FileResponse(WEB_DIST / 'favicon.svg', media_type='image/svg+xml')


@app.get("/video/", include_in_schema=False)
def video_page():
    return FileResponse(WEB_DIST / "video" / "index.html")
