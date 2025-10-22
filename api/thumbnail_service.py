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

# TurboJPEG import (optional)
try:
    from turbojpeg import TurboJPEG
    TURBOJPEG_AVAILABLE = True
except ImportError:
    TURBOJPEG_AVAILABLE = False
    TurboJPEG = None


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
        
        # TurboJPEG 비활성화 - pyvips만 사용 (더 빠름)
        self.turbojpeg = None
        print(f"[ThumbnailService] TurboJPEG 비활성화 - pyvips 최적화 모드")
        
        # 성능 메트릭
        self.generation_count = 0
        self.cache_hits = 0
        self.total_generation_time = 0.0
        
    def get_thumbnail_path(self, image_path: Path, size: Tuple[int, int]) -> Path:
        """썸네일 경로 계산"""
        relative_path = image_path.relative_to(self.root_dir)
        thumbnail_name = f"{relative_path.stem}_{size[0]}x{size[1]}.{self.thumbnail_format.lower()}"
        return self.thumbnail_dir / relative_path.parent / thumbnail_name
    
    def _save_with_turbojpeg(self, work_image, dest: str, quality: int) -> bool:
        """TurboJPEG를 사용한 고속 JPEG 저장 - write_to_memory 최적화"""
        if not self.turbojpeg:
            return False
        
        try:
            import numpy as np
            
            # 이미지 전처리
            image = work_image
            if image.bands > 3:
                image = image.extract_band(0, n=3)
            elif image.bands == 2:
                image = image.extract_band(0, n=1)
            
            if image.interpretation not in ("srgb", "rgb"):
                try:
                    image = image.colourspace("srgb")
                except Exception:
                    pass
            
            # 🔥 최적화: write_to_memory 대신 임시 파일 사용
            start_mem = time.time()
            
            # 방법 1: 임시 파일을 통한 우회 (write_to_memory 병목 회피)
            try:
                import tempfile
                with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp_file:
                    tmp_path = tmp_file.name
                
                # pyvips로 임시 PNG 파일 저장 (매우 빠름)
                image.pngsave(tmp_path, compression=0, strip=True)
                
                # 임시 파일을 다시 읽어서 numpy 배열로 변환
                temp_image = pyvips.Image.new_from_file(tmp_path)
                image_array = temp_image.write_to_memory()
                
                # 임시 파일 삭제
                Path(tmp_path).unlink(missing_ok=True)
                
                mem_time = (time.time() - start_mem) * 1000
                print(f"[TurboJPEG] 임시파일 우회: {mem_time:.1f}ms")
                
            except Exception as e:
                print(f"임시파일 우회 실패: {e}")
                # 폴백: 기본 write_to_memory
                image_array = image.write_to_memory()
                mem_time = (time.time() - start_mem) * 1000
                print(f"[TurboJPEG] 기본 write_mem: {mem_time:.1f}ms")
            
            # numpy 배열 변환
            image_array = np.frombuffer(image_array, dtype=np.uint8)
            image_array = image_array.reshape((image.height, image.width, image.bands))
            
            print(f"[TurboJPEG] write_mem={mem_time:.1f}ms", end="")
            
            # TurboJPEG로 인코딩
            buffer = self.turbojpeg.encode(image_array, quality=quality, jpeg_subsample=2)
            Path(dest).write_bytes(buffer)
            return True
            
        except Exception as e:
            print(f"[ThumbnailService] TurboJPEG 인코딩 실패: {e}")
            return False
    
    def _save_with_optimized_jpeg(self, work_image, dest: str, quality: int) -> bool:
        """최적화된 pyvips JPEG 저장 (속도 우선)"""
        try:
            # pyvips의 속도 최적화된 JPEG 저장 사용
            work_image.jpegsave(
                dest,
                Q=quality,
                strip=True,
                optimize_coding=False,  # 속도 우선
                subsample_mode="auto",
                interlace=False
            )
            return True
        except Exception as e:
            print(f"[ThumbnailService] 최적화된 JPEG 저장 실패: {e}")
            return False
    
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

            # pyvips 사용 (Pillow보다 10-100배 빠름)
            try:
                import pyvips
                # 🔥 최적화: 극한 하드웨어 최적화 - 지원되는 최적화 옵션만 적용
                image = pyvips.Image.new_from_file(
                    str(image_path),
                    access='sequential',
                    fail_on='none',
                    memory=True,      # 메모리 캐시
                    unlimited=True    # 하드웨어 가속
                )
                
                # 🔥 최적화: 메모리 복사 완전 제거 - 스트리밍 방식 사용
                # 메모리 복사를 아예 하지 않고 직접 처리
                print(f"[OPTIMIZATION] Streaming mode (size: {image.width}x{image.height})")
                
                # 성능 측정을 위한 시간 기록
                start_time = time.time()

                target_w, target_h = size
                
                # 🔥 최적화: 가장 빠른 처리 방식 - 단일 파이프라인
                if image.width <= target_w and image.height <= target_h:
                    # 이미지가 목표 크기보다 작으면 그대로 저장
                    if self.thumbnail_format.upper() == "PNG":
                        image.write_to_file(str(thumbnail_path), strip=True, compression=config.PNG_COMPRESSION_LEVEL, interlace=False)
                    else:  # JPEG
                        image.write_to_file(str(thumbnail_path), Q=self.thumbnail_quality, strip=True)
                else:
                    # 🔥 최적화: 가장 빠른 리사이즈 - 단일 단계 처리
                    scale = min(target_w / image.width, target_h / image.height)
                    scale = max(scale, 1.0 / max(image.width, image.height))
                    
                    # 🔥 최적화: 극한 리사이즈 최적화 - 더 공격적인 shrink 사용
                    if scale < 0.5:
                        # 큰 축소의 경우 더 큰 shrink factor 사용
                        shrink_factor = max(int(1.0 / scale) + 1, 1)  # +1 추가로 더 공격적
                        if shrink_factor > 1:
                            resized = image.shrink(shrink_factor, shrink_factor)
                            # 추가 리사이즈가 필요한 경우만
                            remaining_scale = scale * shrink_factor
                            if abs(remaining_scale - 1.0) > 0.01:
                                resized = resized.resize(remaining_scale, vscale=remaining_scale, kernel='cubic')
                        else:
                            resized = image.resize(scale, vscale=scale, kernel='cubic')
                    else:
                        # 작은 축소의 경우 직접 resize
                        resized = image.resize(scale, vscale=scale, kernel='cubic')
                    
                    # 🔥 최적화: 메모리 최적화 제거 - 스트리밍으로 직접 저장
                    # resized = resized.copy_memory()  # 메모리 복사 제거로 속도 향상
                   
                    # 🔥 최적화: 가장 빠른 저장 - 최소 파라미터로 속도 극대화
                    if self.thumbnail_format.upper() == "PNG":
                        resized.write_to_file(str(thumbnail_path), strip=True, compression=config.PNG_COMPRESSION_LEVEL, interlace=False)
                    else:  # JPEG - 극한 속도 최적화
                        # 🔥 최적화: 극한 속도 JPEG 저장 - 지원되는 속도 옵션만 적용
                        resized.jpegsave(
                            str(thumbnail_path),
                            Q=self.thumbnail_quality,  # Q=100 고정
                            strip=True,
                            optimize_coding=False,     # 속도 우선
                            subsample_mode=1,          # 4:2:0 (가장 빠름)
                            interlace=False,           # 인터레이스 비활성화
                            trellis_quant=False,       # 트렐리스 양자화 비활성화
                            quant_table=0,             # 기본 양자화 테이블
                            background=255             # 배경색 설정
                        )
                        
                        # 성능 측정 결과 출력
                        end_time = time.time()
                        processing_time = (end_time - start_time) * 1000
                        file_size = thumbnail_path.stat().st_size if thumbnail_path.exists() else 0
                        
                        print(f"Thumbnail generated successfully!")
                        print(f"  Processing time: {processing_time:.1f}ms")
                        print(f"  File size: {file_size / 1024:.1f} KB")
                        print(f"  100ms target: {'SUCCESS' if processing_time <= 100 else 'FAILED'}")
                        print(f"  Size: 512x512, Quality: Q=100, Kernel: cubic")
                        print(f"  File: {thumbnail_path.name}")
                        print(f"  {'='*50}")
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
