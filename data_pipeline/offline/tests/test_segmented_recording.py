import json
from pathlib import Path
import struct
import shutil
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rtcamera_offline.archive import extract_session_zip
from rtcamera_offline.recording import SegmentedRecording, McapRecording
from rtcamera_offline.server import PlayerApp
from rtcamera_offline import session as session_tool
from rtcamera_offline.errors import McapError
from rtcamera_offline.segments import inspect_session
from test_camera_names import fixture


class SegmentedRecordingTests(unittest.TestCase):
    def make_segment(self, directory, name):
        path = directory / name
        fixture(path, [(0, 'A1', 0), (1, 'B1', 1)])
        return path

    def test_facade_concatenates_frames_and_rebases_packet_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_path = self.make_segment(root, 'first.mcap')
            second_path = self.make_segment(root, 'second.mcap')
            first = McapRecording(first_path)
            second = McapRecording(second_path)
            # Make the second segment occur after the first while preserving
            # the source mmap and frame payloads.
            for recording, delta in ((first, 0), (second, 1_000_000_000)):
                recording.start_time_ns += delta
                recording.end_time_ns += delta
                for stream in recording.streams:
                    for frame in stream.frames:
                        frame.publish_time_ns += delta
                        frame.log_time_ns += delta
            joined = SegmentedRecording([first, second], segment_rows=[
                {'index': 1, 'directory': 'segment-000001', 'status': 'complete'},
                {'index': 2, 'directory': 'segment-000002', 'status': 'complete'}])
            self.addCleanup(joined.close)
            metadata = joined.metadata()
            self.assertEqual([stream['frame_count'] for stream in metadata['streams']], [2, 2])
            self.assertEqual(len(metadata['segments']), 2)
            packet = joined.packet_batch(0, 0, 2)
            self.assertEqual(packet[:4], b'RTPK')
            self.assertEqual(struct.unpack_from('<I', packet, 4)[0], 2)
            self.assertAlmostEqual(struct.unpack_from('<d', packet, 16)[0], 0.0)
            self.assertGreater(struct.unpack_from('<d', packet, 40)[0], 0.9)

    def test_segmented_zip_preserves_nested_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'camera.mcap'
            fixture(source, [(0, 'A1', 0), (1, 'B1', 1)])
            archive = root / 'session.zip'
            session = {
                'status': 'complete', 'cameras': ['A1', 'B1'],
            }
            segments = {'schema_version': 1, 'segments': [
                {'index': 1, 'directory': 'segment-000001', 'status': 'complete'},
                {'index': 2, 'directory': 'segment-000002', 'status': 'complete'},
            ]}
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('session/session.json', json.dumps(session))
                output.writestr('session/segments.json', json.dumps(segments))
                for index in (1, 2):
                    for label in ('A1', 'B1'):
                        output.write(source, 'session/segment-%06d/%s.mcap' %
                                     (index, label))
            extracted = extract_session_zip(archive, root / 'extracted')
            self.assertTrue((extracted / 'segment-000001/A1.mcap').is_file())
            self.assertTrue((extracted / 'segment-000002/B1.mcap').is_file())

    def test_player_opens_each_segment_without_one_large_merged_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'camera.mcap'
            fixture(source, [(0, 'A1', 0), (1, 'B1', 1)])
            archive = root / 'session.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('session/session.json', json.dumps(
                    {'status': 'complete', 'cameras': ['A1', 'B1']}))
                output.writestr('session/segments.json', json.dumps({'segments': [
                    {'index': 1, 'directory': 'segment-000001', 'status': 'complete'},
                    {'index': 2, 'directory': 'segment-000002', 'status': 'complete'},
                ]}))
                for index in (1, 2):
                    for label in ('A1', 'B1'):
                        output.write(source, 'session/segment-%06d/%s.mcap' %
                                     (index, label))
            merger = root / 'mcap_merge'
            merger.touch()
            app = PlayerApp([root], merger=merger)
            self.addCleanup(app.close)

            def fake_merge(command, **_kwargs):
                shutil.copyfile(command[2], command[1])
                return type('Result', (), {'returncode': 0})()

            with patch('rtcamera_offline.server.subprocess.run', side_effect=fake_merge):
                metadata = app.open(archive)
            self.assertEqual(len(metadata['segments']), 2)
            self.assertFalse(metadata['merged_download'])
            self.assertEqual(metadata['streams'][0]['frame_count'], 2)
            with self.assertRaisesRegex(McapError, 'no merged session'):
                app.merged_file()

    def test_cli_analyzes_each_segment_without_claiming_one_merge(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / 'session'
            session.mkdir()
            (session / 'session.json').write_text(json.dumps(
                {'session': 'session', 'status': 'complete', 'cameras': ['A1', 'B1']}))
            (session / 'segments.json').write_text(json.dumps({'segments': [
                {'index': 1, 'directory': 'segment-000001', 'status': 'complete'},
                {'index': 2, 'directory': 'segment-000002', 'status': 'complete'},
            ]}))
            for index in (1, 2):
                directory = session / ('segment-%06d' % index)
                directory.mkdir()
                for label in ('A1', 'B1'):
                    (directory / (label + '.mcap')).write_bytes(b'mcap')
            inspector = root / 'mcap_inspect'
            merger = root / 'mcap_merge'
            inspector.touch()
            merger.touch()
            args = SimpleNamespace(output=None, inspector=inspector, merger=merger,
                                   report=root / 'report.json')
            summary = ('input=A1.mcap frames=1 first=0:0:1 last=0:0:1 dropped_by_alignment=0\n'
                       'input=B1.mcap frames=1 first=0:0:1 last=0:0:1 dropped_by_alignment=0\n'
                       'common_frames_total=1 max_timestamp_span_ns=0 max_span_pulse=1\n'
                       'aligned_common_frames=1 first=0:0:1 last=0:0:1\n')
            with patch.object(session_tool, 'inspect', return_value={'bytes': 4}), \
                    patch.object(session_tool, 'run', return_value=summary):
                result = session_tool.analyze_session(args, session)
            self.assertEqual(result, 0)
            report = json.loads(args.report.read_text())
            self.assertTrue(report['segmented'])
            self.assertEqual(len(report['segments']), 2)

    def test_segment_boundary_tool_requires_idr_on_every_camera(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / 'session'
            session.mkdir()
            (session / 'session.json').write_text(json.dumps(
                {'session': 'session', 'status': 'complete', 'cameras': ['A1', 'B1']}))
            (session / 'segments.json').write_text(json.dumps({'segments': [
                {'index': 1, 'directory': 'segment-000001', 'status': 'complete'},
            ]}))
            directory = session / 'segment-000001'
            directory.mkdir()
            for label in ('A1', 'B1'):
                fixture(directory / (label + '.mcap'), [(0, label, 0)])
            report = inspect_session(session)
            self.assertEqual(report['status'], 'pass')
            self.assertTrue(all(row['first_frame_keyframe']
                                for row in report['segments'][0]['cameras']))


if __name__ == '__main__':
    unittest.main()
