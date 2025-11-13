"""
단일 파일 인덱스 재매핑
인덱스 9-15를 8-14로 변경하고, 인덱스 15를 #000001로 설정
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

def remap_image_indices(image_path: Path):
    """이미지의 인덱스 9-15를 8-14로 재매핑하고, 인덱스 15를 #000001로 설정"""
    try:
        with Image.open(image_path) as img:
            if img.mode != 'P':
                print(f"[ERROR] {image_path.name}: 팔레트 모드가 아님 ({img.mode})")
                return False
            
            # 픽셀 인덱스 추출
            pixel_indices = np.array(img, dtype=np.uint8)
            
            # 인덱스 재매핑: 9-15를 8-14로 당기기
            remapped = pixel_indices.copy()
            
            # 인덱스 9-15를 8-14로 매핑
            for old_idx in range(9, 16):
                new_idx = old_idx - 1
                mask = (pixel_indices == old_idx)
                remapped[mask] = new_idx
            
            # 원본 팔레트 가져오기
            source_palette = img.getpalette()
            
            # 새 팔레트 생성
            new_palette = list(source_palette[:768])
            
            # 인덱스 8-14에 원본 9-15의 색상 복사
            for old_idx in range(9, 15):
                new_idx = old_idx - 1
                old_rgb_start = old_idx * 3
                new_rgb_start = new_idx * 3
                if old_rgb_start + 2 < len(source_palette):
                    new_palette[new_rgb_start] = source_palette[old_rgb_start]
                    new_palette[new_rgb_start + 1] = source_palette[old_rgb_start + 1]
                    new_palette[new_rgb_start + 2] = source_palette[old_rgb_start + 2]
            
            # 인덱스 14에 원본 15의 색상 복사
            if 15 * 3 + 2 < len(source_palette):
                new_palette[14 * 3] = source_palette[15 * 3]
                new_palette[14 * 3 + 1] = source_palette[15 * 3 + 1]
                new_palette[14 * 3 + 2] = source_palette[15 * 3 + 2]
            
            # 인덱스 15를 #000001로 설정
            new_palette[15 * 3] = 0
            new_palette[15 * 3 + 1] = 0
            new_palette[15 * 3 + 2] = 1
            
            # 새 이미지 생성
            new_img = Image.fromarray(remapped, mode='P')
            new_img.putpalette(new_palette)
            
            # 임시 파일로 저장 후 교체
            temp_path = image_path.with_suffix('.tmp.png')
            new_img.save(temp_path, format='PNG', optimize=False, compress_level=0)
            new_img.close()
            
            # 원본 파일 삭제 후 임시 파일을 원본 이름으로 변경
            if image_path.exists():
                image_path.unlink()
            temp_path.rename(image_path)
            
            print(f"[OK] {image_path.name} 처리 완료")
            return True
            
    except Exception as e:
        print(f"[ERROR] {image_path.name}: {e}")
        return False


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="단일 파일 인덱스 재매핑")
    parser.add_argument("image_path", type=str, help="이미지 파일 경로")
    args = parser.parse_args()
    
    image_path = Path(args.image_path)
    if not image_path.exists():
        print(f"[ERROR] 파일이 없습니다: {image_path}")
        sys.exit(1)
    
    print("=" * 80)
    print("인덱스 재매핑 시작")
    print("=" * 80)
    print(f"파일: {image_path.name}")
    print()
    print("인덱스 변경:")
    print("  인덱스 9 → 8")
    print("  인덱스 10 → 9")
    print("  인덱스 11 → 10")
    print("  인덱스 12 → 11")
    print("  인덱스 13 → 12")
    print("  인덱스 14 → 13")
    print("  인덱스 15 → 14")
    print("  인덱스 15 (새로운) → #000001")
    print()
    
    if remap_image_indices(image_path):
        print()
        print("=" * 80)
        print("처리 완료")
        print("=" * 80)
    else:
        print()
        print("=" * 80)
        print("처리 실패")
        print("=" * 80)
        sys.exit(1)

