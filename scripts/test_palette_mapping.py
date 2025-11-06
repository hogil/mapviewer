"""팔레트 인덱스 매핑 테스트"""
import sys
from pathlib import Path

project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from api.personal_colors import load_color_legends, get_palette_for_scheme, _hex_to_rgb_triple

def test_palette_mapping():
    """팔레트 인덱스 매핑이 올바른지 테스트"""
    legends = load_color_legends()
    default = legends.get('default')
    
    if not default:
        print("ERROR: default scheme을 찾을 수 없습니다.")
        return
    
    print("=" * 80)
    print("Default Scheme 분석")
    print("=" * 80)
    print(f"background: {default.get('background')}")
    print(f"text: {default.get('text')}")
    
    # 팔레트 생성
    palette_bytes = get_palette_for_scheme(default)
    
    # 인덱스 14 확인 (변경 후: text → 14)
    idx_14_r = palette_bytes[14 * 3]
    idx_14_g = palette_bytes[14 * 3 + 1]
    idx_14_b = palette_bytes[14 * 3 + 2]
    text_hex = default.get('text', '#000001')
    expected_text = _hex_to_rgb_triple(text_hex)
    
    print(f"\n인덱스 14 (Text → 실제 배경으로 사용):")
    print(f"  팔레트: RGB({idx_14_r}, {idx_14_g}, {idx_14_b})")
    print(f"  기대값 (text): RGB{expected_text}")
    print(f"  일치: {expected_text == (idx_14_r, idx_14_g, idx_14_b)}")
    
    # 인덱스 15 확인 (변경 후: background → 15)
    idx_15_r = palette_bytes[15 * 3]
    idx_15_g = palette_bytes[15 * 3 + 1]
    idx_15_b = palette_bytes[15 * 3 + 2]
    background_hex = default.get('background', '#FEFEFE')
    expected_bg = _hex_to_rgb_triple(background_hex)
    
    print(f"\n인덱스 15 (Background → 실제 텍스트로 사용):")
    print(f"  팔레트: RGB({idx_15_r}, {idx_15_g}, {idx_15_b})")
    print(f"  기대값 (background): RGB{expected_bg}")
    print(f"  일치: {expected_bg == (idx_15_r, idx_15_g, idx_15_b)}")
    
    # 테스트: text 색을 변경했을 때
    print("\n" + "=" * 80)
    print("테스트: text 색을 #FF0000 (빨강)으로 변경")
    print("=" * 80)
    
    test_scheme = default.copy()
    test_scheme['text'] = '#FF0000'
    
    test_palette = get_palette_for_scheme(test_scheme)
    
    # 인덱스 14 (Text → 실제 배경) - 변경되어야 함 (text를 #FF0000으로 변경했으므로)
    test_14_r = test_palette[14 * 3]
    test_14_g = test_palette[14 * 3 + 1]
    test_14_b = test_palette[14 * 3 + 2]
    expected_test_text = _hex_to_rgb_triple('#FF0000')
    
    print(f"\n인덱스 14 (Text → 실제 배경) - 변경되어야 함:")
    print(f"  원본: RGB({idx_14_r}, {idx_14_g}, {idx_14_b})")
    print(f"  테스트: RGB({test_14_r}, {test_14_g}, {test_14_b})")
    print(f"  기대값 (text #FF0000): RGB{expected_test_text}")
    print(f"  올바르게 변경됨: {expected_test_text == (test_14_r, test_14_g, test_14_b)}")
    
    # 인덱스 15 (Background → 실제 텍스트) - 변경되면 안 됨
    test_15_r = test_palette[15 * 3]
    test_15_g = test_palette[15 * 3 + 1]
    test_15_b = test_palette[15 * 3 + 2]
    
    print(f"\n인덱스 15 (Background → 실제 텍스트) - 변경되면 안 됨:")
    print(f"  원본: RGB({idx_15_r}, {idx_15_g}, {idx_15_b})")
    print(f"  테스트: RGB({test_15_r}, {test_15_g}, {test_15_b})")
    print(f"  기대값 (background 유지): RGB{expected_bg}")
    print(f"  변경 안 됨: {expected_bg == (test_15_r, test_15_g, test_15_b)}")

if __name__ == '__main__':
    test_palette_mapping()

