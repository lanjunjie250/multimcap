"""Bounded GOP decoder for browsers without WebCodecs."""
import os
from collections import OrderedDict
import tempfile
import threading
from .errors import McapError

class JpegStreamDecoder:
    """Sequential OpenCV decoder that can restart at an H.264 keyframe."""

    def __init__(self, recording, stream):
        self.recording = recording
        self.stream = stream
        self.lock = threading.Lock()
        self.capture = None
        self.path = None
        self.position = -1
        self.cv2 = None
        self.end_index = 0
        self.cache = OrderedDict()

    def close(self):
        with self.lock:
            self.cache.clear()
            if self.capture is not None:
                self.capture.release()
                self.capture = None
            if self.path is not None:
                try:
                    os.unlink(self.path)
                except FileNotFoundError:
                    pass
                self.path = None

    def _restart(self, target):
        try:
            import cv2
        except ImportError as exc:
            raise McapError(
                'browser has no H.264 WebCodecs support and Python OpenCV is not installed') from exc
        self.cv2 = cv2
        keyframe = 0
        for index in range(target, -1, -1):
            if self.stream.frames[index].keyframe:
                keyframe = index
                break
        if self.capture is not None:
            self.capture.release()
        if self.path is not None:
            try:
                os.unlink(self.path)
            except FileNotFoundError:
                pass
        suffix = '.h264' if self.stream.codec == 'h264' else '.h265'
        temporary = tempfile.NamedTemporaryFile(prefix='mcap-player-', suffix=suffix,
                                                 delete=False)
        self.path = temporary.name
        self.end_index = next((i for i in range(target + 1, len(self.stream.frames))
                               if self.stream.frames[i].keyframe), len(self.stream.frames))
        # Each temporary stream ends at the next random-access point, not EOF.
        try:
            for frame in self.stream.frames[keyframe:self.end_index]:
                temporary.write(self.recording.map[
                    frame.data_offset:frame.data_offset + frame.data_length])
        finally:
            temporary.close()
        if hasattr(cv2, 'CAP_PROP_N_THREADS'):
            # Six camera decoders must not each create a full-machine thread pool.
            self.capture = cv2.VideoCapture(self.path, cv2.CAP_FFMPEG,
                                            [cv2.CAP_PROP_N_THREADS, 2])
        else:
            self.capture = cv2.VideoCapture(self.path)
        if not self.capture.isOpened():
            raise McapError('OpenCV could not open the recorded H.264 stream')
        self.position = keyframe - 1

    def frame(self, index):
        if not 0 <= index < len(self.stream.frames):
            raise McapError('frame index is outside stream')
        with self.lock:
            if index in self.cache:
                self.cache.move_to_end(index)
                return self.cache[index]
            if self.capture is None or index <= self.position or index >= self.end_index:
                self._restart(index)
            image = None
            while self.position < index:
                ok, image = self.capture.read()
                if not ok:
                    raise McapError('OpenCV stopped while decoding frame %d' % index)
                self.position += 1
            if image is None:
                # Re-read the requested frame after an exact-position restart.
                self._restart(index)
                while self.position < index:
                    ok, image = self.capture.read()
                    if not ok:
                        raise McapError('OpenCV stopped while decoding frame %d' % index)
                    self.position += 1
            height, width = image.shape[:2]
            if width > 960:
                scale = 960.0 / width
                image = self.cv2.resize(image, (960, max(1, round(height * scale))),
                                        interpolation=self.cv2.INTER_AREA)
            ok, encoded = self.cv2.imencode(
                '.jpg', image, [int(self.cv2.IMWRITE_JPEG_QUALITY), 82])
            if not ok:
                raise McapError('OpenCV could not encode preview frame')
            result = encoded.tobytes()
            self.cache[index] = result
            while len(self.cache) > 12:
                self.cache.popitem(last=False)
            return result
