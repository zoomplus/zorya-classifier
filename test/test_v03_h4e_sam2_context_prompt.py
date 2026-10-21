"""Synthetic tests for the frozen H4e context-expanded SAM2 prompt."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).parents[1] / "benchmarks" / "v03" / "h4e-sam2-context-prompt.py"
SPEC = importlib.util.spec_from_file_location("h4e_sam2_context_prompt", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ContextPromptTests(unittest.TestCase):
    def test_expands_exactly_25_percent_each_side(self) -> None:
        self.assertEqual(
            MODULE.expand_prompt_box([20, 40, 60, 80], 1280, 800),
            [10.0, 30.0, 70.0, 90.0],
        )

    def test_clips_prompt_to_source_edges_only(self) -> None:
        self.assertEqual(
            MODULE.expand_prompt_box([2, 3, 18, 23], 20, 25),
            [0.0, 0.0, 20.0, 25.0],
        )

    def test_rejects_nonfinite_or_degenerate_box(self) -> None:
        for box in ([0, 0, 0, 1], [0, 2, 1, 1], [0, 0, float("nan"), 1]):
            with self.subTest(box=box), self.assertRaises(MODULE.ProbeError):
                MODULE.expand_prompt_box(box, 1280, 800)

    def test_mask_bounds_remain_based_only_on_actual_source_pixels(self) -> None:
        mask = np.zeros((8, 11), dtype=bool)
        mask[2:6, 4:9] = True
        # An expanded prompt does not dilate the resulting pixel mask or box.
        self.assertEqual(MODULE.mask_bounds(mask), [4, 2, 9, 6])

    def test_empty_mask_is_preserved(self) -> None:
        self.assertIsNone(MODULE.mask_bounds(np.zeros((8, 11), dtype=bool)))

    def test_requires_source_sized_two_dimensional_mask(self) -> None:
        with self.assertRaises(MODULE.ProbeError):
            MODULE.mask_bounds(np.zeros((1, 8, 11), dtype=bool))


if __name__ == "__main__":
    unittest.main()
