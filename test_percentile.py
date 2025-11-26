"""Test percentile calculation"""
import numpy as np

def _percentile_ranks_new(values: np.ndarray) -> np.ndarray:
    """
    주어진 값 배열에 대해 백분위(0~100) 랭크를 계산.
    동일한 값(동점자)은 평균 등수를 부여하여, 값은 같은데 위치만 다를 때 발생하는
    '가짜 그라데이션' 문제를 방지함.
    """
    if values.size == 0:
        return np.zeros_like(values, dtype=np.float32)

    # 1. 값별 빈도수 계산 및 역인덱스 생성
    _, inverse_indices, counts = np.unique(values, return_inverse=True, return_counts=True)

    # 2. 누적 카운트 (각 값 그룹의 상위 누적 개수)
    cumulative_counts = np.cumsum(counts).astype(np.float32)

    # 3. 동점자들의 평균 백분위 계산
    rank_centers = (cumulative_counts - counts + cumulative_counts) / 2.0

    # 4. 백분위로 변환 (0~100)
    total = float(values.size)
    rank_pcts = rank_centers / total * 100.0

    # 5. 원래 위치에 랭크 매핑
    percentiles = rank_pcts[inverse_indices]

    return np.clip(percentiles, 0.0, 100.0)

# Test with square_mean data
square_mean_values = np.array([0, 1, 4, 9, 16, 25, 36, 49], dtype=np.float32)
square_weighted_values = np.array([0, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)

# Simulate a distribution with counts
# Let's say: 0 appears 10000 times, 1 appears 5000 times, etc.
counts_mean = np.array([20000000, 10000000, 4000000, 2000000, 1000000, 300000, 100000, 12398])
counts_weighted = np.array([20000000, 10000000, 4000000, 2000000, 1000000, 300000, 100000, 12398])

# Create synthetic data
mean_data = np.concatenate([np.full(count, val, dtype=np.float32)
                            for val, count in zip(square_mean_values, counts_mean)])
weighted_data = np.concatenate([np.full(count, val, dtype=np.float32)
                                for val, count in zip(square_weighted_values, counts_weighted)])

print("=== square_mean percentiles ===")
mean_pcts = _percentile_ranks_new(mean_data)
unique_vals, indices = np.unique(mean_data, return_index=True)
for val, idx in zip(unique_vals, indices):
    print(f"Value {val:5.1f} -> Percentile {mean_pcts[idx]:6.2f}")

print("\n=== square_weighted percentiles ===")
weighted_pcts = _percentile_ranks_new(weighted_data)
unique_vals, indices = np.unique(weighted_data, return_index=True)
for val, idx in zip(unique_vals, indices):
    print(f"Value {val:5.1f} -> Percentile {weighted_pcts[idx]:6.2f}")

print("\n=== Comparison ===")
print("The percentile distributions are IDENTICAL because both have the same count distribution!")
print("This is why the images look the same.")
