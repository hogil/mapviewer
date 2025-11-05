"""팔레트 색상 분석 스크립트"""
import sys
from pathlib import Path
from PIL import Image
import json
from collections import Counter

# 프로젝트 루트를 경로에 추가
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.personal_colors import load_color_legends, get_palette_for_scheme, swap_first16_colors

def rgb_to_hex(rgb):
    """RGB 튜플을 HEX 문자열로 변환"""
    return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}".upper()

def analyze_palette(image_path, scheme_name=None):
    """이미지의 팔레트를 분석"""
    print(f"\n{'='*80}")
    print(f"이미지 분석: {image_path}")
    print(f"{'='*80}\n")
    
    img = Image.open(image_path)
    
    if img.mode != 'P':
        print(f"[ERROR] 이미지가 팔레트 모드가 아닙니다. 현재 모드: {img.mode}")
        return
    
    # 원본 팔레트 가져오기
    palette = img.getpalette()
    if not palette:
        print("[ERROR] 팔레트가 없습니다.")
        return
    
    # 인덱스별 픽셀 개수 계산
    pixels = list(img.getdata())
    index_counts = Counter(pixels)
    
    print("[원본] 팔레트 인덱스 0~15 분석:")
    print("-" * 80)
    print(f"{'인덱스':<8} {'RGB':<20} {'HEX':<10} {'픽셀 수':<15} {'비율':<10}")
    print("-" * 80)
    
    total_pixels = len(pixels)
    for idx in range(16):
        r = palette[idx * 3]
        g = palette[idx * 3 + 1]
        b = palette[idx * 3 + 2]
        rgb = (r, g, b)
        hex_color = rgb_to_hex(rgb)
        count = index_counts.get(idx, 0)
        ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
        
        print(f"{idx:<8} {str(rgb):<20} {hex_color:<10} {count:<15} {ratio:.2f}%")
    
    # Scheme 적용 분석
    if scheme_name:
        print(f"\n{'='*80}")
        print(f"Scheme '{scheme_name}' 적용 분석")
        print(f"{'='*80}\n")
        
        legends = load_color_legends()
        if scheme_name not in legends:
            print(f"[ERROR] Scheme '{scheme_name}'을 찾을 수 없습니다.")
            return
        
        scheme_data = legends[scheme_name]
        print(f"[Scheme 데이터]")
        print(json.dumps(scheme_data, indent=2, ensure_ascii=False))
        
        # Scheme으로 팔레트 변환
        palette_bytes = get_palette_for_scheme(scheme_data)
        
        print(f"\n[Scheme 적용 후] 팔레트 인덱스 0~15 분석:")
        print("-" * 80)
        print(f"{'인덱스':<8} {'원본 RGB':<20} {'Scheme RGB':<20} {'원본 HEX':<10} {'Scheme HEX':<10} {'픽셀 수':<15} {'비율':<10}")
        print("-" * 80)
        
        for idx in range(16):
            # 원본 팔레트
            orig_r = palette[idx * 3]
            orig_g = palette[idx * 3 + 1]
            orig_b = palette[idx * 3 + 2]
            orig_rgb = (orig_r, orig_g, orig_b)
            orig_hex = rgb_to_hex(orig_rgb)
            
            # Scheme 적용 후 팔레트
            scheme_r = palette_bytes[idx * 3]
            scheme_g = palette_bytes[idx * 3 + 1]
            scheme_b = palette_bytes[idx * 3 + 2]
            scheme_rgb = (scheme_r, scheme_g, scheme_b)
            scheme_hex = rgb_to_hex(scheme_rgb)
            
            count = index_counts.get(idx, 0)
            ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
            
            changed = "CHANGED" if orig_rgb != scheme_rgb else "SAME"
            print(f"{idx:<8} {str(orig_rgb):<20} {str(scheme_rgb):<20} {orig_hex:<10} {scheme_hex:<10} {count:<15} {ratio:.2f}% {changed}")
        
        # Scheme에서 예상되는 색상 매핑 확인
        print(f"\n[Scheme 색상 매핑]")
        print("-" * 80)
        
        # Top (Grade0~7)
        top = scheme_data.get('top', {})
        print("Top (인덱스 0~7):")
        for i, key in enumerate(['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']):
            color = top.get(key, '#000000')
            print(f"  인덱스 {i}: {key} = {color}")
        
        # Bottom (Normal, Invalid, B285~8)
        bottom = scheme_data.get('bottom', {})
        print("\nBottom (인덱스 8~13):")
        for i, key in enumerate(['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288'], start=8):
            color = bottom.get(key, '#000000')
            print(f"  인덱스 {i}: {key} = {color}")
        
        # Background & Text
        background = scheme_data.get('background', '#000000')
        text = scheme_data.get('text', '#000001')
        print(f"\nBackground (인덱스 14): {background}")
        print(f"Text (인덱스 15): {text}")
        
        # 흰색이 많은 인덱스 확인
        print(f"\n[흰색 분석]")
        print("-" * 80)
        white_indices = []
        for idx in range(16):
            r = palette[idx * 3]
            g = palette[idx * 3 + 1]
            b = palette[idx * 3 + 2]
            if (r, g, b) == (255, 255, 255):
                count = index_counts.get(idx, 0)
                ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
                white_indices.append((idx, count, ratio))
                print(f"  인덱스 {idx}: 흰색, 픽셀 수: {count}, 비율: {ratio:.2f}%")
        
        if white_indices:
            print(f"\n[WARNING] 흰색이 발견된 인덱스: {[idx for idx, _, _ in white_indices]}")
        else:
            print("  흰색이 인덱스 0~15에 없습니다.")
        
        # 실제 이미지에 scheme 적용 후 색상 확인
        print(f"\n[실제 이미지 적용 테스트]")
        print("-" * 80)
        try:
            applied_img = swap_first16_colors(img, palette_bytes)
            if applied_img:
                applied_palette = applied_img.getpalette()
                applied_pixels = list(applied_img.getdata())
                applied_index_counts = Counter(applied_pixels)
                
                print("인덱스별 적용 후 색상:")
                for idx in range(16):
                    r = applied_palette[idx * 3]
                    g = applied_palette[idx * 3 + 1]
                    b = applied_palette[idx * 3 + 2]
                    rgb = (r, g, b)
                    hex_color = rgb_to_hex(rgb)
                    count = applied_index_counts.get(idx, 0)
                    ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
                    
                    # 흰색 체크
                    is_white = rgb == (255, 255, 255) or rgb == (254, 254, 254)
                    white_mark = " [WHITE!]" if is_white else ""
                    
                    print(f"  인덱스 {idx}: {rgb} {hex_color} - 픽셀 수: {count}, 비율: {ratio:.2f}%{white_mark}")
        except Exception as e:
            print(f"  [ERROR] 이미지 적용 실패: {e}")

if __name__ == '__main__':
    image_path = Path(r"D:\project\data\wm-811k\palette_5mb\wafer_palette_5mb.png")
    
    if not image_path.exists():
        print(f"[ERROR] 파일을 찾을 수 없습니다: {image_path}")
        sys.exit(1)
    
    # 원본 분석
    analyze_palette(image_path)
    
    # change scheme 적용 분석
    analyze_palette(image_path, scheme_name='change')

