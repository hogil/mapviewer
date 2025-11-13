"""
원본 이미지 인덱스 확인 스크립트
로딩 과정에서 인덱스가 변경되는지 확인
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.config import IMAGES_ROOT

def test_original_indices():
    """원본 이미지 인덱스 확인"""
    test_dir = Path("D:/project/data/wm-811k/palette_3k")
    image_files = sorted([
        f for f in test_dir.iterdir() 
        if f.is_file() and f.suffix.lower() == '.png'
    ])[:1]
    
    if not image_files:
        print("[ERROR] 이미지가 없습니다.")
        return
    
    image_path = image_files[0]
    print(f"[INFO] 테스트 이미지: {image_path.name}")
    
    # 원본 이미지 직접 로드
    with Image.open(image_path) as img:
        width, height = img.size
        print(f"[INFO] 이미지 크기: {width}×{height}")
        print(f"[INFO] 이미지 모드: {img.mode}")
        
        if img.mode == 'P':
            # 팔레트 모드: 직접 인덱스 사용
            pixel_indices_direct = np.array(img, dtype=np.uint8)
        else:
            # 다른 모드: 그레이스케일로 변환 후 인덱스화
            img_l = img.convert('L')
            pixels = np.array(img_l, dtype=np.uint8)
            pixel_indices_direct = (pixels // 32).astype(np.uint8)
    
    # _load_pixel_indices 함수로 로드
    from api.composite_map import _load_pixel_indices
    
    rel_path = image_path.relative_to(IMAGES_ROOT)
    pixel_indices_loaded = _load_pixel_indices(str(rel_path), width, height)
    
    if pixel_indices_loaded is None:
        print("[ERROR] 이미지 로드 실패")
        return
    
    # 비교
    print(f"\n[원본 직접 로드]")
    unique_direct = np.unique(pixel_indices_direct)
    print(f"  고유 인덱스: {unique_direct}")
    print(f"  인덱스 8 이상: {unique_direct[unique_direct >= 8]}")
    
    print(f"\n[_load_pixel_indices로 로드]")
    unique_loaded = np.unique(pixel_indices_loaded)
    print(f"  고유 인덱스: {unique_loaded}")
    print(f"  인덱스 8 이상: {unique_loaded[unique_loaded >= 8]}")
    
    # 차이 확인
    if np.array_equal(pixel_indices_direct, pixel_indices_loaded):
        print("\n[OK] 두 방법의 결과가 동일합니다.")
    else:
        print("\n[ERROR] 두 방법의 결과가 다릅니다!")
        diff_mask = (pixel_indices_direct != pixel_indices_loaded)
        diff_count = np.sum(diff_mask)
        print(f"  다른 픽셀 개수: {diff_count:,}")
        
        if diff_count > 0:
            diff_direct = pixel_indices_direct[diff_mask]
            diff_loaded = pixel_indices_loaded[diff_mask]
            print(f"  원본 값 예시: {diff_direct[:10]}")
            print(f"  로드 값 예시: {diff_loaded[:10]}")
            
            # 인덱스 8 이상 차이 확인
            high_mask_direct = (pixel_indices_direct >= 8)
            high_mask_loaded = (pixel_indices_loaded >= 8)
            if not np.array_equal(high_mask_direct, high_mask_loaded):
                print(f"  [ERROR] 인덱스 8 이상 마스크가 다릅니다!")
                print(f"    원본 8 이상 개수: {np.sum(high_mask_direct):,}")
                print(f"    로드 8 이상 개수: {np.sum(high_mask_loaded):,}")

if __name__ == "__main__":
    test_original_indices()

