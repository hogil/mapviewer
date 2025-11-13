"""
원본 파일 찾기 및 인덱스 재매핑
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
import shutil

def remap_image_indices(image_path: Path, output_path: Path = None):
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
            
            # 저장
            if output_path:
                save_path = output_path
            else:
                save_path = image_path
            
            # 임시 파일로 저장 후 교체
            temp_path = save_path.with_suffix('.tmp.png')
            new_img.save(temp_path, format='PNG', optimize=False, compress_level=0)
            new_img.close()
            
            # 원본 파일 삭제 후 임시 파일을 원본 이름으로 변경
            if save_path.exists():
                save_path.unlink()
            temp_path.rename(save_path)
            
            return True
            
    except Exception as e:
        print(f"[ERROR] {image_path.name}: {e}")
        import traceback
        traceback.print_exc()
        return False


def find_original_file():
    """원본 파일 찾기"""
    possible_paths = [
        Path("D:/project/data/wm-811k/palette_3k/wafer_palette_5mb_0001.png"),
        Path("D:/project/data/wm-811k/palette_5mb/wafer_palette_5mb_0001.png"),
        Path("D:/project/data/wm-811k/palette_3k/wafer_palette_5mb_0001.png.bak"),
    ]
    
    for path in possible_paths:
        if path.exists():
            return path
    
    # 백업 파일 찾기
    bak_dir = Path("D:/project/data/wm-811k/palette_3k")
    if bak_dir.exists():
        bak_files = list(bak_dir.glob("*.bak"))
        if bak_files:
            return bak_files[0]
    
    return None


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="팔레트 인덱스 재매핑")
    parser.add_argument("--input", type=str, help="입력 파일 경로")
    parser.add_argument("--output", type=str, help="출력 파일 경로 (선택사항)")
    args = parser.parse_args()
    
    if args.input:
        input_file = Path(args.input)
    else:
        input_file = find_original_file()
    
    if not input_file or not input_file.exists():
        print("[ERROR] 원본 파일을 찾을 수 없습니다.")
        print("--input 옵션으로 파일 경로를 지정해주세요.")
        sys.exit(1)
    
    output_file = Path(args.output) if args.output else None
    
    print("=" * 80)
    print("팔레트 인덱스 재매핑")
    print("=" * 80)
    print(f"입력 파일: {input_file}")
    if output_file:
        print(f"출력 파일: {output_file}")
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
    
    # 백업 파일인 경우 원본 이름으로 복원
    if input_file.suffix == '.bak':
        restored_path = input_file.with_suffix('')
        if not restored_path.exists():
            shutil.copy2(input_file, restored_path)
            print(f"[OK] 백업 파일에서 복원: {restored_path.name}")
            input_file = restored_path
    
    if remap_image_indices(input_file, output_file):
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

