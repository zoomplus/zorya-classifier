from __future__ import annotations

import importlib.util
import math
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "benchmarks" / "v03" / "ui-proposal-probe.py"
SPEC = importlib.util.spec_from_file_location("ui_proposal_probe", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


class LetterboxTests(unittest.TestCase):
    def test_canvas_is_rgb_1280_top_left_with_fixed_fill(self) -> None:
        from PIL import Image

        source = Image.new("RGB", (1280, 800), (5, 10, 15))
        canvas, transform = probe.prepare_canvas(source)
        self.assertEqual(canvas.size, (1280, 1280))
        self.assertEqual(canvas.mode, "RGB")
        self.assertEqual(canvas.getpixel((0, 0)), (5, 10, 15))
        self.assertEqual(canvas.getpixel((0, 799)), (5, 10, 15))
        self.assertEqual(canvas.getpixel((0, 800)), (114, 114, 114))
        self.assertEqual((transform.pad_left, transform.pad_top), (0, 0))

    def test_landscape_transform_tracks_rounded_dimensions_and_axis_scales(self) -> None:
        transform = probe.letterbox_transform(801, 600)
        self.assertEqual(transform.resized_width, 1280)
        self.assertEqual(transform.resized_height, 959)
        self.assertEqual(transform.pad_left, 0)
        self.assertEqual(transform.pad_top, 0)
        self.assertEqual(transform.scale_x, 1280 / 801)
        self.assertEqual(transform.scale_y, 959 / 600)
        self.assertNotEqual(transform.scale_x, transform.scale_y)

    def test_portrait_transform_and_source_box_round_trip(self) -> None:
        transform = probe.letterbox_transform(700, 1200)
        self.assertEqual((transform.resized_width, transform.resized_height), (747, 1280))
        source = (121.25, 245.5, 432.75, 1001.0)
        canvas = (
            source[0] * transform.scale_x,
            source[1] * transform.scale_y,
            source[2] * transform.scale_x,
            source[3] * transform.scale_y,
        )
        mapped = probe.source_box_from_canvas(canvas, transform)
        for actual, expected in zip(mapped, source, strict=True):
            self.assertAlmostEqual(actual, expected)

    def test_clipping_is_bounded_and_degenerate_clipped_boxes_fail(self) -> None:
        transform = probe.letterbox_transform(1280, 800)
        self.assertEqual(probe.source_box_from_canvas((-10, -8, 35, 40), transform), (0, 0, 35, 40))
        with self.assertRaises(probe.ProbeError):
            probe.source_box_from_canvas((-30, -40, -20, -10), transform)

    def test_invalid_canvas_boxes_fail_closed(self) -> None:
        transform = probe.letterbox_transform(1280, 800)
        for box in ((0, 0, 0, 1), (0, 1, 2, 1), (math.nan, 0, 1, 1), (0, 0, math.inf, 1)):
            with self.subTest(box=box), self.assertRaises(probe.ProbeError):
                probe.source_box_from_canvas(box, transform)


class CandidateAndReceiptTests(unittest.TestCase):
    def test_candidate_cap_orders_by_score_then_flattened_index(self) -> None:
        candidates = [
            {"flat_index": 9, "score": 0.9, "box_xyxy": [0, 0, 2, 2]},
            {"flat_index": 3, "score": 0.9, "box_xyxy": [1, 1, 3, 3]},
            {"flat_index": 1, "score": 0.8, "box_xyxy": [2, 2, 4, 4]},
        ]
        kept, truncated = probe.select_candidates(candidates, limit=2)
        self.assertEqual([candidate["flat_index"] for candidate in kept], [3, 9])
        self.assertEqual(truncated, 1)

    def test_wrong_file_digest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.bin"
            path.write_bytes(b"frozen")
            with self.assertRaises(probe.ProbeError):
                probe.verify_file(path, "0" * 64)


if __name__ == "__main__":
    unittest.main()
