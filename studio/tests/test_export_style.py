import base64
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
from studio.server import exporter, store


class ExportStyleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(store, 'PROJECTS_DIR', Path(self.temp.name))
        self.patch.start()
        shutil.copytree(store.STUDIO_DIR / 'projects/xiaoyan', store.PROJECTS_DIR / 'sample',
                        ignore=shutil.ignore_patterns('jobs', 'exports', 'trash'))
        self.aid = store.get_project('sample')['actions'][0]['id']

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_legacy_effects_cannot_change_export_pixels(self):
        raw = {'scale': 2, 'pixelStep': 4, 'patina': 'retro', 'trim': True, 'background': '#ff0000'}
        frames, times, meta = exporter.render_sequence('sample', self.aid, exporter.ExportOptions.parse(raw))
        baseline, baseline_times, _ = exporter.render_sequence('sample', self.aid, exporter.ExportOptions.parse({}))
        self.assertEqual(frames[0].width, meta['crop'][2] - meta['crop'][0])
        self.assertEqual(times, baseline_times)
        for frame, original in zip(frames, baseline):
            self.assertEqual(frame.tobytes(), original.tobytes())
        action = store.get_action('sample', self.aid)
        first = action['frames'][0]
        original = Image.open(store.frame_path('sample', self.aid, first['id'], first['version'])).convert('RGBA')
        if first.get('flipX'):
            original = original.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        expected = Image.new('RGBA', (meta['cellSize'], meta['cellSize']))
        expected.alpha_composite(original, dest=tuple(first['offset']))
        self.assertEqual(frames[0].tobytes(), expected.crop(meta['crop']).tobytes())

    def test_all_formats_preserve_size_and_preview_matches_export(self):
        source = store.PROJECTS_DIR / 'sample/actions' / self.aid
        before = {str(p): p.read_bytes() for p in source.rglob('*') if p.is_file()}
        for fmt in ('gif', 'webp', 'apng', 'sheet'):
            for scale in (.125, .25, .5):
                opts = {'format': fmt, 'scale': scale, 'pixelStep': 2, 'patina': 'light', 'trim': False}
                preview = exporter.preview_action('sample', self.aid, opts)
                result = exporter.export_action('sample', self.aid, opts)
                self.assertEqual((preview['width'], preview['height']), (result['width'], result['height']))
                path = store.PROJECTS_DIR / 'sample/exports' / Path(result['file']).name
                with Image.open(path) as image:
                    actual = image.convert('RGBA').crop((0, 0, result['width'], result['height']))
                    expected = Image.open(io.BytesIO(base64.b64decode(preview['preview'].split(',')[1]))).convert('RGBA')
                    # Fully transparent RGB is immaterial and some codecs clear it.
                    a, b = np.asarray(actual), np.asarray(expected)
                    self.assertTrue(np.array_equal(a[..., 3], b[..., 3]))
                    visible = b[..., 3] > 0
                    self.assertTrue(np.array_equal(a[visible], b[visible]), fmt)
                if fmt == 'sheet':
                    meta = json.loads(path.with_suffix('.json').read_text())
                    self.assertEqual(meta['pixelStep'], 1)
        self.assertEqual(before, {str(p): p.read_bytes() for p in source.rglob('*') if p.is_file()})

    def test_defaults_and_invalid_format(self):
        opts = exporter.ExportOptions.parse({})
        self.assertEqual((opts.scale, opts.trim, opts.pixel_step, opts.patina), (1, True, 1, 'none'))
        with self.assertRaises(store.StoreError):
            exporter.ExportOptions.parse({'format': 'invalid'})

    def test_crop_uses_all_frames_and_preserves_motion(self):
        images = []
        for x, y in [(30, 40), (90, 110)]:
            image = Image.new('RGBA', (256, 256))
            image.paste((100, 50, 20, 180), (x, y, x + 20, y + 30))
            images.append(image)
        action = {'cellSize': 256, 'frames': [{'id': str(i), 'version': 1, 'offset': [0, 0], 'duration': 120} for i in range(2)]}
        with patch.object(exporter, 'get_action', return_value=action), patch.object(exporter.Image, 'open', side_effect=images):
            frames, durations, meta = exporter.render_sequence('sample', 'test', exporter.ExportOptions())
        self.assertEqual(meta['crop'], [22, 32, 118, 148])
        self.assertEqual(durations, [120, 120])
        for source, cropped in zip(images, frames):
            self.assertEqual(cropped.tobytes(), source.crop(meta['crop']).tobytes())
            self.assertEqual(np.asarray(cropped)[..., 3].sum(), np.asarray(source)[..., 3].sum())
