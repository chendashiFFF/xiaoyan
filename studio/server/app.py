from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import codex, exporter, jobs, store
from .store import STUDIO_DIR, StoreError

WEB_DIST = STUDIO_DIR / "web" / "dist"
MAX_UPLOAD = 32 * 1024 * 1024

app = FastAPI(title="Xiaoyan Sprite Studio")
jobs.recover_interrupted()
_codex_version = codex.codex_version()


@app.exception_handler(StoreError)
async def store_error(_request: Request, exc: StoreError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def not_found(_request: Request, exc: FileNotFoundError) -> JSONResponse:
    return JSONResponse({"detail": f"not found: {exc}"}, status_code=404)


@app.get("/api/projects")
def list_projects() -> list[dict]:
    return store.list_projects()


@app.get("/api/projects/{pid}")
def get_project(pid: str) -> dict:
    return store.get_project(pid)


@app.get("/api/projects/{pid}/actions/{aid}")
def get_action(pid: str, aid: str) -> dict:
    return store.get_action(pid, aid)


@app.put("/api/projects/{pid}/actions/{aid}")
async def save_action(pid: str, aid: str, request: Request) -> dict:
    return store.save_action(pid, aid, await request.json())


@app.post("/api/projects/{pid}/actions/{aid}/frames/{fid}/duplicate")
async def duplicate_frame(pid: str, aid: str, fid: str, request: Request) -> dict:
    body = await request.json()
    return store.duplicate_frame(pid, aid, fid, int(body.get("version", 1)))


@app.post("/api/projects/{pid}/actions/{aid}/frames/{fid}/versions")
async def upload_version(pid: str, aid: str, fid: str, request: Request) -> dict:
    data = await request.body()
    if not data:
        raise HTTPException(400, "empty upload")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "image too large")
    return {"version": store.add_frame_version(pid, aid, fid, data)}


@app.post("/api/projects/{pid}/actions/{aid}/export")
async def export_action(pid: str, aid: str, request: Request) -> dict:
    return exporter.export_action(pid, aid, await request.json())


@app.get("/api/codex")
def codex_status() -> dict:
    return {"available": _codex_version is not None, "version": _codex_version, "model": codex.DEFAULT_MODEL}


@app.post("/api/projects/{pid}/actions/{aid}/frames/{fid}/jobs")
async def create_job(pid: str, aid: str, fid: str, request: Request) -> dict:
    return jobs.create_job(pid, aid, fid, await request.json())


@app.get("/api/projects/{pid}/actions/{aid}/jobs")
def list_jobs(pid: str, aid: str) -> list[dict]:
    return jobs.list_jobs(pid, aid)


@app.get("/api/projects/{pid}/jobs/{jid}")
def get_job(pid: str, jid: str) -> dict:
    return jobs.get_job(pid, jid)


@app.post("/api/projects/{pid}/jobs/{jid}/cancel")
def cancel_job(pid: str, jid: str) -> dict:
    return jobs.cancel_job(pid, jid)


@app.post("/api/projects/{pid}/jobs/{jid}/review")
async def review_job(pid: str, jid: str, request: Request) -> dict:
    body = await request.json()
    return jobs.set_reviewed(pid, jid, bool(body.get("reviewed", True)))


@app.post("/api/projects/{pid}/jobs/{jid}/candidates/{n}/accept")
def accept_candidate(pid: str, jid: str, n: int) -> dict:
    return jobs.accept_candidate(pid, jid, n)


store.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=store.PROJECTS_DIR), name="files")

if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
