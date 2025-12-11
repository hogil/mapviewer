"""
edge, near로 기본검색과 다중검색 테스트
"""
import requests
import json
import time
from urllib.parse import urlencode

# SSL 경고 비활성화 (자체 서명 인증서 사용 시)
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 서버 설정 (HTTP와 HTTPS 모두 시도)
BASE_URLS = [
    "http://localhost:8080",
    "https://localhost:8443",
    "https://localhost:443"
]

def find_working_server():
    """작동하는 서버 URL 찾기"""
    for base_url in BASE_URLS:
        try:
            # 간단한 헬스체크
            response = requests.get(f"{base_url}/api/config", timeout=2, verify=False)
            if response.status_code == 200:
                return base_url
        except:
            continue
    return None

def test_search(base_url, query, lot_multi=None):
    """검색 API 호출"""
    params = {
        "q": query,
        "limit": 5000,
        "offset": 0
    }
    if lot_multi:
        params["lot_multi"] = lot_multi
    
    url = f"{base_url}/api/search?{urlencode(params)}"
    print(f"\n{'='*80}")
    print(f"검색 쿼리: {query}")
    if lot_multi:
        print(f"다중 LOT: {lot_multi}")
    print(f"URL: {url}")
    print(f"{'='*80}")
    
    try:
        response = requests.get(url, timeout=30, verify=False)
        response.raise_for_status()
        result = response.json()
        
        total = result.get("total", 0)
        results_count = len(result.get("results", []))
        timings = result.get("timings", {})
        search_mode = timings.get("search_mode", "unknown")
        
        print(f"\n✅ 검색 성공!")
        print(f"   총 결과 수: {total}")
        print(f"   반환된 결과 수: {results_count}")
        print(f"   검색 모드: {search_mode}")
        print(f"   총 소요 시간: {timings.get('total_ms', 0):.3f}ms")
        print(f"   인덱스 히트 수: {timings.get('index_hit_count', 0)}")
        print(f"   검색 워커 수: {timings.get('search_workers', 0)}")
        
        # 처음 10개 결과 출력
        if results_count > 0:
            print(f"\n   처음 10개 결과:")
            for i, file_path in enumerate(result.get("results", [])[:10], 1):
                print(f"   {i}. {file_path}")
            if results_count > 10:
                print(f"   ... 외 {results_count - 10}개 더")
        
        return result
    except requests.exceptions.RequestException as e:
        print(f"\n❌ 검색 실패: {e}")
        return None

def main():
    print("="*80)
    print("edge, near 검색 테스트")
    print("="*80)
    
    # 서버 찾기 (최대 30초 대기)
    print("\n서버 연결 확인 중...")
    base_url = None
    for i in range(30):
        base_url = find_working_server()
        if base_url:
            print(f"✅ 서버 연결 성공: {base_url}")
            break
        if i < 29:
            print(f"   서버 대기 중... ({i+1}/30)")
            time.sleep(1)
    
    if not base_url:
        print("\n❌ 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.")
        print("   서버 시작: .\\start.ps1")
        return
    
    # 1. 기본 검색: "edge, near" (공백/콤마로 구분된 다중 키워드)
    print("\n[테스트 1] 기본 검색: 'edge, near'")
    result1 = test_search(base_url, "edge, near")
    
    # 2. OR 연산자 사용: "edge or near"
    print("\n[테스트 2] OR 연산자 검색: 'edge or near'")
    result2 = test_search(base_url, "edge or near")
    
    # 3. AND 연산자 사용: "edge and near"
    print("\n[테스트 3] AND 연산자 검색: 'edge and near'")
    result3 = test_search(base_url, "edge and near")
    
    # 4. 다중 LOT 검색 (lot_multi 파라미터 사용)
    # 예시 LOT들 (실제 LOT 이름으로 변경 필요)
    print("\n[테스트 4] 다중 LOT 검색: 'edge, near' + lot_multi")
    # 실제 LOT 이름을 확인해야 하므로 일단 주석 처리
    # result4 = test_search(base_url, "edge, near", lot_multi="LOT001/LOT002")
    
    # 결과 비교
    print("\n" + "="*80)
    print("결과 비교")
    print("="*80)
    print(f"기본 검색 (edge, near): {result1.get('total', 0) if result1 else 0}개")
    print(f"OR 검색 (edge or near): {result2.get('total', 0) if result2 else 0}개")
    print(f"AND 검색 (edge and near): {result3.get('total', 0) if result3 else 0}개")

if __name__ == "__main__":
    main()

