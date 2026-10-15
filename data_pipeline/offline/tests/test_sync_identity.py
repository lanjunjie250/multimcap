"""Expose synchronization identity only when the recording supplies it."""
from pathlib import Path
import tempfile
import unittest
from test_camera_names import fixture, McapRecording


class SyncIdentityTests(unittest.TestCase):
    def test_sync_pulse_zero_and_missing_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sync.mcap'
            fixture(path, [(0, 'A1', 0), (1, 'A2', 1)])
            recording = McapRecording(path)
            try:
                self.assertEqual(recording.metadata()['streams'][0]['sync_frame_ids'], ['42'])
                stream = recording.streams[0]
                stream.frames[0].frame_id = 0
                self.assertEqual(recording.metadata()['streams'][0]['sync_frame_ids'], ['0'])
                recording.video_frame_metadata.pop(stream.topic)
                result = recording.metadata()['streams'][0]
                self.assertEqual(result['sync_frame_ids'], [None])
                self.assertEqual(result['frame_ids'], ['7'])
            finally:
                recording.close()
