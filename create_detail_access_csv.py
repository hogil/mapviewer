#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SAML 접속 상세 로그 CSV 관리기
7개 SAML attribute claim + 접속 시간 = 8개 컬럼
접속할 때마다 실시간으로 기록
"""

import csv
import json
import os
from datetime import datetime
from typing import Dict, List, Any

def create_detail_access_csv():
    """SAML 접속 상세 로그 CSV 파일 생성"""
    
    # CSV 파일 경로
    csv_file = 'logs/detail_access.csv'
    
    # CSV 헤더 정의 (7개 SAML attribute + 접속시간 = 8개 컬럼)
    headers = [
        '접속시간',           # timestamp
        '사용자ID',           # user_id (username)
        '이메일',             # email
        '이름',               # name (display_name)
        '부서',               # department
        '직급',               # title
        '권한',               # roles
        'IP주소'              # ip_address
    ]
    
    # 기존 stats.json에서 데이터 읽기
    stats_file = 'logs/stats.json'
    if not os.path.exists(stats_file):
        print(f"❌ {stats_file} 파일이 없습니다.")
        return
    
    try:
        with open(stats_file, 'r', encoding='utf-8') as f:
            stats_data = json.load(f)
        
        # CSV 데이터 생성
        csv_data = []
        
        # stats.json의 user_data에서 정보 추출
        if 'user_data' in stats_data:
            for user_id, user_info in stats_data['user_data'].items():
                # 접속 기록이 있는 경우만 처리
                if 'access_history' in user_info:
                    for access in user_info['access_history']:
                        row = [
                            access.get('timestamp', ''),                    # 접속시간
                            user_id,                                        # 사용자ID
                            user_info.get('email', ''),                     # 이메일
                            user_info.get('name', user_info.get('display_name', '')),  # 이름
                            user_info.get('department', ''),                # 부서
                            user_info.get('title', ''),                     # 직급
                            ', '.join(user_info.get('roles', [])),          # 권한
                            access.get('ip_address', '')                    # IP주소
                        ]
                        csv_data.append(row)
        
        # CSV 파일 작성
        os.makedirs('logs', exist_ok=True)
        
        with open(csv_file, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            
            # 헤더 작성
            writer.writerow(headers)
            
            # 데이터 작성
            writer.writerows(csv_data)
        
        print(f"성공: {csv_file} 파일이 생성되었습니다.")
        print(f"총 {len(csv_data)}개의 접속 기록이 포함되었습니다.")
        print(f"컬럼: {', '.join(headers)}")
        
        # 샘플 데이터 출력
        if csv_data:
            print("\n샘플 데이터 (최대 3개):")
            for i, row in enumerate(csv_data[:3]):
                print(f"  {i+1}. {row}")
        
    except Exception as e:
        print(f"오류 발생: {e}")

def log_user_access(user_data: Dict[str, Any], ip_address: str = '127.0.0.1'):
    """사용자 접속을 detail_access.csv에 실시간 기록"""
    
    csv_file = 'logs/detail_access.csv'
    headers = [
        '접속일시',
        'Username',
        'LoginId', 
        'Sabun',
        'DeptName',
        'x-ms-forwarded-client-ip',
        'GrdName_EN',
        'GrdName'
    ]
    
    # 현재 시간
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    # 접속 기록 생성
    access_record = [
        timestamp,                                          # 접속시간
        user_data.get('user_id', ''),                      # 사용자ID
        user_data.get('email', ''),                        # 이메일
        user_data.get('name', user_data.get('display_name', '')),  # 이름
        user_data.get('department', ''),                   # 부서
        user_data.get('title', ''),                        # 직급
        ', '.join(user_data.get('roles', [])),             # 권한
        ip_address                                         # IP주소
    ]
    
    # logs 디렉토리 생성
    os.makedirs('logs', exist_ok=True)
    
    # CSV 파일이 존재하는지 확인
    file_exists = os.path.exists(csv_file)
    
    # CSV 파일에 추가 기록
    with open(csv_file, 'a', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        
        # 파일이 없으면 헤더 추가
        if not file_exists:
            writer.writerow(headers)
        
        # 접속 기록 추가
        writer.writerow(access_record)
    
    print(f"접속 기록 추가: {user_data.get('user_id', 'Unknown')} - {timestamp}")
    return True

def create_sample_detail_access_csv():
    """샘플 detail_access.csv 파일 생성 (테스트용)"""
    
    csv_file = 'logs/detail_access.csv'
    headers = [
        '접속일시',
        'Username',
        'LoginId', 
        'Sabun',
        'DeptName',
        'x-ms-forwarded-client-ip',
        'GrdName_EN',
        'GrdName'
    ]
    
    # 샘플 데이터
    sample_data = [
        [
            '2024-01-15 09:30:25',
            'user001',
            'kim.user@company.com',
            '김사용',
            '개발팀',
            '선임연구원',
            'user, developer',
            '192.168.1.100'
        ],
        [
            '2024-01-15 10:15:42',
            'user002', 
            'lee.admin@company.com',
            '이관리',
            'IT팀',
            '팀장',
            'admin, user',
            '192.168.1.101'
        ],
        [
            '2024-01-15 11:22:18',
            'user003',
            'park.analyst@company.com', 
            '박분석',
            '데이터팀',
            '주임연구원',
            'analyst, user',
            '192.168.1.102'
        ]
    ]
    
    os.makedirs('logs', exist_ok=True)
    
    with open(csv_file, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(sample_data)
    
    print(f"샘플 {csv_file} 파일이 생성되었습니다.")
    print(f"샘플 데이터 {len(sample_data)}개가 포함되었습니다.")

if __name__ == '__main__':
    print("SAML 접속 상세 로그 CSV 생성기")
    print("=" * 50)
    
    # 실제 데이터가 있으면 사용, 없으면 샘플 생성
    if os.path.exists('logs/stats.json'):
        print("기존 stats.json 데이터를 사용합니다...")
        create_detail_access_csv()
    else:
        print("stats.json이 없어서 샘플 데이터를 생성합니다...")
        create_sample_detail_access_csv()
