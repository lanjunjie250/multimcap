"""Bounded I/O and repeated-frame regressions, independent of a codec install."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rtcamera_offline.decode import JpegStreamDecoder


class DecodeTests(unittest.TestCase):
    def test_seek_writes_one_gop_and_repeated_frame_is_cached(self):
        opened = []
        class Capture:
            def __init__(self, path):
                self.content = Path(path).read_bytes()
                self.index = 0
                opened.append(self)
            def isOpened(self):
                return True
            def release(self):
                pass
            def read(self):
                if self.index >= len(self.content):
                    return False, None
                frame = SimpleNamespace(shape=(10, 10, 3), value=self.content[self.index])
                self.index += 1
                return True, frame
        codec = SimpleNamespace(VideoCapture=Capture, IMWRITE_JPEG_QUALITY=1,
            imencode=lambda _ext, image, _options:
                (True, SimpleNamespace(tobytes=lambda: bytes([image.value]))))
        stream = SimpleNamespace(codec='h264', frames=[
            SimpleNamespace(data_offset=i, data_length=1, keyframe=i % 10 == 0)
            for i in range(100)])
        decoder = JpegStreamDecoder(SimpleNamespace(map=bytes(range(100))), stream)
        self.addCleanup(decoder.close)
        with patch.dict(sys.modules, cv2=codec):
            self.assertEqual(decoder.frame(65), bytes([65]))
            self.assertEqual(len(opened[0].content), 10, 'seeking must not copy the remaining file')
            self.assertEqual(decoder.frame(65), bytes([65]))
            self.assertEqual(len(opened), 1, 'same-frame repaint must not restart decoder')
            self.assertEqual(decoder.frame(70), bytes([70]))
            self.assertEqual(len(opened), 2)
            self.assertEqual(decoder.frame(15), bytes([15]))
            self.assertEqual(len(opened[-1].content), 10)
            temporary = Path(decoder.path)
            decoder.close()
            self.assertFalse(temporary.exists())


if __name__ == '__main__':
    unittest.main()
