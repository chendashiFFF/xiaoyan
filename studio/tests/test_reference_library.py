import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from studio.server import store, jobs, settings


class ReferenceLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for target, field, value in [(store, 'PROJECTS_DIR', Path(self.temp.name) / 'projects'), (settings, 'SETTINGS_FILE', Path(self.temp.name) / 'settings.json')]:
            p = patch.object(target, field, value)
            p.start()
            self.addCleanup(p.stop)
        store.create_project({'id': 'test', 'name': 'Test'})
        self.refs = []
        for i in range(4):
            data = io.BytesIO()
            Image.new('RGB', (32, 32), (i * 50, 20, 30)).save(data, format='PNG')
            self.refs.append(store.add_reference('test', data.getvalue(), None, f'ref-{i}.png')['reference'])
        store.create_action('test', {'id': 'walk'})
        settings.update({'provider': 'api', 'api': {'base': 'https://example.invalid', 'key': 'test'}})

    def keyposes(self, **body):
        with patch.object(jobs, '_start', side_effect=lambda pid, job, config: job):
            return jobs.create_action_job('test', 'walk', {'instruction': 'walk', **body})

    def test_all_originals_snapshot_and_props(self):
        store.update_project('test', {'referenceSettings': {self.refs[2]: {'angle': 'side', 'enabled': True}}, 'propMode': 'character'})
        job = self.keyposes()
        self.assertEqual(len(job['referenceSnapshots']), 4)
        self.assertEqual(job['referenceSnapshots'][2]['angle'], 'side')
        self.assertIn('omit microphones', job['prompt'])
        saved = Path(job['inputs'][1]).read_bytes()
        store.update_project('test', {'removeReference': self.refs[0]})
        self.assertEqual(Path(job['inputs'][1]).read_bytes(), saved)
        self.assertTrue((store.project_dir('test') / 'references/originals/ref-0.png').exists())

    def test_defaults_overrides_and_invalid_selection(self):
        store.update_project('test', {'referenceSettings': {self.refs[1]: {'enabled': False, 'angle': 'front'}}})
        self.assertEqual(len(self.keyposes()['referenceSnapshots']), 3)
        job = self.keyposes(references=[self.refs[1]], propMode='keep')
        self.assertEqual([r['source'] for r in job['referenceSnapshots']], [self.refs[1]])
        self.assertEqual(job['propMode'], 'keep')
        for selection in ([], ['../outside.png'], [self.refs[0], self.refs[0]]):
            with self.assertRaises(store.StoreError):
                self.keyposes(references=selection)

    def test_all_frame_modes_use_selected_originals(self):
        action = store.get_action('test', 'walk')
        for n in range(2):
            fid = store.add_frame_from_file('test', 'walk', store.project_dir('test') / self.refs[n])
            action['frames'].append({'id': fid, 'duration': 100, 'offset': [0, 0], 'flipX': False, 'version': 1, 'versions': [1]})
        store.save_action('test', 'walk', action)
        for kind in ('redraw', 'repair', 'inbetween'):
            with patch.object(jobs, '_start', side_effect=lambda pid, job, config: job):
                job = jobs.create_job('test', 'walk', action['frames'][0]['id'], {'kind': kind, 'rect': [0, 0, 20, 20], 'references': self.refs, 'propMode': 'character'})
            self.assertEqual(len(job['referenceSnapshots']), 4)
            self.assertTrue(all(Path(p).is_file() for p in job['inputs']))
