"""
공통 유틸리티 함수들
경로 처리, 파일 검증, 응답 생성 등
"""

import os
import hashlib
from pathlib import Path
from typing import Optional, Dict, Any, Union
from fastapi import HTTPException
from fastapi.responses import JSONResponse


class PathUtils:
    """경로 관련 유틸리티"""
    
    @staticmethod
    def safe_resolve_path(path: Optional[str], root_dir: Path) -> Path:
        """안전한 경로 해석 (보안 검증 포함)"""
        if not path:
            return root_dir
        try:
            normalized = os.path.normpath(str(path).lstrip("/\\"))
            target = (root_dir / normalized).resolve()
            if not str(target).startswith(str(root_dir)):
                raise HTTPException(status_code=400, detail="Invalid path")
            return target
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid path: {str(e)}")
    
    @staticmethod
    def relkey_from_any_path(any_path: str, root_dir: Path) -> str:
        """절대/상대 경로를 ROOT 기준 상대경로로 변환"""
        abs_path = PathUtils.safe_resolve_path(any_path, root_dir)
        rel = str(abs_path.relative_to(root_dir)).replace("\\", "/")
        return rel


class FileUtils:
    """파일 관련 유틸리티"""
    
    @staticmethod
    def is_supported_image(path: Path, supported_extensions: set) -> bool:
        """지원되는 이미지 파일인지 확인"""
        return path.suffix.lower() in supported_extensions
    
    @staticmethod
    def compute_etag(st) -> str:
        """파일 ETag 생성"""
        return f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'
    
    @staticmethod
    def get_file_hash(file_path: Path) -> str:
        """파일 해시 생성 (중복 파일 감지용)"""
        hasher = hashlib.md5()
        try:
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(4096), b""):
                    hasher.update(chunk)
            return hasher.hexdigest()
        except Exception:
            return ""


class ResponseUtils:
    """응답 관련 유틸리티"""
    
    @staticmethod
    def success_response(data: Any = None, message: str = "") -> Dict[str, Any]:
        """성공 응답 생성"""
        response = {"success": True}
        if data is not None:
            response.update(data if isinstance(data, dict) else {"data": data})
        if message:
            response["message"] = message
        return response
    
    @staticmethod
    def error_response(
        message: str, 
        status_code: int = 400, 
        details: Any = None
    ) -> JSONResponse:
        """에러 응답 생성"""
        response = {"success": False, "error": message}
        if details:
            response["details"] = details
        return JSONResponse(response, status_code=status_code)
    
    @staticmethod
    def paginated_response(
        items: list, 
        offset: int, 
        limit: int, 
        total_count: Optional[int] = None
    ) -> Dict[str, Any]:
        """페이지네이션 응답 생성"""
        return {
            "success": True,
            "items": items,
            "pagination": {
                "offset": offset,
                "limit": limit,
                "count": len(items),
                "total": total_count or len(items)
            }
        }


class CacheUtils:
    """캐시 관련 유틸리티"""
    
    @staticmethod
    def generate_cache_key(*args) -> str:
        """캐시 키 생성"""
        key_string = "|".join(str(arg) for arg in args)
        return hashlib.md5(key_string.encode()).hexdigest()
    
    @staticmethod
    def should_cache_path(path: Path, no_cache_patterns: list) -> bool:
        """경로를 캐시해야 하는지 판단"""
        path_str = str(path).replace('\\', '/')
        for pattern in no_cache_patterns:
            if pattern in path_str:
                return False
        return True


class ValidationUtils:
    """검증 관련 유틸리티"""
    
    @staticmethod
    def validate_class_name(name: str) -> tuple[bool, str]:
        """클래스명 유효성 검증"""
        import re
        
        if not name or name.isspace():
            return False, "클래스명이 비어있습니다"
        
        name = name.strip()
        
        if len(name) > 50:
            return False, "클래스명이 너무 깁니다 (최대 50자)"
        
        if any(ord(char) < 32 or ord(char) > 126 for char in name):
            return False, "클래스명에 특수문자나 한글 자모를 사용할 수 없습니다"
        
        if not re.match(r"^[A-Za-z0-9_\-]+$", name):
            return False, "클래스명 형식이 올바르지 않습니다 (A-Z, a-z, 0-9, _, - 만 사용 가능)"
        
        return True, ""
    
    @staticmethod
    def validate_search_query(query: str, max_length: int = 100) -> tuple[bool, str]:
        """검색 쿼리 유효성 검증"""
        if not query:
            return False, "검색어가 비어있습니다"
        
        if len(query) > max_length:
            return False, f"검색어가 너무 깁니다 (최대 {max_length}자)"
        
        # 위험한 패턴 검사
        dangerous_patterns = ["../", "..\\", "<script", "javascript:"]
        query_lower = query.lower()
        for pattern in dangerous_patterns:
            if pattern in query_lower:
                return False, "유효하지 않은 검색어입니다"
        
        return True, ""


class Constants:
    """상수 정의"""
    
    # 기본값
    DEFAULT_PAGINATION_LIMIT = 500
    MAX_PAGINATION_LIMIT = 5000
    DEFAULT_THUMBNAIL_SIZE = 512
    
    # 캐시 설정
    DEFAULT_CACHE_TTL = 300  # 5분
    MAX_CACHE_SIZE = 1000
    
    # 파일 시스템
    SKIP_DIRS_DEFAULT = {"classification", "thumbnails", "composite_map", "__pycache__", ".git"}
    NO_CACHE_PATHS = ["classification", "images", "labels"]
    
    # 정규표현식
    CLASS_NAME_PATTERN = r"^[A-Za-z0-9_\-]+$"
    
    # 에러 메시지
    ERROR_MESSAGES = {
        "FILE_NOT_FOUND": "파일을 찾을 수 없습니다",
        "INVALID_PATH": "유효하지 않은 경로입니다",
        "UNSUPPORTED_FORMAT": "지원되지 않는 파일 형식입니다",
        "CLASS_EXISTS": "이미 존재하는 클래스입니다",
        "CLASS_NOT_FOUND": "클래스를 찾을 수 없습니다",
        "PERMISSION_DENIED": "접근 권한이 없습니다",
        "INTERNAL_ERROR": "내부 서버 오류가 발생했습니다"
    }