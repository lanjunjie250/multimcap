"""Launch a separate player browser with NVIDIA PRIME offload when available."""
import os
from pathlib import Path
import shutil
import subprocess
import webbrowser


def open_browser(port):
    url = 'http://127.0.0.1:%d/' % port
    executable = shutil.which('google-chrome') or shutil.which('chromium')
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    local_chrome = cache / 'rtcamera-offline/chrome/opt/google/chrome/chrome'
    if not executable and local_chrome.is_file():
        executable = str(local_chrome)
    if not executable:
        webbrowser.open(url)
        return
    environment = os.environ.copy()
    graphics_args = ['--use-angle=gl']
    profile_name = 'browser-profile'
    if shutil.which('nvidia-smi'):
        try:
            result = subprocess.run(['nvidia-smi', '-L'], stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=5)
            if result.returncode == 0:
                environment.update(__NV_PRIME_RENDER_OFFLOAD='1',
                                   __GLX_VENDOR_LIBRARY_NAME='nvidia',
                                   __VK_LAYER_NV_optimus='NVIDIA_only')
                graphics_args = ['--use-angle=vulkan',
                                 '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan']
                # Avoid reusing an older OpenGL session, which ignores new flags.
                profile_name = 'nvidia-browser-profile'
        except (OSError, subprocess.TimeoutExpired):
            pass
    profile = cache / 'rtcamera-offline' / profile_name
    subprocess.Popen([executable, '--user-data-dir=' + str(profile), '--no-first-run',
                      '--no-default-browser-check', *graphics_args, url],
                     env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
