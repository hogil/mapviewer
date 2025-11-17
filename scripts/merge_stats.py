#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stats.json 파일 병합 스크립트
두 개의 stats.json 파일을 읽어서 사용자별, 일별, 월별, 부서별 통계를 재계산하여 하나로 병합합니다.
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List, Any, Set
from collections import defaultdict
import argparse

def merge_users(old_users: Dict[str, Any], new_users: Dict[str, Any]) -> Dict[str, Any]:
    """사용자 데이터 병합 - 동일 사용자끼리 중복 제거하고 재계산"""
    merged = {}
    
    # 모든 사용자 ID 수집
    all_user_ids = set(old_users.keys()) | set(new_users.keys())
    
    for user_id in all_user_ids:
        old_user = old_users.get(user_id, {})
        new_user = new_users.get(user_id, {})
        
        if not old_user:
            # 새 사용자만 있는 경우
            merged[user_id] = new_user.copy()
        elif not new_user:
            # 이전 사용자만 있는 경우
            merged[user_id] = old_user.copy()
        else:
            # 두 파일 모두에 있는 경우: 병합
            merged_user = {}
            
            # IP 주소 병합 (중복 제거)
            old_ips = set(old_user.get("ip_addresses", []))
            new_ips = set(new_user.get("ip_addresses", []))
            merged_user["ip_addresses"] = list(old_ips | new_ips)
            merged_user["primary_ip"] = old_user.get("primary_ip") or new_user.get("primary_ip") or merged_user["ip_addresses"][0] if merged_user["ip_addresses"] else ""
            
            # 요청 수 합산
            merged_user["total_requests"] = old_user.get("total_requests", 0) + new_user.get("total_requests", 0)
            
            # 날짜 병합 (중복 제거)
            old_days = set(old_user.get("unique_days", []))
            new_days = set(new_user.get("unique_days", []))
            merged_user["unique_days"] = sorted(list(old_days | new_days))
            
            # first_seen: 더 이른 날짜
            old_first = old_user.get("first_seen", "9999-99-99")
            new_first = new_user.get("first_seen", "9999-99-99")
            merged_user["first_seen"] = min(old_first, new_first)
            
            # last_seen: 더 늦은 날짜
            old_last = old_user.get("last_seen", "0000-00-00")
            new_last = new_user.get("last_seen", "0000-00-00")
            merged_user["last_seen"] = max(old_last, new_last)
            
            # last_access_time: 더 늦은 시간
            old_access = old_user.get("last_access_time", "0000-00-00 00:00:00")
            new_access = new_user.get("last_access_time", "0000-00-00 00:00:00")
            merged_user["last_access_time"] = max(old_access, new_access)
            
            # first_access_time: 더 이른 시간
            old_first_access = old_user.get("first_access_time", "9999-99-99 99:99:99")
            new_first_access = new_user.get("first_access_time", "9999-99-99 99:99:99")
            merged_user["first_access_time"] = min(old_first_access, new_first_access)
            
            # daily_requests 병합 (날짜별로 합산)
            merged_user["daily_requests"] = {}
            for day in old_days | new_days:
                old_count = old_user.get("daily_requests", {}).get(day, 0)
                new_count = new_user.get("daily_requests", {}).get(day, 0)
                merged_user["daily_requests"][day] = old_count + new_count
            
            # endpoints 병합 (엔드포인트별로 합산)
            merged_user["endpoints"] = {}
            all_endpoints = set(old_user.get("endpoints", {}).keys()) | set(new_user.get("endpoints", {}).keys())
            for endpoint in all_endpoints:
                old_count = old_user.get("endpoints", {}).get(endpoint, 0)
                new_count = new_user.get("endpoints", {}).get(endpoint, 0)
                merged_user["endpoints"][endpoint] = old_count + new_count
            
            # session_count, total_session_time 합산
            merged_user["session_count"] = old_user.get("session_count", 0) + new_user.get("session_count", 0)
            merged_user["total_session_time"] = old_user.get("total_session_time", 0) + new_user.get("total_session_time", 0)
            
            # current_session_start: 더 최신 것
            old_session = old_user.get("current_session_start", "0000-00-00 00:00:00")
            new_session = new_user.get("current_session_start", "0000-00-00 00:00:00")
            merged_user["current_session_start"] = max(old_session, new_session)
            
            # sessions 병합 (중복 제거는 어려우므로 합치기)
            merged_user["sessions"] = (old_user.get("sessions", []) + new_user.get("sessions", []))
            
            # profile 정보 병합 (더 많은 정보 우선)
            old_profile = old_user.get("profile", {})
            new_profile = new_user.get("profile", {})
            merged_user["profile"] = {**old_profile, **new_profile}
            
            # user_type
            merged_user["user_type"] = old_user.get("user_type") or new_user.get("user_type") or "unknown"
            
            merged[user_id] = merged_user
    
    return merged

