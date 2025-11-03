"""
Chip 기반 노이즈 패턴 Wafer 이미지 생성 스크립트

- 각 chip을 인덱스 1-8로 자연스러운 노이즈 패턴으로 채움
- 인덱스 1로 채워진 chip은 인덱스 9로 테두리
- 불량 chip들은 인덱스 11-14로 자연스럽게 채움
- 팔레트 모드 PNG로 저장
- 병렬 처리 지원 (여러 파일 동시 생성)
- GPU 가속 지원 (PyTorch + CUDA): 모든 이미지 생성 처리를 GPU에서 수행
  * 노이즈 패턴 생성, chip 생성, 테두리 그리기, 경계 계산 등 모든 연산을 GPU에서 처리
  * 최종 이미지 저장 시에만 CPU로 데이터 전송 (파일 I/O는 CPU에서만 가능)
"""
import json
import random
import math
import time
import multiprocessing
from pathlib import Path
from PIL import Image
import numpy as np
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed

# GPU 지원 확인 (PyTorch + CUDA)
# 모듈 레벨에서는 import만 하고, 초기화는 함수에서 수행
TORCH_AVAILABLE = False
GPU_AVAILABLE = False
try:
    import torch
    TORCH_AVAILABLE = True
    GPU_AVAILABLE = torch.cuda.is_available()
except ImportError:
    pass
except Exception:
    pass


def init_gpu_info(verbose: bool = True) -> bool:
    """GPU 정보 초기화 및 출력 (메인 프로세스에서만 호출)"""
    global TORCH_AVAILABLE, GPU_AVAILABLE
    if not TORCH_AVAILABLE:
        if verbose:
            print("[GPU] PyTorch 없음 - CPU만 사용 (pip install torch 또는 conda install pytorch)")
        return False
    
    if not GPU_AVAILABLE:
        if verbose:
            print("[GPU] GPU 사용 불가 - CPU만 사용")
        return False
    
    if verbose:
        try:
            gpu_name = torch.cuda.get_device_name(0)
            gpu_memory = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[GPU] PyTorch + CUDA 사용 가능")
            print(f"[GPU] GPU: {gpu_name}")
            print(f"[GPU] GPU 메모리: {gpu_memory:.1f} GB")
            print(f"[GPU] PyTorch 버전: {torch.__version__}")
            if hasattr(torch.version, 'cuda'):
                print(f"[GPU] CUDA 버전: {torch.version.cuda}")
        except Exception as e:
            if verbose:
                print(f"[GPU] GPU 정보 조회 실패: {e}")
            return False
    
    return True


def hex_to_rgb(hex_color: str) -> list:
    """16진수 색상을 RGB 리스트로 변환"""
    hex_color = hex_color.lstrip('#')
    return [int(hex_color[i:i+2], 16) for i in (0, 2, 4)]


