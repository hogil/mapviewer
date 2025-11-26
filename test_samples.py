"""Check multiple sample points"""
import numpy as np
from pathlib import Path

npz_path = Path(r"D:\project\data\wm-811k\composite_map\tester\20251125_130731\square_maps_data.npz")

with np.load(npz_path) as data:
    grade_counts = data["grade_counts"]
    calc_mask = data["calc_mask"]
    square_mean = data["square_mean"]
    square_weighted = data["square_weighted"]

    # Get all valid points
    valid_y, valid_x = np.where(calc_mask)

    print("=== Checking sample points ===\n")

    # Check 10 random samples
    num_samples = min(20, len(valid_y))
    indices = np.random.choice(len(valid_y), num_samples, replace=False)

    mixed_count = 0
    single_count = 0

    for i, idx in enumerate(indices):
        y, x = valid_y[idx], valid_x[idx]
        counts = grade_counts[:, y, x]
        total = counts.sum()
        non_zero = np.count_nonzero(counts)

        print(f"Point {i+1} ({y}, {x}):")
        print(f"  Counts: {counts}")
        print(f"  Total: {total}, Non-zero grades: {non_zero}")
        print(f"  square_mean: {square_mean[y, x]:.4f}")
        print(f"  square_weighted: {square_weighted[y, x]:.4f}")

        if non_zero > 1:
            mixed_count += 1
            print(f"  ** MIXED (multiple grades) **")
        else:
            single_count += 1
            print(f"  -> Single grade only")
        print()

    print("=" * 60)
    print(f"Summary: {mixed_count} mixed, {single_count} single")
    print("=" * 60)

    # Check if ALL points are single-grade
    total_points = len(valid_y)
    print(f"\nChecking ALL {total_points} valid points...")

    all_single = 0
    all_mixed = 0

    for i in range(total_points):
        y, x = valid_y[i], valid_x[i]
        counts = grade_counts[:, y, x]
        non_zero = np.count_nonzero(counts)

        if non_zero <= 1:
            all_single += 1
        else:
            all_mixed += 1

    print(f"ALL points: {all_single} single-grade, {all_mixed} mixed-grade")
    print(f"Percentage single: {all_single/total_points*100:.2f}%")
    print(f"Percentage mixed: {all_mixed/total_points*100:.2f}%")
