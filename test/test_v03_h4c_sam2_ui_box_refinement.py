"""Synthetic geometry tests for the offline H4c SAM2 mask producer."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).parents[1] / "benchmarks" / "v03" / "h4c-sam2-ui-box-refinement.py"
SPEC = importlib.util.spec_from_file_location("h4c_sam2_ui_box_refinement", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MaskBoundsTests(unittest.TestCase):
    def test_bounds_are_derived_from_foreground_with_exclusive_maxima(self) -> None:
        mask = np.zeros((8, 11), dtype=bool)
        mask[2:6, 4:9] = True
        # Synthetic prompt box would be [5,3,8,5]; a predictor mask is allowed
        # to extend beyond it because the box is a prompt, not a crop boundary.
        self.assertEqual(MODULE.mask_bounds(mask), [4, 2, 9, 6])

    def test_empty_mask_is_preserved_as_no_bounds(self) -> None:
        self.assertIsNone(MODULE.mask_bounds(np.zeros((3, 5), dtype=bool)))

    def test_requires_source_mask_plane(self) -> None:
        with self.assertRaises(MODULE.ProbeError):
            MODULE.mask_bounds(np.zeros((1, 3, 5), dtype=bool))


if __name__ == "__main__":
    unittest.main()
