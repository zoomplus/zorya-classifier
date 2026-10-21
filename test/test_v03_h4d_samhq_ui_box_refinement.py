"""Synthetic geometry tests for the offline H4d SAM-HQ sequential mask producer."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np

SCRIPT = Path(__file__).parents[1] / "benchmarks" / "v03" / "h4d-samhq-sequential-decoder.py"
SPEC = importlib.util.spec_from_file_location("h4d_samhq_ui_box_refinement", SCRIPT)
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

    def test_full_source_logit_plane_is_thresholded_without_box_clipping(self) -> None:
        logits = np.zeros((1, 1, 8, 11), dtype=np.float32)
        logits[0, 0, 2:6, 4:9] = 1.0
        binary = MODULE.binary_source_mask(logits, width=11, height=8)
        # This mask exceeds the motivating synthetic prompt box [5,3,8,5].
        self.assertEqual(MODULE.mask_bounds(binary), [4, 2, 9, 6])

    def test_requires_source_mask_plane(self) -> None:
        with self.assertRaises(MODULE.ProbeError):
            MODULE.mask_bounds(np.zeros((1, 3, 5), dtype=bool))

    def test_rejects_model_mask_with_wrong_source_geometry(self) -> None:
        with self.assertRaises(MODULE.ProbeError):
            MODULE.binary_source_mask(np.zeros((7, 11)), width=11, height=8)

    def test_serial_recipe_encodes_once_and_decodes_every_candidate_in_order(self) -> None:
        proposals = [{"proposal_ordinal": index} for index in range(36)]
        encode_calls = []
        decode_calls = []

        def encode():
            encode_calls.append("once")
            return object()

        def decode(embeddings, ordinal, proposal):
            self.assertIsNotNone(embeddings)
            self.assertEqual(proposal["proposal_ordinal"], ordinal)
            decode_calls.append(ordinal)
            return ordinal

        result = MODULE.encode_and_decode_in_order(proposals, encode, decode)
        self.assertEqual(encode_calls, ["once"])
        self.assertEqual(decode_calls, list(range(36)))
        self.assertEqual(len(result), 36)
        self.assertEqual([row[0] for row in result], list(range(36)))

    def test_serial_recipe_fails_when_any_candidate_has_no_mask(self) -> None:
        proposals = [{"proposal_ordinal": index} for index in range(36)]

        def decode(_embeddings, ordinal, _proposal):
            return None if ordinal == 17 else ordinal

        with self.assertRaises(MODULE.ProbeError):
            MODULE.encode_and_decode_in_order(proposals, lambda: object(), decode)


if __name__ == "__main__":
    unittest.main()
