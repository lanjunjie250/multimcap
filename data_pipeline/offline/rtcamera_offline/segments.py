"""Validate complete MCAP segment boundaries on a host."""

import argparse
import json
from pathlib import Path

from .archive import host_only, validate_manifest, validate_segments_manifest
from .errors import McapError
from .recording import McapRecording


def inspect_segment(directory, cameras):
    directory = Path(directory).resolve()
    recordings = []
    errors = []
    rows = []
    try:
        for label in cameras:
            path = directory / (label + '.mcap')
            if not path.is_file() or path.is_symlink():
                errors.append('%s is missing or is a symlink' % label)
                continue
            recording = McapRecording(path)
            recordings.append(recording)
            streams = [stream for stream in recording.streams if stream.label == label]
            if len(streams) != 1:
                errors.append('%s has no unique %s video stream' % (path.name, label))
                continue
            stream = streams[0]
            first = stream.frames[0]
            keyframes = [frame for frame in stream.frames if frame.keyframe]
            rows.append(dict(label=label, frames=len(stream.frames),
                             codec=stream.codec,
                             first_frame_keyframe=bool(first.keyframe),
                             first_frame_id=str(first.frame_id or 0),
                             first_keyframe_id=str(keyframes[0].frame_id or 0)
                             if keyframes else None,
                             last_frame_id=str(stream.frames[-1].frame_id or 0)))
            if not first.keyframe:
                errors.append('%s first frame is not H.265/H.264 IDR' % label)
        if rows:
            first_ids = {row['first_frame_id'] for row in rows if row['first_frame_id'] != '0'}
            if len(first_ids) > 1:
                errors.append('first frame sync pulse differs across cameras')
    except (OSError, McapError) as exc:
        errors.append(str(exc))
    finally:
        for recording in recordings:
            recording.close()
    return dict(directory=directory.name, status='pass' if not errors else 'fail',
                cameras=rows, errors=errors)


def inspect_session(session, selected=None):
    session = Path(session).resolve()
    with (session / 'session.json').open('rb') as stream:
        manifest = json.loads(stream.read(1024 * 1024 + 1))
    cameras = validate_manifest(manifest)
    manifest_path = session / 'segments.json'
    if not manifest_path.is_file():
        raise ValueError('session has no segments.json')
    with manifest_path.open('rb') as stream:
        segment_manifest = json.loads(stream.read(1024 * 1024 + 1))
    rows = validate_segments_manifest(segment_manifest, cameras)
    wanted = None if selected is None else int(selected)
    reports = []
    for row in rows:
        if wanted is not None and row['index'] != wanted:
            continue
        directory = session / row['directory']
        if not directory.is_dir():
            raise ValueError('segment directory is missing: %s' % row['directory'])
        report = inspect_segment(directory, cameras)
        report['index'] = row['index']
        reports.append(report)
    if not reports:
        raise ValueError('requested segment is not present')
    return dict(session=manifest.get('session', session.name), cameras=cameras,
                segments=reports,
                status='pass' if all(item['status'] == 'pass' for item in reports)
                else 'fail')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session', type=Path, help='segmented session directory')
    parser.add_argument('--segment', type=int, help='check only one segment index')
    args = parser.parse_args(argv)
    host_only()
    print(json.dumps(inspect_session(args.session, args.segment),
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, McapError) as exc:
        raise SystemExit(str(exc))
