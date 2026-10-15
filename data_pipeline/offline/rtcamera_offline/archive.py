"""Validate and extract a downloaded RTCamera session ZIP with bounded memory."""

import json
from pathlib import Path
import re
import shutil
import stat
import zipfile
from .camera_names import ARCHIVE_CAMERA


CAMERA = ARCHIVE_CAMERA
MAX_MANIFEST_BYTES = 1024 * 1024
# A segmented session contains two manifest files plus one file per camera in
# every segment.  Keep this bounded while allowing a realistic long capture.
MAX_ENTRIES = 4096
SEGMENT = re.compile(r'segment-[0-9]{6}')
CAMERA_FILE = re.compile(r'[A-D][1-3]\.mcap')


def host_only():
    model = Path('/proc/device-tree/model')
    if model.is_file():
        with model.open('rb') as stream:
            name = stream.read(256).lower()
        if any(marker in name for marker in (b'jetson', b'orin', b'tegra')):
            raise ValueError('offline analysis and merge must run on a host, not Orin')


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get('status') not in ('complete', 'error'):
        raise ValueError('session is still active or has an unsupported status')
    cameras = manifest.get('cameras')
    if not isinstance(cameras, list) or len(cameras) < 2 or any(
            not isinstance(label, str) or not CAMERA.fullmatch(label) for label in cameras):
        raise ValueError('session manifest has invalid camera list')
    if len(set(cameras)) != len(cameras):
        raise ValueError('session manifest has duplicate cameras')
    return cameras


def validate_segments_manifest(manifest, cameras):
    """Validate the non-file metadata for a segmented session.

    A single-segment download intentionally carries the complete manifest but
    only one segment directory.  Therefore this function validates all rows,
    while extraction below requires only the rows represented by ZIP members.
    """
    if not isinstance(manifest, dict) or manifest.get('schema_version', 1) != 1:
        raise ValueError('session has an unsupported segment manifest')
    rows = manifest.get('segments')
    if not isinstance(rows, list) or not rows:
        raise ValueError('session has no segment entries')
    seen_indices = set()
    seen_directories = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('segment manifest contains an invalid entry')
        index = row.get('index')
        directory = row.get('directory')
        if (not isinstance(index, int) or index < 1 or index in seen_indices or
                not isinstance(directory, str) or not SEGMENT.fullmatch(directory) or
                directory in seen_directories or row.get('status') not in ('complete', 'deleted')):
            raise ValueError('segment manifest contains an invalid or incomplete segment')
        seen_indices.add(index)
        seen_directories.add(directory)
        declared = row.get('files')
        if declared is not None:
            if not isinstance(declared, dict) or set(declared) - set(cameras):
                raise ValueError('segment manifest contains unexpected camera files')
            for label, item in declared.items():
                if not isinstance(item, dict) or item.get('name', label + '.mcap') != label + '.mcap':
                    raise ValueError('segment manifest contains an invalid camera file')
    return rows


def extract_session_zip(source, destination, max_uncompressed_bytes=1024 ** 4):
    """Extract only the manifest and declared MCAPs; reject unsafe ZIP members."""
    with zipfile.ZipFile(source) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if not entries or len(entries) > MAX_ENTRIES:
            raise ValueError('session ZIP has an invalid number of files')
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names):
            raise ValueError('session ZIP has duplicate names')
        roots = {name.split('/')[0] for name in names}
        if len(roots) != 1:
            raise ValueError('session ZIP must contain one session directory')
        root = roots.pop()
        if root in ('', '.', '..') or not re.fullmatch(r'[A-Za-z0-9_.-]+', root):
            raise ValueError('session ZIP has an unsafe directory name')
        # ZIP member names are protocol paths.  Reject absolute paths,
        # backslashes and dot components before constructing a host path.
        for name in names:
            if ('\\' in name or name.startswith('/') or '\x00' in name or
                    any(part in ('', '.', '..') for part in name.split('/')) or
                    name.split('/')[0] != root):
                # Keep the public error stable for callers that classify this
                # as a multi-root/path-traversal archive rejection.
                raise ValueError('session ZIP must contain one session directory')
        by_name = {entry.filename: entry for entry in entries}
        entry = by_name.get(root + '/session.json')
        if entry is None or entry.file_size > MAX_MANIFEST_BYTES:
            raise ValueError('session ZIP has no bounded session manifest')
        with archive.open(entry) as stream:
            manifest_bytes = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(manifest_bytes) > MAX_MANIFEST_BYTES:
            raise ValueError('session manifest exceeds 1 MiB limit')
        session_manifest = json.loads(manifest_bytes)
        cameras = validate_manifest(session_manifest)
        relative_names = {name[len(root) + 1:] for name in names}
        segmented = 'segments.json' in relative_names
        if segmented:
            segment_entry = by_name.get(root + '/segments.json')
            if segment_entry is None or segment_entry.file_size > MAX_MANIFEST_BYTES:
                raise ValueError('segmented ZIP has no bounded segment manifest')
            with archive.open(segment_entry) as stream:
                segment_bytes = stream.read(MAX_MANIFEST_BYTES + 1)
            if len(segment_bytes) > MAX_MANIFEST_BYTES:
                raise ValueError('segment manifest exceeds 1 MiB limit')
            rows = validate_segments_manifest(json.loads(segment_bytes), cameras)
            directories = {row['directory'] for row in rows}
            actual = set()
            for relative in relative_names:
                parts = relative.split('/')
                if len(parts) == 2 and SEGMENT.fullmatch(parts[0]):
                    if parts[1] not in {label + '.mcap' for label in cameras}:
                        raise ValueError('segmented ZIP has an unexpected camera file')
                    if parts[0] not in directories:
                        raise ValueError('segmented ZIP references an unknown segment')
                    actual.add(parts[0])
                elif relative not in ('session.json', 'segments.json', 'validation.json'):
                    raise ValueError('segmented ZIP has an unexpected file')
            if not actual:
                raise ValueError('segmented ZIP has no camera segment')
            for directory in actual:
                files = {relative.split('/')[1] for relative in relative_names
                         if relative.startswith(directory + '/')}
                if files != {label + '.mcap' for label in cameras}:
                    raise ValueError('segmented ZIP has a missing camera file')
        else:
            required = {'session.json', *(label + '.mcap' for label in cameras)}
            if not required.issubset(relative_names) or relative_names - required - {'validation.json'}:
                raise ValueError('session ZIP has missing or unexpected files')
        if sum(item.file_size for item in entries) > max_uncompressed_bytes:
            raise ValueError('session ZIP exceeds extraction size limit')
        for item in entries:
            mode = (item.external_attr >> 16) & 0xffff
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('session ZIP contains a non-regular file')
            if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('session ZIP uses unsupported compression')
        session = Path(destination) / root
        session.mkdir(parents=True, exist_ok=False)
        for item in entries:
            relative = item.filename[len(root) + 1:]
            target = session / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as input_stream, target.open('xb') as output:
                shutil.copyfileobj(input_stream, output, length=1024 * 1024)
        return session
