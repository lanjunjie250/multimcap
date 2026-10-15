#!/usr/bin/env python3
"""Analyze a copied multi-camera session and optionally merge it on a host PC."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

from .archive import extract_session_zip, validate_manifest, validate_segments_manifest
from .paths import find_tool


ALIGNMENT = re.compile(
    r'aligned_common_frames=(\d+) first=(\d+):(\d+):(\d+) '
    r'last=(\d+):(\d+):(\d+)')
INPUT = re.compile(
    r'input=(.+?) frames=(\d+) first=(\d+):(\d+):(\d+) '
    r'last=(\d+):(\d+):(\d+) dropped_by_alignment=(\d+)')


def host_only():
    model = Path('/proc/device-tree/model')
    if model.is_file():
        with model.open('rb') as stream:
            name = stream.read(256).lower()
        if any(marker in name for marker in (b'jetson', b'orin', b'tegra')):
            raise ValueError('offline analysis and merge must run on a host, not Orin')


def run(command, timeout=None):
    with tempfile.TemporaryFile(mode='w+t') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                text=True, timeout=timeout, check=False)
        log.seek(0)
        output = log.read(1024 * 1024 + 1)
    if len(output) > 1024 * 1024:
        raise RuntimeError('%s output exceeds 1 MiB limit' % Path(command[0]).name)
    if result.returncode:
        raise RuntimeError('%s failed: %s' % (Path(command[0]).name,
                                              output.strip()[-1000:]))
    return output


def inspect(inspector, path):
    size = path.stat().st_size
    timeout = min(600, max(60, size // (32 * 1024 * 1024) + 30))
    output = run([str(inspector), str(path)], timeout=timeout)
    if 'valid MCAP' not in output:
        raise RuntimeError('%s: inspector did not confirm a valid MCAP' % path)
    match = re.search(r'messages=(\d+)', output)
    return dict(bytes=size, messages=int(match.group(1)) if match else None,
                channels=re.findall(r'channel topic=([^ ]+)', output))


def alignment_report(output):
    match = ALIGNMENT.search(output)
    if not match:
        raise RuntimeError('merger did not report synchronized frame boundaries')
    values = [int(value) for value in match.groups()]
    inputs = {}
    for row in INPUT.finditer(output):
        numbers = [int(value) for value in row.groups()[1:]]
        inputs[Path(row.group(1)).stem] = dict(
            frames=numbers[0], first=numbers[1:4], last=numbers[4:7],
            dropped_by_alignment=numbers[7])
    span = re.search(r'common_frames_total=(\d+) max_timestamp_span_ns=(\d+) '
                     r'max_span_pulse=(\d+)', output)
    return dict(common_frames=values[0], first=values[1:4], last=values[4:7],
                common_frames_total=int(span.group(1)) if span else None,
                max_timestamp_span_ns=int(span.group(2)) if span else None,
                max_span_pulse=int(span.group(3)) if span else None,
                inputs=inputs)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session', nargs='+', type=Path,
                        help='session directory, ZIP, or two or more camera MCAP files')
    parser.add_argument('--output', type=Path, help='optional merged MCAP output path')
    parser.add_argument('--report', type=Path, help='optional JSON report path')
    parser.add_argument('--work-dir', type=Path,
                        help='disk with room to extract the ZIP (default: system temporary directory)')

    parser.add_argument('--inspector', type=Path, default=find_tool('mcap_inspect'))
    parser.add_argument('--merger', type=Path, default=find_tool('mcap_merge'))
    args = parser.parse_args(argv)
    host_only()
    sources = [path.resolve(strict=True) for path in args.session]
    if len(sources) > 1 or sources[0].suffix.lower() == '.mcap':
        if len(sources) < 2 or any(path.suffix.lower() != '.mcap' or
                                   not path.is_file() for path in sources):
            raise ValueError('direct merge requires two or more MCAP files')
        if len(set(sources)) != len(sources) or len({path.stem for path in sources}) != len(sources):
            raise ValueError('direct merge requires distinct camera files and names')
        return analyze_files(args, sources, dict(session='manual_files', source_status='manual'))
    source = sources[0]
    if args.work_dir and not args.work_dir.is_dir():
        raise ValueError('work directory does not exist: %s' % args.work_dir)
    with tempfile.TemporaryDirectory(prefix='rtcamera-session-', dir=args.work_dir) as extraction:
        session = (extract_session_zip(source, extraction) if source.is_file() and
                   source.suffix.lower() == '.zip' else source)
        return analyze_session(args, session)


def analyze_session(args, session):
    with (session / 'session.json').open('rb') as stream:
        manifest_bytes = stream.read(1024 * 1024 + 1)
    if len(manifest_bytes) > 1024 * 1024:
        raise ValueError('session manifest exceeds 1 MiB limit')
    manifest = json.loads(manifest_bytes)
    cameras = validate_manifest(manifest)
    segment_manifest_path = session / 'segments.json'
    if segment_manifest_path.is_file():
        with segment_manifest_path.open('rb') as stream:
            segment_bytes = stream.read(1024 * 1024 + 1)
        if len(segment_bytes) > 1024 * 1024:
            raise ValueError('segment manifest exceeds 1 MiB limit')
        segment_manifest = json.loads(segment_bytes)
        validate_segments_manifest(segment_manifest, cameras)
        return analyze_segmented_session(args, session, manifest, segment_manifest, cameras)
    files = [session / (label + '.mcap') for label in cameras]
    if any(not path.is_file() or path.is_symlink() for path in files):
        raise ValueError('one or more camera MCAP files are missing or symlinks')
    return analyze_files(args, files, dict(
        session=manifest.get('session', session.name), source_status=manifest['status'],
        source_error=manifest.get('error')))


def analyze_segmented_session(args, session, manifest, segment_manifest, cameras):
    """Analyze every complete segment without pretending it is one MCAP."""
    if args.output:
        raise ValueError('segmented session output is not supported; analyze each segment separately')
    rows = []
    by_directory = {row['directory']: row for row in segment_manifest['segments']}
    directories = sorted((item for item in session.iterdir()
                          if item.is_dir() and item.name.startswith('segment-')),
                         key=lambda item: item.name)
    if not directories:
        raise ValueError('segmented session contains no segment directory')
    for directory in directories:
        row = by_directory.get(directory.name)
        if not row or row.get('status') != 'complete':
            raise ValueError('segmented session contains an unlisted or incomplete segment')
        files = [directory / (label + '.mcap') for label in cameras]
        if any(not path.is_file() or path.is_symlink() for path in files):
            raise ValueError('segment %s is missing a camera MCAP' % directory.name)
        rows.append(analyze_files(args, files, dict(
            segment=row.get('index'), directory=directory.name,
            source_status=row.get('status')),
            emit=False))
    report = dict(session=manifest.get('session', session.name),
                  source_status=manifest['status'], cameras=cameras,
                  segmented=True, segments=rows)
    rendered = json.dumps(report, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered)
    else:
        print(rendered, end='')
    return 0


def analyze_files(args, files, report, emit=True):
    for executable in (args.inspector, args.merger):
        if not executable.is_file():
            raise ValueError('tool not found: %s' % executable)

    report['files'] = {path.stem: inspect(args.inspector, path) for path in files}
    if args.output:
        output = args.output.resolve()
        if output.exists():
            raise ValueError('output already exists: %s' % output)
        temporary = output.with_name(output.name + '.partial')
        if temporary.exists():
            raise ValueError('partial output already exists: %s' % temporary)
        output.parent.mkdir(parents=True, exist_ok=True)
        summary = run([str(args.merger), str(temporary), *map(str, files)])
        report['merged'] = inspect(args.inspector, temporary)
        temporary.rename(output)
        report['merged']['path'] = str(output)
    else:
        summary = run([str(args.merger), '--analyze', *map(str, files)])
    report['alignment'] = alignment_report(summary)
    if not emit:
        return report
    rendered = json.dumps(report, indent=2) + '\n'
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered)
    else:
        print(rendered, end='')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile,
            subprocess.TimeoutExpired) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
