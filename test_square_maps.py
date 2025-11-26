"""Test script to verify square map calculations"""
import numpy as np
from pathlib import Path

# Load the npz file
npz_path = Path(r"D:\project\data\wm-811k\composite_map\tester\20251125_130731\square_maps_data.npz")

with np.load(npz_path) as data:
    square_mean = data["square_mean"]
    square_weighted = data["square_weighted"]
    calc_mask = data["calc_mask"]
    weighted_mask = data["weighted_mask"]

    print("=== Data loaded ===")
    print(f"square_mean shape: {square_mean.shape}")
    print(f"square_weighted shape: {square_weighted.shape}")
    print(f"calc_mask points: {calc_mask.sum()}")
    print(f"weighted_mask points: {weighted_mask.sum()}")
    print(f"Masks are equal: {np.array_equal(calc_mask, weighted_mask)}")
    print()

    # Extract valid values
    mean_values = square_mean[calc_mask]
    weighted_values = square_weighted[weighted_mask]

    print("=== square_mean statistics ===")
    print(f"Min: {mean_values.min():.4f}")
    print(f"Max: {mean_values.max():.4f}")
    print(f"Mean: {mean_values.mean():.4f}")
    print(f"Std: {mean_values.std():.4f}")
    print(f"Unique values: {len(np.unique(mean_values))}")
    print()

    print("=== square_weighted statistics ===")
    print(f"Min: {weighted_values.min():.4f}")
    print(f"Max: {weighted_values.max():.4f}")
    print(f"Mean: {weighted_values.mean():.4f}")
    print(f"Std: {weighted_values.std():.4f}")
    print(f"Unique values: {len(np.unique(weighted_values))}")
    print()

    print("=== Comparison ===")
    print(f"Values are identical: {np.array_equal(mean_values, weighted_values)}")
    print(f"Max difference: {np.abs(mean_values - weighted_values).max():.6f}")

    # Check if the percentile calculation is working
    print("\n=== Percentile test ===")

    # Sample some values
    sample_mean = mean_values[:100] if len(mean_values) >= 100 else mean_values
    sample_weighted = weighted_values[:100] if len(weighted_values) >= 100 else weighted_values

    print(f"Sample mean values (first 10): {sample_mean[:10]}")
    print(f"Sample weighted values (first 10): {sample_weighted[:10]}")
