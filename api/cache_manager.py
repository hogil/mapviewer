"""
개선된 캐시 관리 시스템
LRU, TTL 캐시를 통합하고 메모리 효율성을 개선
"""

import time
import threading
from collections import OrderedDict
from typing import Any, Optional, Dict, Tuple, Set
from pathlib import Path


class AdaptiveLRUCache:
    """
    적응형 LRU 캐시 - 메모리 사용량에 따라 크기 조절
    """
    
    def __init__(self, base_capacity: int = 1024, max_capacity: int = 2048):
        self.base_capacity = base_capacity
        self.max_capacity = max_capacity
        self.current_capacity = base_capacity
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._lock = threading.RLock()
        self._hit_count = 0
        self._miss_count = 0
        self._last_resize = time.time()
        
    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            if key in self._cache:
                # LRU 업데이트
                self._cache.move_to_end(key)
                self._hit_count += 1
                return self._cache[key]
            
            self._miss_count += 1
            return None
    
    def set(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            else:
                # 용량 초과 시 오래된 항목 제거
                while len(self._cache) >= self.current_capacity:
                    self._cache.popitem(last=False)
            
            self._cache[key] = value
            
            # 주기적으로 캐시 크기 조정 (30초마다)
            if time.time() - self._last_resize > 30:
                self._adjust_capacity()
                self._last_resize = time.time()
    
    def delete(self, key: str) -> None:
        with self._lock:
            self._cache.pop(key, None)
    
    def clear(self) -> None:
        with self._lock:
            self._cache.clear()
            self._hit_count = 0
            self._miss_count = 0
    
    def _adjust_capacity(self) -> None:
        """히트율에 따라 캐시 크기 조정"""
        total_requests = self._hit_count + self._miss_count
        if total_requests < 100:  # 충분한 데이터가 없으면 조정하지 않음
            return
        
        hit_rate = self._hit_count / total_requests
        
        if hit_rate > 0.8 and self.current_capacity < self.max_capacity:
            # 히트율이 높으면 캐시 크기 증가
            self.current_capacity = min(
                self.max_capacity, 
                int(self.current_capacity * 1.2)
            )
        elif hit_rate < 0.5 and self.current_capacity > self.base_capacity:
            # 히트율이 낮으면 캐시 크기 감소
            self.current_capacity = max(
                self.base_capacity,
                int(self.current_capacity * 0.8)
            )
            
            # 현재 용량보다 많은 항목이 있으면 제거
            while len(self._cache) > self.current_capacity:
                self._cache.popitem(last=False)
    
    def get_stats(self) -> Dict[str, Any]:
        """캐시 통계 반환"""
        with self._lock:
            total_requests = self._hit_count + self._miss_count
            hit_rate = self._hit_count / total_requests if total_requests > 0 else 0
            
            return {
                "size": len(self._cache),
                "capacity": self.current_capacity,
                "max_capacity": self.max_capacity,
                "hit_count": self._hit_count,
                "miss_count": self._miss_count,
                "hit_rate": hit_rate,
                "memory_efficiency": len(self._cache) / self.current_capacity
            }


class SmartTTLCache:
    """
    스마트 TTL 캐시 - 접근 패턴에 따라 TTL 조정
    """
    
    def __init__(self, default_ttl: float = 300, capacity: int = 1000):
        self.default_ttl = default_ttl
        self.capacity = capacity
        self._data: OrderedDict[str, Tuple[float, Any, int]] = OrderedDict()  # (expire_time, value, access_count)
        self._lock = threading.RLock()
        self._last_cleanup = time.time()
    
    def get(self, key: str) -> Optional[Any]:
        now = time.time()
        
        with self._lock:
            if key not in self._data:
                return None
            
            expire_time, value, access_count = self._data[key]
            
            if expire_time < now:
                del self._data[key]
                return None
            
            # 접근 횟수 증가 및 TTL 조정
            new_access_count = access_count + 1
            
            # 접근이 많은 항목은 TTL 연장
            if new_access_count > 10:
                ttl_multiplier = min(3.0, 1.0 + (new_access_count - 10) * 0.1)
                new_expire_time = now + (self.default_ttl * ttl_multiplier)
            else:
                new_expire_time = expire_time
            
            self._data[key] = (new_expire_time, value, new_access_count)
            self._data.move_to_end(key)
            
            # 주기적 정리
            if now - self._last_cleanup > 60:  # 1분마다
                self._cleanup_expired()
                self._last_cleanup = now
            
            return value
    
    def set(self, key: str, value: Any, ttl: Optional[float] = None) -> None:
        now = time.time()
        expire_time = now + (ttl or self.default_ttl)
        
        with self._lock:
            if key in self._data:
                # 기존 접근 횟수 유지
                _, _, access_count = self._data[key]
                self._data[key] = (expire_time, value, access_count)
                self._data.move_to_end(key)
            else:
                # 용량 초과 시 오래된 항목 제거
                while len(self._data) >= self.capacity:
                    self._data.popitem(last=False)
                
                self._data[key] = (expire_time, value, 1)
    
    def delete(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)
    
    def clear(self) -> None:
        with self._lock:
            self._data.clear()
    
    def _cleanup_expired(self) -> None:
        """만료된 항목 정리"""
        now = time.time()
        expired_keys = [
            key for key, (expire_time, _, _) in self._data.items()
            if expire_time < now
        ]
        
        for key in expired_keys:
            self._data.pop(key, None)
    
    def get_stats(self) -> Dict[str, Any]:
        """캐시 통계 반환"""
        with self._lock:
            now = time.time()
            active_count = sum(
                1 for expire_time, _, _ in self._data.values()
                if expire_time >= now
            )
            
            access_counts = [count for _, _, count in self._data.values()]
            avg_access = sum(access_counts) / len(access_counts) if access_counts else 0
            
            return {
                "total_size": len(self._data),
                "active_size": active_count,
                "capacity": self.capacity,
                "average_access_count": avg_access,
                "utilization": len(self._data) / self.capacity
            }


class CacheManager:
    """
    통합 캐시 관리자
    """
    
    def __init__(self):
        self.dir_cache = AdaptiveLRUCache(base_capacity=512, max_capacity=1024)
        self.thumb_cache = SmartTTLCache(default_ttl=300, capacity=2000)
        self.file_cache = AdaptiveLRUCache(base_capacity=1024, max_capacity=2048)
        
        # 캐시 무효화 패턴
        self.no_cache_patterns = {"classification", "images", "labels"}
        
        # 성능 모니터링
        self._start_time = time.time()
        self._operation_count = 0
    
    def should_cache_dir(self, path: Path) -> bool:
        """디렉토리를 캐시해야 하는지 판단"""
        path_str = str(path).replace('\\', '/')
        return not any(pattern in path_str for pattern in self.no_cache_patterns)
    
    def invalidate_path_caches(self, path: Path) -> None:
        """특정 경로와 관련된 모든 캐시 무효화"""
        path_str = str(path)
        
        # 디렉토리 캐시 무효화
        keys_to_delete = []
        for key in self.dir_cache._cache.keys():
            if path_str in key:
                keys_to_delete.append(key)
        
        for key in keys_to_delete:
            self.dir_cache.delete(key)
            self.thumb_cache.delete(key)
            self.file_cache.delete(key)
    
    def clear_all_caches(self) -> None:
        """모든 캐시 초기화"""
        self.dir_cache.clear()
        self.thumb_cache.clear()
        self.file_cache.clear()
    
    def clear_thumbnail_cache(self) -> None:
        """썸네일 캐시만 초기화"""
        self.thumb_cache.clear()
    
    def get_global_stats(self) -> Dict[str, Any]:
        """전체 캐시 통계"""
        uptime = time.time() - self._start_time
        
        return {
            "uptime_seconds": uptime,
            "total_operations": self._operation_count,
            "operations_per_second": self._operation_count / uptime if uptime > 0 else 0,
            "caches": {
                "directory": self.dir_cache.get_stats(),
                "thumbnail": self.thumb_cache.get_stats(),
                "file": self.file_cache.get_stats()
            }
        }
    
    def increment_operations(self) -> None:
        """연산 카운터 증가"""
        self._operation_count += 1


# 전역 캐시 매니저 인스턴스
cache_manager = CacheManager()