def merge_daily_stats(old_daily: Dict[str, Any], new_daily: Dict[str, Any], merged_users: Dict[str, Any]) -> Dict[str, Any]:
    """일별 통계 병합 및 재계산"""
    merged = {}
    all_dates = set(old_daily.keys()) | set(new_daily.keys())
    
    for date in all_dates:
        old_stat = old_daily.get(date, {})
        new_stat = new_daily.get(date, {})
        
        if not old_stat:
            merged[date] = new_stat.copy()
        elif not new_stat:
            merged[date] = old_stat.copy()
        else:
            # active_users: 합집합 (중복 제거)
            old_active = set(old_stat.get("active_users", []))
            new_active = set(new_stat.get("active_users", []))
            merged[date] = {
                "active_users": sorted(list(old_active | new_active)),
                "new_users": [],
                "total_requests": old_stat.get("total_requests", 0) + new_stat.get("total_requests", 0),
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
            }
            
            # new_users: 합집합 (중복 제거)
            old_new = set(old_stat.get("new_users", []))
            new_new = set(new_stat.get("new_users", []))
            merged[date]["new_users"] = sorted(list(old_new | new_new))
            
            # by_department 병합 (부서별로 합산)
            all_depts = set(old_stat.get("by_department", {}).keys()) | set(new_stat.get("by_department", {}).keys())
            for dept in all_depts:
                old_count = old_stat.get("by_department", {}).get(dept, 0)
                new_count = new_stat.get("by_department", {}).get(dept, 0)
                merged[date]["by_department"][dept] = old_count + new_count
            
            # by_team, by_company, by_org_url도 동일하게 병합
            for key in ["by_team", "by_company", "by_org_url"]:
                all_keys = set(old_stat.get(key, {}).keys()) | set(new_stat.get(key, {}).keys())
                for k in all_keys:
                    old_count = old_stat.get(key, {}).get(k, 0)
                    new_count = new_stat.get(key, {}).get(k, 0)
                    if key not in merged[date]:
                        merged[date][key] = {}
                    merged[date][key][k] = old_count + new_count
    
    return merged

