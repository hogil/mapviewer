import time
from pathlib import Path
from PIL import Image
src = Path(r"D:\project\data\wm-811k\composite_map\change\20251127_162449\square_average.png")
img = Image.open(src)
print('source', src, 'size', src.stat().st_size)
levels = [0,1,3,6,9]
for lvl in levels:
    dst = src.with_name(f"{src.stem}_opt{lvl}.png")
    t0=time.time(); img.save(dst, format='PNG', optimize=True, compress_level=lvl); dur=time.time()-t0
    print(f"level {lvl}: size {dst.stat().st_size} bytes, time {dur:.2f}s")
    dst.unlink(missing_ok=True)
