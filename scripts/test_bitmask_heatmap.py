"""
비트마스크 기반 인덱스별 히트맵 생성 테스트

로직:
1. 동일 포인트 내에 인덱스 0-7만 있는 경우:
   - 특정 인덱스가 있으면 그 인덱스로 표시
   - 없으면 인덱스 31로 변경
2. 동일 포인트 내에 인덱스 8 이상이 있으면:
   - 인덱스 종류 중 max 값 사용
"""
import numpy as np
from PIL import Image

def create_heatmap_from_bitmask(
    presence_map: np.ndarray,
    high_mask_combined: np.ndarray,
    high_indices_combined: np.ndarray,
    target_idx: int,
    height: int,
    width: int
) -> np.ndarray:
    """
    비트마스크 기반 인덱스별 히트맵 생성
    
    Args:
        presence_map: 각 픽셀에서 등장한 인덱스 0-7의 비트마스크
        high_mask_combined: 인덱스 8 이상이 있는 픽셀 마스크
        high_indices_combined: 인덱스 8 이상 중 최댓값
        target_idx: 생성할 히트맵의 인덱스 (0-7)
        height, width: 이미지 크기
    
    Returns:
        히트맵 배열 (uint8)
    """
    # 결과 배열 초기화
    result = np.zeros((height, width), dtype=np.uint8)
    
    # 1. 인덱스 8 이상이 있는 픽셀: max 값 사용
    if np.any(high_mask_combined):
        result[high_mask_combined] = high_indices_combined[high_mask_combined]
    
    # 2. 인덱스 0-7만 있는 픽셀 처리
    low_only_mask = ~high_mask_combined  # 인덱스 8 이상이 없는 픽셀
    
    if np.any(low_only_mask):
        # 타겟 인덱스의 비트 플래그
        target_bit = 1 << target_idx
        
        # 타겟 인덱스가 있는 픽셀
        has_target = (presence_map & target_bit) != 0
        
        # 인덱스 0-7만 있는 픽셀 중에서
        low_only_pixels = low_only_mask & has_target
        
        # 타겟 인덱스가 있으면 그 인덱스로
        result[low_only_pixels] = target_idx
        
        # 타겟 인덱스가 없으면 인덱스 31로
        low_only_no_target = low_only_mask & ~has_target
        result[low_only_no_target] = 31
    
    return result


def test_bitmask_heatmap():
    """비트마스크 히트맵 생성 테스트"""
    height, width = 100, 100
    
    # 테스트 케이스 1: 인덱스 0, 2, 5가 등장 (인덱스 8 이상 없음)
    presence_map_1 = np.zeros((height, width), dtype=np.uint8)
    presence_map_1[50, 50] = (1 << 0) | (1 << 2) | (1 << 5)  # 인덱스 0, 2, 5
    
    high_mask_1 = np.zeros((height, width), dtype=bool)
    high_indices_1 = np.zeros((height, width), dtype=np.uint8)
    
    # 인덱스 0의 히트맵
    heatmap_0 = create_heatmap_from_bitmask(
        presence_map_1, high_mask_1, high_indices_1, 0, height, width
    )
    assert heatmap_0[50, 50] == 0, "인덱스 0이 있으면 0이어야 함"
    assert heatmap_0[0, 0] == 31, "인덱스 0이 없으면 31이어야 함"
    
    # 인덱스 1의 히트맵
    heatmap_1 = create_heatmap_from_bitmask(
        presence_map_1, high_mask_1, high_indices_1, 1, height, width
    )
    assert heatmap_1[50, 50] == 31, "인덱스 1이 없으면 31이어야 함"
    
    print("[OK] 테스트 케이스 1 통과: 인덱스 0-7만 있는 경우")
    
    # 테스트 케이스 2: 인덱스 8 이상이 있는 경우
    presence_map_2 = np.zeros((height, width), dtype=np.uint8)
    presence_map_2[50, 50] = (1 << 0) | (1 << 2)  # 인덱스 0, 2
    
    high_mask_2 = np.zeros((height, width), dtype=bool)
    high_mask_2[50, 50] = True  # 인덱스 8 이상 있음
    high_indices_2 = np.zeros((height, width), dtype=np.uint8)
    high_indices_2[50, 50] = 12  # 최댓값 12
    
    # 인덱스 0의 히트맵
    heatmap_0_high = create_heatmap_from_bitmask(
        presence_map_2, high_mask_2, high_indices_2, 0, height, width
    )
    assert heatmap_0_high[50, 50] == 12, "인덱스 8 이상이 있으면 max 값(12)이어야 함"
    
    print("[OK] 테스트 케이스 2 통과: 인덱스 8 이상이 있는 경우")
    
    print("\n[SUCCESS] 모든 테스트 통과!")


if __name__ == "__main__":
    test_bitmask_heatmap()

