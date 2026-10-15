"""Camera names follow physical routes, including old zero-based recordings."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rtcamera_offline.archive import extract_session_zip, validate_manifest
from rtcamera_offline.camera_names import camera_label, route_label
from rtcamera_offline.recording import McapRecording, MCAP_MAGIC
from rtcamera_offline.errors import McapError


def text(value):
    b = value.encode()
    return struct.pack('<I', len(b)) + b


def record(op, data):
    return bytes([op]) + struct.pack('<Q', len(data)) + data


def channel(cid, sid, topic, encoding, metadata):
    values = b''.join(text(k) + text(v) for k, v in metadata.items())
    return record(4, struct.pack('<HH', cid, sid) + text(topic) + text(encoding) +
                  struct.pack('<I', len(values)) + values)


def fixture(path, routes):
    data = MCAP_MAGIC + record(1, text('') + text('test'))
    for sid, name in [(1, 'foxglove.CompressedImage'), (2, 'foxglove.IMUMeasurement')]:
        data += record(3, struct.pack('<H', sid) + text(name) + text('protobuf') + struct.pack('<I', 0))
    messages = b''
    for n, (topic_index, name, vc) in enumerate(routes):
        base = '/robot0/sensor/camera%d' % topic_index
        cid = n * 3 + 1
        data += channel(cid, 1, base + '/compressed', 'protobuf', {})
        data += channel(cid + 1, 0, base + '/metadata/raw', 'application/octet-stream',
                        {'camera_id': name, 'sensor_id': name, 'logical_vc': str(vc)})
        data += channel(cid + 2, 2, '/robot0/sensor/imu', 'protobuf', {})
        nal = b'\x00\x00\x01\x65\x88'
        video = b'\x12' + bytes([len(nal)]) + nal + b'\x1a\x04h264'
        packet = bytearray(132)
        packet[:4] = b'SBR2'
        struct.pack_into('<HHI', packet, 4, 4, 88, len(packet))
        struct.pack_into('<H', packet, 36, 1)
        struct.pack_into('<Q', packet, 40, 42)
        struct.pack_into('<HBBH', packet, 88, 1, 1, 0, 1)  # One IMU descriptor/sample.
        struct.pack_into('<Q', packet, 96, 7)
        source = (name + '_imu').encode()
        imu = b'\x12' + bytes([len(source)]) + source
        for target, payload in [(cid, video), (cid + 1, packet), (cid + 2, imu)]:
            messages += record(5, struct.pack('<HIQQ', target, 7, 1000, 1000) + payload)
    path.write_bytes(data + messages + record(15, b'\0' * 4) + MCAP_MAGIC)


class CameraNamesTests(unittest.TestCase):
    def test_new_eight_camera_names_and_old_routes(self):
        modern = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C2', 'D2']
        legacy = ['A0', 'A1', 'A2', 'B0', 'B1', 'B2', 'C1', 'D1']
        vcs = [0, 1, 2, 0, 1, 2, 1, 1]
        for names in [modern, legacy]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'cameras.mcap'
                fixture(path, list(reversed(list(zip(range(8), names, vcs)))))
                recording = McapRecording(path)
                try:
                    result = recording.metadata()
                    self.assertEqual([s['label'] for s in result['streams']], modern)
                    self.assertEqual([s['id'] for s in result['streams']], list(range(8)))
                    for s in recording.streams:
                        self.assertEqual(s.topic, '/robot0/sensor/camera%d/compressed' % s.id)
                        self.assertEqual(s.frames[0].frame_id, 42)
                        self.assertEqual(recording.packet_batch(s.id, 0, 1)[:4], b'RTPK')
                    imu = [s for s in result['sensor_streams'] if s['kind'] == 'imu']
                    self.assertEqual(sorted(s['source'] for s in imu), sorted(n + '_imu' for n in modern))
                    self.assertTrue(all(s['frame_ids'] == ['42'] for s in imu))
                finally:
                    recording.close()

    def test_legacy_four_camera_routes_override_modern_numeric_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'legacy.mcap'
            fixture(path, [(0, 'A2', 2), (1, 'B2', 2), (2, 'C1', 1), (3, 'D1', 1)])
            recording = McapRecording(path)
            try:
                self.assertEqual([s.label for s in recording.streams], ['A3', 'B3', 'C2', 'D2'])
            finally:
                recording.close()

    def test_named_topics_and_generic_numeric_fallback(self):
        for label in ['A3', 'B3', 'C1', 'C3', 'D1', 'D3']:
            self.assertEqual(camera_label('/camera/%s/video/encoded' % label), label)
        self.assertEqual(camera_label('/robot0/sensor/camera0/compressed'), 'A1')
        self.assertEqual(camera_label('/robot0/sensor/camera7/compressed'), 'D2')
        self.assertEqual(camera_label('/robot0/sensor/camera19/compressed'), 'Camera 19')
        self.assertEqual(route_label('/camera/C1/metadata/raw', {'logical_vc': '0'}), 'C1')

    def test_new_zip_names_and_legacy_names_remain_accepted(self):
        for names in [['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C3', 'D3'], ['A0', 'A1', 'B0', 'B2']]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'sample.zip'
                manifest = {'status': 'complete', 'cameras': names}
                with zipfile.ZipFile(path, 'w') as z:
                    z.writestr('session/session.json', json.dumps(manifest))
                    for name in names:
                        z.writestr('session/' + name + '.mcap', MCAP_MAGIC * 2)
                session = extract_session_zip(path, Path(temporary) / 'extracted')
                self.assertTrue(all((session / (name + '.mcap')).is_file() for name in names))
        for invalid in ['A4', 'D9', '../A1', 'A01', 'A-1']:
            with self.assertRaises(ValueError):
                validate_manifest({'status': 'complete', 'cameras': ['B1', invalid]})

    def test_invalid_channel_metadata_length_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'invalid.mcap'
            body = struct.pack('<HH', 1, 1) + text('/camera/A3/compressed') + text('protobuf') + struct.pack('<I', 100)
            path.write_bytes(MCAP_MAGIC + record(4, body) + MCAP_MAGIC)
            with self.assertRaises(McapError):
                McapRecording(path)


if __name__ == '__main__':
    unittest.main()
