"""Integration checks run entirely in temporary directories; user projects stay untouched."""
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

TEMP = tempfile.TemporaryDirectory()
os.environ['STUDIO_MUSIC_DIR'] = str(Path(TEMP.name) / 'music')
os.environ['STUDIO_SETTINGS_FILE'] = str(Path(TEMP.name) / 'settings.json')
os.environ['STUDIO_PROJECTS_DIR'] = str(Path(TEMP.name) / 'characters')
from PIL import Image
from pydantic import ValidationError
from studio.server import music, store


class MusicTests(unittest.TestCase):
    def test_document_validation_and_roundtrip(self):
        with self.assertRaises(ValidationError):
            music.Document(cues=[music.Cue(id='a', start=0, end=3, text='一'), music.Cue(id='b', start=2, end=4, text='二')])
        doc = music.default_document()
        music.save_document(doc)
        self.assertEqual(music.get_document(), doc.model_dump())
        with self.assertRaises(store.StoreError):
            music.media_path('../document.json')
        with self.assertRaises(ValidationError):
            music.Document(duration=float('nan'))

    def test_image_upload_and_composition(self):
        source = Image.new('RGBA', (50, 100), (220, 30, 100, 255))
        raw = io.BytesIO(); source.save(raw, format='PNG')
        result = music.upload(raw.getvalue(), 'character', 'test.png')
        self.assertIn('透明', result['warning'])
        doc = music.Document(character=result['id'], duration=2, rain=False, cues=[music.Cue(id='a', start=0, end=2, text='雨夜旋律')])
        renderer = music.Renderer(doc)
        renderer.check_text()
        self.assertNotEqual(renderer.frame(0).tobytes(), renderer.frame(1).tobytes())
        self.assertEqual(renderer.frame(1).size, (720, 1280))
        with self.assertRaises(store.StoreError):
            music.upload(b'not an image', 'background', 'bad.png')

    def test_overflow_is_rejected(self):
        doc = music.Document(cues=[music.Cue(id='a', start=0, end=4, text='长歌词' * 50)], fontSize=48)
        with self.assertRaisesRegex(store.StoreError, '放不下'):
            music.Renderer(doc).check_text()

    def test_typography_fonts_and_persistent_themes(self):
        from studio.server.typography import Typeset
        doc = music.Document(title='月光来信', fontId='noto-serif.ttf', textAlign='center', letterSpacing=2,
                             cues=[music.Cue(id='line', start=0, end=3, text='你好，月亮')])
        typeset = Typeset(doc.model_dump(), music.MEDIA)
        self.assertEqual(typeset.missing, [])
        self.assertEqual(typeset.overflow, [])
        payload = typeset.public()
        self.assertTrue(payload['atlas'].startswith('data:image/png;base64,'))
        self.assertEqual(len(payload['layouts']['line']), 5)
        bad = doc.model_copy(update={'cues': [music.Cue(id='bad', start=0, end=3, text='\U0010ffff')]})
        self.assertTrue(Typeset(bad.model_dump(), music.MEDIA).missing)
        item = music.save_template({'name': '月夜', 'style': doc.model_dump()})
        self.assertEqual(music.templates()[-1]['id'], item['id'])
        self.assertEqual(item['style']['fontId'], 'noto-serif.ttf')
        self.assertNotIn('cues', item['style'])

    def test_reference_led_generation_contract_without_billable_calls(self):
        from unittest.mock import patch
        from studio.server import art
        raw = io.BytesIO()
        Image.new('RGBA', (32, 64), (30, 40, 60, 255)).save(raw, format='PNG')
        character = music.upload(raw.getvalue(), 'character', 'reference.png')
        doc = music.Document(character=character['id'])
        calls = []
        def fake_generate(prompt, references, out_dir, log, cancel, config, size='auto'):
            calls.append((prompt, references))
            out_dir.mkdir(parents=True, exist_ok=True)
            output = out_dir / 'result.png'
            Image.new('RGB', (120, 40), '#483a29').save(output)
            return output
        with patch.object(art.settings, 'load', return_value={'api': {'base': 'https://example.invalid', 'key': 'test-only', 'model': 'test-image'}}), patch.object(art.imageapi, 'generate_image', side_effect=fake_generate):
            result = art.create({'document': doc.model_dump(), 'kind': 'panel', 'brief': '月光金边'})
            deadline = time.monotonic() + 5
            while result['status'] in ('queued', 'running') and time.monotonic() < deadline:
                time.sleep(.02); result = art.get(result['id'])
            self.assertEqual(result['status'], 'done', result)
            self.assertEqual(len(calls[0][1]), 2)
            self.assertIn('STYLE REFERENCE', calls[0][0])
            self.assertTrue(music.media_path(result['asset']['id']).is_file())
            self.assertEqual(music.catalog()[-1]['kind'], 'panel')
        with self.assertRaises(store.StoreError):
            music.create_export(doc.model_copy(update={'panelImage': '../secret.png'}))

    def test_http_restored_workshop_and_generation_without_credentials(self):
        from fastapi.testclient import TestClient
        from studio.server.app import app
        client = TestClient(app)
        self.assertEqual(client.get('/api/projects').status_code, 200)
        self.assertEqual(client.get('/api/settings').status_code, 200)
        doc = music.Document().model_dump()
        response = client.post('/api/music/typography', json=doc)
        self.assertEqual(response.status_code, 200, response.text)
        result = client.post('/api/music/art', json={'document': doc, 'brief': '月夜书房', 'kind': 'background'})
        self.assertEqual(result.status_code, 400)
        self.assertIn('API', result.json()['detail'])
        invalid = client.put('/api/music/document', json={**doc, 'dialogY': .84, 'dialogHeight': .3})
        self.assertEqual(invalid.status_code, 422)
        self.assertNotIn('key', client.get('/api/settings').json()['api'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg not installed')
    def test_audio_video_exports_in_both_aspects(self):
        wav = Path(TEMP.name) / 'tone.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', str(wav)], check=True)
        audio = music.upload(wav.read_bytes(), 'audio', 'tone.wav')
        self.assertAlmostEqual(audio['duration'], 1, places=2)
        for aspect, size in [('portrait', (720, 1280)), ('landscape', (1280, 720))]:
            doc = music.Document(duration=1, aspect=aspect, audio=audio['id'], cues=[music.Cue(id='one', start=0, end=1, text='雨夜旋律')])
            job = music.create_export(doc)
            deadline = time.monotonic() + 30
            while job['status'] in ('queued', 'running') and time.monotonic() < deadline:
                time.sleep(.05)
                job = music.get_export(job['id'])
            self.assertEqual(job['status'], 'done', job)
            path = music.EXPORTS / Path(job['url']).name
            info = music.probe(path)
            video = next(s for s in info['streams'] if s['codec_type'] == 'video')
            self.assertEqual((video['width'], video['height']), size)
            self.assertEqual(video['codec_name'], 'h264')
            self.assertTrue(any(s['codec_type'] == 'audio' for s in info['streams']))
            self.assertAlmostEqual(float(info['format']['duration']), 1, delta=.1)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg not installed')
    def test_export_cancellation_and_parallel_guard(self):
        doc = music.Document(duration=30)
        job = music.create_export(doc)
        with self.assertRaisesRegex(store.StoreError, '已有'):
            music.create_export(doc)
        music.CANCEL[job['id']].set()
        for _ in range(100):
            job = music.get_export(job['id'])
            if job['status'] not in ('queued', 'running'):
                break
            time.sleep(.02)
        self.assertEqual(job['status'], 'cancelled')
        self.assertIsNone(job['url'])

if __name__ == '__main__':
    unittest.main()
