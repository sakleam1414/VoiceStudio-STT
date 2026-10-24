"""Reproducible app icon drawn as code; Pillow is a build dependency only."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
assets = root / 'assets'
assets.mkdir(exist_ok=True)
scale = 4
image = Image.new('RGBA', (256*scale, 256*scale))
draw = ImageDraw.Draw(image)
def box(coords): return tuple(int(v*scale) for v in coords)
draw.rounded_rectangle(box((8,8,248,248)), radius=56*scale, fill='#192238', outline='#435581', width=3*scale)
draw.rounded_rectangle(box((99,46,157,153)), radius=29*scale, fill='#a1a6ff')
draw.arc(box((77,88,179,188)), 0, 180, fill='#59d6e6', width=12*scale)
draw.line(box((128,188,128,212)), fill='#59d6e6', width=12*scale)
draw.rounded_rectangle(box((101,207,155,219)), radius=6*scale, fill='#59d6e6')
draw.ellipse(box((182,50,202,70)), fill='#73e2bc')
icon = image.resize((256,256), Image.Resampling.LANCZOS)
icon.save(assets/'voice-studio.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
icon.resize((48,48),Image.Resampling.LANCZOS).save(assets/'voice-studio.png')
print('Generated assets/voice-studio.ico and voice-studio.png')
