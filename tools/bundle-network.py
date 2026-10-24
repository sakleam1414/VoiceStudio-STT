"""Embed the shared helper: BetterDiscord's external JS module compiler is broken."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BEGIN = '// BEGIN GENERATED VOICE STUDIO NETWORK\n'
END = '// END GENERATED VOICE STUDIO NETWORK\n'


def bundle(check=False):
    helper = (ROOT / 'stt_updates.js').read_text(encoding='utf-8-sig')
    block = (BEGIN + 'function createVoiceStudioNetwork() {\n'
             '    const helperModule = {exports: {}};\n'
             '    (function(require, module) {\n'
             + ''.join('        ' + line if line.strip() else line for line in helper.splitlines(keepends=True))
             + '\n    })(require, helperModule);\n'
             '    return helperModule.exports;\n}\n' + END)
    for filename in ('microphone.plugin.js', 'subtitles.plugin.js'):
        target = ROOT / filename
        source = target.read_text(encoding='utf-8-sig')
        if BEGIN in source:
            start = source.index(BEGIN)
            finish = source.index(END, start) + len(END)
            updated = source[:start] + block + source[finish:]
        else:
            position = source.index(' */\n') + len(' */\n')
            updated = source[:position] + block + source[position:]
        if check:
            if updated != source:
                raise SystemExit(f'{filename}: run python tools/bundle-network.py')
        elif updated != source:
            target.write_text(updated, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    bundle(parser.parse_args().check)
