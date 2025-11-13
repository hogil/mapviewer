"""
인덱스 8 이상 처리 디버깅 스크립트
이미지 1개일 때 high_indices_combined가 올바르게 계산되는지 확인
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.config import IMAGES_ROOT

def test_high_indices_calculation():
    """인덱스 8 이상 처리 테스트"""
    # 테스트 이미지 경로
    test_dir = Path("D:/project/data/wm-811k/palette_3k")
    image_files = sorted([
        f for f in test_dir.iterdir() 
        if f.is_file() and f.suffix.lower() == '.png'
    ])[:1]  # 1개만
    
    if not image_files:
        print("[ERROR] 이미지가 없습니다.")
        return
    
    image_path = image_files[0]
    print(f"[INFO] 테스트 이미지: {image_path.name}")
    
    # 이미지 로드
    with Image.open(image_path) as img:
        width, height = img.size
        print(f"[INFO] 이미지 크기: {width}×{height}")
        
        if img.mode == 'P':
            pixel_indices = np.array(img, dtype=np.uint8)
        else:
            pixel_indices = np.array(img.convert('L'), dtype=np.uint8) // 32
    
    # 인덱스 8 이상 값 확인
    high_mask = (pixel_indices >= 8)
    high_count = np.sum(high_mask)
    print(f"[INFO] 인덱스 8 이상 픽셀 개수: {high_count:,}")
    
    if high_count > 0:
        high_values = pixel_indices[high_mask]
        unique_high = np.unique(high_values)
        print(f"[INFO] 인덱스 8 이상 고유 값: {unique_high}")
        print(f"[INFO] 최댓값: {np.max(high_values)}")
        
        # high_indices_list 시뮬레이션
        high_indices_list = []
        high_values_full = np.where(high_mask, pixel_indices, 0)
        high_indices_list.append(high_values_full)
        
        # high_indices_combined 계산
        high_indices_stack = np.stack(high_indices_list, axis=0)
        print(f"[INFO] high_indices_stack shape: {high_indices_stack.shape}")
        print(f"[INFO] high_indices_stack dtype: {high_indices_stack.dtype}")
        
        high_indices_combined = np.max(high_indices_stack, axis=0).astype(np.uint8)
        print(f"[INFO] high_indices_combined shape: {high_indices_combined.shape}")
        print(f"[INFO] high_indices_combined dtype: {high_indices_combined.dtype}")
        
        # 결과 확인
        result_high_mask = (high_indices_combined > 0)
        result_high_values = high_indices_combined[result_high_mask]
        if len(result_high_values) > 0:
            unique_result = np.unique(result_high_values)
            print(f"[INFO] high_indices_combined 고유 값: {unique_result}")
            print(f"[INFO] high_indices_combined 최댓값: {np.max(result_high_values)}")
            
            # 원본과 비교
            if np.array_equal(unique_high, unique_result):
                print("[OK] 원본과 결과가 일치합니다.")
            else:
                print("[ERROR] 원본과 결과가 다릅니다!")
                print(f"  원본: {unique_high}")
                print(f"  결과: {unique_result}")
        else:
            print("[WARN] high_indices_combined에 값이 없습니다.")
    else:
        print("[INFO] 인덱스 8 이상 픽셀이 없습니다.")

if __name__ == "__main__":
    test_high_indices_calculation()

