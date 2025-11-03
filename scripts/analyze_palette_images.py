"""
팔레트 형식 PNG 이미지의 컬러 인덱스별 색상과 픽셀 개수 분석
"""
from pathlib import Path
from PIL import Image
import numpy as np
from collections import Counter

# 큰 이미지 파일 허용
Image.MAX_IMAGE_PIXELS = None


def rgb_to_hex(rgb):
    """RGB 튜플을 16진수 색상 코드로 변환"""
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def analyze_palette_image(image_path: Path):
    """단일 팔레트 이미지 분석"""
    print(f"\n{'='*80}")
    print(f"파일: {image_path.name}")
    print(f"{'='*80}")
    
    try:
        img = Image.open(image_path)
        
        # 이미지 모드 확인
        print(f"이미지 모드: {img.mode}")
        print(f"이미지 크기: {img.size[0]}x{img.size[1]} = {img.size[0] * img.size[1]:,} 픽셀")
        
        if img.mode != 'P':
            print(f"[WARN] 팔레트 모드가 아닙니다 (mode: {img.mode})")
            return
        
        # 팔레트 정보 가져오기
        palette = img.getpalette()
        if palette is None:
            print("[ERROR] 팔레트 정보를 가져올 수 없습니다")
            return
        
        # 팔레트 크기 (일반적으로 256색, 하지만 실제 사용되는 색상 수가 더 적을 수 있음)
        palette_size = len(palette) // 3
        print(f"팔레트 크기: {palette_size}색")
        
        # 이미지 데이터를 numpy 배열로 변환
        img_array = np.array(img)
        total_pixels = img_array.size
        
        # 각 인덱스별 픽셀 개수 계산
        unique_indices, counts = np.unique(img_array, return_counts=True)
        
        # 인덱스별 색상 정보 생성
        color_info = []
        for idx, count in zip(unique_indices, counts):
            # 팔레트에서 RGB 값 가져오기
            r = palette[idx * 3]
            g = palette[idx * 3 + 1]
            b = palette[idx * 3 + 2]
            rgb = (r, g, b)
            hex_color = rgb_to_hex(rgb)
            
            percentage = (count / total_pixels) * 100
            
            color_info.append({
                'index': idx,
                'rgb': rgb,
                'hex': hex_color,
                'count': int(count),
                'percentage': percentage
            })
        
        # 인덱스별 픽셀 개수 딕셔너리 생성 (빠른 조회용)
        index_counts = {info['index']: {'count': info['count'], 'percentage': info['percentage']} 
                        for info in color_info}
        
        # 실제 사용된 인덱스 집합
        used_indices = {info['index'] for info in color_info}
        
        # 전체 팔레트 표시 (인덱스 0~31 순서대로, 미사용 인덱스도 모두 포함)
        print(f"\n전체 팔레트 (인덱스 0~31, 인덱스 순서대로 정렬):")
        print(f"{'인덱스':<8} {'RGB':<18} {'HEX':<10} {'사용 여부':<10} {'픽셀 수':>15} {'비율':>10}")
        print("-" * 80)
        
        # 팔레트의 처음 32개 색상 표시 (인덱스 순서대로)
        display_limit = min(32, palette_size)
        for idx in range(display_limit):
            r = palette[idx * 3]
            g = palette[idx * 3 + 1]
            b = palette[idx * 3 + 2]
            rgb = (r, g, b)
            hex_color = rgb_to_hex(rgb)
            
            is_used = "사용" if idx in used_indices else "미사용"
            
            # 사용된 경우 픽셀 개수와 비율 표시
            if idx in used_indices:
                info = index_counts[idx]
                count_str = f"{info['count']:>15,}"
                pct_str = f"{info['percentage']:>9.2f}%"
            else:
                count_str = f"{'0':>15}"
                pct_str = f"{'0.00':>10}%"
            
            rgb_str = f"({r:3d},{g:3d},{b:3d})"
            print(f"{idx:<8} {rgb_str:<18} {hex_color:<10} {is_used:<10} {count_str} {pct_str}")
        
        # 사용된 인덱스 요약
        print(f"\n사용된 컬러 인덱스: {len(used_indices)}개 / {display_limit}개")
        
        return color_info
        
    except Exception as e:
        print(f"[ERROR] 분석 실패: {e}")
        import traceback
        traceback.print_exc()
        return None


def main():
    """메인 함수"""
    print("="*80)
    print("팔레트 형식 PNG 이미지 분석")
    print("="*80)
    
    # 분석할 폴더
    target_dir = Path("D:/project/data/wm-811k/palette_5mb")
    if not target_dir.exists():
        print(f"[ERROR] 폴더를 찾을 수 없습니다: {target_dir}")
        return
    
    # PNG 파일 수집
    png_files = sorted(target_dir.glob("*.png"))
    if not png_files:
        print(f"[ERROR] PNG 파일을 찾을 수 없습니다: {target_dir}")
        return
    
    print(f"\n[INFO] 분석 대상 폴더: {target_dir}")
    print(f"[INFO] 파일 수: {len(png_files)}개\n")
    
    # 각 파일 분석
    all_results = []
    for img_path in png_files:
        result = analyze_palette_image(img_path)
        if result:
            all_results.append((img_path.name, result))
    
    # 전체 요약
    if len(all_results) > 1:
        print(f"\n{'='*80}")
        print("전체 파일 요약")
        print(f"{'='*80}")
        print(f"분석된 파일 수: {len(all_results)}개\n")
        
        # 모든 파일에서 사용된 인덱스 집합
        all_indices = set()
        for _, color_info in all_results:
            all_indices.update(info['index'] for info in color_info)
        
        print(f"모든 파일에서 사용된 인덱스: {sorted(all_indices)}")
        print(f"총 사용 인덱스 수: {len(all_indices)}개")


if __name__ == "__main__":
    main()

