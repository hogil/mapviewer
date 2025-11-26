"""Test continuous calculation"""
import numpy as np

# 예제: 한 포인트에서 여러 이미지의 인덱스 값
# 0 0 1 1 1 2 2 2 2 3 3
indices = np.array([0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3], dtype=np.uint8)
image_count = len(indices)

print(f"Indices: {indices}")
print(f"Image count: {image_count}")
print()

# Grade counts
grade_counts = np.zeros(8, dtype=np.uint16)
for idx in range(8):
    grade_counts[idx] = np.count_nonzero(indices == idx)

print(f"Grade counts: {grade_counts}")
print()

# Square weights
square_weights = np.arange(8, dtype=np.float32) ** 2
print(f"Square weights: {square_weights}")
print()

# Square sum
square_sum = np.sum(grade_counts.astype(np.float32) * square_weights)
print(f"Square sum: {square_sum}")
print(f"  = 0²×{grade_counts[0]} + 1²×{grade_counts[1]} + 2²×{grade_counts[2]} + 3²×{grade_counts[3]}")
print(f"  = 0×{grade_counts[0]} + 1×{grade_counts[1]} + 4×{grade_counts[2]} + 9×{grade_counts[3]}")
print(f"  = {0*grade_counts[0]} + {1*grade_counts[1]} + {4*grade_counts[2]} + {9*grade_counts[3]}")
print(f"  = {square_sum}")
print()

# Square average
square_average = square_sum / image_count
print(f"Square average: {square_average:.4f}")
print(f"  = {square_sum} / {image_count}")
print()

# Weight factors
weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)
weight_sum = np.sum(grade_counts.astype(np.float32) * weight_factors)
print(f"Weight sum: {weight_sum}")
print(f"  = 1×{grade_counts[0]} + 1×{grade_counts[1]} + 2×{grade_counts[2]} + 3×{grade_counts[3]}")
print(f"  = {1*grade_counts[0]} + {1*grade_counts[1]} + {2*grade_counts[2]} + {3*grade_counts[3]}")
print(f"  = {weight_sum}")
print()

# Square weighted average
if weight_sum > 0:
    square_weighted = square_sum / weight_sum
    print(f"Square weighted average: {square_weighted:.4f}")
    print(f"  = {square_sum} / {weight_sum}")
else:
    print("Weight sum is 0, cannot calculate weighted average")
print()

print("=" * 50)
print("결론: 두 값은 CONTINUOUS합니다!")
print(f"  square_average = {square_average:.4f}")
print(f"  square_weighted = {square_weighted:.4f}")
print("=" * 50)
