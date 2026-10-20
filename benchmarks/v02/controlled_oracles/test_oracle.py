from __future__ import annotations

import unittest

from oracle import (
    canonicalize_calculator_evaluator_truth,
    wesnoth_float32_sample_indices,
    wesnoth_project_village_support,
)


class ControlledUiEvaluatorTruthTests(unittest.TestCase):
    def test_converts_pixel_xyxy_and_keeps_scoped_negative_evidence(self) -> None:
        source = {
            "cases": [
                {"caseId": "ui-positive", "expectedPresence": True, "box": [10, 20, 30, 50]},
                {"caseId": "ui-negative", "expectedPresence": False, "evidence": "complete inventory"},
            ]
        }
        producer = [
            {"caseId": "ui-positive", "image": {"width": 100, "height": 100}},
            {"caseId": "ui-negative", "image": {"width": 100, "height": 100}},
        ]
        rows = canonicalize_calculator_evaluator_truth(source, producer)
        self.assertEqual(rows[0]["targetBoxes"][0]["xyxy"], [0.1, 0.2, 0.3, 0.5])
        self.assertEqual(rows[1]["targetBoxes"], [])
        self.assertEqual(rows[1]["negativeEvidence"], "complete inventory")

    def test_rejects_box_outside_matched_input_dimensions(self) -> None:
        with self.assertRaisesRegex(ValueError, "outside"):
            canonicalize_calculator_evaluator_truth(
                {"cases": [{"caseId": "ui-positive", "expectedPresence": True, "box": [9, 0, 11, 2]}]},
                [{"caseId": "ui-positive", "image": {"width": 10, "height": 10}}],
            )

    def test_rejects_nonmatching_or_duplicate_case_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "identities differ"):
            canonicalize_calculator_evaluator_truth(
                {"cases": [{"caseId": "truth-id", "expectedPresence": False, "evidence": "verified"}]},
                [{"caseId": "input-id", "image": {"width": 10, "height": 10}}],
            )


class WesnothProjectionTests(unittest.TestCase):
    def test_float32_accumulation_preserves_the_row_53_boundary_sample(self) -> None:
        sampled = wesnoth_float32_sample_indices(864, 212)
        self.assertEqual(sampled[52:55], [211, 215, 220])

    def test_projected_village_support_uses_accumulated_float32_samples(self) -> None:
        # A 38x38 raw map has a 36x36 playable region. At 24px terrain scale
        # and a 160x212 theme area, the source bitmap becomes 159x212.
        support = wesnoth_project_village_support(
            [(16, 9)],
            map_width=38,
            map_height=38,
            scale=24,
            area=(856, 11, 160, 212),
        )
        # Row 53 maps to source row 215 due float32 accumulation, making the
        # bottom-row sample part of this marker's half-open source rectangle.
        self.assertIn((923, 64), support)
        self.assertIn((924, 64), support)
        self.assertIn((925, 64), support)
        self.assertEqual((min(x for x, _ in support), min(y for _, y in support), max(x for x, _ in support) + 1, max(y for _, y in support) + 1), (921, 59, 926, 65))

    def test_rejects_border_and_invalid_dimensions(self) -> None:
        with self.assertRaises(ValueError):
            wesnoth_project_village_support(
                [(0, 1)], map_width=38, map_height=38, scale=24, area=(856, 11, 160, 212)
            )
        with self.assertRaises(ValueError):
            wesnoth_float32_sample_indices(0, 10)


if __name__ == "__main__":
    unittest.main()
