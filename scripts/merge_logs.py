#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
로그 파일 병합 스크립트
두 개의 로그 파일을 합쳐서 하나로 만듭니다.
"""

import json
import csv
import sys
from pathlib import Path
from typing import Dict, Any, List
import argparse

def merge_json_logs(old_file: Path, new_file: Path, output_file: Path, simple_mode: bool = False):
    """JSON 로그 파일 병합 (color-legends.json, stats.json, permissions.json 등)"""
    mode_str = "단순 병합" if simple_mode else "스마트 병합"
    print(f"JSON 파일 병합 ({mode_str}): {old_file.name} + {new_file.name} -> {output_file.name}")
    
    # 이전 파일 로드
    old_data = {}
    if old_file.exists():
        with open(old_file, 'r', encoding='utf-8') as f:
            old_data = json.load(f)
        print(f"  이전 파일: {len(old_data)} 개의 키")
    else:
        print(f"  경고: 이전 파일이 존재하지 않습니다: {old_file}")
    
    # 새 파일 로드
    new_data = {}
    if new_file.exists():
        with open(new_file, 'r', encoding='utf-8') as f:
            new_data = json.load(f)
        print(f"  새 파일: {len(new_data)} 개의 키")
    else:
        print(f"  경고: 새 파일이 존재하지 않습니다: {new_file}")
        return False
    
    if simple_mode:
        # 단순 병합: 이전 파일의 모든 키를 유지하고, 새 파일의 키만 추가
        # (같은 키가 있어도 이전 것을 유지)
        merged_data = {**old_data}
        for key, value in new_data.items():
            if key not in merged_data:
                merged_data[key] = value
            else:
                print(f"  경고: 키 '{key}'가 이미 존재합니다. 이전 값을 유지합니다.")
    else:
        # 스마트 병합: 
        # - 같은 키가 있으면 새 파일의 값으로 덮어쓰기 (최신 우선)
        # - 없는 키는 추가
        merged_data = {**old_data, **new_data}
        
        # color-legends.json의 경우, 각 scheme별로 lastModified를 비교하여 최신 것 선택
        if 'lastModified' in str(old_file) or 'color-legends' in str(old_file):
            for key in merged_data:
                if isinstance(merged_data[key], dict):
                    old_mod = old_data.get(key, {}).get('lastModified', '')
                    new_mod = new_data.get(key, {}).get('lastModified', '')
                    # lastModified가 더 최신인 것을 선택
                    if new_mod > old_mod:
                        merged_data[key] = new_data[key]
                    elif old_mod > new_mod:
                        merged_data[key] = old_data[key]
                    else:
                        # 같거나 둘 다 없으면 새 것을 사용
                        merged_data[key] = new_data.get(key, old_data.get(key, {}))
    
    # 결과 저장
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(merged_data, f, ensure_ascii=False, indent=2)
    
    print(f"  병합 완료: {len(merged_data)} 개의 키")
    return True

def merge_csv_logs(old_file: Path, new_file: Path, output_file: Path):
    """CSV 로그 파일 병합 (detail_access.csv 등)"""
    print(f"CSV 파일 병합: {old_file.name} + {new_file.name} -> {output_file.name}")
    
    rows = []
    header = None
    
    # 이전 파일 읽기
    if old_file.exists():
        with open(old_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header:
                rows.extend(list(reader))
        print(f"  이전 파일: {len(rows)} 개의 행")
    else:
        print(f"  경고: 이전 파일이 존재하지 않습니다: {old_file}")
    
    # 새 파일 읽기 (헤더 제외)
    if new_file.exists():
        with open(new_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            new_header = next(reader, None)
            if not header and new_header:
                header = new_header
            new_rows = list(reader)
            rows.extend(new_rows)
        print(f"  새 파일: {len(new_rows)} 개의 행 추가")
    else:
        print(f"  경고: 새 파일이 존재하지 않습니다: {new_file}")
        return False
    
    # 중복 제거 (같은 행이 있으면 하나만 유지)
    seen = set()
    unique_rows = []
    for row in rows:
        row_tuple = tuple(row)
        if row_tuple not in seen:
            seen.add(row_tuple)
            unique_rows.append(row)
    
    print(f"  중복 제거 후: {len(unique_rows)} 개의 행")
    
    # 결과 저장
    with open(output_file, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        if header:
            writer.writerow(header)
        writer.writerows(unique_rows)
    
    print(f"  병합 완료")
    return True

def merge_text_logs(old_file: Path, new_file: Path, output_file: Path):
    """텍스트 로그 파일 병합 (access.log 등)"""
    print(f"텍스트 파일 병합: {old_file.name} + {new_file.name} -> {output_file.name}")
    
    lines = []
    
    # 이전 파일 읽기
    if old_file.exists():
        with open(old_file, 'r', encoding='utf-8') as f:
            old_lines = f.readlines()
            lines.extend(old_lines)
        print(f"  이전 파일: {len(old_lines)} 개의 행")
    else:
        print(f"  경고: 이전 파일이 존재하지 않습니다: {old_file}")
    
    # 새 파일 읽기
    if new_file.exists():
        with open(new_file, 'r', encoding='utf-8') as f:
            new_lines = f.readlines()
            lines.extend(new_lines)
        print(f"  새 파일: {len(new_lines)} 개의 행 추가")
    else:
        print(f"  경고: 새 파일이 존재하지 않습니다: {new_file}")
        return False
    
    # 결과 저장
    with open(output_file, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    print(f"  병합 완료: 총 {len(lines)} 개의 행")
    return True

def main():
    parser = argparse.ArgumentParser(
        description='로그 파일 병합 스크립트',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
사용 예시:
  # JSON 파일 병합 - 스마트 모드 (기본, 같은 키는 새 값으로 덮어쓰기)
  python scripts/merge_logs.py logs/color-legends.json.old logs/color-legends.json logs/color-legends.json
  
  # JSON 파일 병합 - 단순 모드 (같은 키가 있어도 이전 값 유지)
  python scripts/merge_logs.py --simple logs/color-legends.json.old logs/color-legends.json logs/color-legends.json
  
  # CSV 파일 병합 (위아래로 합치고 중복 제거)
  python scripts/merge_logs.py logs/detail_access.csv.old logs/detail_access.csv logs/detail_access.csv
  
  # 텍스트 로그 병합 (단순히 위아래로 합치기)
  python scripts/merge_logs.py logs/access.log.old logs/access.log logs/access.log
        """
    )
    parser.add_argument('old_file', type=Path, help='이전 로그 파일 경로')
    parser.add_argument('new_file', type=Path, help='새 로그 파일 경로')
    parser.add_argument('output_file', type=Path, help='병합된 결과 파일 경로')
    parser.add_argument('--backup', action='store_true', help='기존 output_file을 백업')
    parser.add_argument('--simple', action='store_true', help='JSON 단순 병합 모드 (같은 키가 있어도 이전 값 유지)')
    
    args = parser.parse_args()
    
    # 출력 파일이 이미 존재하면 백업
    if args.backup and args.output_file.exists():
        backup_file = args.output_file.with_suffix(args.output_file.suffix + '.backup')
        import shutil
        shutil.copy2(args.output_file, backup_file)
        print(f"기존 파일 백업: {backup_file}")
    
    # 파일 확장자에 따라 병합 방법 선택
    suffix = args.old_file.suffix.lower()
    
    if suffix == '.json':
        success = merge_json_logs(args.old_file, args.new_file, args.output_file, simple_mode=args.simple)
    elif suffix == '.csv':
        success = merge_csv_logs(args.old_file, args.new_file, args.output_file)
    elif suffix == '.log':
        success = merge_text_logs(args.old_file, args.new_file, args.output_file)
    else:
        print(f"알 수 없는 파일 형식: {suffix}")
        print("지원 형식: .json, .csv, .log")
        return 1
    
    if success:
        print(f"\n✅ 병합 완료: {args.output_file}")
        return 0
    else:
        print(f"\n❌ 병합 실패")
        return 1

if __name__ == '__main__':
    sys.exit(main())

