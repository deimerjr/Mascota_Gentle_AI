import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

frames_dir, out, delay, width = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

LABELS = {
    'rest': 'REPOSO',
    'thinking': 'PENSANDO',
    'coding': 'PROGRAMANDO',
    'verifying': 'VERIFICANDO',
    'singing': 'CANTANDO',
    'attention': 'TE NECESITA',
    'done': 'TERMINADO',
    'error': 'ERROR',
}

def font(size):
    for candidate in (
        r'C:\Windows\Fonts\segoeui.ttf',
        r'C:\Windows\Fonts\arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ):
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()

label_font = font(13)
files = sorted(name for name in os.listdir(frames_dir) if name.endswith('.png'))
frames = []
for name in files:
    match = re.search(r'-([a-z]+)\.png$', name)
    label = LABELS.get(match.group(1) if match else '', '')
    image = Image.open(os.path.join(frames_dir, name)).convert('RGB')
    ratio = width / image.width
    image = image.resize((width, round(image.height * ratio)), Image.LANCZOS)
    canvas = Image.new('RGB', (width, image.height + 26), (20, 22, 27))
    canvas.paste(image, (0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, image.height + 5), label, fill=(222, 222, 232), font=label_font)
    frames.append(canvas)

frames[0].save(
    out,
    save_all=True,
    append_images=frames[1:],
    duration=delay,
    loop=0,
    optimize=True,
    disposal=2,
)
print('[gif] escrito ' + out + ' (' + str(os.path.getsize(out) // 1024) + ' KB)')