def merge_monthly_stats(old_monthly: Dict[str, Any], new_monthly: Dict[str, Any]) -> Dict[str, Any]:
    """월별 통계 병합 및 재계산"""
    merged = {}
    all_months = set(old_monthly.keys()) | set(new_monthly.keys())
    
    for month in all_months:
        old_stat = old_monthly.get(month, {})
        new_stat = new_monthly.get(month, {})
        
        if not old_stat:
            merged[month] = new_stat.copy()
        elif not new_stat:
            merged[month] = old_stat.copy()
        else:
            # active_users: 합집합 (중복 제거)
            old_active = set(old_stat.get("active_users", []))
            new_active = set(new_stat.get("active_users", []))
            
            # new_users: 합집합 (중복 제거)
            old_new = set(old_stat.get("new_users", []))
            new_new = set(new_stat.get("new_users", []))
            
            merged[month] = {
                "active_users": sorted(list(old_active | new_active)),
                "new_users": sorted(list(old_new | new_new)),
                "total_requests": old_stat.get("total_requests", 0) + new_stat.get("total_requests", 0),
                "month_name": old_stat.get("month_name") or new_stat.get("month_name") or datetime.strptime(month + "-01", "%Y-%m-%d").strftime("%Y년 %m월"),
                "by_department": {},
                "by_team": {},
                "by_company": {},
                "by_org_url": {}
            }
            
            # by_department 병합 (부서별로 합산)
            all_depts = set(old_stat.get("by_department", {}).keys()) | set(new_stat.get("by_department", {}).keys())
            for dept in all_depts:
                old_count = old_stat.get("by_department", {}).get(dept, 0)
                new_count = new_stat.get("by_department", {}).get(dept, 0)
                merged[month]["by_department"][dept] = old_count + new_count
            
            # by_team, by_company, by_org_url도 동일하게 병합
            for key in ["by_team", "by_company", "by_org_url"]:
                all_keys = set(old_stat.get(key, {}).keys()) | set(new_stat.get(key, {}).keys())
                for k in all_keys:
                    old_count = old_stat.get(key, {}).get(k, 0)
                    new_count = new_stat.get(key, {}).get(k, 0)
                    if key not in merged[month]:
                        merged[month][key] = {}
                    merged[month][key][k] = old_count + new_count
    
    return merged

def merge_department_stats(old_dept: Dict[str, Any], new_dept: Dict[str, Any], merged_users: Dict[str, Any]) -> Dict[str, Any]:
    """부서별 통계 병합 및 재계산"""
    merged = {}
    all_depts = set(old_dept.keys()) | set(new_dept.keys())
    
    # 30일 전 날짜 계산
    thirty_days_ago = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    
    for dept_name in all_depts:
        old_stat = old_dept.get(dept_name, {})
        new_stat = new_dept.get(dept_name, {})
        
        if not old_stat:
            merged[dept_name] = new_stat.copy()
        elif not new_stat:
            merged[dept_name] = old_stat.copy()
        else:
            # users 리스트 병합 (중복 제거)
            old_user_list = old_stat.get("users", [])
            new_user_list = new_stat.get("users", [])
            
            # user_id 기준으로 중복 제거
            user_dict = {}
            for user in old_user_list + new_user_list:
                user_id = user.get("user_id")
                if user_id:
                    # 같은 user_id가 있으면 더 최신 정보로 업데이트
                    if user_id not in user_dict:
                        user_dict[user_id] = user
                    else:
                        # last_seen이 더 최신인 것으로 교체
                        existing_last = user_dict[user_id].get("last_seen", "0000-00-00")
                        new_last = user.get("last_seen", "0000-00-00")
                        if new_last > existing_last:
                            user_dict[user_id] = user
            
            merged_user_list = list(user_dict.values())
            
            # user_count 재계산
            merged[dept_name] = {
                "name": dept_name,
                "user_count": len(merged_user_list),
                "total_requests": old_stat.get("total_requests", 0) + new_stat.get("total_requests", 0),
                "new_users_30d": 0,
                "users": merged_user_list
            }
            
            # new_users_30d 재계산 (30일 내 신규 사용자)
            for user in merged_user_list:
                user_id = user.get("user_id")
                if user_id in merged_users:
                    user_data = merged_users[user_id]
                    first_seen = user_data.get("first_seen", "9999-99-99")
                    if first_seen >= thirty_days_ago:
                        merged[dept_name]["new_users_30d"] += 1
    
    return merged

