"""Set versions and package a verified Windows release."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = {
    'server': ['stt_server.py', 'stt_server.exe', 'stt_server.bat', 'stt_requirements.txt', 'stt_install.bat', 'stt_updater.ps1', 'stt_updates.js', 'stt_update.json'],
    'microphone': ['microphone.plugin.js', 'vosk_models.json', 'stt_engines.json', 'stt_updater.ps1', 'stt_updates.js', 'stt_update.json'],
    'subtitles': ['subtitles.plugin.js', 'stt_updater.ps1', 'stt_updates.js', 'stt_update.json'],
}
SUPPORT = ['stt_updater.ps1', 'stt_updates.js', 'STT_README.txt', 'stt_update.json']

def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise argparse.ArgumentTypeError('Use X.Y.Z')
    return value

def set_versions(release=None, server=None, microphone=None, subtitles=None):
    file = ROOT / 'VERSION.json'
    versions = json.loads(file.read_text(encoding='utf-8-sig'))
    for component, value in [('release', release), ('server', server), ('microphone', microphone), ('subtitles', subtitles)]:
        if value:
            previous = versions[component + '_version']
            if tuple(map(int, value.split('.'))) < tuple(map(int, previous.split('.'))):
                raise ValueError(f'Cannot lower {component} version')
            versions[component + '_version'] = value
    for component, filename in [('server','stt_server.py'), ('microphone','microphone.plugin.js'), ('subtitles','subtitles.plugin.js')]:
        path = ROOT / filename
        source = path.read_text(encoding='utf-8-sig')
        value = versions[component + '_version']
        if component == 'server':
            source = re.sub(r'SERVER_VERSION = "[\d.]+"', f'SERVER_VERSION = "{value}"', source)
            source = re.sub(r'Версия \d+\.\d+\.\d+', f'Версия {value}', source)
        else:
            source = re.sub(r'@version [\d.]+', f'@version {value}', source, count=1)
            if component == 'microphone':
                source = re.sub(r'Microphone · [\d.]+', f'Microphone · {value}', source)
            else:
                source = re.sub(r'Обновление Subtitles · [\d.]+', f'Обновление Subtitles · {value}', source)
        path.write_text(source, encoding='utf-8', newline='\n')
    file.write_text(json.dumps(versions, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return versions

def package(exe, output, versions):
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(exe, output / 'stt_server.exe')
    names = list(dict.fromkeys(sum(COMPONENTS.values(), []) + SUPPORT))
    for name in names:
        if name != 'stt_server.exe': shutil.copyfile(ROOT / name, output / name)
    manifest = {'schema': 1, 'release_version': versions['release_version'], 'components': {}}
    for component, files in COMPONENTS.items():
        manifest['components'][component] = {
            'version': versions[component + '_version'],
            'files': [{'name': name, 'sha256': hashlib.sha256((output/name).read_bytes()).hexdigest()} for name in files],
        }
    (output / 'update-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    checksums = '\n'.join(hashlib.sha256((output/name).read_bytes()).hexdigest() + '  ' + name for name in names) + '\n'
    (output / 'SHA256SUMS.txt').write_text(checksums, encoding='ascii')
    archive = output / f"STT-for-friend-{versions['release_version']}.zip"
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name in names + ['update-manifest.json','SHA256SUMS.txt']: bundle.write(output/name, name)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        for name in names: assert bundle.read(name) == (output/name).read_bytes()
    print(f'Verified release: {archive}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for component in ['release','server','microphone','subtitles']: parser.add_argument('--'+component, type=version)
    parser.add_argument('--exe', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'release')
    args = parser.parse_args()
    versions = set_versions(args.release, args.server, args.microphone, args.subtitles)
    if args.exe: package(args.exe, args.output, versions)
    else: print(json.dumps(versions, indent=2))
