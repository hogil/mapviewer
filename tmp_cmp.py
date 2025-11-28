import time
from pathlib import Path
from PIL import Image
src = Path(r"D:\project\data\wm-811k\composite_map\change\20251127_162449\square_average.png")
for label, params in [
    ("webp_q95", dict(format='WEBP', quality=95, method=4)),
    ("webp_lossless", dict(format='WEBP', lossless=True)),
    ("png_opt", dict(format='PNG', optimize=True, compress_level=9)),
]:
    dst = src.with_name(src.stem + f'_{label}' + src.suffix)
    img = Image.open(src)
    t0=time.time(); img.save(dst, **params); dur=time.time()-t0
    print(label, dst.stat().st_size, f"time {dur:.2f}s")
