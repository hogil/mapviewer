"""
stats.json 파일 2개를 병합하는 스크립트

실수로 삭제된 stats.json 파일과 새로 생성된 파일을 병합합니다.
- 숫자 카운트는 합산 (독립적인 두 기간의 로그)
- IP, 날짜 등은 중복 제거 후 병합
- 날짜는 더 이른/늦은 것 자동 선택

사용법:
    python merge_stats.py

실행 전 준비:
    1. 이 파일(merge_stats.py)과 같은 폴더에 두 개의 stats.json 파일을 준비
    2. stats_old.json - 이전에 찾은 파일 (백업)
    3. stats_new.json - 새로 생성된 파일

결과:
    - stats_merged.json - 병합된 결과 파일
    - stats_backup.json - 현재 logs/stats.json 백업 (있는 경우)

병합 규칙:
    📌 사용자(users):
       ✅ total_requests, session_count, total_session_time → 합산
       ✅ daily_requests, endpoints → 날짜/엔드포인트별 합산
       ✅ ip_addresses, unique_days → Set 병합 (중복 제거)
       ✅ first_seen, first_access_time → 더 이른 날짜/시간
       ✅ last_seen, last_access_time, current_session_start → 더 늦은 날짜/시간
       ✅ profile → 값이 있는 것 우선
       ✅ user_type → saml 우선
       ✅ sessions → session_id 기준 중복 제거

    📌 일별/월별 통계(daily_stats, monthly_stats):
       ✅ active_users, new_users → Set 병합 (중복 제거)
       ✅ total_requests → 합산
       ✅ by_department, by_team, by_company, by_org_url → 키별 합산
       ✅ month_name → 둘 중 하나 보존

    📌 부서별 통계(department_stats):
       ✅ name → 둘 중 하나 보존
       ✅ user_count → 실제 users 배열 길이로 재계산
       ✅ total_requests → 합산
       ✅ new_users_30d → MAX (중복 방지)
       ✅ users → user_id 기준 중복 제거, 더 최신 정보 우선
"""

import json
from datetime import datetime
from pathlib import Path
from collections import defaultdict


def parse_datetime(dt_str):
    """날짜/시간 문자열을 datetime 객체로 변환"""
    if not dt_str:
        return None
    try:
        # "2025-10-17 21:26:16" 형식
        return datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
    except:
        try:
            # "2025-10-17" 형식
            return datetime.strptime(dt_str, "%Y-%m-%d")
        except:
            return None


