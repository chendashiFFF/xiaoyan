import unittest
import numpy as np
from PIL import Image
from studio.server import jobs, process


class PixelStyleTests(unittest.TestCase):
    def test_sprite_resizing_does_not_add_colours_or_partial_alpha(self):
        data = np.array([[[24, 32, 48, 255], [230, 180, 80, 255]],
                         [[0, 0, 0, 0], [90, 65, 45, 255]]], dtype=np.uint8)
        source = Image.fromarray(data)
        palette = set(map(tuple, data.reshape(-1, 4)))
        for size in [(11, 13), (1, 1)]:
            result = np.asarray(process.resize_rgba(source, size))
            self.assertLessEqual(set(map(tuple, result.reshape(-1, 4))), palette)

    def test_all_action_operations_lock_reference_pixel_style(self):
        for kind in ('keyposes', 'redraw', 'repair', 'inbetween'):
            prompt = jobs.build_prompt(kind, 'jump', 'test', ['reference'], {'grid': [2, 2]})
            self.assertIn(jobs.PIXEL_STYLE, prompt)
            self.assertIn('pixel size relative to the character', prompt)

    def test_sheet_frames_keep_hard_edges(self):
        sheet = Image.new('RGBA', (64, 32), (255, 0, 255, 255))
        for x in (10, 42):
            for y in range(8, 28):
                for xx in range(x, x + 10):
                    sheet.putpixel((xx, y), (40, 65, 90, 255))
        frames = process.split_sheet(sheet, 1, 2, 32, True)
        self.assertEqual(len(frames), 2)
        for frame in frames:
            self.assertTrue(frame.getbbox())
            self.assertLessEqual(set(np.asarray(frame)[..., 3].ravel()), {0, 255})
