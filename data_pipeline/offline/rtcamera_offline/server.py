"""Local offline recording HTTP service."""
import argparse
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import collections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs, urlparse
import uuid
import zipfile

from .archive import extract_session_zip, host_only


from .recording import McapRecording, SegmentedRecording, MCAP_MAGIC
from .errors import McapError
from .paths import find_tool, asset_dir

class PlayerApp:
    def __init__(self, roots, initial=None, max_upload_bytes=64 * 1024 ** 3,
                 merger=None, work_dir=None):
        self.roots = tuple(Path(root).resolve() for root in roots)
        self.max_upload_bytes = max_upload_bytes
        self.upload_directory = tempfile.TemporaryDirectory(prefix='rtcamera-mcap-player-',
                                                            dir=work_dir)
        self.upload_root = Path(self.upload_directory.name)
        self.merger = Path(merger) if merger else find_tool('mcap_merge')
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.readers = collections.Counter()
        self.jobs = {}
        self.import_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="offline-import")
        self.recording = None
        self.uploaded_path = None
        if initial:
            self.open(initial)

    def allowed(self, path):
        path = Path(path).resolve()
        return any(path == root or root in path.parents for root in self.roots)

    def _replace(self, recording, uploaded_path=None):
        metadata = recording.metadata()
        metadata['merged_download'] = (uploaded_path is not None and uploaded_path.is_dir() and
                                       len(list(uploaded_path.glob('merged*.mcap'))) == 1)
        with self.lock:
            previous, self.recording = self.recording, recording
            previous_upload, self.uploaded_path = self.uploaded_path, uploaded_path
            while previous and self.readers[previous]:
                self.condition.wait()
        if previous:
            previous.close()
        if previous_upload and previous_upload != uploaded_path:
            if previous_upload.is_dir():
                shutil.rmtree(previous_upload)
            else:
                previous_upload.unlink(missing_ok=True)
        return metadata

    def _open_archive(self, path, display_name, progress=lambda stage: None):
        host_only()
        if not self.merger.is_file():
            raise McapError('local mcap_merge not found; build data_pipeline/build-host first')
        workspace = Path(tempfile.mkdtemp(prefix='session-', dir=self.upload_root))
        try:
            progress('正在校验并解包 ZIP')
            session = extract_session_zip(path, workspace / 'extracted',
                                          max_uncompressed_bytes=self.max_upload_bytes)
            with (session / 'session.json').open('r') as stream:
                manifest = json.load(stream)
            segment_manifest_path = session / 'segments.json'
            if segment_manifest_path.is_file():
                with segment_manifest_path.open('r') as stream:
                    segment_manifest = json.load(stream)
                rows = segment_manifest.get('segments', [])
                by_directory = {row.get('directory'): row for row in rows
                                if isinstance(row, dict)}
                directories = sorted((child for child in session.iterdir()
                                      if child.is_dir() and child.name.startswith('segment-')),
                                     key=lambda child: child.name)
                if not directories:
                    raise McapError('segmented ZIP contains no segment directory')
                merged_paths = []
                selected_rows = []
                for directory in directories:
                    row = by_directory.get(directory.name)
                    if not row or row.get('status') != 'complete':
                        raise McapError('segmented ZIP contains an unlisted or incomplete segment')
                    inputs = [directory / (label + '.mcap') for label in manifest['cameras']]
                    if any(not item.is_file() or item.is_symlink() for item in inputs):
                        raise McapError('segmented ZIP is missing a camera MCAP')
                    merged = workspace / ('merged-' + directory.name + '.mcap')
                    progress('正在合并 ' + directory.name)
                    with tempfile.TemporaryFile(mode='w+t') as log:
                        result = subprocess.run([str(self.merger), str(merged),
                                                 *map(str, inputs)], stdout=log,
                                                stderr=subprocess.STDOUT, check=False)
                        log.seek(0)
                        output = log.read(4096)
                    if result.returncode:
                        raise McapError('MCAP merge failed for %s: %s' %
                                        (directory.name, output.strip()[-1000:]))
                    merged_paths.append(merged)
                    selected_rows.append(row)
                progress('正在建立分段时间轴索引')
                recordings = []
                try:
                    for merged, row in zip(merged_paths, selected_rows):
                        recordings.append(McapRecording(
                            merged, display_name=display_name,
                            display_path='本地 ZIP / %s / %s' %
                            (display_name, row.get('directory', 'segment'))))
                except Exception:
                    for current in recordings:
                        current.close()
                    raise
                recording = SegmentedRecording(recordings, display_name=display_name,
                                               display_path='本地 ZIP / ' + display_name,
                                               segment_rows=selected_rows)
            else:
                inputs = [session / (label + '.mcap') for label in manifest['cameras']]
                merged = workspace / 'merged.mcap'
                progress('正在对齐并合并 MCAP')
                with tempfile.TemporaryFile(mode='w+t') as log:
                    result = subprocess.run([str(self.merger), str(merged), *map(str, inputs)],
                                            stdout=log, stderr=subprocess.STDOUT, check=False)
                    log.seek(0)
                    output = log.read(4096)
                if result.returncode:
                    raise McapError('MCAP merge failed: ' + output.strip()[-1000:])
                progress('正在建立时间轴索引')
                recording = McapRecording(merged, display_name=display_name,
                                          display_path='本地 ZIP / ' + display_name)
            return self._replace(recording, workspace)
        except Exception:
            shutil.rmtree(workspace)
            raise

    def open(self, path, progress=lambda stage: None):
        path = Path(path).resolve()
        if not self.allowed(path):
            raise McapError('file is outside configured roots')
        if not path.is_file():
            raise McapError('recording file not found')
        if path.suffix.lower() == '.zip':
            return self._open_archive(path, path.name, progress)
        if path.suffix.lower() != '.mcap':
            raise McapError('expected an MCAP or session ZIP')
        progress('正在建立时间轴索引')
        return self._replace(McapRecording(path))

    def upload(self, stream, name, length, deferred=False):
        name = Path(name).name
        if not name or Path(name).suffix.lower() not in ('.mcap', '.zip'):
            raise McapError('uploaded file must be an MCAP or session ZIP')
        if not 0 < length <= self.max_upload_bytes:
            raise McapError('uploaded MCAP exceeds the configured size limit')
        path = self.upload_root / ('%s-%s%s' % (
            uuid.uuid4().hex, Path(name).stem[:80], Path(name).suffix.lower()))
        remaining = length
        try:
            with path.open('xb') as output:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise McapError('upload ended before Content-Length')
                    output.write(chunk)
                    remaining -= len(chunk)
            if deferred:
                return self.submit_import(lambda progress: self._open_uploaded(path, name, progress))
            return self._open_uploaded(path, name)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def _open_uploaded(self, path, name, progress=lambda stage: None):
        try:
            if path.suffix == '.zip':
                result = self._open_archive(path, name, progress)
                path.unlink()
                return result
            with path.open('rb') as uploaded:
                if uploaded.read(len(MCAP_MAGIC)) != MCAP_MAGIC:
                    raise McapError('uploaded file is not an MCAP container')
            progress('正在建立时间轴索引')
            recording = McapRecording(path, display_name=name,
                                      display_path='本机文件 / ' + name)
            return self._replace(recording, path)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def submit_import(self, operation):
        with self.lock:
            if any(job['status'] == 'running' for job in self.jobs.values()):
                raise McapError('已有导入任务正在进行，请稍后重试')
            # Retain one job only: large metadata results must not accumulate.
            self.jobs.clear()
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = dict(status='running', stage='正在准备导入')
        def update(**values):
            with self.lock:
                self.jobs[job_id].update(values)
        def run():
            try:
                result = operation(lambda stage: update(stage=stage))
                update(status='complete', recording=result)
            except Exception as exc:
                update(status='error', error=str(exc))
        self.import_pool.submit(run)
        return dict(job_id=job_id)

    def job_status(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise McapError('import job not found')
            return dict(self.jobs[job_id])

    def close(self):
        self.import_pool.shutdown(wait=True)
        with self.lock:
            recording, self.recording = self.recording, None
            while recording and self.readers[recording]:
                self.condition.wait()
        if recording:
            recording.close()
        self.upload_directory.cleanup()

    def metadata(self):
        with self.lock:
            if not self.recording:
                return None
            metadata = self.recording.metadata()
            metadata['merged_download'] = self._merged_download_available()
            return metadata

    def _merged_download_available(self):
        if self.uploaded_path is None or not self.uploaded_path.is_dir():
            return False
        return len(list(self.uploaded_path.glob('merged*.mcap'))) == 1

    @contextmanager
    def recording_lease(self, expected=None):
        with self.lock:
            recording = self.recording
            if not recording:
                raise McapError('no MCAP file is open')
            if expected and expected != recording.recording_id:
                raise McapError('recording changed; reopen the current recording')
            self.readers[recording] += 1
        try:
            yield recording
        finally:
            with self.lock:
                self.readers[recording] -= 1
                if not self.readers[recording]:
                    del self.readers[recording]
                self.condition.notify_all()

    def packets(self, stream, start, count, expected=None):
        with self.recording_lease(expected) as recording:
            return recording.packet_batch(stream, start, count)

    def jpeg_frame(self, stream, index, expected=None):
        with self.recording_lease(expected) as recording:
            return recording.jpeg_frame(stream, index)

    def files(self):
        files = []
        for root in self.roots:
            if not root.exists():
                continue
            for path in root.rglob('*'):
                if path.suffix.lower() not in ('.mcap', '.zip') or not path.is_file():
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                files.append(dict(path=str(path), name=path.name, size_bytes=stat.st_size,
                                  modified_ns=stat.st_mtime_ns))
                if len(files) >= 300:
                    break
        return sorted(files, key=lambda item: item['modified_ns'], reverse=True)

    def merged_file(self):
        with self.lock:
            if not self._merged_download_available():
                raise McapError('no merged session is open')
            return next(self.uploaded_path.glob('merged*.mcap'))

    def open_merged_file(self):
        # Keep the descriptor valid if another import retires this workspace.
        with self.lock:
            return self.merged_file().open('rb')


class PlayerHandler(BaseHTTPRequestHandler):
    server_version = 'RTCameraMcapPlayer/1.0'

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args))

    def reply_json(self, value, status=200):
        body = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def reply_file(self, name, content_type):
        aliases = {'mcap_player.html': 'index.html', 'mcap_player.js': 'player.js',
                   'mcap_player.css': 'player.css'}
        path = Path(__file__).with_name('web') / aliases.get(name, name)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith(('/analysis/', '/assets/')):
                root = asset_dir() if parsed.path.startswith('/assets/') else Path(__file__).with_name('web')
                relative = parsed.path[len('/assets/'):] if parsed.path.startswith('/assets/') else parsed.path[1:]
                path = (root / relative).resolve()
                if not path.is_relative_to(root.resolve()) or not path.is_file():
                    self.reply_json(dict(error='Local asset missing; run rtcamera-offline fetch-assets'), 404)
                    return
                body = path.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(body)
            elif parsed.path == '/api/analysis-capabilities':
                self.reply_json(dict(assets_ready=(asset_dir() / 'hand_landmarker.task').is_file(),
                                     algorithm='hand_landmarks', model='MediaPipe 0.10.32 / float16 v1'))
            elif parsed.path == '/':
                self.reply_file('mcap_player.html', 'text/html; charset=utf-8')
            elif parsed.path == '/mcap_player.js':
                self.reply_file('mcap_player.js', 'text/javascript; charset=utf-8')
            elif parsed.path == '/mcap_player.css':
                self.reply_file('mcap_player.css', 'text/css; charset=utf-8')
            elif parsed.path == '/api/import-status':
                job_id = parse_qs(parsed.query).get('id', [''])[0]
                self.reply_json(self.server.app.job_status(job_id))
            elif parsed.path == '/api/recording':
                self.reply_json(self.server.app.metadata())
            elif parsed.path == '/api/files':
                self.reply_json(dict(files=self.server.app.files()))
            elif parsed.path == '/api/merged-download':
                with self.server.app.open_merged_file() as stream:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Disposition',
                                     'attachment; filename="merged_output.mcap"')
                    self.send_header('Content-Length', str(os.fstat(stream.fileno()).st_size))
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    shutil.copyfileobj(stream, self.wfile, length=1024 * 1024)
            elif parsed.path == '/api/packets':
                query = parse_qs(parsed.query)
                stream = int(query.get('stream', ['-1'])[0])
                start = int(query.get('start', ['0'])[0])
                count = min(120, max(1, int(query.get('count', ['60'])[0])))
                body = self.server.app.packets(stream, start, count, query.get('recording', [None])[0])
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            elif parsed.path == '/api/frame':
                query = parse_qs(parsed.query)
                stream = int(query.get('stream', ['-1'])[0])
                index = int(query.get('index', ['-1'])[0])
                body = self.server.app.jpeg_frame(stream, index, query.get('recording', [None])[0])
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            else:
                self.reply_json(dict(error='not found'), 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (OSError, ValueError, McapError, zipfile.BadZipFile) as exc:
            self.reply_json(dict(error=str(exc)), 400)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == '/api/upload':
                length = int(self.headers.get('Content-Length', '0'))
                name = parse_qs(parsed.query).get('name', [''])[0]
                self.reply_json(self.server.app.upload(self.rfile, name, length, deferred=parse_qs(parsed.query).get('async') == ['1']))
                return
            if parsed.path != '/api/open':
                self.reply_json(dict(error='not found'), 404)
                return
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise McapError('JSON body is required')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise McapError('JSON body must be an object')
            if body.get('async'):
                result = self.server.app.submit_import(lambda progress: self.server.app.open(body.get('path', ''), progress))
            else:
                result = self.server.app.open(body.get('path', ''))
            self.reply_json(result)
        except (OSError, ValueError, McapError, zipfile.BadZipFile,
                json.JSONDecodeError) as exc:
            self.reply_json(dict(error=str(exc)), 400)


def parse_args():
    parser = argparse.ArgumentParser(description='Local MCAP timeline player')
    parser.add_argument('input', nargs='?', type=Path, help='MCAP or session ZIP to open initially')
    parser.add_argument('--root', action='append', type=Path,
                        help='allowed file root; may be repeated')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--browser', action='store_true', help='open a dedicated browser, preferring NVIDIA PRIME when available')
    parser.add_argument('--max-upload-gib', type=float, default=64,
                        help='maximum browser upload size in GiB (default: 64)')
    parser.add_argument('--merger', type=Path, help='local mcap_merge executable')
    parser.add_argument('--work-dir', type=Path,
                        help='disk with room for ZIP extraction and merged MCAP')
    return parser.parse_args()


def main():
    args = parse_args()
    roots = args.root or [Path.cwd(), Path('/home/gang/Downloads')]
    if args.input:
        roots.append(args.input.resolve().parent)
    if args.max_upload_gib <= 0:
        raise SystemExit('--max-upload-gib must be positive')
    app = PlayerApp(roots, args.input, int(args.max_upload_gib * 1024 ** 3),
                    args.merger, args.work_dir)
    server = ThreadingHTTPServer((args.host, args.port), PlayerHandler)
    server.app = app
    print('RTCamera Offline: http://%s:%d/' % (args.host, server.server_port), flush=True)
    if args.browser:
        from .browser import open_browser
        open_browser(server.server_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()


if __name__ == '__main__':
    main()
