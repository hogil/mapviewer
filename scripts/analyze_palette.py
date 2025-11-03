"""
팔레트 이미지 분석 스크립트
각 인덱스별 색상과 사용 빈도를 분석합니다.
"""
from pathlib import Path
from collections import Counter, defaultdict
from PIL import Image
import json


def analyze_palette_image(image_path: Path):
    """단일 이미지의 팔레트 정보를 분석합니다."""
    try:
        img = Image.open(image_path)
        
        # 팔레트 모드 확인
        if img.mode != 'P':
            return None, f"Not a palette image (mode: {img.mode})"
        
        # 팔레트 정보 가져오기
        palette = img.getpalette()
        if palette is None:
            return None, "No palette found"
        
        # 팔레트 크기 확인 (보통 768 = 256 * 3 RGB)
        palette_size = len(palette) // 3
        if palette_size == 0:
            return None, "Empty palette"
        
        # 각 픽셀의 인덱스 추출
        pixels = list(img.getdata())
        index_counts = Counter(pixels)
        
        # 인덱스별 색상 정보 구성
        palette_info = {}
        for idx in range(min(palette_size, 256)):  # 최대 256색
            r = palette[idx * 3]
            g = palette[idx * 3 + 1]
            b = palette[idx * 3 + 2]
            count = index_counts.get(idx, 0)
            hex_color = f"#{r:02x}{g:02x}{b:02x}".upper()
            
            palette_info[idx] = {
                "index": idx,
                "rgb": [r, g, b],
                "hex": hex_color,
                "count": count
            }
        
        return palette_info, None
        
    except Exception as e:
        return None, str(e)


def analyze_folder(folder_path: Path):
    """폴더 내 모든 PNG 이미지를 분석합니다."""
    folder_path = Path(folder_path)
    
    if not folder_path.exists():
        print(f"[ERROR] 폴더가 존재하지 않습니다: {folder_path}")
        return
    
    # PNG 파일 찾기
    png_files = sorted(folder_path.glob("*.png"))
    
    if not png_files:
        print(f"[ERROR] PNG 파일을 찾을 수 없습니다: {folder_path}")
        return
    
    print(f"[INFO] 분석 대상 폴더: {folder_path}")
    print(f"[INFO] 발견된 PNG 파일: {len(png_files)}개\n")
    print("=" * 80)
    
    # 전체 통계
    all_palette_info = defaultdict(lambda: {"rgb": None, "hex": None, "total_count": 0, "files": []})
    valid_files = []
    
    # 각 파일 분석
    for img_path in png_files:
        print(f"\n[ANALYZE] 분석 중: {img_path.name}")
        palette_info, error = analyze_palette_image(img_path)
        
        if error:
            print(f"  [WARN] {error}")
            continue
        
        if palette_info:
            valid_files.append(img_path.name)
            print(f"  [OK] 팔레트 모드 확인됨 ({len(palette_info)}개 인덱스)")
            
            # 전체 통계에 추가
            for idx, info in palette_info.items():
                if all_palette_info[idx]["rgb"] is None:
                    all_palette_info[idx]["rgb"] = info["rgb"]
                    all_palette_info[idx]["hex"] = info["hex"]
                
                all_palette_info[idx]["total_count"] += info["count"]
                if info["count"] > 0:
                    all_palette_info[idx]["files"].append({
                        "file": img_path.name,
                        "count": info["count"]
                    })
    
    # 결과 출력
    print("\n" + "=" * 80)
    print("[RESULT] 팔레트 분석 결과 요약")
    print("=" * 80)
    print(f"\n[OK] 분석된 파일: {len(valid_files)}개")
    print(f"[INFO] 사용된 팔레트 인덱스: {len(all_palette_info)}개\n")
    
    # 인덱스별 상세 정보
    print("-" * 80)
    print(f"{'인덱스':<8} {'RGB':<15} {'HEX':<10} {'전체 사용':<12} {'사용 파일 수':<12}")
    print("-" * 80)
    
    # 사용된 인덱스만 정렬하여 출력
    used_indices = sorted([idx for idx, info in all_palette_info.items() if info["total_count"] > 0])
    
    for idx in used_indices:
        info = all_palette_info[idx]
        rgb_str = f"({info['rgb'][0]},{info['rgb'][1]},{info['rgb'][2]})"
        files_count = len([f for f in info["files"] if f["count"] > 0])
        print(f"{idx:<8} {rgb_str:<15} {info['hex']:<10} {info['total_count']:<12,} {files_count:<12}")
    
    # 사용되지 않은 인덱스 출력
    unused_indices = sorted([idx for idx, info in all_palette_info.items() if info["total_count"] == 0])
    if unused_indices:
        print(f"\n[WARN] 사용되지 않은 인덱스: {len(unused_indices)}개")
        print(f"       인덱스: {', '.join(map(str, unused_indices))}")
    
    # 상세 정보 (JSON 출력)
    print("\n" + "=" * 80)
    print("[DETAIL] 상세 정보 (JSON 형식)")
    print("=" * 80)
    
    detailed_result = {
        "folder": str(folder_path),
        "analyzed_files": valid_files,
        "total_indices": len(all_palette_info),
        "used_indices": len(used_indices),
        "palette": {}
    }
    
    for idx in sorted(all_palette_info.keys()):
        info = all_palette_info[idx]
        detailed_result["palette"][idx] = {
            "rgb": info["rgb"],
            "hex": info["hex"],
            "total_count": info["total_count"],
            "used_in_files": len([f for f in info["files"] if f["count"] > 0]),
            "file_details": [f for f in info["files"] if f["count"] > 0]
        }
    
    print(json.dumps(detailed_result, indent=2, ensure_ascii=False))
    
    # JSON 파일로 저장
    output_json = folder_path / "palette_analysis.json"
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(detailed_result, f, indent=2, ensure_ascii=False)
    print(f"\n[SAVED] 상세 정보가 저장되었습니다: {output_json}")


if __name__ == "__main__":
    import sys
    
    # 기본 경로
    default_path = Path("D:/project/data/wm-811k/palette_5mb")
    
    if len(sys.argv) > 1:
        folder_path = Path(sys.argv[1])
    else:
        folder_path = default_path
    
    analyze_folder(folder_path)