def load_color_legends() -> dict:
    """color-legends.json 파일에서 색상 정보 로드"""
    color_legends_path = Path(__file__).parent.parent / "logs" / "color-legends.json"
    with open(color_legends_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def generate_noise_pattern(size: int, base_index: int, noise_intensity: float = 0.3) -> np.ndarray:
    """
    자연스러운 노이즈 패턴 생성 (Perlin noise 유사)
    
    Args:
        size: 패턴 크기 (chip_size)
        base_index: 기본 인덱스 (1-8)
        noise_intensity: 노이즈 강도 (0.0 ~ 1.0)
    
    Returns:
        numpy 배열 (인덱스 값)
    """
    # 다층 노이즈 생성 (더 자연스러운 패턴)
    pattern = np.zeros((size, size), dtype=np.uint8)
    
    # 기본값은 base_index
    pattern.fill(base_index)
    
    # 여러 스케일의 노이즈를 합성
    scales = [0.1, 0.25, 0.5, 1.0]  # 다양한 주파수
    weights = [0.4, 0.3, 0.2, 0.1]  # 가중치
    
    noise_sum = np.zeros((size, size), dtype=np.float32)
    
    for scale, weight in zip(scales, weights):
        # 스케일에 맞춰 노이즈 생성
        noise_size = max(4, int(size * scale))
        
        # 랜덤 노이즈 생성
        noise = np.random.randn(noise_size, noise_size).astype(np.float32)
        
        # 보간을 위해 리사이즈 (smooth한 전환)
        from scipy.ndimage import zoom
        try:
            zoomed = zoom(noise, size / noise_size, order=3)
        except ImportError:
            # scipy 없으면 간단한 리사이즈
            zoomed = np.array(Image.fromarray(noise).resize((size, size), Image.Resampling.LANCZOS))
            zoomed = (zoomed - zoomed.mean()) / zoomed.std()
        
        noise_sum += zoomed * weight
    
    # 노이즈 정규화
    if noise_sum.std() > 0:
        noise_sum = (noise_sum - noise_sum.mean()) / noise_sum.std()
    
    # 노이즈를 인덱스 변화로 변환
    # 주변 인덱스로 자연스럽게 변화 (base_index ± 0~2 범위)
    index_variation = (noise_sum * noise_intensity * 2).astype(np.int32)
    
    # 인덱스 범위 제한 (1-8)
    result = np.clip(base_index + index_variation, 1, 8).astype(np.uint8)
    
    return result


def generate_noise_pattern_simple(size: int, base_index: int, noise_intensity: float = 0.3, use_gpu: bool = False, device=None):
    """
    간단한 노이즈 패턴 생성 (scipy 없이)
    GPU 지원 (PyTorch + CUDA 사용 시) - CUDA 가속
    """
    if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
        # GPU 사용 (PyTorch) - CUDA 가속
        if device is None:
            try:
                current_device = torch.cuda.current_device()
                device = torch.device(f'cuda:{current_device}')
            except:
                device = torch.device('cuda:0')
        
        # GPU에서 랜덤 시드 설정 (프로세스별로 다른 시드)
        import os
        seed = random.randint(0, 2**32) + (os.getpid() % 1000)
        torch.manual_seed(seed)
        torch.cuda.manual_seed(seed)
        
        # 패턴 생성 (PyTorch 텐서)
        pattern = torch.zeros((size, size), dtype=torch.uint8, device=device)
        pattern.fill_(base_index)
        
        # 가우시안 블러를 이용한 자연스러운 노이즈
        # 1. 고주파 노이즈 생성 (GPU 가속)
        noise = torch.randn(size, size, dtype=torch.float32, device=device)
        
        # 2. 다단계 블러 적용 (자연스러운 전환) - PyTorch 활용
        blurred = noise.clone()
        for _ in range(3):
            # PyTorch의 평균 풀링을 이용한 블러 (GPU 가속)
            kernel_size = 5
            padding = kernel_size // 2
            
            # 2D 평균 풀링을 위한 형태 변환
            blurred_4d = blurred.unsqueeze(0).unsqueeze(0)  # (1, 1, H, W)
            
            # 평균 풀링으로 블러 효과
            blurred_pooled = torch.nn.functional.avg_pool2d(
                blurred_4d, 
                kernel_size=kernel_size, 
                stride=1, 
                padding=padding
            )
            blurred = blurred_pooled.squeeze(0).squeeze(0)  # (H, W)
        
        # 3. 정규화 (GPU 가속)
        if blurred.std() > 0:
            blurred = (blurred - blurred.mean()) / blurred.std()
        
        # 4. 인덱스 변화 적용
        # base_index에 따라 범위 제한
        if base_index == 0:
            # Grade0: 인덱스 0만 사용 (변화 없음)
            index_variation = (blurred * noise_intensity * 0.3).to(torch.int32)
            result = torch.clamp(base_index + index_variation, 0, 0).to(torch.uint8)
        else:
            # Grade1-7: base_index ±1 범위
            index_variation = (blurred * noise_intensity * 1.0).to(torch.int32)
            result = torch.clamp(base_index + index_variation, max(1, base_index-1), min(7, base_index+1)).to(torch.uint8)
        
        # GPU 텐서로 반환 (CPU 변환 안 함)
        # 최종 wafer 배열에서 한 번에 변환
        return result
        
    else:
        # CPU 사용 (NumPy)
        pattern = np.zeros((size, size), dtype=np.uint8)
        pattern.fill(base_index)
        
        # 가우시안 블러를 이용한 자연스러운 노이즈
        # 1. 고주파 노이즈 생성
        noise = np.random.randn(size, size).astype(np.float32)
        
        # 2. 다단계 블러 적용 (자연스러운 전환)
        blurred = noise.copy()
        for _ in range(3):
            kernel_size = 5
            kernel_val = 1.0 / (kernel_size * kernel_size)
            padded = np.pad(blurred, kernel_size//2, mode='edge')
            blurred = np.zeros_like(noise)
            for i in range(size):
                for j in range(size):
                    blurred[i, j] = padded[i:i+kernel_size, j:j+kernel_size].sum() * kernel_val
        
        # 3. 정규화
        if blurred.std() > 0:
            blurred = (blurred - blurred.mean()) / blurred.std()
        
        # 4. 인덱스 변화 적용
        # base_index에 따라 범위 제한
        if base_index == 0:
            # Grade0: 인덱스 0만 사용 (변화 없음)
            index_variation = (blurred * noise_intensity * 0.3).astype(np.int32)
            result = np.clip(base_index + index_variation, 0, 0).astype(np.uint8)
        else:
            # Grade1-7: base_index ±1 범위
            index_variation = (blurred * noise_intensity * 1.0).astype(np.int32)
            result = np.clip(base_index + index_variation, max(1, base_index-1), min(7, base_index+1)).astype(np.uint8)
    
    return result


def generate_chip_with_noise(size: int, grade_index: int, use_gpu: bool = False, device=None):
    """
    노이즈 패턴이 있는 chip 생성
    
    Args:
        size: chip 크기
        grade_index: Grade 인덱스 (0=Grade0, 1=Grade1, ..., 7=Grade7)
        use_gpu: GPU 사용 여부
        device: PyTorch device (GPU 사용 시)
    
    Returns:
        numpy 배열 또는 torch 텐서 (인덱스 값)
    """
    # 노이즈 강도 랜덤 (약간의 변화)
    noise_intensity = random.uniform(0.2, 0.4)
    
    if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
        # GPU 사용: GPU 텐서로 반환
        pattern = generate_noise_pattern_simple(size, grade_index, noise_intensity, use_gpu, device)
        return pattern
    else:
        # CPU 사용: scipy 또는 간단한 버전
        try:
            from scipy.ndimage import zoom
            pattern = generate_noise_pattern(size, grade_index, noise_intensity)
        except ImportError:
            pattern = generate_noise_pattern_simple(size, grade_index, noise_intensity, use_gpu)
        return pattern


def draw_chip_border(chip_data, border_width: int = 2, border_index: int = 9, is_tensor: bool = False, device=None):
    """
    chip 테두리 그리기 (numpy 배열 또는 torch 텐서)
    GPU 최적화: 벡터화된 연산 사용
    
    Args:
        chip_data: chip 데이터 (in-place 수정)
        border_width: 테두리 두께
        border_index: 테두리 인덱스
        is_tensor: torch 텐서인지 여부
        device: GPU device (텐서인 경우)
    """
    h, w = chip_data.shape
    if is_tensor:
        # GPU 텐서 버전: 벡터화된 연산으로 모든 테두리를 한 번에 설정
        border_idx_tensor = torch.tensor(border_index, dtype=torch.uint8, device=device)
        for i in range(border_width):
            chip_data[i, :] = border_idx_tensor  # 상
            chip_data[h-1-i, :] = border_idx_tensor  # 하
            chip_data[:, i] = border_idx_tensor  # 좌
            chip_data[:, w-1-i] = border_idx_tensor  # 우
    else:
        # NumPy 배열 버전
        for i in range(border_width):
            chip_data[i, :] = border_index  # 상
            chip_data[h-1-i, :] = border_index  # 하
            chip_data[:, i] = border_index  # 좌
            chip_data[:, w-1-i] = border_index  # 우


def palette_to_rgb_gpu(wafer_tensor: torch.Tensor, palette: list, device: torch.device) -> torch.Tensor:
    """
    GPU에서 팔레트 인덱스 텐서를 RGB 텐서로 변환 (모든 처리를 GPU에서 수행)
    
    Args:
        wafer_tensor: 팔레트 인덱스 텐서 (H, W) uint8, GPU에 위치
        palette: RGB 팔레트 리스트 (32 * 3 = 96개 값)
        device: GPU device
    
    Returns:
        RGB 텐서 (H, W, 3) uint8, GPU에 위치
    """
    h, w = wafer_tensor.shape
    
    # 팔레트를 GPU 텐서로 변환 (32, 3) shape
    palette_tensor = torch.tensor(palette, dtype=torch.uint8, device=device).view(32, 3)
    
    # 인덱스를 0-31 범위로 클램프 (안전장치)
    indices = torch.clamp(wafer_tensor.long(), 0, 31)
    
    # 인덱싱으로 RGB 값 가져오기 (H, W, 3)
    rgb_tensor = palette_tensor[indices]  # GPU에서 직접 인덱싱
    
    return rgb_tensor


def generate_wafer_image(
    output_path: Path,
    grid_size: int = 25,
    chip_size: int = 100,
    wafer_radius_ratio: float = 0.45,
    defect_ratio: float = 0.05,
    target_size_mb: float = None,
    use_gpu: bool = False
):
    """
    Chip 기반 노이즈 패턴 Wafer 이미지 생성
    
    Args:
        output_path: 출력 이미지 경로
        grid_size: 격자 크기 (N x N chips)
        chip_size: 각 chip의 픽셀 크기
        wafer_radius_ratio: wafer 반지름 비율
        defect_ratio: 불량 chip 비율
    """
    # 색상 정보 로드
    color_data = load_color_legends()
    default_colors = color_data['default']
    
    # 팔레트 생성 (32색)
    palette = [0] * (32 * 3)
    
    # 인덱스 0: Grade0 (chip 내부, 80% 차지)
    grade0_rgb = hex_to_rgb(default_colors['top']['Grade0'])
    palette[0:3] = grade0_rgb
    
    # 인덱스 1-7: Grade1-7 (chip 내부 불량 부분, 20%)
    grade_order = ['Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7']
    for i, grade in enumerate(grade_order, start=1):
        hex_color = default_colors['top'][grade]
        rgb = hex_to_rgb(hex_color)
        palette[i*3:(i*3)+3] = rgb
    
    # 인덱스 8: 미사용
    palette[8*3:(8*3)+3] = [0, 0, 0]
    
    # 인덱스 9: Normal (칩 테두리용)
    normal_rgb = hex_to_rgb(default_colors['bottom']['Normal'])
    palette[9*3:(9*3)+3] = normal_rgb
    
    # 인덱스 10: Invalid (사용 안 함, 예비)
    invalid_rgb = hex_to_rgb(default_colors['bottom']['Invalid'])
    palette[10*3:(10*3)+3] = invalid_rgb
    
    # 인덱스 11-14: 불량 종류 (B285-B288)
    defect_indices = {
        11: 'B285',
        12: 'B286',
        13: 'B287',
        14: 'B288'
    }
    for idx, defect_type in defect_indices.items():
        defect_rgb = hex_to_rgb(default_colors['bottom'][defect_type])
        palette[idx*3:(idx*3)+3] = defect_rgb
    
    # 인덱스 15: Background
    bg_rgb = hex_to_rgb(default_colors['background'])
    palette[15*3:(15*3)+3] = bg_rgb
    
    # 인덱스 16-31: 검은색
    for i in range(16, 32):
        palette[i*3:(i*3)+3] = [0, 0, 0]
    
    # 이미지 크기 계산
    image_size = grid_size * chip_size
    
    # GPU 사용 시 전체 wafer 배열을 GPU 텐서로 생성
    if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
        device = torch.device('cuda:0')
        wafer_tensor = torch.full((image_size, image_size), 15, dtype=torch.uint8, device=device)  # 배경색 (인덱스 15)
    else:
        # CPU 사용 시 numpy 배열
        wafer_array = np.zeros((image_size, image_size), dtype=np.uint8)
        wafer_array.fill(15)  # 배경색 (인덱스 15)
    
    # 각 chip 생성
    total_chips = grid_size * grid_size
    chips_processed = 0
    
    for row in range(grid_size):
        for col in range(grid_size):
            chip_idx = row * grid_size + col
            chip_x_start = col * chip_size
            chip_y_start = row * chip_size
            chip_x_end = chip_x_start + chip_size
            chip_y_end = chip_y_start + chip_size
            
            # Chip 단위 정상/불량 구분: 80% 정상 chip (완전히 Grade0만), 20% 불량 chip (불량 패턴 포함)
            # 정상 chip 비율
            normal_chip_ratio = 0.8
            is_normal_chip = random.random() < normal_chip_ratio
            
            if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
                # GPU 버전: 모든 작업을 GPU에서 수행
                if is_normal_chip:
                    # 정상 chip: 완전히 Grade0만 (노이즈 패턴)
                    chip_pattern = generate_chip_with_noise(chip_size, 0, use_gpu, device)  # Grade0 (GPU 텐서)
                    border_index = 9  # Normal 테두리
                else:
                    # 불량 chip: Grade0 + 불량 패턴 혼합
                    grade0_pattern = generate_chip_with_noise(chip_size, 0, use_gpu, device)  # Grade0 (GPU 텐서)
                    
                    # Grade1-7 영역 (불량 부분, 노이즈 패턴)
                    defect_grade = random.randint(1, 7)  # 1-7 중 하나
                    defect_pattern = generate_chip_with_noise(chip_size, defect_grade, use_gpu, device)  # Grade1-7 (GPU 텐서)
                    
                    # 불량 chip 내부: 30% 불량, 70% Grade0 (chip 자체가 불량이므로)
                    defect_ratio_in_chip = 0.3
                    mask = torch.rand(chip_size, chip_size, device=device) < (1.0 - defect_ratio_in_chip)
                    chip_pattern = torch.where(mask, grade0_pattern, defect_pattern).to(torch.uint8)
                    
                    # 불량 타입 결정 (GPU에서)
                    defect_mask = chip_pattern > 0
                    if torch.any(defect_mask):
                        defect_values = chip_pattern[defect_mask]
                        unique_vals, counts = torch.unique(defect_values, return_counts=True)
                        main_defect = unique_vals[torch.argmax(counts)].item()
                        
                        if main_defect == 1:
                            border_index = 11  # Grade1 -> B285
                        elif main_defect == 2:
                            border_index = 12  # Grade2 -> B286
                        elif main_defect == 3:
                            border_index = 13  # Grade3 -> B287
                        else:  # Grade4-7
                            border_index = 14  # Grade4-7 -> B288
                    else:
                        border_index = 9  # 기본값
                
                # 테두리 그리기 (GPU 텐서)
                draw_chip_border(chip_pattern, border_width=2, border_index=border_index, is_tensor=True, device=device)
                
                # GPU wafer 텐서에 직접 복사 (GPU에서)
                wafer_tensor[chip_y_start:chip_y_end, chip_x_start:chip_x_end] = chip_pattern
                
            else:
                # CPU 버전: chip 단위 정상/불량 구분
                if is_normal_chip:
                    # 정상 chip: 완전히 Grade0만 (노이즈 패턴)
                    chip_pattern = generate_chip_with_noise(chip_size, 0, use_gpu)  # Grade0
                    border_index = 9  # Normal 테두리
                else:
                    # 불량 chip: Grade0 + 불량 패턴 혼합
                    chip_pattern = np.zeros((chip_size, chip_size), dtype=np.uint8)
                    
                    # Grade0 영역 (노이즈 패턴)
                    grade0_pattern = generate_chip_with_noise(chip_size, 0, use_gpu)  # Grade0
                    
                    # Grade1-7 영역 (불량 부분, 노이즈 패턴)
                    defect_grade = random.randint(1, 7)  # 1-7 중 하나
                    defect_pattern = generate_chip_with_noise(chip_size, defect_grade, use_gpu)  # Grade1-7
                    
                    # 불량 chip 내부: 30% 불량, 70% Grade0
                    defect_ratio_in_chip = 0.3
                    mask = np.random.rand(chip_size, chip_size) < (1.0 - defect_ratio_in_chip)
                    chip_pattern[mask] = grade0_pattern[mask]
                    chip_pattern[~mask] = defect_pattern[~mask]
                    
                    # 불량 타입 결정
                    defect_grades_in_chip = chip_pattern[chip_pattern > 0]
                    if len(defect_grades_in_chip) > 0:
                        unique, counts = np.unique(defect_grades_in_chip, return_counts=True)
                        main_defect = unique[np.argmax(counts)]
                        
                        if main_defect == 1:
                            border_index = 11
                        elif main_defect == 2:
                            border_index = 12
                        elif main_defect == 3:
                            border_index = 13
                        else:
                            border_index = 14
                    else:
                        border_index = 9  # 기본값
                
                # 테두리 그리기
                draw_chip_border(chip_pattern, border_width=2, border_index=border_index, is_tensor=False)
                
                wafer_array[chip_y_start:chip_y_end, chip_x_start:chip_x_end] = chip_pattern
            
            # 진행 상황 출력 (1% 또는 100개 단위, 더 자주)
            chips_processed += 1
            update_interval = max(100, total_chips // 100)  # 최소 100개마다, 최대 1%마다
            if chips_processed % update_interval == 0:
                progress = (chips_processed / total_chips) * 100
                import sys
                sys.stdout.write(f"\r  [진행] {chips_processed}/{total_chips} chips ({progress:.1f}%)      ")
                sys.stdout.flush()
    
    print()  # 진행 상황 출력 줄바꿈
    print(f"  [진행] Chip 생성 완료, Wafer 경계 적용 중...")
    
    # Wafer 원형 경계 적용
    center_x, center_y = image_size // 2, image_size // 2
    wafer_radius = int(image_size * wafer_radius_ratio)
    
    print(f"  [진행] Wafer 경계 적용 중... ({image_size}x{image_size} 픽셀)")
    
    if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
        # GPU 버전: 모든 처리를 GPU에서 수행
        # 1. 전체 경계를 한 번에 계산 (GPU에서)
        y_coords, x_coords = torch.meshgrid(
            torch.arange(image_size, device=device, dtype=torch.float32),
            torch.arange(image_size, device=device, dtype=torch.float32),
            indexing='ij'
        )
        
        # 중심으로부터 거리 계산 (GPU에서)
        dist_from_center = torch.sqrt((x_coords - center_x)**2 + (y_coords - center_y)**2)
        
        # wafer 경계 밖은 background(인덱스 15)로 복원 (GPU에서)
        wafer_tensor[dist_from_center > wafer_radius] = 15
        
        # 2. GPU에서 팔레트 인덱스 배열을 CPU로 한 번만 전송 (이미지 저장 전)
        # 모든 GPU 연산 완료 후 최종 결과만 전송
        print(f"  [진행] GPU -> CPU 데이터 전송 중 (팔레트 인덱스)...")
        wafer_array = wafer_tensor.cpu().numpy().astype(np.uint8)
        
        # GPU 메모리 정리
        del wafer_tensor, y_coords, x_coords, dist_from_center
        torch.cuda.empty_cache()
        
        # 3. PIL 이미지로 변환 및 저장 (CPU에서만 수행, 필수 - 파일 I/O)
        # 팔레트 모드로 직접 생성 (RGB 변환 불필요, 더 효율적)
        print(f"  [진행] PIL 이미지 생성 및 PNG 파일 저장 중...")
        img = Image.new('P', (image_size, image_size))
        img.putpalette(palette)
        img.putdata(wafer_array.flatten())
        
        # PNG로 저장 (팔레트 모드, 압축 최소화로 파일 크기 증가)
        img.save(output_path, 'PNG', compress_level=1, optimize=False)
        print(f"  [진행] 파일 저장 완료: {output_path.name}")
        
    else:
        # CPU 버전: 기존 로직
        for y in range(image_size):
            if y % max(1, image_size // 20) == 0:
                progress = (y / image_size) * 100
                import sys
                sys.stdout.write(f"\r  [진행] 경계 적용: {progress:.0f}%      ")
                sys.stdout.flush()
            for x in range(image_size):
                dist_from_center = math.sqrt((x - center_x)**2 + (y - center_y)**2)
                if dist_from_center > wafer_radius:
                    wafer_array[y, x] = 15
        print()  # 줄바꿈
        
        # PIL 이미지로 변환
        img = Image.new('P', (image_size, image_size))
        img.putpalette(palette)
        img.putdata(wafer_array.flatten())
        
        # PNG로 저장 (팔레트 모드, 압축 최소화로 파일 크기 증가)
        print(f"  [진행] PNG 파일 저장 중...")
        img.save(output_path, 'PNG', compress_level=1, optimize=False)
        print(f"  [진행] 파일 저장 완료: {output_path.name}")
    
    return image_size


def generate_single_file(config_dict: dict, target_dir: Path, use_gpu: bool = False) -> dict:
    """단일 파일 생성"""
    config = config_dict
    filename = config["name"]
    output_path = target_dir / filename
    
    start_time = time.time()
    
    # GPU 설정 (순차 처리 시 GPU 집중 사용)
    if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
        try:
            # GPU 0 사용 (단일 GPU 환경)
            torch.cuda.set_device(0)
            # GPU 메모리 초기화 (이전 작업의 메모리 정리)
            torch.cuda.empty_cache()
        except Exception as e:
            print(f"[WARN] GPU 설정 실패: {e}")
            use_gpu = False
    
    try:
        image_size = generate_wafer_image(
            output_path=output_path,
            grid_size=config["grid"],
            chip_size=config["chip"],
            wafer_radius_ratio=0.45,
            defect_ratio=random.uniform(0.03, 0.07),
            target_size_mb=config.get("target_mb"),
            use_gpu=use_gpu
        )
        
        elapsed = time.time() - start_time
        file_size_mb = output_path.stat().st_size / (1024 * 1024)
        total_pixels = image_size * image_size
        pixels_million = total_pixels / 1_000_000
        
        # GPU 메모리 정리 (다음 파일 생성을 위해)
        if use_gpu and GPU_AVAILABLE and TORCH_AVAILABLE:
            torch.cuda.empty_cache()
        
        return {
            "success": True,
            "filename": filename,
            "image_size": image_size,
            "pixels_million": pixels_million,
            "file_size_mb": file_size_mb,
            "target_mb": config.get("target_mb"),
            "elapsed": elapsed
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "filename": filename,
            "error": str(e)
        }


def main():
    """메인 함수"""
    print("="*80)
    print("Chip 기반 노이즈 패턴 Wafer 이미지 생성 (병렬 처리 지원)")
    print("="*80)
    
    # GPU 정보 초기화 (메인 프로세스에서만 출력)
    use_gpu = init_gpu_info(verbose=True)
    
    # GPU 사용 시 순차 처리, CPU 사용 시 병렬 처리
    # GPU는 파일을 하나씩 생성하는 것이 더 효율적 (GPU 메모리 집중 사용)
    # CPU는 병렬 처리로 여러 파일 동시 생성
    # GPU에서도 병렬 처리를 원하면 use_gpu_parallel=True로 변경 가능 (단, GPU 메모리 부족 시 OOM 발생 가능)
    use_gpu_parallel = False  # GPU 병렬 처리 여부 (False 권장: 메모리 부족 방지)
    use_parallel = not use_gpu or (use_gpu and use_gpu_parallel)  # GPU 사용 시 순차 처리 (병렬 옵션 있음)
    max_workers = min(multiprocessing.cpu_count(), 5)  # 최대 5개 파일 동시 처리
    if use_gpu:
        max_workers = min(2, len(file_configs) if 'file_configs' in locals() else 2)  # GPU는 최대 2개 동시 처리 (메모리 고려)
    
    print(f"\n[INFO] CPU 코어 수: {multiprocessing.cpu_count()}")
    print(f"[INFO] GPU 가속: {'ON' if use_gpu else 'OFF'}")
    if use_gpu:
        print(f"[INFO] 처리 방식: 순차 처리 (GPU 집중 사용, 파일을 하나씩 생성)")
    else:
        print(f"[INFO] 처리 방식: 병렬 처리 ({max_workers} workers)")
    
    # 타겟 디렉토리
    target_dir = Path("D:/project/data/wm-811k/palette_5mb")
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # 기존 파일 백업 여부 확인
    existing_files = list(target_dir.glob("*.png"))
    backup_files = list(target_dir.glob("*.png.backup"))
    
    if existing_files and not backup_files:
        print(f"[WARN] 기존 PNG 파일이 있지만 백업이 없습니다.")
        print(f"[WARN] 백업 파일을 찾을 수 없어 기존 파일을 덮어씁니다.")
    
    # 생성할 파일들 (용량 2배 증가: 이미지 크기 약 1.41배)
    # 팔레트 PNG는 노이즈 패턴 때문에 압축률이 낮을 수 있음
    # chip 개수: 약 500개 (grid ≈ 22-23), chip 크기 증가
    file_configs = [
        {"name": "wafer_palette_5mb.png", "grid": 22, "chip": 354, "target_mb": 5.0},    # 약 7,788x7,788 = 61M 픽셀 (chip 484개, 약 2배)
        {"name": "wafer_palette_10mb.png", "grid": 23, "chip": 396, "target_mb": 10.0},  # 약 9,108x9,108 = 83M 픽셀 (chip 529개, 약 2배)
        {"name": "wafer_palette_15mb.png", "grid": 23, "chip": 424, "target_mb": 15.0},  # 약 9,752x9,752 = 95M 픽셀 (chip 529개, 약 2배)
        {"name": "wafer_palette_20mb.png", "grid": 23, "chip": 452, "target_mb": 20.0},  # 약 10,396x10,396 = 108M 픽셀 (chip 529개, 약 2배)
        {"name": "wafer_palette_25mb.png", "grid": 23, "chip": 480, "target_mb": 25.0},  # 약 11,040x11,040 = 122M 픽셀 (chip 529개, 약 2배)
    ]
    
    print(f"\n[INFO] 출력 폴더: {target_dir}")
    print(f"[INFO] 생성할 파일: {len(file_configs)}개\n")
    print("="*80)
    
    total_start_time = time.time()
    
    if use_parallel and len(file_configs) > 1 and not use_gpu:
        # CPU 병렬 처리 (GPU 미사용 시만)
        print(f"\n[PARALLEL CPU] {max_workers}개 프로세스로 병렬 생성 시작...\n")
        results = []
        
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            # 모든 작업 제출
            future_to_config = {
                executor.submit(generate_single_file, config, target_dir, False): config  # CPU만 사용
                for config in file_configs
            }
            
            # 완료된 작업부터 결과 수집
            for future in as_completed(future_to_config):
                config = future_to_config[future]
                try:
                    result = future.result()
                    results.append(result)
                    
                    if result["success"]:
                        print(f"[OK] {result['filename']}: "
                              f"{result['image_size']:,}x{result['image_size']:,}px "
                              f"({result['pixels_million']:.1f}M 픽셀), "
                              f"{result['file_size_mb']:.2f}MB "
                              f"(목표: {result['target_mb']}MB, "
                              f"소요: {result['elapsed']:.1f}초)")
                    else:
                        print(f"[ERROR] {result['filename']}: {result.get('error', 'Unknown error')}")
                except Exception as e:
                    print(f"[ERROR] {config['name']}: {e}")
                    import traceback
                    traceback.print_exc()
    else:
        # 순차 처리 (GPU 사용 시 또는 단일 파일)
        if use_gpu:
            print(f"\n[SEQUENTIAL GPU] 파일을 하나씩 순차 생성 (GPU 집중 사용)...\n")
        else:
            print(f"\n[SEQUENTIAL CPU] 파일을 하나씩 순차 생성...\n")
        
        results = []
        previous_file_size_mb = None
        previous_config = None
        
        for i, config in enumerate(file_configs, 1):
            filename = config["name"]
            
            # 이전 파일이 있고, 크기 조정이 필요한 경우
            if previous_file_size_mb is not None and i > 1:
                # 목표: 이전 파일 크기의 1.5배 이상
                target_min_size_mb = previous_file_size_mb * 1.5
                
                # 현재 설정으로 예상되는 이미지 크기 계산
                current_image_size = config["grid"] * config["chip"]
                current_pixels = current_image_size * current_image_size
                
                # 이전 파일의 실제 크기로부터 픽셀당 MB 비율 계산
                if previous_config:
                    prev_image_size = previous_config["grid"] * previous_config["chip"]
                    prev_pixels = prev_image_size * prev_image_size
                    pixels_per_mb = prev_pixels / previous_file_size_mb if previous_file_size_mb > 0 else 0
                else:
                    pixels_per_mb = current_pixels / config.get("target_mb", 5.0) if config.get("target_mb", 5.0) > 0 else 0
                
                # 목표 크기에 필요한 픽셀 수 계산
                if pixels_per_mb > 0:
                    target_pixels = target_min_size_mb * pixels_per_mb
                    target_image_size = int(math.sqrt(target_pixels))
                    
                    # 현재 크기가 목표보다 작으면 조정
                    if current_image_size < target_image_size:
                        # grid와 chip을 균등하게 증가시켜서 목표 크기 달성
                        scale_factor = target_image_size / current_image_size
                        # 최소 1.5배는 되도록 보장
                        scale_factor = max(scale_factor, math.sqrt(1.5))
                        
                        new_image_size = int(current_image_size * scale_factor)
                        # grid와 chip 비율 유지하면서 증가
                        grid_ratio = config["grid"] / current_image_size
                        chip_ratio = config["chip"] / current_image_size
                        
                        # grid는 정수여야 하므로 조정
                        new_grid = max(int(new_image_size * grid_ratio), config["grid"] + 1)
                        new_chip = int(new_image_size / new_grid)
                        
                        # chip 크기가 너무 작아지지 않도록 조정
                        if new_chip < config["chip"]:
                            new_chip = int(config["chip"] * math.sqrt(1.5))
                            new_grid = int(new_image_size / new_chip)
                        
                        config = config.copy()
                        config["grid"] = new_grid
                        config["chip"] = new_chip
                        
                        expected_image_size = new_grid * new_chip
                        expected_mb = (expected_image_size * expected_image_size) / pixels_per_mb if pixels_per_mb > 0 else config.get("target_mb", 5.0)
                        
                        original_config = file_configs[i-1] if i > 1 else file_configs[0]
                        prev_used_config = previous_config if previous_config else original_config
                        
                        print(f"\n[{i}/{len(file_configs)}] 크기 자동 조정: {filename}")
                        print(f"  이전 파일 크기: {previous_file_size_mb:.2f}MB")
                        print(f"  목표 최소 크기: {target_min_size_mb:.2f}MB (이전의 1.5배)")
                        print(f"  원래 설정: Grid {original_config['grid']}x{original_config['grid']}, Chip {original_config['chip']}px")
                        print(f"  이전 사용 설정: Grid {prev_used_config['grid']}x{prev_used_config['grid']}, Chip {prev_used_config['chip']}px")
                        print(f"  조정된 설정: Grid {new_grid}x{new_grid}, Chip {new_chip}px")
                        print(f"  예상 크기: {expected_image_size:,}x{expected_image_size:,}px ({expected_mb:.2f}MB)")
            
            print(f"\n[{i}/{len(file_configs)}] 생성 중: {filename}")
            print(f"  Grid: {config['grid']}x{config['grid']}, Chip size: {config['chip']}px")
            
            result = generate_single_file(config, target_dir, use_gpu)
            results.append(result)
            
            if result["success"]:
                current_file_size_mb = result["file_size_mb"]
                
                # 크기 비교 출력 (이전 파일과 비교)
                if i > 1 and previous_file_size_mb is not None:
                    size_increase = (current_file_size_mb / previous_file_size_mb) if previous_file_size_mb > 0 else 0
                    print(f"  [OK] 완료: {result['image_size']:,}x{result['image_size']:,}px "
                          f"({result['pixels_million']:.1f}M 픽셀), {current_file_size_mb:.2f}MB "
                          f"(목표: {result['target_mb']}MB, 소요: {result['elapsed']:.1f}초)")
                    print(f"  [크기 증가] 이전 대비 {size_increase:.2f}배 ({current_file_size_mb:.2f}MB / {previous_file_size_mb:.2f}MB)")
                else:
                    print(f"  [OK] 완료: {result['image_size']:,}x{result['image_size']:,}px "
                          f"({result['pixels_million']:.1f}M 픽셀), {current_file_size_mb:.2f}MB "
                          f"(목표: {result['target_mb']}MB, 소요: {result['elapsed']:.1f}초)")
                
                # 다음 파일을 위한 이전 파일 정보 업데이트
                previous_file_size_mb = current_file_size_mb
                previous_config = config.copy()
            else:
                print(f"  [ERROR] 실패: {result.get('error', 'Unknown error')}")
                import traceback
                traceback.print_exc()
                # 실패해도 이전 값 유지 (다음 파일 조정에 사용)
    
    total_elapsed = time.time() - total_start_time
    success_count = sum(1 for r in results if r.get("success", False))
    
    print("\n" + "="*80)
    print("[RESULT] 생성 완료!")
    print(f"  성공: {success_count}/{len(file_configs)}개 파일")
    print(f"  총 소요 시간: {total_elapsed:.1f}초")
    if success_count > 0:
        avg_time = total_elapsed / success_count
        print(f"  평균 파일당 소요 시간: {avg_time:.1f}초")
    print(f"  위치: {target_dir}")
    print("="*80)


if __name__ == "__main__":
    main()