def merge_user_data(user1, user2):
    """두 사용자 데이터를 병합 (access_logger.py의 병합 로직 기반)"""
    merged = {}

    # IP 주소 병합 (Set union - 중복 제거)
    ip_addresses = list(set(user1.get("ip_addresses", []) + user2.get("ip_addresses", [])))
    merged["ip_addresses"] = sorted(ip_addresses)
    merged["primary_ip"] = user1.get("primary_ip") or user2.get("primary_ip")

    # 🔥 숫자는 합산 (독립적인 두 기간의 로그를 병합)
    merged["total_requests"] = user1.get("total_requests", 0) + user2.get("total_requests", 0)
    merged["session_count"] = user1.get("session_count", 0) + user2.get("session_count", 0)
    merged["total_session_time"] = user1.get("total_session_time", 0) + user2.get("total_session_time", 0)

    # 고유 날짜 병합
    unique_days = list(set(user1.get("unique_days", []) + user2.get("unique_days", [])))
    merged["unique_days"] = sorted(unique_days)

    # 날짜 비교 - first_seen은 더 이른 것
    first1 = parse_datetime(user1.get("first_seen"))
    first2 = parse_datetime(user2.get("first_seen"))
    if first1 and first2:
        merged["first_seen"] = min(first1, first2).strftime("%Y-%m-%d")
    elif first1:
        merged["first_seen"] = user1.get("first_seen")
    elif first2:
        merged["first_seen"] = user2.get("first_seen")
    else:
        merged["first_seen"] = ""

    # last_seen은 더 늦은 것
    last1 = parse_datetime(user1.get("last_seen"))
    last2 = parse_datetime(user2.get("last_seen"))
    if last1 and last2:
        merged["last_seen"] = max(last1, last2).strftime("%Y-%m-%d")
    elif last1:
        merged["last_seen"] = user1.get("last_seen")
    elif last2:
        merged["last_seen"] = user2.get("last_seen")
    else:
        merged["last_seen"] = ""

    # last_access_time은 더 늦은 것
    access1 = parse_datetime(user1.get("last_access_time"))
    access2 = parse_datetime(user2.get("last_access_time"))
    if access1 and access2:
        merged["last_access_time"] = max(access1, access2).strftime("%Y-%m-%d %H:%M:%S")
    elif access1:
        merged["last_access_time"] = user1.get("last_access_time")
    elif access2:
        merged["last_access_time"] = user2.get("last_access_time")
    else:
        merged["last_access_time"] = ""

    # current_session_start는 더 최근 것
    session1 = parse_datetime(user1.get("current_session_start"))
    session2 = parse_datetime(user2.get("current_session_start"))
    if session1 and session2:
        merged["current_session_start"] = max(session1, session2).strftime("%Y-%m-%d %H:%M:%S")
    elif session1:
        merged["current_session_start"] = user1.get("current_session_start")
    elif session2:
        merged["current_session_start"] = user2.get("current_session_start")
    else:
        merged["current_session_start"] = ""

    # 🔥 daily_requests 병합 (같은 날짜는 합산)
    daily_requests = defaultdict(int)
    for date, count in user1.get("daily_requests", {}).items():
        daily_requests[date] += count
    for date, count in user2.get("daily_requests", {}).items():
        daily_requests[date] += count
    merged["daily_requests"] = dict(sorted(daily_requests.items()))

    # 🔥 endpoints 병합 (같은 엔드포인트는 합산)
    endpoints = defaultdict(int)
    for endpoint, count in user1.get("endpoints", {}).items():
        endpoints[endpoint] += count
    for endpoint, count in user2.get("endpoints", {}).items():
        endpoints[endpoint] += count
    merged["endpoints"] = dict(sorted(endpoints.items()))

    # 🔥 profile 정보 병합 (더 많은 정보 우선)
    profile = {}
    profile1 = user1.get("profile", {})
    profile2 = user2.get("profile", {})

    # 모든 키를 수집
    all_keys = set(list(profile1.keys()) + list(profile2.keys()))
    for key in all_keys:
        val1 = profile1.get(key)
        val2 = profile2.get(key)
        # 값이 있는 것을 우선
        if val1:
            profile[key] = val1
        elif val2:
            profile[key] = val2

    if profile:
        merged["profile"] = profile

    # 🔥 user_type 병합 (saml 우선)
    user_type1 = user1.get("user_type", "unknown")
    user_type2 = user2.get("user_type", "unknown")
    if user_type1 == "saml" or user_type2 == "saml":
        merged["user_type"] = "saml"
    elif user_type1 != "unknown":
        merged["user_type"] = user_type1
    else:
        merged["user_type"] = user_type2

    # 🔥 first_access_time 병합 (더 이른 것)
    first_access1 = parse_datetime(user1.get("first_access_time"))
    first_access2 = parse_datetime(user2.get("first_access_time"))
    if first_access1 and first_access2:
        merged["first_access_time"] = min(first_access1, first_access2).strftime("%Y-%m-%d %H:%M:%S")
    elif first_access1:
        merged["first_access_time"] = user1.get("first_access_time")
    elif first_access2:
        merged["first_access_time"] = user2.get("first_access_time")

    # sessions 병합 (중복 제거)
    sessions1 = user1.get("sessions", [])
    sessions2 = user2.get("sessions", [])

    # session_id로 중복 제거
    session_dict = {}
    for session in sessions1 + sessions2:
        session_id = session.get("session_id")
        if session_id:
            if session_id not in session_dict:
                session_dict[session_id] = session
            else:
                # 같은 session_id가 있으면 request_count가 더 큰 것 사용
                if session.get("request_count", 0) > session_dict[session_id].get("request_count", 0):
                    session_dict[session_id] = session

    # 시작 시간 기준으로 정렬
    merged["sessions"] = sorted(
        session_dict.values(),
        key=lambda s: s.get("start_time", "")
    )

    return merged


