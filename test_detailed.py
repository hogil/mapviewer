"""Detailed analysis of square map data"""
import numpy as np
from pathlib import Path

# Load the npz file
npz_path = Path(r"D:\project\data\wm-811k\composite_map\tester\20251125_130731\square_maps_data.npz")

with np.load(npz_path) as data:
    square_mean = data["square_mean"]
    square_weighted = data["square_weighted"]
    calc_mask = data["calc_mask"]
    weighted_mask = data["weighted_mask"]
    grade_counts = data.get("grade_counts")

    print("=== Data loaded ===")
    print(f"square_mean shape: {square_mean.shape}")
    print(f"square_weighted shape: {square_weighted.shape}")
    print()

    # Extract valid values
    mean_values = square_mean[calc_mask]
    weighted_values = square_weighted[weighted_mask]

    print("=== square_mean detailed ===")
    print(f"Unique values count: {len(np.unique(mean_values))}")
    unique_mean = np.unique(mean_values)
    print(f"First 20 unique values: {unique_mean[:20]}")
    print(f"Last 20 unique values: {unique_mean[-20:]}")
    print(f"Is discrete (all integers)? {np.all(mean_values == np.round(mean_values))}")
    print()

    print("=== square_weighted detailed ===")
    print(f"Unique values count: {len(np.unique(weighted_values))}")
    unique_weighted = np.unique(weighted_values)
    print(f"First 20 unique values: {unique_weighted[:20]}")
    print(f"Last 20 unique values: {unique_weighted[-20:]}")
    print(f"Is discrete (all integers)? {np.all(weighted_values == np.round(weighted_values))}")
    print()

    # Check if grade_counts is available
    if grade_counts is not None:
        print("=== grade_counts analysis ===")
        print(f"grade_counts shape: {grade_counts.shape}")

        # Sample one point
        sample_y, sample_x = np.where(calc_mask)
        if len(sample_y) > 0:
            y, x = sample_y[100], sample_x[100]  # Pick 100th valid point
            counts = grade_counts[:, y, x]
            print(f"\nSample point ({y}, {x}):")
            print(f"  Grade counts: {counts}")
            print(f"  Total images: {counts.sum()}")

            # Calculate manually
            square_weights = np.arange(8, dtype=np.float32) ** 2
            square_sum = np.sum(counts.astype(np.float32) * square_weights)
            image_count = counts.sum()

            manual_mean = square_sum / image_count if image_count > 0 else 0
            print(f"  Manual square_mean: {manual_mean:.6f}")
            print(f"  Stored square_mean: {square_mean[y, x]:.6f}")
            print(f"  Match: {np.isclose(manual_mean, square_mean[y, x])}")

            weight_factors = np.array([1, 1, 2, 3, 4, 5, 6, 7], dtype=np.float32)
            weight_sum = np.sum(counts.astype(np.float32) * weight_factors)
            manual_weighted = square_sum / weight_sum if weight_sum > 0 else 0
            print(f"  Manual square_weighted: {manual_weighted:.6f}")
            print(f"  Stored square_weighted: {square_weighted[y, x]:.6f}")
            print(f"  Match: {np.isclose(manual_weighted, square_weighted[y, x])}")
