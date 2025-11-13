"""
이미지 인덱스별 색상 및 통계 분석
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.config import IMAGES_ROOT

def analyze_image_indices(image_path: Path):
    """이미지의 인덱스별 색상 및 통계 분석"""
    if not image_path.exists():
        print(f"[ERROR] 이미지가 없습니다: {image_path}")
        return
    
    print("=" * 80)
    print(f"이미지 인덱스 분석: {image_path.name}")
    print("=" * 80)
    
    # 이미지 로드
    with Image.open(image_path) as img:
        width, height = img.size
        print(f"\n이미지 크기: {width}×{height} ({width*height:,} 픽셀)")
        print(f"이미지 모드: {img.mode}")
        
        # 팔레트 추출
        source_palette = None
        if img.mode == 'P':
            source_palette = img.getpalette()
            pixel_indices = np.array(img, dtype=np.uint8)
        else:
            img_l = img.convert('L')
            pixels = np.array(img_l, dtype=np.uint8)
            pixel_indices = (pixels // 32).astype(np.uint8)
        
        total_pixels = width * height
        
        # 인덱스별 통계
        unique_indices, counts = np.unique(pixel_indices, return_counts=True)
        
        print(f"\n총 고유 인덱스: {len(unique_indices)}개")
        print(f"인덱스 범위: {np.min(unique_indices)} ~ {np.max(unique_indices)}")
        
        # 팔레트 RGB 추출
        palette_rgb = {}
        if source_palette:
            for i in range(256):
                palette_idx = i * 3
                if palette_idx + 2 < len(source_palette):
                    palette_rgb[i] = (
                        source_palette[palette_idx],
                        source_palette[palette_idx + 1],
                        source_palette[palette_idx + 2]
                    )
                else:
                    palette_rgb[i] = (128, 128, 128)  # 기본 회색
        else:
            # 그레이스케일인 경우
            for i in range(256):
                palette_rgb[i] = (i, i, i)
        
        # RGB를 HEX로 변환
        def rgb_to_hex(r, g, b):
            return f"#{r:02X}{g:02X}{b:02X}"
        
        print("\n" + "=" * 80)
        print("인덱스별 상세 통계")
        print("=" * 80)
        print(f"{'인덱스':<8} {'RGB':<20} {'HEX':<10} {'개수':>15} {'비율':>10} {'설명':<20}")
        print("-" * 80)
        
        # 인덱스 순서대로 정렬
        sorted_indices = sorted(unique_indices)
        
        for idx in sorted_indices:
            count = counts[unique_indices == idx][0]
            percentage = (count / total_pixels) * 100
            
            r, g, b = palette_rgb.get(idx, (128, 128, 128))
            hex_color = rgb_to_hex(r, g, b)
            
            # 설명
            if idx < 8:
                description = f"인덱스 {idx}"
            elif idx == 8:
                description = "인덱스 8 (경계선?)"
            elif idx == 9:
                description = "인덱스 9 (주황색 선?)"
            elif idx >= 8:
                description = f"인덱스 {idx} (고인덱스)"
            else:
                description = ""
            
            print(f"{idx:<8} ({r:3d},{g:3d},{b:3d}) {hex_color:<10} {count:>15,} {percentage:>9.2f}% {description:<20}")
        
        # 인덱스 0-7 통계
        print("\n" + "=" * 80)
        print("인덱스 0-7 통계")
        print("=" * 80)
        low_indices = [idx for idx in sorted_indices if idx < 8]
        if low_indices:
            low_total = sum(counts[unique_indices == idx][0] for idx in low_indices)
            low_percentage = (low_total / total_pixels) * 100
            print(f"인덱스 0-7 총 픽셀: {low_total:,} ({low_percentage:.2f}%)")
        else:
            print("인덱스 0-7 없음")
        
        # 인덱스 8 이상 통계
        print("\n" + "=" * 80)
        print("인덱스 8 이상 통계")
        print("=" * 80)
        high_indices = [idx for idx in sorted_indices if idx >= 8]
        if high_indices:
            high_total = sum(counts[unique_indices == idx][0] for idx in high_indices)
            high_percentage = (high_total / total_pixels) * 100
            print(f"인덱스 8 이상 총 픽셀: {high_total:,} ({high_percentage:.2f}%)")
            print(f"인덱스 8 이상 고유 값: {high_indices}")
        else:
            print("인덱스 8 이상 없음")
        
        # 인덱스 8과 9 비교
        if 8 in unique_indices and 9 in unique_indices:
            count_8 = counts[unique_indices == 8][0]
            count_9 = counts[unique_indices == 9][0]
            print(f"\n인덱스 8: {count_8:,} 픽셀 ({(count_8/total_pixels)*100:.2f}%)")
            print(f"인덱스 9: {count_9:,} 픽셀 ({(count_9/total_pixels)*100:.2f}%)")
            print(f"인덱스 8 RGB: {palette_rgb[8]}")
            print(f"인덱스 9 RGB: {palette_rgb[9]}")
        
        print("\n" + "=" * 80)

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="이미지 인덱스 분석")
    parser.add_argument("image_path", type=str, help="이미지 경로")
    args = parser.parse_args()
    
    image_path = Path(args.image_path)
    if not image_path.is_absolute():
        # 상대 경로인 경우 IMAGES_ROOT 기준으로 변환 시도
        try:
            image_path = IMAGES_ROOT / image_path
        except:
            pass
    
    analyze_image_indices(image_path)

