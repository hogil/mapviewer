"""
팔레트 이미지의 인덱스를 재구성하는 스크립트
1. 인덱스 1~8을 default의 top 색상으로 채움
2. 인덱스 8~14를 인덱스 9~15로 이동
3. 인덱스 0은 그대로 유지
"""
from pathlib import Path
from PIL import Image
import json


def hex_to_rgb(hex_color):
    """HEX 색상을 RGB로 변환"""
    hex_color = hex_color.lstrip('#')
    return [int(hex_color[i:i+2], 16) for i in (0, 2, 4)]


def reorganize_palette_image(image_path: Path, color_legends_path: Path):
    """단일 이미지의 팔레트를 재구성합니다."""
    try:
        # color-legends.json 로드
        with open(color_legends_path, 'r', encoding='utf-8') as f:
            legends = json.load(f)
        
        default_top = legends['default']['top']
        default_bottom = legends['default']['bottom']
        default_bg = legends['default']['background']
        
        # 이미지 로드
        img = Image.open(image_path)
        
        if img.mode != 'P':
            print(f"  [SKIP] {image_path.name}은 팔레트 모드가 아닙니다 (mode: {img.mode})")
            return False
        
        # 현재 팔레트 가져오기
        old_palette = img.getpalette()
        if old_palette is None:
            print(f"  [ERROR] {image_path.name}에 팔레트가 없습니다")
            return False
        
        # 픽셀 데이터 가져오기 (인덱스만)
        pixels = list(img.getdata())
        
        # 새로운 팔레트 생성 (32색)
        new_palette = [0] * (32 * 3)  # 32색 * 3 (RGB)
        
        # 인덱스 0: 기존 유지 (#FFFFFF)
        old_idx_0_rgb = [old_palette[0], old_palette[1], old_palette[2]]
        new_palette[0:3] = old_idx_0_rgb
        
        # 인덱스 1~8: default의 top 색상으로 채움
        grade_order = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']
        for i, grade in enumerate(grade_order, start=1):
            hex_color = default_top[grade]
            rgb = hex_to_rgb(hex_color)
            new_palette[i*3:(i*3)+3] = rgb
        
        # 인덱스 9~15: 기존 인덱스 8~14를 이동
        # 기존 인덱스 8 → 새 인덱스 9
        # 기존 인덱스 9 → 새 인덱스 10
        # 기존 인덱스 10 → 새 인덱스 11
        # 기존 인덱스 11 → 새 인덱스 12
        # 기존 인덱스 12 → 새 인덱스 13
        # 기존 인덱스 13 → 새 인덱스 14
        # 기존 인덱스 14 → 새 인덱스 15
        for old_idx in range(8, 15):
            new_idx = old_idx + 1
            old_r = old_palette[old_idx * 3]
            old_g = old_palette[old_idx * 3 + 1]
            old_b = old_palette[old_idx * 3 + 2]
            new_palette[new_idx * 3] = old_r
            new_palette[new_idx * 3 + 1] = old_g
            new_palette[new_idx * 3 + 2] = old_b
        
        # 인덱스 16~31: 검은색으로 채움 (사용 안 함)
        for i in range(16, 32):
            new_palette[i*3:(i*3)+3] = [0, 0, 0]
        
        # 픽셀 데이터 재매핑
        # 인덱스 0 → 인덱스 0 (그대로)
        # 인덱스 8~14 → 인덱스 9~15 (이동)
        # 나머지 인덱스는 그대로 (1~7은 새로 정의된 색상으로 사용 가능)
        new_pixels = []
        for old_idx in pixels:
            if old_idx == 0:
                new_pixels.append(0)  # 인덱스 0 유지
            elif 8 <= old_idx <= 14:
                new_pixels.append(old_idx + 1)  # 8→9, 9→10, ..., 14→15
            else:
                # 1~7은 새로 정의된 색상이므로 그대로 유지 (사용되지 않았지만)
                new_pixels.append(old_idx)
        
        # 새 이미지 생성
        new_img = Image.new('P', img.size)
        new_img.putpalette(new_palette)
        new_img.putdata(new_pixels)
        
        # 원본 백업 (선택사항)
        backup_path = image_path.with_suffix('.png.backup')
        if not backup_path.exists():
            img.save(backup_path, 'PNG')
            print(f"  [BACKUP] 백업 생성: {backup_path.name}")
        
        # 새 이미지 저장
        new_img.save(image_path)
        print(f"  [OK] 팔레트 재구성 완료: {image_path.name}")
        return True
        
    except Exception as e:
        print(f"  [ERROR] {image_path.name} 처리 실패: {e}")
        import traceback
        traceback.print_exc()
        return False


def reorganize_folder(folder_path: Path, color_legends_path: Path):
    """폴더 내 모든 PNG 이미지의 팔레트를 재구성합니다."""
    folder_path = Path(folder_path)
    color_legends_path = Path(color_legends_path)
    
    if not folder_path.exists():
        print(f"[ERROR] 폴더가 존재하지 않습니다: {folder_path}")
        return
    
    if not color_legends_path.exists():
        print(f"[ERROR] color-legends.json이 존재하지 않습니다: {color_legends_path}")
        return
    
    # PNG 파일 찾기
    png_files = sorted(folder_path.glob("*.png"))
    png_files = [f for f in png_files if not f.name.endswith('.backup')]
    
    if not png_files:
        print(f"[ERROR] PNG 파일을 찾을 수 없습니다: {folder_path}")
        return
    
    print(f"[INFO] 분석 대상 폴더: {folder_path}")
    print(f"[INFO] 발견된 PNG 파일: {len(png_files)}개\n")
    print("=" * 80)
    
    success_count = 0
    for img_path in png_files:
        print(f"\n[PROCESS] 처리 중: {img_path.name}")
        if reorganize_palette_image(img_path, color_legends_path):
            success_count += 1
    
    print("\n" + "=" * 80)
    print(f"[RESULT] 완료: {success_count}/{len(png_files)}개 파일 처리 성공")
    print("=" * 80)


if __name__ == "__main__":
    import sys
    
    # 기본 경로
    default_folder = Path("D:/project/data/wm-811k/palette_5mb")
    default_legends = Path("D:/project/mapviewer/logs/color-legends.json")
    
    if len(sys.argv) > 1:
        folder_path = Path(sys.argv[1])
    else:
        folder_path = default_folder
    
    if len(sys.argv) > 2:
        legends_path = Path(sys.argv[2])
    else:
        legends_path = default_legends
    
    reorganize_folder(folder_path, legends_path)

