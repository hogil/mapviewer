from PIL import Image
from pathlib import Path
import numpy as np
paths = [
    ("full", Path(r"D:\project\data\wm-811k\composite_map\change\20251127_161352\square_average.png")),
    ("subset", Path(r"D:\project\data\wm-811k\composite_map\change\20251127_161352\square_average_12.png")),
]
for label, p in paths:
    img = Image.open(p).convert('RGB')
    arr = np.array(img)
    flat = arr.reshape(-1,3)
    unique, counts = np.unique(flat, axis=0, return_counts=True)
    idx = None
    for i,cnt in enumerate(counts):
        if cnt==436542:
            idx=i; break
    print(label, 'unique colors', len(unique))
    if idx is not None:
        color = unique[idx]
        print('  count=436542 color', tuple(map(int,color)))
    else:
        print('  count=436542 color not found')
    top_idx = counts.argsort()[::-1][:10]
    for ti in top_idx:
        c = unique[ti]; cnt = counts[ti]
        mark='*' if cnt==436542 else ''
        print('   ', mark, cnt, tuple(map(int,c)))
    img.close()
