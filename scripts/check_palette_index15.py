"""
인덱스 15의 팔레트 색상 확인
"""
from pathlib import Path
from PIL import Image

image_path = Path("D:/project/data/wm-811k/palette_3k/wafer_palette_5mb_0000.png")

with Image.open(image_path) as img:
    if img.mode != 'P':
        print(f"[ERROR] 팔레트 모드가 아님: {img.mode}")
    else:
        palette = img.getpalette()
        
        # 인덱스 15의 RGB 값
        idx = 15
        r = palette[idx * 3]
        g = palette[idx * 3 + 1]
        b = palette[idx * 3 + 2]
        
        print("=" * 80)
        print("인덱스 15 팔레트 색상 확인")
        print("=" * 80)
        print(f"RGB: ({r}, {g}, {b})")
        print(f"HEX: #{r:02X}{g:02X}{b:02X}")
        print()
        
        if r == 0 and g == 0 and b == 1:
            print("[OK] 인덱스 15가 #000001로 올바르게 설정되었습니다.")
        else:
            print(f"[WARNING] 인덱스 15가 예상과 다릅니다. 예상: #000001, 실제: #{r:02X}{g:02X}{b:02X}")

