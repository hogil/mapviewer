#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import shutil
from pathlib import Path
from datetime import datetime, timedelta
import sys

# Windows 콘솔 인코딩 설정
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def fix_all_ip_users():
    stats_file = Path("logs/stats.json")
    
    # 타임스탬프를 포함한 백업 파일명 생성 (덮어쓰기 방지)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = Path(f"logs/stats.json.backup_{timestamp}")
    
    # 백업 생성
    if stats_file.exists():
        shutil.copy2(stats_file, backup_file)
        print(f"✅ 백업 생성: {backup_file}")
    
    # stats.json 로드
    with open(stats_file, 'r', encoding='utf-8') as f:
        stats_data = json.load(f)
    
    # 사내 SAML claim 7개 필드
    SAML_FIELDS = ["Username", "LoginId", "Sabun", "DeptName", "GrdName_EN", "GrdName", "x-ms-forwarded-client-ip"]
    
    fixed_count = 0
    key_replaced_count = 0
    profile_fixed_count = 0
    
    # 새로운 users 딕셔너리 (key 교체를 위해)
    new_users = {}
    
    for user_id, data in stats_data.get("users", {}).items():
        # IP 형식 체크 (IPv4)
        is_ip_format = user_id.count('.') == 3
        
        # profile 처리
        profile = data.get("profile", {})
        old_profile = profile.copy()
        
        # 1. profile 외부에 있는 account, username, department를 profile 내부로 이동
        if "account" in data and data["account"]:
            if "LoginId" not in profile:
                profile["LoginId"] = data["account"]
                print(f"  📝 {user_id}: account → profile.LoginId")
        
        if "username" in data and data["username"]:
            if "Username" not in profile:
                profile["Username"] = data["username"]
                print(f"  📝 {user_id}: username → profile.Username")
        
        if "department" in data and data["department"]:
            if "DeptName" not in profile:
                profile["DeptName"] = data["department"]
                print(f"  📝 {user_id}: department → profile.DeptName")
        
        # 2. IP 형식인 경우 새로운 key 결정 및 profile 채우기
        new_user_id = user_id
        
        if is_ip_format:
            # IP 사용자인데 LoginId가 있으면 key를 LoginId로 교체
            if profile.get("LoginId"):
                new_user_id = profile["LoginId"]
                if new_user_id != user_id:
                    key_replaced_count += 1
                    print(f"  🔄 사용자 Key 교체: {user_id} → {new_user_id}")
            
            # IP 사용자의 7개 필드 채우기
            if "Username" not in profile or not profile["Username"]:
                profile["Username"] = "IP"
            if "LoginId" not in profile or not profile["LoginId"]:
                profile["LoginId"] = user_id  # IP 주소를 LoginId로
            if "Sabun" not in profile or not profile["Sabun"]:
                profile["Sabun"] = "-"
            if "DeptName" not in profile or not profile["DeptName"]:
                profile["DeptName"] = "외부"
            if "GrdName_EN" not in profile or not profile["GrdName_EN"]:
                profile["GrdName_EN"] = "Guest"
            if "GrdName" not in profile or not profile["GrdName"]:
                profile["GrdName"] = "방문자"
            if "x-ms-forwarded-client-ip" not in profile or not profile["x-ms-forwarded-client-ip"]:
                profile["x-ms-forwarded-client-ip"] = user_id
            
            # user_type 설정
            data["user_type"] = "ip"
        else:
            # SAML 사용자 - 빈 필드는 공백으로 처리
            data["user_type"] = "saml"
            
            # 필수 필드가 비어있으면 빈 문자열로 설정 (Guest 등 기본값 사용 안 함)
            for field in SAML_FIELDS:
                if field not in profile or profile[field] is None:
                    profile[field] = ""
        
        # 3. 7개 필드만 남기고 나머지 삭제
        allowed_keys = set(SAML_FIELDS)
        profile_keys = list(profile.keys())
        
        for key in profile_keys:
            if key not in allowed_keys:
                del profile[key]
                print(f"  🧹 {new_user_id}: 불필요한 profile 키 삭제 - {key}")
        
        # profile 업데이트
        data["profile"] = profile
        
        # 4. profile과 동등한 계층에 있는 불필요한 키 삭제
        keys_to_remove = ["account", "username", "department", "position"]
        for key in keys_to_remove:
            if key in data:
                del data[key]
        
        # first_access_time이 없는 경우 추가
        if "first_access_time" not in data:
            first_seen = data.get("first_seen", "2025-01-01")
            last_access = data.get("last_access_time")
            if last_access:
                data["first_access_time"] = last_access
            else:
                data["first_access_time"] = f"{first_seen} 00:00:00"
        
        # primary_ip가 없거나 빈 경우
        if "primary_ip" not in data or not data["primary_ip"]:
            if is_ip_format:
                data["primary_ip"] = user_id
            else:
                # SAML 사용자인 경우 ip_addresses에서 가져오기
                if data.get("ip_addresses") and len(data["ip_addresses"]) > 0:
                    data["primary_ip"] = data["ip_addresses"][0]
        
        # ip_addresses가 리스트가 아닌 경우 수정
        if "ip_addresses" not in data:
            data["ip_addresses"] = [data.get("primary_ip", user_id)]
        elif not isinstance(data["ip_addresses"], list):
            data["ip_addresses"] = [data["ip_addresses"]]
        
        # 새로운 users 딕셔너리에 추가
        if old_profile != profile:
            profile_fixed_count += 1
        
        new_users[new_user_id] = data
        fixed_count += 1
    
    # users 교체
    stats_data["users"] = new_users
    
    # ========== 부서별 통계 집계 ==========
    print(f"\n📊 부서별 통계 집계 중...")
    
    department_stats = {}
    thirty_days_ago = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    
    for user_id, data in new_users.items():
        # localhost IP 제외
        if user_id in ['127.0.0.1', '::1', 'localhost']:
            continue
        
        profile = data.get("profile", {})
        user_type = data.get("user_type", "unknown")
        
        # 부서명 추출
        if user_type == "saml":
            dept_name = profile.get("DeptName") or "부서미지정"
        else:
            dept_name = "외부"
        
        # 부서별 통계 초기화
        if dept_name not in department_stats:
            department_stats[dept_name] = {
                "name": dept_name,
                "user_count": 0,
                "total_requests": 0,
                "new_users_30d": 0,
                "users": []
            }
        
        # 사용자 수 증가
        department_stats[dept_name]["user_count"] += 1
        
        # 30일 내 신규 사용자 체크
        first_seen = data.get("first_seen", "")
        if first_seen >= thirty_days_ago:
            department_stats[dept_name]["new_users_30d"] += 1
        
        # 총 요청 수 계산
        total_requests = 0
        daily_requests = data.get("daily_requests", {})
        for date, count in daily_requests.items():
            total_requests += count
        department_stats[dept_name]["total_requests"] += total_requests
        
        # 사용자 정보 저장
        department_stats[dept_name]["users"].append({
            "user_id": user_id,
            "profile": profile,
            "first_seen": first_seen
        })
    
    # department_stats를 stats.json에 추가
    stats_data["department_stats"] = department_stats
    
    print(f"✅ 부서별 통계 집계 완료: {len(department_stats)}개 부서")
    for dept_name, dept_data in sorted(department_stats.items(), key=lambda x: x[1]["user_count"], reverse=True):
        print(f"   - {dept_name}: {dept_data['user_count']}명, {dept_data['total_requests']}회 요청, 신규 {dept_data['new_users_30d']}명")
    
    # stats.json 저장
    with open(stats_file, 'w', encoding='utf-8') as f:
        json.dump(stats_data, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ IP 사용자 정보 수정 완료")
    print(f"   - 처리한 사용자 수: {fixed_count}")
    print(f"   - 사용자 Key 교체: {key_replaced_count}명")
    print(f"   - Profile 수정: {profile_fixed_count}명")
    print(f"   - 최종 사용자 수: {len(new_users)}")
    print(f"   - 부서 수: {len(department_stats)}")
    print(f"\n💾 원본 백업: {backup_file}")
    print(f"\n⚠️  서버를 재시작해야 변경사항이 적용됩니다!")

if __name__ == "__main__":
    fix_all_ip_users()
