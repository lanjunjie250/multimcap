"""MCAP indexing and encoded packet access."""
import bisect
import collections
from dataclasses import dataclass, field
import mmap
from pathlib import Path
import struct
import time
import uuid

from .errors import McapError
from .decode import JpegStreamDecoder
from .camera_names import (camera_label as _camera_label, camera_topic_key,
                           camera_sort_key, recorded_camera_name, route_label)

MCAP_MAGIC = b'\x89MCAP0\r\n'
PACKET_MAGIC = b'RTPK'
VIDEO_SUFFIXES = ('/compressed', '/video/encoded')


@dataclass
class Frame:
    sequence: int
    log_time_ns: int
    publish_time_ns: int
    data_offset: int
    data_length: int
    keyframe: bool
    frame_id: int = 0
    global_frame_sequence: int = 0
    clock_generation: int = 0
    sync_epoch: int = 0


@dataclass
class VideoStream:
    id: int
    channel_id: int
    topic: str
    label: str
    codec: str = 'h264'
    web_codec: str = 'avc1.42E01E'
    frames: list = field(default_factory=list)


def _u16(data, offset):
    return struct.unpack_from('<H', data, offset)[0]


def _u32(data, offset):
    return struct.unpack_from('<I', data, offset)[0]


def _u64(data, offset):
    return struct.unpack_from('<Q', data, offset)[0]


def _string(data, offset, end):
    if offset + 4 > end:
        raise McapError('truncated MCAP string')
    size = _u32(data, offset)
    offset += 4
    if size > end - offset:
        raise McapError('MCAP string exceeds record')
    return bytes(data[offset:offset + size]).decode('utf-8'), offset + size


def _varint(data, offset, end):
    value = 0
    shift = 0
    while offset < end and shift < 70:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
    raise McapError('invalid protobuf varint')


def _protobuf_fields(data, offset, length):
    end = offset + length
    while offset < end:
        key, offset = _varint(data, offset, end)
        number, wire = key >> 3, key & 7
        if number == 0:
            raise McapError('invalid protobuf field zero')
        if wire == 0:
            _, offset = _varint(data, offset, end)
            yield number, wire, None, 0
        elif wire == 1:
            if offset + 8 > end:
                raise McapError('truncated protobuf fixed64')
            yield number, wire, offset, 8
            offset += 8
        elif wire == 2:
            size, offset = _varint(data, offset, end)
            if size > end - offset:
                raise McapError('protobuf bytes exceed message')
            yield number, wire, offset, size
            offset += size
        elif wire == 5:
            if offset + 4 > end:
                raise McapError('truncated protobuf fixed32')
            yield number, wire, offset, 4
            offset += 4
        else:
            raise McapError('unsupported protobuf wire type %d' % wire)


def _protobuf_text_field(data, offset, length, wanted):
    for number, wire, field_offset, field_length in _protobuf_fields(
            data, offset, length):
        if number == wanted and wire == 2:
            return bytes(data[field_offset:field_offset + field_length]).decode('utf-8')
    return ''


def _sbr2_frame_info(data, offset, length):
    if length < 84 or bytes(data[offset:offset + 4]) != b'SBR2':
        raise McapError('metadata message has an invalid SBR2 header')
    version = _u16(data, offset + 4)
    header_length = _u16(data, offset + 6)
    if (version, header_length) not in ((3, 80), (4, 88)):
        raise McapError('metadata message has an unsupported SBR2 version')
    if _u32(data, offset + 8) != length:
        raise McapError('metadata message SBR2 length differs from payload')
    descriptors = []
    descriptor_count = _u16(data, offset + 36)
    for index in range(descriptor_count):
        descriptor = offset + header_length + index * 40
        if descriptor + 40 > offset + length - 4:
            raise McapError('metadata message has a truncated SBR2 descriptor')
        descriptors.append(dict(
            sensor_id=_u16(data, descriptor), kind=data[descriptor + 2],
            count=_u16(data, descriptor + 4),
            first_sequence=_u64(data, descriptor + 8)))
    return dict(
        global_frame_sequence=_u64(data, offset + 24),
        sync_epoch=_u32(data, offset + 32),
        sync_pulse_id=_u64(data, offset + 40),
        clock_generation=_u32(data, offset + 68), descriptors=descriptors)


def _annex_b_nals(data, offset, length):
    end = offset + length
    starts = []
    cursor = offset
    # mmap.find runs in native code. A four-byte start code is found from its
    # second zero, which still places the returned NAL offset correctly.
    while cursor + 3 <= end:
        marker = data.find(b'\x00\x00\x01', cursor, end)
        if marker < 0:
            break
        starts.append(marker + 3)
        cursor = marker + 3
    return starts


