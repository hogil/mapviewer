#!/usr/bin/env python3
"""
wafer_palette_5mb.png 파일을 지정된 디렉토리에 3000개 복사합니다.
"""

import shutil
from pathlib import Path
from tqdm import tqdm

def copy_palette_files():
    source_file = Path(r"D:\project\data\wm-811k\palette_5mb\wafer_palette_5mb.png")
    target_dir = Path(r"D:\project\data\wm-811k\palette_3k")
    
    # 원본 파일 존재 확인
    if not source_file.exists():
        print(f"ERROR: 원본 파일이 존재하지 않습니다: {source_file}")
        return
    
    # 대상 디렉토리 생성
    target_dir.mkdir(parents=True, exist_ok=True)
    print(f"대상 디렉토리: {target_dir}")
    
    # 파일 복사 (3000개)
    num_copies = 3000
    print(f"\n{num_copies}개 파일 복사 시작...")
    
    for i in tqdm(range(1, num_copies + 1), desc="복사 중"):
        target_file = target_dir / f"wafer_palette_5mb_{i:04d}.png"
        shutil.copy2(source_file, target_file)
    
    print(f"\n완료! {num_copies}개 파일이 {target_dir}에 복사되었습니다.")

if __name__ == "__main__":
    copy_palette_files()

