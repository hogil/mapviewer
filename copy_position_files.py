"""
palette_3k 이미지들에 대응하는 position 파일 생성
"""
import json
from pathlib import Path

# 경로 설정
source_json = Path(r"D:\project\data\positions\palette_5mb\wafer_palette_5mb.json")
output_dir = Path(r"D:\project\data\positions\palette_3k")
images_dir = Path(r"D:\project\data\wm-811k\palette_3k")

# 출력 디렉토리 생성
output_dir.mkdir(parents=True, exist_ok=True)

# 원본 JSON 로드
with open(source_json, 'r', encoding='utf-8') as f:
    template = json.load(f)

# 모든 PNG 파일 찾기
png_files = sorted(images_dir.glob("*.png"))
print(f"Found {len(png_files)} PNG files")

# 각 이미지에 대응하는 position 파일 생성
for png_file in png_files:
    # 파일명에서 stem 추출 (확장자 제외)
    stem = png_file.stem

    # JSON 데이터 복사 및 업데이트
    positions_data = template.copy()
    positions_data['image_path'] = f"palette_3k/{png_file.name}"
    positions_data['root'] = "palette_3k"
    positions_data['step'] = png_file.name
    positions_data['wafer'] = stem

    # position 파일 저장
    output_file = output_dir / f"{stem}.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(positions_data, f, ensure_ascii=False, indent=2)

    if len(png_files) <= 10 or png_files.index(png_file) % 100 == 0:
        print(f"Created: {output_file.name}")

print(f"\nTotal: {len(png_files)} position files created in {output_dir}")
