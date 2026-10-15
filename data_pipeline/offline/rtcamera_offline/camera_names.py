"""Public camera labels shared by offline indexing and archive validation.

Hardware local VCs remain zero-based. Recorded route metadata, when available,
identifies both old and new recordings without guessing from cameraN alone.
"""
import re

ARCHIVE_CAMERA = re.compile(r'[A-D][0-3]')  # Include legacy zero-based filenames.
PUBLIC_CAMERAS = ('A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C2', 'D2')
_TOPIC_CAMERA = re.compile(r'^(.*?/camera(?:\d+|/[A-D][0-3]))(?:/|$)')


def camera_topic_key(topic):
    match = _TOPIC_CAMERA.search(topic)
    return match.group(1) if match else None


def recorded_camera_name(topic, metadata):
    for key in ('camera_label', 'camera_id', 'sensor_id'):
        label = metadata.get(key, '')
        if ARCHIVE_CAMERA.fullmatch(label):
            return label
    match = re.search(r'/camera/([A-D][0-3])(?:/|$)', topic)
    return match.group(1) if match else None


def route_label(topic, metadata):
    label = recorded_camera_name(topic, metadata)
    local_vc = metadata.get('logical_vc', metadata.get('camera_id_value'))
    link = label[0] if label else None
    if not link and metadata.get('extvc') in ('0', '1', '2', '3'):
        link = 'ABCD'[int(metadata['extvc'])]
    if link and local_vc in ('0', '1', '2'):
        return link + str(int(local_vc) + 1)
    if label:
        # A0 is unambiguously legacy; A1/A2 without route data are ambiguous.
        return label[0] + '1' if label.endswith('0') else label
    return None


def camera_label(topic):
    explicit = route_label(topic, {})
    if explicit:
        return explicit
    match = re.search(r'/camera(\d+)(?:/|$)', topic)
    if match:
        index = int(match.group(1))
        return PUBLIC_CAMERAS[index] if index < len(PUBLIC_CAMERAS) else 'Camera ' + str(index)
    return topic.rstrip('/').split('/')[-2] if '/' in topic.rstrip('/') else topic


def camera_sort_key(label):
    match = re.fullmatch(r'([A-D])(\d+)', label)
    return (0, match.group(1), int(match.group(2))) if match else (1, label, 0)
