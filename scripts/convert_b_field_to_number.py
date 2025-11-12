#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JSON 파일의 b 필드를 "B0000" 형식에서 숫자만 저장하도록 변환
"""

import json
import sys
from pathlib import Path


def convert_b_field(json_path: Path):
    """JSON 파일의 b 필드를 숫자로 변환"""
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        if 'chips' not in data:
            print(f"[WARN] {json_path}: 'chips' 필드가 없습니다.")
            return False
        
        modified = False
        for chip in data['chips']:
            if 'b' in chip:
                b_value = chip['b']
                # "B0000" 형식인 경우 숫자로 변환
                if isinstance(b_value, str) and b_value.startswith('B'):
                    try:
                        # "B" 제거하고 숫자로 변환
                        num_str = b_value[1:]
                        chip['b'] = int(num_str)
                        modified = True
                    except ValueError:
                        print(f"[WARN] {json_path}: b 값 '{b_value}'를 숫자로 변환할 수 없습니다.")
                elif isinstance(b_value, (int, float)):
                    # 이미 숫자인 경우 그대로 유지
                    chip['b'] = int(b_value)
                    if not isinstance(b_value, int):
                        modified = True
        
        if modified:
            # 백업 생성
            backup_path = json_path.with_suffix('.json.bak')
            if not backup_path.exists():
                with open(backup_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                print(f"[OK] 백업 생성: {backup_path}")
            
            # 원본 파일에 저장
            with open(json_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print(f"[OK] 변환 완료: {json_path}")
            return True
        else:
            print(f"[INFO] {json_path}: 변환할 내용이 없습니다 (이미 숫자 형식이거나 b 필드가 없음).")
            return False
            
    except Exception as e:
        print(f"[ERROR] {json_path}: 오류 발생 - {e}")
        return False


def main():
    if len(sys.argv) < 2:
        print("사용법: python convert_b_field_to_number.py <json_file_path>")
        print("예시: python convert_b_field_to_number.py D:/project/data/positions/palette_5mb/wafer_palette_5mb.json")
        sys.exit(1)
    
    json_path = Path(sys.argv[1])
    
    if not json_path.exists():
        print(f"[ERROR] 파일을 찾을 수 없습니다: {json_path}")
        sys.exit(1)
    
    if json_path.is_dir():
        # 디렉토리인 경우 모든 JSON 파일 변환
        json_files = list(json_path.rglob('*.json'))
        if not json_files:
            print(f"[ERROR] JSON 파일을 찾을 수 없습니다: {json_path}")
            sys.exit(1)
        
        print(f"[INFO] 디렉토리 내 {len(json_files)}개 JSON 파일 변환 시작...")
        success_count = 0
        for json_file in json_files:
            if json_file.name.endswith('.bak'):
                continue
            if convert_b_field(json_file):
                success_count += 1
        print(f"\n[OK] 완료: {success_count}/{len(json_files)}개 파일 변환됨")
    else:
        # 단일 파일 변환
        convert_b_field(json_path)


if __name__ == '__main__':
    main()

