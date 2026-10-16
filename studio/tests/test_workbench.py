"""Image tests exercise the original job pipeline with isolated copies of real artwork."""
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from studio.server import store, settings, imageapi, jobs
from studio.server.app import app


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patches = [patch.object(store, 'PROJECTS_DIR', root / 'projects'),
                        patch.object(settings, 'SETTINGS_FILE', root / 'settings.json')]
        for item in self.patches:
            item.start()
        shutil.copytree(store.STUDIO_DIR / 'projects' / 'xiaoyan', store.PROJECTS_DIR / 'xiaoyan',
                        ignore=shutil.ignore_patterns('jobs', 'exports'))
        settings.update({'provider': 'api', 'api': {'base': 'https://example.invalid/v1', 'key': 'test-secret-only'}})
        self.client = TestClient(app)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def wait_job(self, result):
        for _ in range(200):
            job = self.client.get(f"/api/projects/{result['project']}/jobs/{result['job']['id']}").json()
            if job['status'] not in ('queued', 'running'):
                return job
            time.sleep(.02)
        self.fail('image job timed out')

    def test_shared_settings_preserve_key_and_hide_secret(self):
        response = self.client.put('/api/settings', json={'api': {'base': 'https://example.invalid/v1/', 'model': 'image-test', 'key': ''}})
        self.assertEqual(response.status_code, 200)
        saved = self.client.get('/api/settings').json()
        self.assertEqual(saved['api']['model'], 'image-test')
        self.assertEqual(saved['api']['base'], 'https://example.invalid/v1')
        self.assertTrue(saved['api']['hasKey'])
        self.assertNotIn('test-secret-only', response.text)
        self.assertEqual(settings.load()['api']['key'], 'test-secret-only')

    def test_real_frame_pipeline_success_preserves_originals(self):
        before = {str(p): p.read_bytes() for p in (store.PROJECTS_DIR / 'xiaoyan' / 'actions').rglob('*') if p.is_file()}
        def generate(prompt, inputs, work, log, cancel, config, size):
            self.assertIn('preserve this character', prompt)
            self.assertGreaterEqual(len(inputs), 2)
            self.assertTrue(all(p.exists() for p in inputs))
            work.mkdir(parents=True, exist_ok=True)
            output = work / 'image.png'
            shutil.copyfile(inputs[0], output)
            return output
        with patch.object(imageapi, 'generate_image', side_effect=generate) as generator:
            response = self.client.post('/api/settings/test-image', json={'project': 'xiaoyan'})
            self.assertEqual(response.status_code, 200)
            result = response.json()
            job = self.wait_job(result)
            self.assertEqual(job['status'], 'done')
            self.assertEqual(job['accepted'], [])
            generator.assert_called_once()
            output = jobs.job_dir('xiaoyan', job['id']) / job['candidates'][0]['image']
            with Image.open(output) as image:
                image.verify()
        after = {str(p): p.read_bytes() for p in (store.PROJECTS_DIR / 'xiaoyan' / 'actions').rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_generation_failure_is_not_connection_success(self):
        with patch.object(imageapi, 'generate_image', side_effect=imageapi.ImageApiError('生图权限未开启')):
            response = self.client.post('/api/settings/test-image', json={})
            job = self.wait_job(response.json())
            self.assertEqual(job['status'], 'failed')
            self.assertIn('生图权限未开启', job['candidates'][0]['error'])
            self.assertIsNone(job['candidates'][0]['image'])

    def test_original_home_and_separate_video_entry(self):
        root = self.client.get('/')
        video = self.client.get('/video/')
        self.assertEqual(root.status_code, 200)
        self.assertIn('Sprite Studio', root.text)
        self.assertEqual(video.status_code, 200)
        self.assertIn('歌词视频工作台', video.text)
        self.assertFalse((store.STUDIO_DIR.parent / 'src/main.js').exists())
