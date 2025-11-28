import time
from pathlib import Path
from PIL import Image
src = Path(r"D:\project\data\wm-811k\composite_map\change\20251127_162449\square_average.png")
original = src.stat().st_size
print('original_bytes', original)
configs = [
    ('webp_q95', dict(format='WEBP', quality=95, method=4)),
    ('webp_lossless', dict(format='WEBP', lossless=True, method=4)),
    ('png_opt', dict(format='PNG', optimize=True, compress_level=9)),
]
results = []
for label, params in configs:
    dst = src.with_name(f"{src.stem}_{label}{src.suffix}")
    img = Image.open(src)
    t0 = time.time(); img.save(dst, **params); dur = time.time() - t0
    size = dst.stat().st_size
    results.append((label, size, dur, dst))
for label, size, dur, dst in results:
    print(label, size, f"{dur:.2f}s")
    dst.unlink(missing_ok=True)
