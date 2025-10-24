"""
피라미드 썸네일 생성 성능 벤치마크
pyvips vs TurboJPEG 비교 (다양한 옵션 조합)
"""

import sys
import io
import time
import os
from pathlib import Path
import pyvips
from typing import Dict, List, Any

# Windows 인코딩 문제 해결
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# TurboJPEG import (optional)
try:
    from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_420
    try:
        from turbojpeg import TJFLAG_FASTDCT
    except ImportError:
        TJFLAG_FASTDCT = None
    TURBOJPEG_AVAILABLE = True
except ImportError:
    TURBOJPEG_AVAILABLE = False
    print("⚠️ TurboJPEG not available - testing pyvips only")

import numpy as np


class BenchmarkRunner:
    def __init__(self, input_path: str, output_dir: str, level: float = 0.7):
        self.input_path = Path(input_path)
        self.output_dir = Path(output_dir)
        self.level = level
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # TurboJPEG 초기화
        self.turbo = None
        if TURBOJPEG_AVAILABLE:
            try:
                turbo_path = os.getenv("TURBOJPEG_PATH", "")
                self.turbo = TurboJPEG(lib_path=turbo_path if turbo_path else None)
                print(f"✅ TurboJPEG initialized (lib={turbo_path or 'auto'})")
            except Exception as e:
                print(f"⚠️ TurboJPEG initialization failed: {e}")

        self.results: List[Dict[str, Any]] = []

    def test_pyvips(self, name: str, quality: int, optimize_coding: bool,
                    subsample_mode: int, trellis_quant: bool = False) -> Dict[str, Any]:
        """pyvips JPEG 저장 테스트"""
        output_path = self.output_dir / f"{name}.jpg"

        try:
            start_time = time.time()

            # 이미지 로드
            image = pyvips.Image.new_from_file(
                str(self.input_path),
                access='sequential',
                fail_on='none',
                memory=True,
                unlimited=True
            )

            # 리사이즈
            if self.level < 1.0:
                scale = self.level
                if scale < 0.5:
                    shrink_factor = max(int(1.0 / scale) + 1, 1)
                    if shrink_factor > 1:
                        image = image.shrink(shrink_factor, shrink_factor)
                        remaining_scale = scale * shrink_factor
                        if abs(remaining_scale - 1.0) > 0.01:
                            image = image.resize(remaining_scale, vscale=remaining_scale, kernel='cubic')
                    else:
                        image = image.resize(scale, vscale=scale, kernel='cubic')
                else:
                    image = image.resize(scale, vscale=scale, kernel='cubic')

            # JPEG 저장
            image.jpegsave(
                str(output_path),
                Q=quality,
                strip=True,
                optimize_coding=optimize_coding,
                subsample_mode=subsample_mode,
                interlace=False,
                trellis_quant=trellis_quant,
                quant_table=0
            )

            elapsed = time.time() - start_time
            file_size = output_path.stat().st_size

            result = {
                'method': 'pyvips',
                'name': name,
                'quality': quality,
                'optimize_coding': optimize_coding,
                'subsample_mode': subsample_mode,
                'trellis_quant': trellis_quant,
                'time_ms': elapsed * 1000,
                'size_bytes': file_size,
                'size_kb': file_size / 1024,
                'success': True
            }

            print(f"✅ {name}: {elapsed*1000:.0f}ms, {file_size/1024:.1f}KB")
            return result

        except Exception as e:
            print(f"❌ {name}: {e}")
            return {
                'method': 'pyvips',
                'name': name,
                'success': False,
                'error': str(e)
            }

    def test_turbojpeg(self, name: str, quality: int, use_fastdct: bool = True) -> Dict[str, Any]:
        """TurboJPEG 저장 테스트"""
        if not self.turbo:
            return {
                'method': 'turbojpeg',
                'name': name,
                'success': False,
                'error': 'TurboJPEG not available'
            }

        output_path = self.output_dir / f"{name}.jpg"

        try:
            start_time = time.time()

            # 이미지 로드 (pyvips)
            image = pyvips.Image.new_from_file(
                str(self.input_path),
                access='sequential',
                fail_on='none',
                memory=True,
                unlimited=True
            )

            # 리사이즈
            if self.level < 1.0:
                scale = self.level
                if scale < 0.5:
                    shrink_factor = max(int(1.0 / scale) + 1, 1)
                    if shrink_factor > 1:
                        image = image.shrink(shrink_factor, shrink_factor)
                        remaining_scale = scale * shrink_factor
                        if abs(remaining_scale - 1.0) > 0.01:
                            image = image.resize(remaining_scale, vscale=remaining_scale, kernel='cubic')
                    else:
                        image = image.resize(scale, vscale=scale, kernel='cubic')
                else:
                    image = image.resize(scale, vscale=scale, kernel='cubic')

            # pyvips → numpy 변환
            mem_img = image.write_to_memory()
            np_array = np.frombuffer(mem_img, dtype=np.uint8).reshape(
                image.height, image.width, image.bands
            )

            # RGB 변환
            if image.bands == 1:
                np_array = np.stack([np_array] * 3, axis=-1).squeeze()
            elif image.bands == 4:
                np_array = np_array[:, :, :3]

            # TurboJPEG 인코딩
            base_kwargs = {
                "quality": quality,
                "pixel_format": TJPF_RGB,
            }

            if use_fastdct and TJFLAG_FASTDCT is not None:
                base_kwargs["flags"] = TJFLAG_FASTDCT

            # Subsampling 처리
            try:
                jpeg_buf = self.turbo.encode(np_array, jpeg_subsample=TJSAMP_420, **base_kwargs)
            except TypeError:
                try:
                    jpeg_buf = self.turbo.encode(np_array, chroma_subsampling=TJSAMP_420, **base_kwargs)
                except TypeError:
                    jpeg_buf = self.turbo.encode(np_array, **base_kwargs)

            # 파일 저장
            with open(output_path, "wb") as f:
                f.write(jpeg_buf)

            elapsed = time.time() - start_time
            file_size = output_path.stat().st_size

            result = {
                'method': 'turbojpeg',
                'name': name,
                'quality': quality,
                'use_fastdct': use_fastdct,
                'time_ms': elapsed * 1000,
                'size_bytes': file_size,
                'size_kb': file_size / 1024,
                'success': True
            }

            print(f"✅ {name}: {elapsed*1000:.0f}ms, {file_size/1024:.1f}KB")
            return result

        except Exception as e:
            print(f"❌ {name}: {e}")
            return {
                'method': 'turbojpeg',
                'name': name,
                'success': False,
                'error': str(e)
            }

    def run_all_tests(self):
        """모든 테스트 실행"""
        print("=" * 80)
        print(f"🚀 피라미드 썸네일 벤치마크 (Level {self.level})")
        print(f"📁 입력: {self.input_path} ({self.input_path.stat().st_size / 1024 / 1024:.2f}MB)")
        print("=" * 80)

        # pyvips 테스트 케이스
        print("\n📊 pyvips 테스트")
        print("-" * 80)

        # Q100 (현재 설정)
        self.results.append(self.test_pyvips(
            "pyvips_Q100_noopt",
            quality=100,
            optimize_coding=False,
            subsample_mode=1  # 4:2:0
        ))

        # Q95 (권장)
        self.results.append(self.test_pyvips(
            "pyvips_Q95_noopt",
            quality=95,
            optimize_coding=False,
            subsample_mode=1
        ))

        # Q95 + optimize
        self.results.append(self.test_pyvips(
            "pyvips_Q95_opt",
            quality=95,
            optimize_coding=True,
            subsample_mode=1
        ))

        # Q90
        self.results.append(self.test_pyvips(
            "pyvips_Q90_noopt",
            quality=90,
            optimize_coding=False,
            subsample_mode=1
        ))

        # Q100 + trellis
        self.results.append(self.test_pyvips(
            "pyvips_Q100_trellis",
            quality=100,
            optimize_coding=False,
            subsample_mode=1,
            trellis_quant=True
        ))

        # Q95 + optimize + trellis
        self.results.append(self.test_pyvips(
            "pyvips_Q95_opt_trellis",
            quality=95,
            optimize_coding=True,
            subsample_mode=1,
            trellis_quant=True
        ))

        # subsample_mode=0 (no subsampling)
        self.results.append(self.test_pyvips(
            "pyvips_Q95_nosub",
            quality=95,
            optimize_coding=False,
            subsample_mode=0
        ))

        # TurboJPEG 테스트 케이스
        if self.turbo:
            print("\n📊 TurboJPEG 테스트")
            print("-" * 80)

            # Q100 + FASTDCT
            self.results.append(self.test_turbojpeg(
                "turbojpeg_Q100_fast",
                quality=100,
                use_fastdct=True
            ))

            # Q100 no FASTDCT
            self.results.append(self.test_turbojpeg(
                "turbojpeg_Q100_nofast",
                quality=100,
                use_fastdct=False
            ))

            # Q95 + FASTDCT
            self.results.append(self.test_turbojpeg(
                "turbojpeg_Q95_fast",
                quality=95,
                use_fastdct=True
            ))

            # Q95 no FASTDCT
            self.results.append(self.test_turbojpeg(
                "turbojpeg_Q95_nofast",
                quality=95,
                use_fastdct=False
            ))

            # Q90 + FASTDCT
            self.results.append(self.test_turbojpeg(
                "turbojpeg_Q90_fast",
                quality=90,
                use_fastdct=True
            ))

        self.print_summary()

    def print_summary(self):
        """결과 요약 출력"""
        print("\n" + "=" * 80)
        print("📈 벤치마크 결과 요약")
        print("=" * 80)

        # 성공한 결과만 필터링
        success_results = [r for r in self.results if r.get('success', False)]

        if not success_results:
            print("❌ 성공한 테스트가 없습니다")
            return

        # 속도 순 정렬
        sorted_by_time = sorted(success_results, key=lambda x: x['time_ms'])

        print("\n🏆 속도 순위 (빠른 순)")
        print("-" * 80)
        print(f"{'순위':<4} {'이름':<30} {'시간(ms)':<12} {'크기(KB)':<12} {'압축률':<10}")
        print("-" * 80)

        for idx, result in enumerate(sorted_by_time, 1):
            time_ms = result['time_ms']
            size_kb = result['size_kb']
            print(f"{idx:<4} {result['name']:<30} {time_ms:<12.0f} {size_kb:<12.1f}")

        # 파일 크기 순 정렬
        sorted_by_size = sorted(success_results, key=lambda x: x['size_kb'])

        print("\n💾 파일 크기 순위 (작은 순)")
        print("-" * 80)
        print(f"{'순위':<4} {'이름':<30} {'크기(KB)':<12} {'시간(ms)':<12}")
        print("-" * 80)

        for idx, result in enumerate(sorted_by_size, 1):
            time_ms = result['time_ms']
            size_kb = result['size_kb']
            print(f"{idx:<4} {result['name']:<30} {size_kb:<12.1f} {time_ms:<12.0f}")

        # 상세 비교
        print("\n📊 상세 비교")
        print("-" * 80)
        print(f"{'이름':<30} {'메서드':<12} {'시간(ms)':<12} {'크기(KB)':<12} {'품질':<8}")
        print("-" * 80)

        for result in success_results:
            method = result['method']
            name = result['name']
            time_ms = result['time_ms']
            size_kb = result['size_kb']
            quality = result.get('quality', 'N/A')

            print(f"{name:<30} {method:<12} {time_ms:<12.0f} {size_kb:<12.1f} {quality:<8}")

        # 최고 성능
        fastest = sorted_by_time[0]
        smallest = sorted_by_size[0]

        print("\n🥇 추천 설정")
        print("-" * 80)
        print(f"⚡ 가장 빠름: {fastest['name']} ({fastest['time_ms']:.0f}ms)")
        print(f"💾 가장 작음: {smallest['name']} ({smallest['size_kb']:.1f}KB)")

        # 균형잡힌 옵션 찾기 (속도 상위 50% + 크기 상위 50%)
        mid_time = sorted_by_time[len(sorted_by_time)//2]['time_ms']
        mid_size = sorted_by_size[len(sorted_by_size)//2]['size_kb']

        balanced = [r for r in success_results if r['time_ms'] <= mid_time and r['size_kb'] <= mid_size]
        if balanced:
            best_balanced = sorted(balanced, key=lambda x: (x['time_ms'] + x['size_kb']/100))[0]
            print(f"⚖️  균형잡힌: {best_balanced['name']} ({best_balanced['time_ms']:.0f}ms, {best_balanced['size_kb']:.1f}KB)")


if __name__ == "__main__":
    input_path = "D:/project/mapviewer/input.png"
    output_dir = "D:/project/mapviewer/benchmark_output"

    runner = BenchmarkRunner(input_path, output_dir, level=0.7)
    runner.run_all_tests()