def _frame_alignment(streams):
    if not streams:
        return 0, []
    keyed = [{frame.frame_id: frame.publish_time_ns for frame in stream.frames
              if frame.frame_id} for stream in streams]
    if keyed and all(keyed):
        common = set(keyed[0])
        for frames in keyed[1:]:
            common.intersection_update(frames)
        spans = [max(frames[frame_id] for frames in keyed) -
                 min(frames[frame_id] for frames in keyed)
                 for frame_id in sorted(common)]
        return len(common), spans
    anchor = min(streams, key=lambda stream: len(stream.frames))
    timestamp_sets = [[frame.publish_time_ns for frame in stream.frames]
                      for stream in streams]
    intervals = [b - a for timestamps in timestamp_sets
                 for a, b in zip(timestamps, timestamps[1:]) if b > a]
    tolerance = (sorted(intervals)[len(intervals) // 2] // 2
                 if intervals else 1_000_000)
    spans = []
    for frame in anchor.frames:
        group = []
        for timestamps in timestamp_sets:
            index = bisect.bisect_left(timestamps, frame.publish_time_ns)
            candidates = timestamps[max(0, index - 1):min(len(timestamps), index + 1)]
            if not candidates:
                break
            group.append(min(candidates, key=lambda value: abs(value - frame.publish_time_ns)))
        if len(group) == len(streams) and max(group) - min(group) <= tolerance:
            spans.append(max(group) - min(group))
    return len(spans), spans


def _h264_info(data, offset, length):
    nals = _annex_b_nals(data, offset, length)
    keyframe = any(data[start] & 0x1f == 5 for start in nals if start < offset + length)
    web_codec = None
    for start in nals:
        if start + 3 < offset + length and data[start] & 0x1f == 7:
            web_codec = 'avc1.%02X%02X%02X' % (
                data[start + 1], data[start + 2], data[start + 3])
            break
    return keyframe, web_codec


def _h265_info(data, offset, length):
    nals = _annex_b_nals(data, offset, length)
    nal_types = [((data[start] >> 1) & 0x3f) for start in nals
                 if start < offset + length]
    # BLA, IDR and CRA pictures are valid random-access points.
    keyframe = any(16 <= nal_type <= 21 for nal_type in nal_types)
    # WebCodecs implementations require an HEVC codec family to select the
    # decoder. Exact profile/level parsing is unnecessary for the GStreamer
    # compatibility fallback used when the browser has no HEVC support.
    return keyframe, 'hvc1.1.6.L93.B0'


def _video_payload(data, offset, length, schema_name):
    data_field = 3 if schema_name == 'foxglove.CompressedVideo' else 2
    format_field = 4 if schema_name == 'foxglove.CompressedVideo' else 3
    encoded = None
    codec = None
    for number, wire, field_offset, field_length in _protobuf_fields(data, offset, length):
        if wire != 2:
            continue
        if number == data_field:
            encoded = (field_offset, field_length)
        elif number == format_field:
            codec = bytes(data[field_offset:field_offset + field_length]).decode('utf-8')
    if encoded is None or codec not in ('h264', 'h265'):
        raise McapError('video payload has no supported compressed frame')
    return encoded[0], encoded[1], codec


class McapRecording:
    def __init__(self, path, display_name=None, display_path=None):
        self.path = Path(path).resolve()
        self.display_name = display_name or self.path.name
        self.display_path = display_path or str(self.path)
        self.file = self.path.open('rb')
        self.map = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        self.schemas = {}
        self.channels = {}
        self.streams = []
        self.start_time_ns = 0
        self.end_time_ns = 0
        self.message_count = 0
        self.topic_counts = collections.Counter()
        self.topic_messages = collections.defaultdict(list)
        self.sensor_messages = collections.defaultdict(list)
        self.video_frame_metadata = collections.defaultdict(dict)
        self.sensor_frame_ids = {}
        self.sensor_sequence_high = {}
        self.log_publish_mismatches = collections.Counter()
        self.parse_started = time.perf_counter()
        self.parse_ms = 0.0
        self.jpeg_decoders = []
        self.recording_id = uuid.uuid4().hex
        try:
            self._parse()
        except Exception:
            self.close()
            raise

    def close(self):
        for decoder in getattr(self, 'jpeg_decoders', []):
            decoder.close()
        self.jpeg_decoders = []
        if getattr(self, 'map', None) is not None:
            self.map.close()
            self.map = None
        if getattr(self, 'file', None) is not None:
            self.file.close()
            self.file = None

    def _records(self, start, end):
        cursor = start
        while cursor < end:
            if cursor + 9 > end:
                raise McapError('truncated MCAP record header')
            opcode = self.map[cursor]
            length = _u64(self.map, cursor + 1)
            content = cursor + 9
            if length > end - content:
                raise McapError('MCAP record exceeds container')
            yield opcode, content, length
            cursor = content + length
        if cursor != end:
            raise McapError('MCAP record parser lost alignment')

    def _parse_schema(self, offset, length):
        end = offset + length
        if length < 2:
            raise McapError('short schema record')
        schema_id = _u16(self.map, offset)
        name, _ = _string(self.map, offset + 2, end)
        self.schemas[schema_id] = name

    def _parse_channel(self, offset, length):
        end = offset + length
        if length < 4:
            raise McapError('short channel record')
        channel_id = _u16(self.map, offset)
        schema_id = _u16(self.map, offset + 2)
        topic, cursor = _string(self.map, offset + 4, end)
        encoding, cursor = _string(self.map, cursor, end)
        if cursor + 4 > end:
            raise McapError('truncated channel metadata map')
        metadata_end = cursor + 4 + _u32(self.map, cursor)
        if metadata_end != end:
            raise McapError('channel metadata map has invalid length')
        cursor += 4
        metadata = {}
        while cursor < metadata_end:
            key, cursor = _string(self.map, cursor, metadata_end)
            value, cursor = _string(self.map, cursor, metadata_end)
            metadata[key] = value
        self.channels[channel_id] = dict(schema_id=schema_id, topic=topic,
                                         encoding=encoding, metadata=metadata)

    def _index_camera_names(self):
        self.camera_labels = {}
        aliases = collections.defaultdict(set)
        for channel in self.channels.values():
            topic, metadata = channel['topic'], channel['metadata']
            label = route_label(topic, metadata)
            if label:
                key = camera_topic_key(topic)
                if key:
                    self.camera_labels[key] = label
                original = recorded_camera_name(topic, metadata)
                if original:
                    aliases[original].add(label)
        self.camera_aliases = {name: next(iter(labels)) for name, labels in aliases.items()
                               if len(labels) == 1}

    def _channel_camera_label(self, topic):
        return self.camera_labels.get(camera_topic_key(topic), _camera_label(topic))

    def _sensor_source(self, source):
        camera, separator, suffix = source.partition('_')
        return self.camera_aliases.get(camera, camera) + separator + suffix

    def _parse_message(self, offset, length, streams_by_channel):
        if length < 22:
            raise McapError('short message record')
        channel_id = _u16(self.map, offset)
        stream = streams_by_channel.get(channel_id)
        self.message_count += 1
        channel = self.channels.get(channel_id)
        if channel:
            self.topic_counts[channel['topic']] += 1
            sequence = _u32(self.map, offset + 2)
            log_time = _u64(self.map, offset + 6)
            publish_time = _u64(self.map, offset + 14)
            self.topic_messages[channel['topic']].append(
                (publish_time, log_time, sequence))
            if log_time != publish_time:
                self.log_publish_mismatches[channel['topic']] += 1
            payload_offset = offset + 22
            payload_length = length - 22
            schema = self.schemas.get(channel['schema_id'], '')
            if channel['topic'].endswith('/metadata/raw'):
                info = _sbr2_frame_info(
                    self.map, payload_offset, payload_length)
                label = self._channel_camera_label(channel['topic'])
                video_topic = channel['topic'][:-len('/metadata/raw')] + '/compressed'
                self.video_frame_metadata[video_topic][sequence] = info
                self.sensor_messages[(channel['topic'], label + '_metadata')].append(
                    (publish_time, log_time, sequence, info['sync_pulse_id']))
                for descriptor in info['descriptors']:
                    if descriptor['kind'] not in (1, 2):
                        continue
                    suffix = 'imu' if descriptor['kind'] == 1 else 'encoder'
                    source = label + '_' + suffix
                    key = (source, descriptor['sensor_id'], info['clock_generation'])
                    previous = self.sensor_sequence_high.get(key)
                    for index in range(descriptor['count']):
                        sample_sequence = (descriptor['first_sequence'] + index) & 0xffff
                        if previous is not None:
                            sample_sequence |= previous & ~0xffff
                            if sample_sequence + 0x8000 < previous:
                                sample_sequence += 0x10000
                        self.sensor_frame_ids[(source, sample_sequence)] = \
                            info['sync_pulse_id']
                        previous = sample_sequence
                    if previous is not None:
                        self.sensor_sequence_high[key] = previous
            elif ('imu' in schema.lower() or 'encoder' in schema.lower()):
                source = _protobuf_text_field(
                    self.map, payload_offset, payload_length, 2)
                if not source:
                    source = channel['topic'].rstrip('/').split('/')[-1]
                source = self._sensor_source(source)
                self.sensor_messages[(channel['topic'], source)].append(
                    (publish_time, log_time, sequence, None))
        if stream is None:
            return
        schema = self.schemas.get(self.channels[channel_id]['schema_id'], '')
        frame_offset, frame_length, codec = _video_payload(
            self.map, payload_offset, payload_length, schema)
        keyframe = False
        web_codec = None
        if codec == 'h264':
            keyframe, web_codec = _h264_info(self.map, frame_offset, frame_length)
        elif codec == 'h265':
            keyframe, web_codec = _h265_info(self.map, frame_offset, frame_length)
        stream.codec = codec
        if web_codec:
            stream.web_codec = web_codec
        stream.frames.append(Frame(sequence, log_time, publish_time,
                                   frame_offset, frame_length, keyframe))

    def _parse(self):
        size = len(self.map)
        if size < 16 or self.map[:8] != MCAP_MAGIC or self.map[-8:] != MCAP_MAGIC:
            raise McapError('invalid MCAP magic')
        top_records = list(self._records(8, size - 8))
        for opcode, offset, length in top_records:
            if opcode == 0x03:
                self._parse_schema(offset, length)
            elif opcode == 0x04:
                self._parse_channel(offset, length)
            elif opcode == 0x0f:
                break

        self._index_camera_names()
        streams_by_channel = {}
        for channel_id, channel in self.channels.items():
            if (channel['encoding'] == 'protobuf' and
                    channel['topic'].endswith(VIDEO_SUFFIXES)):
                label = self._channel_camera_label(channel['topic'])
                stream = VideoStream(len(self.streams), channel_id, channel['topic'], label)
                self.streams.append(stream)
                streams_by_channel[channel_id] = stream
        if not self.streams:
            raise McapError('MCAP contains no supported video channels')

        for opcode, offset, length in top_records:
            if opcode == 0x05:
                self._parse_message(offset, length, streams_by_channel)
            elif opcode == 0x06:
                self._parse_chunk(offset, length, streams_by_channel)
            elif opcode == 0x0f:
                break
        self.streams = [stream for stream in self.streams if stream.frames]
        self.streams.sort(key=lambda stream: camera_sort_key(stream.label))
        for index, stream in enumerate(self.streams):
            stream.id = index
        if not self.streams:
            raise McapError('MCAP video channels contain no frames')
        for stream in self.streams:
            metadata = self.video_frame_metadata.get(stream.topic, {})
            for frame in stream.frames:
                info = metadata.get(frame.sequence)
                if info:
                    frame.frame_id = info['sync_pulse_id']
                    frame.global_frame_sequence = info['global_frame_sequence']
                    frame.clock_generation = info['clock_generation']
                    frame.sync_epoch = info['sync_epoch']
        times = [message[0] for messages in self.topic_messages.values()
                 for message in messages]
        self.start_time_ns, self.end_time_ns = min(times), max(times)
        self.jpeg_decoders = [JpegStreamDecoder(self, stream) for stream in self.streams]
        self.parse_ms = (time.perf_counter() - self.parse_started) * 1000.0

    def _parse_chunk(self, offset, length, streams_by_channel):
        end = offset + length
        if length < 40:
            raise McapError('short MCAP chunk')
        cursor = offset + 28
        compression, cursor = _string(self.map, cursor, end)
        if compression:
            raise McapError('compressed MCAP chunks are not supported')
        if cursor + 8 > end:
            raise McapError('chunk has no records length')
        records_length = _u64(self.map, cursor)
        cursor += 8
        if records_length > end - cursor:
            raise McapError('chunk records exceed chunk')
        for opcode, nested_offset, nested_length in self._records(
                cursor, cursor + records_length):
            if opcode == 0x05:
                self._parse_message(nested_offset, nested_length, streams_by_channel)

    def metadata(self):
        start = self.start_time_ns
        result = []
        for stream in self.streams:
            times = [(frame.publish_time_ns - start) / 1e9 for frame in stream.frames]
            intervals_ns = [b.publish_time_ns - a.publish_time_ns
                            for a, b in zip(stream.frames, stream.frames[1:])]
            positive_ns = sorted(interval for interval in intervals_ns if interval > 0)
            median_ns = positive_ns[len(positive_ns) // 2] if positive_ns else 0
            median = median_ns / 1e9
            result.append(dict(
                id=stream.id, label=stream.label, topic=stream.topic, kind='video',
                codec=stream.codec, web_codec=stream.web_codec,
                frame_count=len(stream.frames), times=times,
                timestamps_ns=[str(frame.publish_time_ns) for frame in stream.frames],
                log_timestamps_ns=[str(frame.log_time_ns) for frame in stream.frames],
                sequences=[frame.sequence for frame in stream.frames],
                frame_ids=[str(frame.frame_id or frame.sequence) for frame in stream.frames],
                # Sequence fallback is useful for display, but is not evidence
                # that cameras share a hardware synchronization pulse.
                sync_frame_ids=[str(frame.frame_id) if frame.sequence in
                                self.video_frame_metadata.get(stream.topic, {})
                                else None for frame in stream.frames],
                global_frame_sequences=[str(frame.global_frame_sequence)
                                        for frame in stream.frames],
                clock_generations=[frame.clock_generation for frame in stream.frames],
                sync_epochs=[frame.sync_epoch for frame in stream.frames],
                keyframes=[index for index, frame in enumerate(stream.frames) if frame.keyframe],
                fps=(1.0 / median if median else 0),
                median_interval_ns=median_ns,
                min_interval_ns=min(positive_ns, default=0),
                max_interval_ns=max(positive_ns, default=0),
                gaps=[index + 1 for index, interval in enumerate(intervals_ns)
                      if median_ns and interval > median_ns * 1.5],
                gap_events=[dict(index=index + 1, time=times[index + 1],
                                 interval_ms=interval / 1e6,
                                 missing=max(1, round(interval / median_ns) - 1))
                            for index, interval in enumerate(intervals_ns)
                            if median_ns and interval > median_ns * 1.5]))
        common_frames, spans = _frame_alignment(self.streams)
        sorted_spans = sorted(spans)
        p95_index = round((len(sorted_spans) - 1) * 0.95) if sorted_spans else 0
        alignment = dict(
            common_frames=common_frames,
            min_span_ns=min(spans, default=0),
            p95_span_ns=sorted_spans[p95_index] if sorted_spans else 0,
            max_span_ns=max(spans, default=0),
            exact_frame_counts=len({len(stream.frames) for stream in self.streams}) <= 1,
            log_publish_alignment=not self.log_publish_mismatches)
        topics = []
        sensor_streams = []
        topic_schema = {}
        for channel_id, channel in sorted(self.channels.items(),
                                          key=lambda item: item[1]['topic']):
            topic = channel['topic']
            schema = self.schemas.get(channel['schema_id'], '')
            topic_schema[topic] = schema
            messages = self.topic_messages[topic]
            timestamps = [message[0] for message in messages]
            intervals = [b - a for a, b in zip(timestamps, timestamps[1:])]
            positive = sorted(interval for interval in intervals if interval > 0)
            median_ns = positive[len(positive) // 2] if positive else 0
            kind = ('video' if topic.endswith(VIDEO_SUFFIXES) else
                    'imu' if 'imu' in topic.lower() or 'imu' in schema.lower() else
                    'metadata' if 'metadata' in topic.lower() or 'metadata' in schema.lower() else
                    'sensor')
            topic_info = dict(
                id=channel_id, topic=topic, schema=schema,
                encoding=channel['encoding'], messages=len(messages), kind=kind,
                first_time_ns=str(timestamps[0]) if timestamps else None,
                last_time_ns=str(timestamps[-1]) if timestamps else None,
                rate_hz=(1e9 / median_ns if median_ns else 0),
                min_interval_ns=min(positive, default=0),
                median_interval_ns=median_ns,
                max_interval_ns=max(positive, default=0),
                log_publish_mismatches=self.log_publish_mismatches[topic])
            topics.append(topic_info)
        for sensor_id, ((topic, source), messages) in enumerate(sorted(
                self.sensor_messages.items())):
            schema = topic_schema.get(topic, '')
            kind = ('imu' if 'imu' in topic.lower() or 'imu' in schema.lower() else
                    'metadata' if 'metadata' in topic.lower() or
                    'metadata' in schema.lower() else 'sensor')
            timestamps = [message[0] for message in messages]
            intervals = [b - a for a, b in zip(timestamps, timestamps[1:])]
            positive = sorted(interval for interval in intervals if interval > 0)
            median_ns = positive[len(positive) // 2] if positive else 0
            frame_ids = []
            for message in messages:
                frame_id = message[3]
                if frame_id is None:
                    frame_id = self.sensor_frame_ids.get((source, message[2]), 0)
                frame_ids.append(str(frame_id or 0))
            sensor_streams.append(dict(
                id='sensor-%d' % sensor_id, topic=topic,
                label=source.replace('_', ' '), source=source, kind=kind,
                schema=schema, message_count=len(messages),
                times=[(timestamp - start) / 1e9 for timestamp in timestamps],
                timestamps_ns=[str(timestamp) for timestamp in timestamps],
                log_timestamps_ns=[str(message[1]) for message in messages],
                sequences=[message[2] for message in messages],
                frame_ids=frame_ids, median_interval_ns=median_ns,
                min_interval_ns=min(positive, default=0),
                max_interval_ns=max(positive, default=0),
                gaps=[index + 1 for index, interval in enumerate(intervals)
                      if median_ns and interval > median_ns * 1.5]))
        sources_by_topic = collections.Counter(stream['topic'] for stream in sensor_streams)
        for topic in topics:
            topic['source_count'] = sources_by_topic[topic['topic']]
        return dict(recording_id=self.recording_id, path=self.display_path, name=self.display_name,
                    size_bytes=self.path.stat().st_size,
                    start_time_ns=self.start_time_ns, end_time_ns=self.end_time_ns,
                    start_timestamp_ns=str(self.start_time_ns),
                    end_timestamp_ns=str(self.end_time_ns),
                    duration=(self.end_time_ns - self.start_time_ns) / 1e9,
                    message_count=self.message_count, parse_ms=self.parse_ms,
                    alignment=alignment, topics=topics, streams=result,
                    sensor_streams=sensor_streams)

    def packet_batch(self, stream_id, start, count):
        if not 0 <= stream_id < len(self.streams):
            raise McapError('unknown video stream')
        stream = self.streams[stream_id]
        if not 0 <= start <= len(stream.frames):
            raise McapError('frame start is outside stream')
        frames = stream.frames[start:min(len(stream.frames), start + count)]
        header = bytearray(PACKET_MAGIC + struct.pack('<I', len(frames)))
        payload = bytearray()
        for frame in frames:
            relative = (frame.publish_time_ns - self.start_time_ns) / 1e9
            header.extend(struct.pack('<IIdB7x', frame.data_length, frame.sequence,
                                      relative, frame.keyframe))
            payload.extend(self.map[frame.data_offset:frame.data_offset + frame.data_length])
        return bytes(header + payload)

    def jpeg_frame(self, stream_id, index):
        if not 0 <= stream_id < len(self.jpeg_decoders):
            raise McapError('unknown video stream')
        return self.jpeg_decoders[stream_id].frame(index)


class SegmentedRecording:
    """Read a session made of independently merged MCAP segments.

    Each segment remains an ordinary :class:`McapRecording`; this facade only
    joins the indexes for browser playback.  It deliberately does not rewrite
    MCAP bytes, so a damaged segment can be diagnosed independently and the
    import never creates a second full-size merged file.
    """

    def __init__(self, recordings, display_name=None, display_path=None, segment_rows=None):
        if not recordings:
            raise McapError('segmented session has no complete segments')
        self.recordings = list(recordings)
        self.display_name = display_name or 'segmented-session'
        self.display_path = display_path or self.display_name
        self.segment_rows = list(segment_rows or [])
        self.recording_id = uuid.uuid4().hex
        self._stream_indexes = []
        self._segment_metadata = []
        self.start_time_ns = min(recording.start_time_ns for recording in self.recordings)
        self.end_time_ns = max(recording.end_time_ns for recording in self.recordings)
        self.message_count = sum(recording.message_count for recording in self.recordings)
        self.parse_ms = sum(recording.parse_ms for recording in self.recordings)
        self._closed = False
        labels = [stream.label for stream in self.recordings[0].streams]
        if not labels:
            self.close()
            raise McapError('segmented session contains no video streams')
        for recording in self.recordings:
            current = [stream.label for stream in recording.streams]
            if current != labels:
                self.close()
                raise McapError('segment camera mapping differs between segments')
        self.streams = []
        for stream_id, label in enumerate(labels):
            sources = []
            first = self.recordings[0].streams[stream_id]
            for recording in self.recordings:
                stream = next(item for item in recording.streams if item.label == label)
                sources.extend((recording, index, frame)
                               for index, frame in enumerate(stream.frames))
            proxy = VideoStream(stream_id, first.channel_id, first.topic, label,
                                codec=first.codec, web_codec=first.web_codec)
            # Consumers only use the proxy identity; packet/frame lookup uses
            # _stream_indexes so mmap offsets stay owned by the source object.
            proxy.frames = [item[2] for item in sources]
            self.streams.append(proxy)
            self._stream_indexes.append(sources)
        self._segment_metadata = [recording.metadata() for recording in self.recordings]

    def close(self):
        if self._closed:
            return
        self._closed = True
        for recording in getattr(self, 'recordings', []):
            recording.close()

    @staticmethod
    def _topic_rows(recordings):
        rows = {}
        for recording in recordings:
            for topic in recording.metadata()['topics']:
                row = rows.setdefault(topic['topic'], dict(topic))
                for key in ('messages', 'log_publish_mismatches'):
                    row[key] = row.get(key, 0) + topic.get(key, 0)
                row['first_time_ns'] = min(filter(None, (row.get('first_time_ns'),
                                                          topic.get('first_time_ns'))),
                                           default=None)
                row['last_time_ns'] = max(filter(None, (row.get('last_time_ns'),
                                                         topic.get('last_time_ns'))),
                                          default=None)
                row['min_interval_ns'] = min((value for value in
                    (row.get('min_interval_ns', 0), topic.get('min_interval_ns', 0)) if value),
                    default=0)
                row['max_interval_ns'] = max(row.get('max_interval_ns', 0),
                                             topic.get('max_interval_ns', 0))
        for row in rows.values():
            # A rate over the complete timeline is more useful than a sum of
            # per-segment rates.  The original interval remains available.
            first, last = row.get('first_time_ns'), row.get('last_time_ns')
            row['rate_hz'] = (row['messages'] - 1) * 1e9 / (int(last) - int(first)) \
                if first is not None and last is not None and int(last) > int(first) else 0
            row['source_count'] = 0
        return list(sorted(rows.values(), key=lambda row: row['topic']))

    def metadata(self):
        streams = []
        for stream_id, stream in enumerate(self.streams):
            sources = self._stream_indexes[stream_id]
            timestamps = [frame.publish_time_ns for _, _, frame in sources]
            intervals = [b - a for a, b in zip(timestamps, timestamps[1:])]
            positive = sorted(value for value in intervals if value > 0)
            median_ns = positive[len(positive) // 2] if positive else 0
            times = [(timestamp - self.start_time_ns) / 1e9 for timestamp in timestamps]
            streams.append(dict(
                id=stream_id, label=stream.label, topic=stream.topic, kind='video',
                codec=stream.codec, web_codec=stream.web_codec,
                frame_count=len(sources), times=times,
                timestamps_ns=[str(frame.publish_time_ns) for _, _, frame in sources],
                log_timestamps_ns=[str(frame.log_time_ns) for _, _, frame in sources],
                sequences=[frame.sequence for _, _, frame in sources],
                frame_ids=[str(frame.frame_id or frame.sequence)
                           for _, _, frame in sources],
                sync_frame_ids=[str(frame.frame_id) if frame.frame_id else None
                                for _, _, frame in sources],
                global_frame_sequences=[str(frame.global_frame_sequence)
                                        for _, _, frame in sources],
                clock_generations=[frame.clock_generation for _, _, frame in sources],
                sync_epochs=[frame.sync_epoch for _, _, frame in sources],
                keyframes=[index for index, (_, _, frame) in enumerate(sources)
                           if frame.keyframe],
                fps=1e9 / median_ns if median_ns else 0,
                median_interval_ns=median_ns,
                min_interval_ns=min(positive, default=0),
                max_interval_ns=max(positive, default=0),
                gaps=[index + 1 for index, value in enumerate(intervals)
                      if median_ns and value > median_ns * 1.5],
                gap_events=[dict(index=index + 1, time=times[index + 1],
                                 interval_ms=value / 1e6,
                                 missing=max(1, round(value / median_ns) - 1))
                            for index, value in enumerate(intervals)
                            if median_ns and value > median_ns * 1.5]))
        segment_info = []
        for index, (recording, metadata) in enumerate(zip(self.recordings, self._segment_metadata)):
            row = dict(index=index + 1, path=recording.display_path,
                       start_time_ns=recording.start_time_ns,
                       end_time_ns=recording.end_time_ns,
                       duration=metadata['duration'], size_bytes=recording.path.stat().st_size)
            if index < len(self.segment_rows):
                row.update({key: self.segment_rows[index].get(key)
                            for key in ('index', 'directory', 'start_pulse', 'end_pulse', 'status')
                            if key in self.segment_rows[index]})
            segment_info.append(row)
        sensor_rows = {}
        for metadata in self._segment_metadata:
            for sensor in metadata['sensor_streams']:
                key = (sensor['topic'], sensor['source'])
                row = sensor_rows.setdefault(key, dict(sensor, times=[], timestamps_ns=[],
                                                       log_timestamps_ns=[], sequences=[],
                                                       frame_ids=[], gaps=[]))
                row['times'].extend((int(value) - self.start_time_ns) / 1e9
                                    for value in sensor['timestamps_ns'])
                row['timestamps_ns'].extend(sensor['timestamps_ns'])
                row['log_timestamps_ns'].extend(sensor['log_timestamps_ns'])
                row['sequences'].extend(sensor['sequences'])
                row['frame_ids'].extend(sensor['frame_ids'])
        for row in sensor_rows.values():
            timestamps = [int(value) for value in row['timestamps_ns']]
            intervals = [b - a for a, b in zip(timestamps, timestamps[1:])]
            positive = sorted(value for value in intervals if value > 0)
            row['message_count'] = len(timestamps)
            row['median_interval_ns'] = positive[len(positive) // 2] if positive else 0
            row['min_interval_ns'] = min(positive, default=0)
            row['max_interval_ns'] = max(positive, default=0)
            row['gaps'] = [index + 1 for index, value in enumerate(intervals)
                           if row['median_interval_ns'] and
                           value > row['median_interval_ns'] * 1.5]
        alignments = [metadata['alignment'] for metadata in self._segment_metadata]
        return dict(recording_id=self.recording_id, path=self.display_path,
                    name=self.display_name, size_bytes=sum(row['size_bytes']
                                                           for row in segment_info),
                    start_time_ns=self.start_time_ns, end_time_ns=self.end_time_ns,
                    start_timestamp_ns=str(self.start_time_ns),
                    end_timestamp_ns=str(self.end_time_ns),
                    duration=(self.end_time_ns - self.start_time_ns) / 1e9,
                    message_count=self.message_count, parse_ms=self.parse_ms,
                    alignment=dict(
                        common_frames=sum(item.get('common_frames', 0) for item in alignments),
                        min_span_ns=min((item.get('min_span_ns', 0) for item in alignments),
                                        default=0),
                        p95_span_ns=max((item.get('p95_span_ns', 0) for item in alignments),
                                        default=0),
                        max_span_ns=max((item.get('max_span_ns', 0) for item in alignments),
                                        default=0),
                        exact_frame_counts=len({stream['frame_count'] for stream in streams}) <= 1,
                        log_publish_alignment=all(item.get('log_publish_alignment', True)
                                                  for item in alignments)),
                    topics=self._topic_rows(self.recordings), streams=streams,
                    sensor_streams=sorted(sensor_rows.values(),
                                          key=lambda row: (row['topic'], row['source'])),
                    segments=segment_info)

    def packet_batch(self, stream_id, start, count):
        if not 0 <= stream_id < len(self._stream_indexes):
            raise McapError('unknown video stream')
        sources = self._stream_indexes[stream_id]
        if not 0 <= start <= len(sources):
            raise McapError('frame start is outside stream')
        selected = sources[start:start + count]
        header = bytearray(PACKET_MAGIC + struct.pack('<I', len(selected)))
        payload = bytearray()
        for recording, _, frame in selected:
            relative = (frame.publish_time_ns - self.start_time_ns) / 1e9
            header.extend(struct.pack('<IIdB7x', frame.data_length, frame.sequence,
                                      relative, frame.keyframe))
            payload.extend(recording.map[frame.data_offset:frame.data_offset + frame.data_length])
        return bytes(header + payload)

    def jpeg_frame(self, stream_id, index):
        if not 0 <= stream_id < len(self._stream_indexes):
            raise McapError('unknown video stream')
        sources = self._stream_indexes[stream_id]
        if not 0 <= index < len(sources):
            raise McapError('frame index is outside stream')
        recording, local_index, _ = sources[index]
        local_stream_id = next(item.id for item in recording.streams
                               if item.label == self.streams[stream_id].label)
        return recording.jpeg_frame(local_stream_id, local_index)
