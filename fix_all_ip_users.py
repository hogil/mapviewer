#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import shutil
from pathlib import Path
import sys

# Windows 콘솔 인코딩 설정
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def fix_all_ip_users():
    stats_file = Path("logs/stats.json")
    backup_file = Path("logs/stats.json.backup_fix_all_ip")
    
    # 백업 생성
    if stats_file.exists():
        shutil.copy2(stats_file, backup_file)
        print(f"✅ 백업 생성: {backup_file}")
    
    # stats.json 로드
    with open(stats_file, 'r', encoding='utf-8') as f:
        stats_data = json.load(f)
    
    # 사내 SAML claim 7개 필드만 허용
    SAML_FIELDS = ["Username", "LoginId", "Sabun", "DeptName", "GrdName_EN", "GrdName", "x-ms-forwarded-client-ip"]
    
    fixed_count = 0
    empty_profile_count = 0
    cleaned_key_count = 0
    
    for user_id, data in stats_data.get("users", {}).items():
        # IP 형식 체크 (IPv4)
        is_ip_format = user_id.count('.') == 3
        
        if is_ip_format:
            # user_type 설정
            if "user_type" not in data or data["user_type"] != "ip":
                data["user_type"] = "ip"
                fixed_count += 1
            
            # profile 처리
            profile = data.get("profile", {})
            
            # profile이 비어있는 경우 -> 빈 객체로 유지 (백엔드에서 "IP" / "Guest" / "외부"로 표시됨)
            if not profile or len(profile) == 0:
                data["profile"] = {}
                empty_profile_count += 1
            else:
                # profile에 불필요한 키가 있는 경우 -> 7개 필드만 남기고 삭제
                original_keys = set(profile.keys())
                allowed_keys = set(SAML_FIELDS)
                
                # 삭제할 키 찾기
                keys_to_remove = original_keys - allowed_keys
                
                if keys_to_remove:
                    for key in keys_to_remove:
                        del profile[key]
                        cleaned_key_count += 1
                    print(f"  🧹 {user_id}: 불필요한 키 삭제 - {keys_to_remove}")
                
                # profile을 업데이트
                data["profile"] = profile
            
            # first_access_time이 없는 경우 추가
            if "first_access_time" not in data:
                first_seen = data.get("first_seen", "2025-01-01")
                last_access = data.get("last_access_time")
                if last_access:
                    data["first_access_time"] = last_access
                else:
                    data["first_access_time"] = f"{first_seen} 00:00:00"
                fixed_count += 1
    
    # stats.json 저장
    with open(stats_file, 'w', encoding='utf-8') as f:
        json.dump(stats_data, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ IP 사용자 정보 수정 완료")
    print(f"   - user_type 수정: {fixed_count}")
    print(f"   - 빈 profile 처리: {empty_profile_count}")
    print(f"   - 불필요한 키 삭제: {cleaned_key_count}")
    print(f"   - 총 사용자 수: {len(stats_data.get('users', {}))}")
    print(f"\n💾 원본 백업: {backup_file}")

if __name__ == "__main__":
    fix_all_ip_users()

