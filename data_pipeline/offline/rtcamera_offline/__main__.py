"""Command line entry point for RTCamera Offline."""
import json
import sys


def main():
    command = sys.argv.pop(1) if len(sys.argv) > 1 else 'serve'
    if command in ('-h', '--help'):
        print('Usage: rtcamera-offline {serve|analyze|check-segments|doctor|fetch-assets} [options]')
        return
    if command == 'serve':
        from .server import main as serve
        serve()
    elif command == 'analyze':
        from .session import main as analyze
        analyze()
    elif command == 'check-segments':
        from .segments import main as check_segments
        check_segments()
    elif command == 'doctor':
        from .diagnostics import diagnose
        print(json.dumps(diagnose(), ensure_ascii=False, indent=2))
    elif command == 'fetch-assets':
        from .assets import fetch_assets
        fetch_assets()
    else:
        raise SystemExit('Usage: rtcamera-offline {serve|analyze|check-segments|doctor|fetch-assets} [options]')


if __name__ == '__main__':
    main()
