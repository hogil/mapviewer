"""
개선된 썸네일 생성 및 관리 서비스
배치 처리, 중복 제거, 비동기 처리 지원
"""

import os
import asyncio
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
import time

from .utils import FileUtils, Constants
from .cache_manager import cache_manager
from . import config

# pyvips만 사용 (TurboJPEG 제거 - pyvips가 훨씬 빠름)
import pyvips


class ThumbnailService:
    """썸네일 생성 및 관리 서비스"""
    
    def __init__(
        self, 
        root_dir: Path, 
        thumbnail_dir: Path, 
        thumbnail_format: str = None,
        thumbnail_quality: int = 90,
        max_concurrent: int = None
    ):
        self.root_dir = root_dir
        self.thumbnail_dir = thumbnail_dir
        self.thumbnail_format = (thumbnail_format or config.THUMBNAIL_FORMAT).upper()
        self.thumbnail_quality = thumbnail_quality
        # max_concurrent가 None이면 config에서 가져오기
        if max_concurrent is None:
            max_concurrent = config.THUMBNAIL_SEM
        self.semaphore = asyncio.Semaphore(max_concurrent)
        
        # pyvips 전용 모드 (권장 설정: Cubic, Q95)
        print(f"[ThumbnailService] pyvips 최적화 모드 (Cubic, Q95)")
        
        # 성능 메트릭
        self.generation_count = 0
        self.cache_hits = 0
        self.total_generation_time = 0.0
        
    def get_thumbnail_path(self, image_path: Path, size: Tuple[int, int]) -> Path:
        """썸네일 경로 계산"""
        relative_path = image_path.relative_to(self.root_dir)
        thumbnail_name = f"{relative_path.stem}_{size[0]}x{size[1]}.{self.thumbnail_format.lower()}"
        return self.thumbnail_dir / relative_path.parent / thumbnail_name
    
    def _generate_thumbnail_sync(
        self,
        image_path: Path,
        thumbnail_path: Path,
        size: Tuple[int, int]
    ) -> bool:
        """동기 썸네일 생성 (pyvips 최적화 - 최고 속도)"""
        try:
            start_time = time.time()

            # 썸네일 디렉토리 생성
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)

            # pyvips 사용 (권장 설정: Cubic, Q95)
            try:
                # 이미지 로드 (Sequential access for streaming)
                image = pyvips.Image.new_from_file(
                    str(image_path),
                    access='sequential',
                    fail_on='none'
                )

                target_w, target_h = size

                # 이미지가 목표 크기보다 작으면 그대로 저장
                if image.width <= target_w and image.height <= target_h:
                    if self.thumbnail_format.upper() == "PNG":
                        image.write_to_file(
                            str(thumbnail_path),
                            strip=True,
                            compression=config.PNG_COMPRESSION_LEVEL,
                            interlace=False
                        )
                    else:  # JPEG
                        image.jpegsave(
                            str(thumbnail_path),
                            Q=self.thumbnail_quality,
                            strip=True,
                            optimize_coding=False,
                            subsample_mode=pyvips.ForeignSubsample.AUTO,
                            interlace=False
                        )
                else:
                    # 리사이즈 계산
                    scale = min(target_w / image.width, target_h / image.height)

                    # Cubic 커널 사용 (권장: 속도와 화질의 최적 균형)
                    resized = image.resize(scale, vscale=scale, kernel='cubic')

                    # 저장
                    if self.thumbnail_format.upper() == "PNG":
                        resized.pngsave(
                            str(thumbnail_path),
                            strip=True,
                            compression=config.PNG_COMPRESSION_LEVEL,
                            interlace=False
                        )
                    else:  # JPEG - 권장 설정 (Cubic, Q95)
                        resized.jpegsave(
                            str(thumbnail_path),
                            Q=95,  # 권장: Q95 (Q100 대비 51% 파일크기 감소, 화질은 동등)
                            strip=True,
                            optimize_coding=False,  # 속도 우선
                            subsample_mode=pyvips.ForeignSubsample.AUTO,  # 자동 서브샘플링
                            interlace=False
                        )

            except ImportError:
                # pyvips가 없으면 Pillow 사용 (폴백)
                with Image.open(image_path) as img:
                    if img.mode not in ('RGB', 'RGBA'):
                        img = img.convert('RGB')

                    save_kwargs = self._build_pillow_save_kwargs()

                    target_w, target_h = size
                    if img.width <= target_w and img.height <= target_h:
                        resized = img.copy()
                    else:
                        resized = img.copy()
                        resized.thumbnail((target_w, target_h), Image.Resampling.BICUBIC)
                    resized.save(thumbnail_path, self.thumbnail_format, **save_kwargs)
            
            generation_time = time.time() - start_time
            self.total_generation_time += generation_time
            self.generation_count += 1
            
            return True
            
        except Exception as e:
            print(f"썸네일 생성 실패 {image_path}: {e}")
            return False

    def _build_pillow_save_kwargs(self) -> Dict[str, Any]:
        """Pillow 저장시 포맷별 옵션"""
        fmt = self.thumbnail_format.upper()
        if fmt == "PNG":
            return {
                "compress_level": config.PNG_COMPRESSION_LEVEL,
                "optimize": True
            }
        return {
            "quality": self.thumbnail_quality,
            "optimize": True,
            "method": 6
        }
    
    async def generate_thumbnail(
        self, 
        image_path: Path, 
        size: Tuple[int, int],
        executor: ThreadPoolExecutor
    ) -> Optional[Path]:
        """비동기 썸네일 생성"""
        thumbnail_path = self.get_thumbnail_path(image_path, size)
        cache_key = f"thumb:{thumbnail_path}|{size[0]}x{size[1]}"
        
        # 원본 파일 존재 확인
        if not image_path.exists():
            return None
        
        try:
            image_mtime = image_path.stat().st_mtime
        except Exception:
            return None
        
        # 썸네일이 존재하고 최신인지 확인
        if thumbnail_path.exists() and thumbnail_path.stat().st_size > 0:
            try:
                thumb_mtime = thumbnail_path.stat().st_mtime
                if thumb_mtime >= image_mtime:
                    # 캐시에 기록
                    cache_manager.thumb_cache.set(cache_key, True)
                    self.cache_hits += 1
                    return thumbnail_path
            except Exception:
                pass
        
        # 동시 생성 수 제한
        async with self.semaphore:
            # 다시 한번 확인 (레이스 컨디션 방지)
            if thumbnail_path.exists() and thumbnail_path.stat().st_size > 0:
                try:
                    thumb_mtime = thumbnail_path.stat().st_mtime
                    if thumb_mtime >= image_mtime:
                        cache_manager.thumb_cache.set(cache_key, True)
                        return thumbnail_path
                except Exception:
                    pass
            
            # 기존 썸네일 삭제 (구버전인 경우)
            if thumbnail_path.exists():
                try:
                    thumbnail_path.unlink()
                except Exception:
                    pass
            
            # 새 썸네일 생성
            success = await asyncio.get_running_loop().run_in_executor(
                executor, 
                self._generate_thumbnail_sync, 
                image_path, 
                thumbnail_path, 
                size
            )
            
            if success:
                cache_manager.thumb_cache.set(cache_key, True)
                return thumbnail_path
            
            return None
    
    async def generate_thumbnails_batch(
        self, 
        image_paths: List[str], 
        size: Tuple[int, int],
        executor: ThreadPoolExecutor
    ) -> Dict[str, Any]:
        """배치 썸네일 생성"""
        if not image_paths:
            return {"success": True, "results": []}
        
        # 중복 제거 및 유효성 검사
        valid_paths = []
        for path_str in set(image_paths):  # 중복 제거
            try:
                image_path = self.root_dir / path_str
                if image_path.exists() and FileUtils.is_supported_image(
                    image_path, 
                    {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'}
                ):
                    valid_paths.append((path_str, image_path))
            except Exception:
                continue
        
        if not valid_paths:
            return {"success": True, "results": []}
        
        # 이미 존재하는 썸네일 필터링
        paths_to_generate = []
        existing_thumbnails = []
        
        for path_str, image_path in valid_paths:
            thumbnail_path = self.get_thumbnail_path(image_path, size)
            
            try:
                image_mtime = image_path.stat().st_mtime
                
                if (thumbnail_path.exists() and 
                    thumbnail_path.stat().st_size > 0 and 
                    thumbnail_path.stat().st_mtime >= image_mtime):
                    existing_thumbnails.append(path_str)
                else:
                    paths_to_generate.append((path_str, image_path))
            except Exception:
                paths_to_generate.append((path_str, image_path))
        
        # 배치 생성 - 병렬 처리로 성능 개선
        start_time = time.time()
        tasks = []
        
        for path_str, image_path in paths_to_generate:
            task = self.generate_thumbnail(image_path, size, executor)
            tasks.append((path_str, task))
        
        # 결과 수집 - asyncio.gather로 병렬 처리
        results = []
        if tasks:
            task_results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
            for (path_str, _), result in zip(tasks, task_results):
                try:
                    if isinstance(result, Exception):
                        results.append({
                            "path": path_str,
                            "success": False,
                            "error": str(result)
                        })
                    else:
                        results.append({
                            "path": path_str,
                            "success": result is not None,
                            "thumbnail": str(result) if result else None
                        })
                except Exception as e:
                    results.append({
                        "path": path_str,
                        "success": False,
                        "error": str(e)
                    })
        
        # 기존 썸네일도 결과에 포함
        for path_str in existing_thumbnails:
            results.append({
                "path": path_str,
                "success": True,
                "cached": True
            })
        
        generation_time = time.time() - start_time
        
        return {
            "success": True,
            "results": results,
            "statistics": {
                "total_requested": len(image_paths),
                "valid_paths": len(valid_paths),
                "generated": len(paths_to_generate),
                "cached": len(existing_thumbnails),
                "generation_time": generation_time,
                "avg_time_per_image": generation_time / max(1, len(paths_to_generate))
            }
        }
    
    def cleanup_orphaned_thumbnails(self) -> Dict[str, Any]:
        """고아 썸네일 정리 (원본이 없는 썸네일)"""
        cleaned = 0
        total_size_freed = 0
        
        if not self.thumbnail_dir.exists():
            return {"cleaned": 0, "size_freed": 0}
        
        for thumb_path in self.thumbnail_dir.rglob("*"):
            if not thumb_path.is_file():
                continue
            
            try:
                # 썸네일에서 원본 경로 역추적
                relative_thumb = thumb_path.relative_to(self.thumbnail_dir)
                
                # 파일명에서 크기 정보 제거
                name_parts = thumb_path.stem.split("_")
                if len(name_parts) >= 2 and "x" in name_parts[-1]:
                    original_name = "_".join(name_parts[:-1])
                else:
                    continue
                
                # 가능한 원본 확장자들 확인
                original_extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif']
                original_exists = False
                
                for ext in original_extensions:
                    potential_original = self.root_dir / relative_thumb.parent / f"{original_name}{ext}"
                    if potential_original.exists():
                        original_exists = True
                        break
                
                if not original_exists:
                    size = thumb_path.stat().st_size
                    thumb_path.unlink()
                    cleaned += 1
                    total_size_freed += size
                    
            except Exception:
                continue
        
        return {
            "cleaned": cleaned,
            "size_freed": total_size_freed,
            "size_freed_mb": total_size_freed / (1024 * 1024)
        }
    
    def get_thumbnail_stats(self) -> Dict[str, Any]:
        """썸네일 통계"""
        total_thumbnails = 0
        total_size = 0
        
        if self.thumbnail_dir.exists():
            for thumb_path in self.thumbnail_dir.rglob("*"):
                if thumb_path.is_file():
                    total_thumbnails += 1
                    try:
                        total_size += thumb_path.stat().st_size
                    except Exception:
                        pass
        
        avg_generation_time = (
            self.total_generation_time / self.generation_count 
            if self.generation_count > 0 else 0
        )
        
        cache_hit_rate = (
            self.cache_hits / (self.cache_hits + self.generation_count) 
            if (self.cache_hits + self.generation_count) > 0 else 0
        )
        
        return {
            "total_thumbnails": total_thumbnails,
            "total_size": total_size,
            "total_size_mb": total_size / (1024 * 1024),
            "generation_count": self.generation_count,
            "cache_hits": self.cache_hits,
            "cache_hit_rate": cache_hit_rate,
            "total_generation_time": self.total_generation_time,
            "average_generation_time": avg_generation_time
        }

    def clear_cache(self) -> Dict[str, Any]:
        """썸네일 캐시 완전 삭제"""
        try:
            # 캐시 매니저에서 썸네일 관련 캐시 삭제
            cache_manager.clear_thumbnail_cache()
            
            # 성능 메트릭 초기화
            self.generation_count = 0
            self.cache_hits = 0
            self.total_generation_time = 0.0
            
            return {
                "success": True,
                "message": "썸네일 캐시가 완전히 삭제되었습니다",
                "cleared": {
                    "cache_manager": True,
                    "metrics": True
                }
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "cleared": {}
            }


# 시스템 정보 API 추가
def get_system_username() -> Dict[str, Any]:
    """시스템 사용자 이름 획득"""
    try:
        import getpass
        system_username = getpass.getuser()
        return {
            "success": True,
            "system_username": system_username
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "system_username": None
        }