def merge_stats_files(old_file, new_file, output_file):
    """두 stats.json 파일을 병합"""

    # 파일 읽기
    print(f"📖 읽는 중: {old_file}")
    with open(old_file, 'r', encoding='utf-8') as f:
        old_data = json.load(f)

    print(f"📖 읽는 중: {new_file}")
    with open(new_file, 'r', encoding='utf-8') as f:
        new_data = json.load(f)

    # 사용자 병합
    merged_users = {}

    old_users = old_data.get("users", {})
    new_users = new_data.get("users", {})

    # 모든 사용자 ID 수집
    all_user_ids = set(list(old_users.keys()) + list(new_users.keys()))

    print(f"\n🔄 사용자 병합 중... (총 {len(all_user_ids)}명)")

    for user_id in all_user_ids:
        user1 = old_users.get(user_id, {})
        user2 = new_users.get(user_id, {})

        if user1 and user2:
            # 두 파일에 모두 있는 사용자
            print(f"  ➕ {user_id}: 병합 (old: {user1.get('total_requests', 0)} requests, new: {user2.get('total_requests', 0)} requests)")
            merged_users[user_id] = merge_user_data(user1, user2)
        elif user1:
            # old에만 있는 사용자
            print(f"  📋 {user_id}: old에서 복사 ({user1.get('total_requests', 0)} requests)")
            merged_users[user_id] = user1
        else:
            # new에만 있는 사용자
            print(f"  📋 {user_id}: new에서 복사 ({user2.get('total_requests', 0)} requests)")
            merged_users[user_id] = user2

    # 🔥 daily_stats, monthly_stats, department_stats 병합
    print(f"\n🔄 통계 데이터 병합 중...")

    merged_daily = {}
    merged_monthly = {}
    merged_department = {}

    # daily_stats 병합
    for date, data in old_data.get("daily_stats", {}).items():
        merged_daily[date] = data
    for date, data in new_data.get("daily_stats", {}).items():
        if date in merged_daily:
            # 병합 (active_users, new_users는 합집합)
            old_active = set(merged_daily[date].get("active_users", []))
            new_active = set(data.get("active_users", []))
            merged_daily[date]["active_users"] = list(old_active | new_active)

            old_new_users = set(merged_daily[date].get("new_users", []))
            new_new_users = set(data.get("new_users", []))
            merged_daily[date]["new_users"] = list(old_new_users | new_new_users)

            merged_daily[date]["total_requests"] = merged_daily[date].get("total_requests", 0) + data.get("total_requests", 0)

            # 🔥 by_department, by_team, by_company, by_org_url 병합 (합산)
            for field in ["by_department", "by_team", "by_company", "by_org_url"]:
                if field in data or field in merged_daily[date]:
                    if field not in merged_daily[date]:
                        merged_daily[date][field] = {}
                    for key, count in data.get(field, {}).items():
                        merged_daily[date][field][key] = merged_daily[date][field].get(key, 0) + count
        else:
            merged_daily[date] = data

    # monthly_stats 병합
    for month, data in old_data.get("monthly_stats", {}).items():
        merged_monthly[month] = data
    for month, data in new_data.get("monthly_stats", {}).items():
        if month in merged_monthly:
            # 병합
            old_active = set(merged_monthly[month].get("active_users", []))
            new_active = set(data.get("active_users", []))
            merged_monthly[month]["active_users"] = list(old_active | new_active)

            old_new_users = set(merged_monthly[month].get("new_users", []))
            new_new_users = set(data.get("new_users", []))
            merged_monthly[month]["new_users"] = list(old_new_users | new_new_users)

            merged_monthly[month]["total_requests"] = merged_monthly[month].get("total_requests", 0) + data.get("total_requests", 0)

            # 🔥 month_name 보존 (둘 중 하나)
            if "month_name" not in merged_monthly[month] and "month_name" in data:
                merged_monthly[month]["month_name"] = data["month_name"]

            # 🔥 by_department, by_team, by_company, by_org_url 병합 (합산)
            for field in ["by_department", "by_team", "by_company", "by_org_url"]:
                if field in data or field in merged_monthly[month]:
                    if field not in merged_monthly[month]:
                        merged_monthly[month][field] = {}
                    for key, count in data.get(field, {}).items():
                        merged_monthly[month][field][key] = merged_monthly[month][field].get(key, 0) + count
        else:
            merged_monthly[month] = data

    # department_stats 병합
    for dept, data in old_data.get("department_stats", {}).items():
        merged_department[dept] = data
    for dept, data in new_data.get("department_stats", {}).items():
        if dept in merged_department:
            # 병합
            # name 보존 (둘 중 하나)
            if "name" not in merged_department[dept] and "name" in data:
                merged_department[dept]["name"] = data["name"]

            # user_count는 중복 제거 후 실제 사용자 수로 계산
            merged_department[dept]["user_count"] = max(
                merged_department[dept].get("user_count", 0),
                data.get("user_count", 0)
            )

            # total_requests는 합산
            merged_department[dept]["total_requests"] = (
                merged_department[dept].get("total_requests", 0) +
                data.get("total_requests", 0)
            )

            # new_users_30d는 MAX (30일 내 신규는 중복 카운트하지 않음)
            merged_department[dept]["new_users_30d"] = max(
                merged_department[dept].get("new_users_30d", 0),
                data.get("new_users_30d", 0)
            )

            # users 배열 병합 (user_id 기준 중복 제거)
            user_dict = {}
            for u in merged_department[dept].get("users", []):
                user_dict[u["user_id"]] = u
            for u in data.get("users", []):
                if u["user_id"] in user_dict:
                    # 더 최신 정보로 업데이트
                    if u.get("last_seen", "") > user_dict[u["user_id"]].get("last_seen", ""):
                        user_dict[u["user_id"]] = u
                else:
                    user_dict[u["user_id"]] = u
            merged_department[dept]["users"] = list(user_dict.values())

            # 실제 user_count를 users 배열 길이로 업데이트
            merged_department[dept]["user_count"] = len(user_dict)
        else:
            merged_department[dept] = data

    # 결과 생성
    result = {
        "users": merged_users,
        "daily_stats": merged_daily,
        "monthly_stats": merged_monthly,
        "department_stats": merged_department
    }

    # 파일 저장
    print(f"\n💾 저장 중: {output_file}")
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    # 통계 출력
    print("\n✅ 병합 완료!")
    print(f"\n📊 병합 결과:")
    print(f"  - 전체 사용자 수: {len(merged_users)}명")
    total_requests = sum(user.get("total_requests", 0) for user in merged_users.values())
    total_sessions = sum(user.get("session_count", 0) for user in merged_users.values())
    print(f"  - 전체 요청 수: {total_requests:,}건")
    print(f"  - 전체 세션 수: {total_sessions:,}개")
    print(f"  - 일별 통계: {len(result.get('daily_stats', {}))}개 날짜")
    print(f"  - 월별 통계: {len(result.get('monthly_stats', {}))}개 월")
    print(f"  - 부서별 통계: {len(result.get('department_stats', {}))}개 부서")

    return result


