"""Reference-led scene generation, backed by the same settings as the character workshop."""
from __future__ import annotations
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from . import imageapi, settings, store

POOL = ThreadPoolExecutor(max_workers=1)
LOCK = threading.RLock()
JOBS = {}


def create(body: dict) -> dict:
    from . import music
    config = settings.load()['api']
    if not config['base'] or not config['key']:
        raise store.StoreError('还没有图片 API 配置。请先打开“生图设置”填写服务地址和密钥；人物工坊也使用这份设置。')
    kind = body.get('kind', 'background')
    if kind not in ('background', 'panel'):
        raise store.StoreError('只能生成背景或对话框')
    doc = music.Document.model_validate(body.get('document', {}))
    music.validate_assets(doc)
    brief = str(body.get('brief', '')).strip()[:2000]
    if not brief:
        raise store.StoreError('请写下你想要的场景')
    character = next((c for c in music.library()['characters'] if c['id'] == doc.character), None)
    if character:
        reference = music.media_path(character['actions'][0]['frames'][0])
    elif doc.character:
        reference = music.media_path(doc.character)
    else:
        raise store.StoreError('请先选择一个人物，让场景有明确的画风参考')
    refs = [reference]
    prompt = f'''Create a production-ready game music video asset. Image 1 is a STYLE REFERENCE of the character, not a person to include in the output. Match its rendering medium, pixel density or line detail, edge treatment, shading and colour harmony. The palette should harmonize with {doc.accentColor}, {doc.panelColor}, {doc.textColor}.
Art direction: {brief}
No letters, words, lyrics, watermark, logos, characters or human silhouettes. Do not include a screenshot, device, application window or a collage. Only deliver the requested asset.'''
    if kind == 'background':
        prompt += '\nDeliver one atmospheric empty environment illustration. Leave the lower centre floor area uncluttered as a standing area for a character composited later. Eye-level camera, readable small-scale game setting. Background only, no dialogue box. Beautiful intentional lighting and a restrained coherent palette. Composition must remain readable cropped to both horizontal and vertical formats.'
    else:
        bg = 'builtin-room.png' if doc.background == 'builtin-room' else doc.background
        refs.append(music.media_path(bg))
        prompt += '\nImage 2 is the environment to harmonize with. Deliver a flat front-facing wide rectangular RPG dialogue panel only, filling the whole canvas. Ornament stays strictly within the outer 10 percent, delicate corners, restrained border. Central 80 percent is an entirely empty flat dark writing area, no symbols or text in it. Wide 3:1 composition. No cast shadow outside, no perspective, no surrounding scene. The panel will be resized by nine-slice scaling, so use straight quiet edge runs.'
    with LOCK:
        if any(j['status'] in ('queued', 'running') for j in JOBS.values()):
            raise store.StoreError('一张场景正在生成，请完成后再试')
        jid = uuid.uuid4().hex
        JOBS[jid] = {'id': jid, 'status': 'queued', 'kind': kind, 'error': None, 'asset': None}
    POOL.submit(generate, jid, prompt, refs, config, kind, brief)
    return get(jid)


def generate(jid: str, prompt: str, refs: list[Path], config: dict, kind: str, brief: str):
    from . import music
    folder = music.ROOT / 'art-jobs' / jid
    folder.mkdir(parents=True, exist_ok=True)
    store.write_json(folder / 'brief.json', {'prompt': prompt, 'references': [str(p.relative_to(music.ROOT)) for p in refs], 'model': config['model']})
    try:
        with LOCK:
            JOBS[jid]['status'] = 'running'
        path = imageapi.generate_image(prompt, refs, folder, folder / 'generation.log', threading.Event(), config, size='1536x1024')
        asset = music.upload(path.read_bytes(), kind, '生成的场景.png' if kind == 'background' else '生成的对话框.png')
        asset['brief'] = brief
        with LOCK:
            JOBS[jid].update(status='done', asset=asset)
    except Exception as exc:
        with LOCK:
            JOBS[jid].update(status='failed', error=str(exc))
    finally:
        store.write_json(folder / 'job.json', get(jid))


def get(jid: str):
    with LOCK:
        if jid not in JOBS:
            raise store.StoreError('生成任务不存在或服务已重启，请到素材库查看已经完成的图片')
        return dict(JOBS[jid])
