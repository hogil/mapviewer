#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SAML 접속 상세 로그 CSV 관리기
접속할 때마다 실시간으로 detail_access.csv에 기록
"""

import csv
import os
from datetime import datetime
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)

class DetailAccessLogger:
    """SAML 접속 상세 로그 CSV 관리 클래스"""
    
    def __init__(self):
        self.csv_file = 'logs/detail_access.csv'
        self.headers = [
            '접속일시',
            'Username(이름)',
            'LoginId(계정)', 
            'Sabun(사번)',
            'DeptName(부서명)',
            'x-ms-forwarded-client-ip(사용자IP)',
            'GrdName_EN(직급)',
            'GrdName(담당업무)'
        ]
        self._ensure_csv_exists()
    
    def _ensure_csv_exists(self):
        """CSV 파일이 존재하지 않으면 헤더만 있는 파일 생성"""
        os.makedirs('logs', exist_ok=True)
        
        if not os.path.exists(self.csv_file):
            with open(self.csv_file, 'w', newline='', encoding='utf-8-sig') as f:
                writer = csv.writer(f)
                writer.writerow(self.headers)
            logger.info(f"새로운 detail_access.csv 파일 생성됨")
    
    def log_saml_access(self, saml_attributes: Dict[str, Any], client_ip: str) -> bool:
        """SAML 로그인 성공 시 접속 기록"""
        try:
            # 현재 시간
            access_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            
            # SAML 속성에서 데이터 추출
            username = saml_attributes.get('Username', '').strip()
            login_id = saml_attributes.get('LoginId', '').strip()
            sabun = saml_attributes.get('Sabun', '').strip()
            dept_name = saml_attributes.get('DeptName', '').strip()
            grade_en = saml_attributes.get('GrdName_EN', '').strip()
            grade = saml_attributes.get('GrdName', '').strip()
            
            # 동일한 LoginId가 같은 날짜에 이미 기록되어 있는지 확인
            if self._is_duplicate_login_today(login_id, access_time[:10]):  # YYYY-MM-DD 부분만 추출
                logger.info(f"동일한 LoginId({login_id})가 오늘 이미 기록됨, 스킵")
                return True
            
            # 접속 기록 생성
            access_record = [
                access_time,                    # 접속일시
                username,                       # Username(이름)
                login_id,                       # LoginId(계정)
                sabun,                          # Sabun(사번)
                dept_name,                      # DeptName(부서명)
                client_ip,                      # x-ms-forwarded-client-ip(사용자IP)
                grade_en,                       # GrdName_EN(직급)
                grade                           # GrdName(담당업무)
            ]
            
            # CSV 파일에 추가 기록
            with open(self.csv_file, 'a', newline='', encoding='utf-8-sig') as f:
                writer = csv.writer(f)
                writer.writerow(access_record)
            
            logger.info(f"SAML 접속 기록 추가: {login_id} ({username}) - {access_time}")
            return True
            
        except Exception as e:
            logger.error(f"SAML 접속 기록 실패: {e}")
            return False
    
    def _is_duplicate_login_today(self, login_id: str, date_str: str) -> bool:
        """동일한 LoginId가 오늘 이미 기록되어 있는지 확인"""
        if not os.path.exists(self.csv_file):
            return False
        
        try:
            with open(self.csv_file, 'r', encoding='utf-8-sig') as f:
                reader = csv.reader(f)
                headers = next(reader, None)  # 헤더 스킵
                
                for row in reader:
                    if len(row) >= 3:  # 최소 필요한 컬럼 수 확인
                        record_date = row[0][:10]  # 접속일시에서 날짜 부분만 추출
                        record_login_id = row[2]   # LoginId(계정) 컬럼
                        
                        if record_date == date_str and record_login_id == login_id:
                            return True
            
            return False
            
        except Exception as e:
            logger.error(f"중복 확인 실패: {e}")
            return False
    
    def get_recent_records(self, limit: int = 10) -> list:
        """최근 기록 조회 (테스트용)"""
        if not os.path.exists(self.csv_file):
            return []
        
        try:
            records = []
            with open(self.csv_file, 'r', encoding='utf-8-sig') as f:
                reader = csv.reader(f)
                headers = next(reader, None)  # 헤더 스킵
                
                for row in reader:
                    if len(row) >= 8:  # 최소 필요한 컬럼 수 확인
                        records.append(row)
            
            # 최근 기록부터 반환
            return records[-limit:] if records else []
            
        except Exception as e:
            logger.error(f"최근 기록 조회 실패: {e}")
            return []

# 전역 인스턴스
detail_access_logger = DetailAccessLogger()
