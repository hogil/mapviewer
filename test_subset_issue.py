"""Test subset calculation issue"""
import numpy as np
from pathlib import Path

# Simulate the issue
print("=== Simulating Subset Calculation Issue ===\n")

# Mock data: 3 images, 5x5 grid
# Point distributions:
# - Some points: only grade 0
# - Some points: only grade 1  
# - Some points: only grade 2
# - Some points: mixed grades

height, width = 5, 5
image_count = 3

# Create grade_counts (8 x H x W)
grade_counts = np.zeros((8, height, width), dtype=np.uint16)

# Point (0,0): All grade 0 (3 images)
grade_counts[0, 0, 0] = 3

# Point (0,1): All grade 1 (3 images)
grade_counts[1, 0, 1] = 3

# Point (0,2): All grade 2 (3 images)
grade_counts[2, 0, 2] = 3

# Point (1,0): Mixed - grade 0 (1), grade 1 (2)
grade_counts[0, 1, 0] = 1
grade_counts[1, 1, 0] = 2

# Point (1,1): Mixed - grade 1 (1), grade 2 (2)
grade_counts[1, 1, 1] = 1
grade_counts[2, 1, 1] = 2

print("Grade counts at test points:")
print(f"(0,0) - Only grade 0: {grade_counts[:, 0, 0]}")
print(f"(0,1) - Only grade 1: {grade_counts[:, 0, 1]}")
print(f"(0,2) - Only grade 2: {grade_counts[:, 0, 2]}")
print(f"(1,0) - Mixed 0,1: {grade_counts[:, 1, 0]}")
print(f"(1,1) - Mixed 1,2: {grade_counts[:, 1, 1]}")
print()

# Full Map calc_mask: any 0-7 present
full_calc_mask = grade_counts.sum(axis=0) > 0
print(f"Full Map calc_mask shape: {full_calc_mask.shape}")
print(f"Full Map calc_mask points: {full_calc_mask.sum()}")
print(f"Full Map calc_mask:\n{full_calc_mask.astype(int)}\n")

# === SUBSET: Select only grades [1, 2] ===
selected_grades = [1, 2]
print(f"Selected grades: {selected_grades}\n")

# Method 1: Using full_calc_mask (WRONG)
print("=== Method 1: Using full_calc_mask (CURRENT BUGGY APPROACH) ===")
counts_subset = grade_counts.astype(np.float32, copy=True)
# Zero out non-selected grades
counts_subset[0, :, :] = 0  # grade 0 -> 0
counts_subset[3:, :, :] = 0  # grades 3-7 -> 0

square_weights = (np.arange(8, dtype=np.float32) ** 2).reshape(8, 1, 1)
square_sums = np.sum(counts_subset * square_weights, axis=0)

subset_calc_mask_wrong = full_calc_mask.copy()  # Using full mask
square_mean_wrong = np.zeros_like(square_sums)
square_mean_wrong[subset_calc_mask_wrong] = square_sums[subset_calc_mask_wrong] / float(image_count)

print(f"Subset calc_mask (using full):\n{subset_calc_mask_wrong.astype(int)}")
print(f"Square sums:\n{square_sums}")
print(f"Square mean (wrong method):\n{square_mean_wrong}\n")

print("Problem points:")
print(f"  (0,0) - Only grade 0 (NOT in selection) -> value: {square_mean_wrong[0, 0]} (should be 0 or masked)")
print()

# Method 2: Recompute mask from original grade_counts (CORRECT)
print("=== Method 2: Recompute mask from ORIGINAL grade_counts (CORRECT) ===")
# Should use original grade_counts to determine calc_mask
# because we want same spatial coverage as full map
raw_counts_float = grade_counts.astype(np.float32, copy=False)
subset_calc_mask_correct = raw_counts_float.sum(axis=0) > 0  # Same as full_calc_mask
print(f"Subset calc_mask (recomputed):\n{subset_calc_mask_correct.astype(int)}")
print(f"Mask is same as full: {np.array_equal(subset_calc_mask_correct, full_calc_mask)}\n")

# But now: points with only non-selected grades will have square_sum=0
square_mean_correct = np.zeros_like(square_sums)
square_mean_correct[subset_calc_mask_correct] = square_sums[subset_calc_mask_correct] / float(image_count)
print(f"Square mean (correct method):\n{square_mean_correct}")
print()

print("Correct behavior:")
print(f"  (0,0) - Only grade 0 (NOT in selection) -> value: {square_mean_correct[0, 0]} (correctly 0)")
print(f"  (0,1) - Only grade 1 (IN selection) -> value: {square_mean_correct[0, 1]}")
print(f"  (0,2) - Only grade 2 (IN selection) -> value: {square_mean_correct[0, 2]}")
print(f"  (1,0) - Mixed 0,1 (partially in) -> value: {square_mean_correct[1, 0]}")
print(f"  (1,1) - Mixed 1,2 (fully in) -> value: {square_mean_correct[1, 1]}")
print()

print("=== CONCLUSION ===")
print("The mask should be the SAME for both Full and Subset maps.")
print("The difference is in the COUNTS (zeroed for non-selected grades).")
print("Points with only non-selected grades will naturally have value=0.")
print()
print("CURRENT BUG: If we pass full_calc_mask as only_low_mask,")
print("  the function reuses it without recomputing from original grade_counts.")
print("  This is actually OK IF the mask is correct.")
print()
print("REAL ISSUE: Let me check the actual bug...")

