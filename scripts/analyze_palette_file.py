"""특정 파일의 팔레트 인덱스 분석 (개인색 설정 전후)"""
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
    print("-" * 100)
    print(f"{'인덱스':<8} {'RGB':<20} {'HEX':<10} {'픽셀 수':<15} {'비율':<12} {'설명':<20}")
    print("-" * 100)
    
    total_pixels = len(pixels)
    
    # 인덱스별 설명 매핑
    index_labels = {
        0: 'Grade0', 1: 'Grade1', 2: 'Grade2', 3: 'Grade3',
        4: 'Grade4', 5: 'Grade5', 6: 'Grade6', 7: 'Grade7',
        8: 'Normal', 9: 'Invalid', 10: 'B285', 11: 'B286', 12: 'B287', 13: 'B288',
        14: 'Background', 15: 'Text'
    }
    
    for idx in range(16):
        r = palette[idx * 3]
        g = palette[idx * 3 + 1]
        b = palette[idx * 3 + 2]
        rgb = (r, g, b)
        hex_color = rgb_to_hex(rgb)
        count = index_counts.get(idx, 0)
        ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
        label = index_labels.get(idx, '')
        
        print(f"{idx:<8} {str(rgb):<20} {hex_color:<10} {count:<15} {ratio:>10.2f}%  {label:<20}")
    
    # Scheme 적용 분석
    if scheme_name:
        print(f"\n{'='*80}")
        print(f"Scheme '{scheme_name}' 적용 분석")
        print(f"{'='*80}\n")
        
        legends = load_color_legends()
        if scheme_name not in legends:
            print(f"[ERROR] Scheme '{scheme_name}'을 찾을 수 없습니다.")
            print(f"사용 가능한 schemes: {list(legends.keys())}")
            return
        
        scheme_data = legends[scheme_name]
        print(f"[Scheme 데이터]")
        print(json.dumps(scheme_data, indent=2, ensure_ascii=False))
        
        # Scheme으로 팔레트 변환
        palette_bytes = get_palette_for_scheme(scheme_data)
        
        print(f"\n[Scheme 적용 후] 팔레트 인덱스 0~15 분석:")
        print("-" * 120)
        print(f"{'인덱스':<8} {'원본 RGB':<20} {'Scheme RGB':<20} {'원본 HEX':<10} {'Scheme HEX':<10} {'설명':<20} {'변경':<10}")
        print("-" * 120)
        
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
            
            label = index_labels.get(idx, '')
            changed = "CHANGED" if orig_rgb != scheme_rgb else "SAME"
            
            print(f"{idx:<8} {str(orig_rgb):<20} {str(scheme_rgb):<20} {orig_hex:<10} {scheme_hex:<10} {label:<20} {changed:<10}")
        
        # 특히 인덱스 14와 15 확인
        print(f"\n[중요] 인덱스 14 (Background) 및 15 (Text) 상세 분석:")
        print("-" * 80)
        
        # 인덱스 14 분석
        orig_14_rgb = (palette[14 * 3], palette[14 * 3 + 1], palette[14 * 3 + 2])
        scheme_14_rgb = (palette_bytes[14 * 3], palette_bytes[14 * 3 + 1], palette_bytes[14 * 3 + 2])
        print(f"인덱스 14 (Background):")
        print(f"  원본: {orig_14_rgb} {rgb_to_hex(orig_14_rgb)}")
        print(f"  Scheme: {scheme_14_rgb} {rgb_to_hex(scheme_14_rgb)}")
        print(f"  Scheme에서 설정된 background: {scheme_data.get('background', 'N/A')}")
        
        # 인덱스 15 분석
        orig_15_rgb = (palette[15 * 3], palette[15 * 3 + 1], palette[15 * 3 + 2])
        scheme_15_rgb = (palette_bytes[15 * 3], palette_bytes[15 * 3 + 1], palette_bytes[15 * 3 + 2])
        print(f"\n인덱스 15 (Text):")
        print(f"  원본: {orig_15_rgb} {rgb_to_hex(orig_15_rgb)}")
        print(f"  Scheme: {scheme_15_rgb} {rgb_to_hex(scheme_15_rgb)}")
        print(f"  Scheme에서 설정된 text: {scheme_data.get('text', 'N/A')}")
        
        # 실제 이미지에 scheme 적용 후 색상 확인
        print(f"\n[실제 이미지 적용 테스트]")
        print("-" * 80)
        try:
            applied_img = swap_first16_colors(img, palette_bytes)
            if applied_img:
                applied_palette = applied_img.getpalette()
                
                print("인덱스별 적용 후 색상 (인덱스 14, 15 중심):")
                for idx in [14, 15]:
                    r = applied_palette[idx * 3]
                    g = applied_palette[idx * 3 + 1]
                    b = applied_palette[idx * 3 + 2]
                    rgb = (r, g, b)
                    hex_color = rgb_to_hex(rgb)
                    count = index_counts.get(idx, 0)
                    ratio = (count / total_pixels * 100) if total_pixels > 0 else 0
                    label = index_labels.get(idx, '')
                    
                    print(f"  인덱스 {idx} ({label}): {rgb} {hex_color} - 픽셀 수: {count}, 비율: {ratio:.2f}%")
        except Exception as e:
            print(f"  [ERROR] 이미지 적용 실패: {e}")
            import traceback
            traceback.print_exc()

if __name__ == '__main__':
    image_path = Path(r"D:\project\data\wm-811k\palette_3k\wafer_palette_0000.png")
    
    if not image_path.exists():
        print(f"[ERROR] 파일을 찾을 수 없습니다: {image_path}")
        sys.exit(1)
    
    # 원본 분석
    analyze_palette(image_path)
    
    # 현재 사용 중인 scheme 적용 분석 (예: 'change' 또는 'default')
    # 먼저 default scheme로 분석
    print("\n\n" + "="*80)
    print("="*80)
    analyze_palette(image_path, scheme_name='default')
    
    # change scheme도 분석
    print("\n\n" + "="*80)
    print("="*80)
    analyze_palette(image_path, scheme_name='change')

