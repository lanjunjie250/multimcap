"""Regression checks for concurrent file replacement and stale frame requests."""
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rtcamera_offline.server import PlayerApp
from rtcamera_offline.errors import McapError


class LifecycleTests(unittest.TestCase):
    def test_import_failure_is_reported_and_later_import_can_proceed(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = PlayerApp([temporary])
            self.addCleanup(app.close)
            def fail(progress):
                progress('正在校验')
                raise ValueError('invalid archive')
            job = app.submit_import(fail)
            # A barrier in the same executor avoids timing-based polling.
            app.import_pool.submit(lambda: None).result(timeout=2)
            state = app.job_status(job['job_id'])
            self.assertEqual(state['status'], 'error')
            self.assertEqual(state['error'], 'invalid archive')
            job = app.submit_import(lambda progress: {'recording_id': 'next'})
            app.import_pool.submit(lambda: None).result(timeout=2)
            self.assertEqual(app.job_status(job['job_id'])['status'], 'complete')

    def test_replace_waits_for_reader_without_blocking_other_camera(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = PlayerApp([temporary])
            self.addCleanup(app.close)
            old, new = Mock(), Mock()
            old.metadata.return_value = {}; new.metadata.return_value = {}
            old.recording_id = 'old'; new.recording_id = 'new'
            app._replace(old)
            entered, release, replaced = threading.Event(), threading.Event(), threading.Event()
            def reader():
                with app.recording_lease('old'):
                    entered.set()
                    release.wait(5)
                    old.close.assert_not_called()
            reader_thread = threading.Thread(target=reader)
            reader_thread.start()
            self.assertTrue(entered.wait(2))
            def replace():
                app._replace(new)
                replaced.set()
            writer = threading.Thread(target=replace)
            writer.start()
            try:
                self.assertFalse(replaced.wait(0.05))
                # Independent leases are concurrent, not a lock held across decoding.
                with app.recording_lease() as current:
                    self.assertIs(current, new)
                old.close.assert_not_called()
            finally:
                release.set()
                reader_thread.join(2); writer.join(2)
            self.assertTrue(replaced.is_set())
            old.close.assert_called_once()
            with self.assertRaisesRegex(McapError, 'recording changed'):
                app.packets(0, 0, 1, expected='old')


if __name__ == '__main__':
    unittest.main()