def merge_stats_files(old_file: Path, new_file: Path, output_file: Path):
    """두 개의 stats.json 파일을 병합"""
    print(f"stats.json 병합 시작: {old_file.name} + {new_file.name} -> {output_file.name}")
    
    # 이전 파일 로드
    old_data = {}
    if old_file.exists():
        with open(old_file, 'r', encoding='utf-8') as f:
            old_data = json.load(f)
        print(f"  이전 파일: {len(old_data.get('users', {}))} 명의 사용자")
    else:
        print(f"  경고: 이전 파일이 존재하지 않습니다: {old_file}")
        return False
    
    # 새 파일 로드
    new_data = {}
    if new_file.exists():
        with open(new_file, 'r', encoding='utf-8') as f:
            new_data = json.load(f)
        print(f"  새 파일: {len(new_data.get('users', {}))} 명의 사용자")
    else:
        print(f"  경고: 새 파일이 존재하지 않습니다: {new_file}")
        return False
    
    # 사용자 병합
    print("  사용자 데이터 병합 중...")
    merged_users = merge_users(
        old_data.get("users", {}),
        new_data.get("users", {})
    )
    print(f"    병합된 사용자 수: {len(merged_users)} 명")
    
    # 일별 통계 병합
    print("  일별 통계 병합 중...")
    merged_daily = merge_daily_stats(
        old_data.get("daily_stats", {}),
        new_data.get("daily_stats", {}),
        merged_users
    )
    print(f"    병합된 일별 통계: {len(merged_daily)} 일")
    
    # 월별 통계 병합
    print("  월별 통계 병합 중...")
    merged_monthly = merge_monthly_stats(
        old_data.get("monthly_stats", {}),
        new_data.get("monthly_stats", {})
    )
    print(f"    병합된 월별 통계: {len(merged_monthly)} 개월")
    
    # 부서별 통계 병합
    print("  부서별 통계 병합 중...")
    merged_department = merge_department_stats(
        old_data.get("department_stats", {}),
        new_data.get("department_stats", {}),
        merged_users
    )
    print(f"    병합된 부서 통계: {len(merged_department)} 개 부서")
    
    # 최종 병합 데이터
    merged_data = {
        "users": merged_users,
        "daily_stats": merged_daily,
        "monthly_stats": merged_monthly,
        "department_stats": merged_department
    }
    
    # 결과 저장
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(merged_data, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ 병합 완료!")
    print(f"  총 사용자: {len(merged_users)} 명")
    print(f"  총 일별 통계: {len(merged_daily)} 일")
    print(f"  총 월별 통계: {len(merged_monthly)} 개월")
    print(f"  총 부서 통계: {len(merged_department)} 개 부서")
    
    return True

def main():
    parser = argparse.ArgumentParser(
        description='stats.json 파일 병합 스크립트',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
사용 예시:
  # stats.json 병합
  python scripts/merge_stats.py logs/stats.json.old logs/stats.json logs/stats.json
  
  # 백업 포함
  python scripts/merge_stats.py --backup logs/stats.json.old logs/stats.json logs/stats.json
        """
    )
    parser.add_argument('old_file', type=Path, help='이전 stats.json 파일 경로')
    parser.add_argument('new_file', type=Path, help='새 stats.json 파일 경로')
    parser.add_argument('output_file', type=Path, help='병합된 결과 파일 경로')
    parser.add_argument('--backup', action='store_true', help='기존 output_file을 백업')
    
    args = parser.parse_args()
    
    # 출력 파일이 이미 존재하면 백업
    if args.backup and args.output_file.exists():
        backup_file = args.output_file.with_suffix(args.output_file.suffix + '.backup')
        import shutil
        shutil.copy2(args.output_file, backup_file)
        print(f"기존 파일 백업: {backup_file}")
    
    success = merge_stats_files(args.old_file, args.new_file, args.output_file)
    
    if success:
        print(f"\n✅ 병합 완료: {args.output_file}")
        return 0
    else:
        print(f"\n❌ 병합 실패")
        return 1

if __name__ == '__main__':
    sys.exit(main())