def main():
    print("=" * 60)
    print("stats.json 파일 병합 도구")
    print("=" * 60)

    # 현재 디렉토리
    current_dir = Path(__file__).parent

    # 파일 경로 설정
    old_file = current_dir / "stats_old.json"
    new_file = current_dir / "stats_new.json"
    output_file = current_dir / "stats_merged.json"
    backup_file = current_dir / "stats_backup.json"

    # 파일 존재 확인
    if not old_file.exists():
        print(f"\n❌ 오류: {old_file} 파일을 찾을 수 없습니다.")
        print(f"   이전 stats.json 파일을 'stats_old.json'으로 저장해주세요.")
        return

    if not new_file.exists():
        print(f"\n❌ 오류: {new_file} 파일을 찾을 수 없습니다.")
        print(f"   새로운 stats.json 파일을 'stats_new.json'으로 저장해주세요.")
        return

    # 기존 stats.json 백업 (있는 경우)
    original_stats = current_dir / "logs" / "stats.json"
    if original_stats.exists():
        print(f"\n💾 원본 백업 중: {original_stats} → {backup_file}")
        with open(original_stats, 'r', encoding='utf-8') as f:
            backup_data = f.read()
        with open(backup_file, 'w', encoding='utf-8') as f:
            f.write(backup_data)

    # 병합 실행
    try:
        merge_stats_files(old_file, new_file, output_file)

        print(f"\n📁 생성된 파일:")
        print(f"  - {output_file} (병합된 결과)")
        if backup_file.exists():
            print(f"  - {backup_file} (원본 백업)")

        print(f"\n💡 다음 단계:")
        print(f"  1. {output_file} 파일을 확인하세요")
        print(f"  2. 문제가 없으면 logs/stats.json을 교체하세요:")
        print(f"     copy stats_merged.json logs\\stats.json")

    except Exception as e:
        print(f"\n❌ 오류 발생: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
