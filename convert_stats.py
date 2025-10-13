#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
기존 stats.json을 LoginId 기준 형식으로 변환하는 스크립트
"""
import json
import shutil
from pathlib import Path
import sys

# Windows 콘솔 인코딩 설정
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def convert_stats():
    stats_file = Path("logs/stats.json")
    backup_file = Path("logs/stats.json.backup")
    
    # 백업 생성
    if stats_file.exists():
        shutil.copy2(stats_file, backup_file)
        print(f"✅ 백업 생성: {backup_file}")
    
    # stats.json 로드
    with open(stats_file, 'r', encoding='utf-8') as f:
        stats_data = json.load(f)
    
    # 사내 SAML claim 7개 필드
    SAML_FIELDS = ["Username", "LoginId", "Sabun", "DeptName", "GrdName_EN", "GrdName", "x-ms-forwarded-client-ip"]
    
    # users 데이터 변환
    converted_users = {}
    for user_id, data in stats_data.get("users", {}).items():
        # 기존 데이터 복사
        converted_data = data.copy()
        
        # profile 정리: SAML claim 7개만 남기기
        old_profile = converted_data.get("profile", {})
        new_profile = {}
        
        # LoginId 추출 (profile에서 또는 user_id에서)
        login_id = old_profile.get("LoginId") or old_profile.get("LginId")  # 오타 처리
        
        # SAML 7개 필드만 추출
        for field in SAML_FIELDS:
            if field in old_profile:
                new_profile[field] = old_profile[field]
        
        # user_type 결정
        is_ip = user_id.count('.') == 3  # IPv4 형식
        
        if login_id and not is_ip:
            # LoginId가 있고 IP가 아닌 경우 -> SAML 사용자
            converted_data["user_type"] = "saml"
            new_user_id = login_id
            # LoginId를 profile에 추가 (없는 경우)
            if "LoginId" not in new_profile:
                new_profile["LoginId"] = login_id
            converted_data["profile"] = new_profile
        elif login_id and is_ip:
            # LoginId가 profile에 있지만 user_id가 IP인 경우 -> LoginId로 변경
            converted_data["user_type"] = "saml"
            new_user_id = login_id
            # LoginId를 profile에 추가 (없는 경우)
            if "LoginId" not in new_profile:
                new_profile["LoginId"] = login_id
            converted_data["profile"] = new_profile
        else:
            # LoginId가 없는 경우 -> IP 사용자
            converted_data["user_type"] = "ip"
            new_user_id = user_id
            # IP 사용자는 profile을 비움
            converted_data["profile"] = {}
        
        # first_access_time 필드 추가 (없는 경우)
        if "first_access_time" not in converted_data:
            first_seen = converted_data.get("first_seen", "2025-01-01")
            # last_access_time이 있으면 그것 사용, 없으면 first_seen 사용
            if "last_access_time" in converted_data:
                converted_data["first_access_time"] = converted_data["last_access_time"]
            else:
                converted_data["first_access_time"] = f"{first_seen} 00:00:00"
        
        # ip_addresses가 리스트인지 확인
        if "ip_addresses" not in converted_data:
            converted_data["ip_addresses"] = [converted_data.get("primary_ip", user_id)]
        elif not isinstance(converted_data["ip_addresses"], list):
            converted_data["ip_addresses"] = [converted_data["ip_addresses"]]
        
        converted_users[new_user_id] = converted_data
    
    # 변환된 데이터로 업데이트
    stats_data["users"] = converted_users
    
    # stats.json 저장
    with open(stats_file, 'w', encoding='utf-8') as f:
        json.dump(stats_data, f, ensure_ascii=False, indent=2)
    
    print(f"✅ stats.json 변환 완료")
    print(f"   - 총 사용자 수: {len(converted_users)}")
    
    # 사용자 타입별 통계
    ip_users = sum(1 for u in converted_users.values() if u.get("user_type") == "ip")
    saml_users = sum(1 for u in converted_users.values() if u.get("user_type") == "saml")
    
    print(f"   - IP 사용자: {ip_users}")
    print(f"   - SAML 사용자: {saml_users}")
    print(f"\n💾 원본 백업: {backup_file}")

if __name__ == "__main__":
    convert_stats()

