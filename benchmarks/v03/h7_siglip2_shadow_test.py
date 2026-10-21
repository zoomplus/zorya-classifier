import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

import h7_siglip2_shadow as h7


def packed(mask: np.ndarray) -> bytes:
    return np.packbits(mask.reshape(-1), bitorder="little").tobytes()


def candidate(family: str, ordinal: int, packed_mask: bytes = b"\x01") -> h7.Candidate:
    return h7.Candidate(
        family=family,
        ordinal=ordinal,
        alias=f"{family}{ordinal:02}",
        source_family="fixture",
        source_alias=f"{family}{ordinal:02}",
        source_mask_path=f"fixture/{family}{ordinal:02}.png",
        source_mask_sha256=f"{ordinal:064x}",
        mask_packed=packed_mask,
    )


class FakeTensor:
    def __init__(self, length: int):
        self.shape = (1, length)


class FakeTokenizer:
    def __init__(self, token_lengths: dict[str, int]):
        self.token_lengths = token_lengths
        self.encode_calls: list[tuple[str, bool, bool]] = []
        self.pad_calls: list[tuple[str, int]] = []

    def __call__(self, text: str, *, truncation: bool, padding: bool) -> dict[str, list[int]]:
        self.encode_calls.append((text, truncation, padding))
        length = self.token_lengths[text]
        return {"input_ids": [2] * length, "attention_mask": [1] * length}

    def pad(
        self,
        features: list[dict[str, list[int]]],
        *,
        padding: str,
        max_length: int,
        return_tensors: str,
    ) -> dict[str, FakeTensor]:
        self.pad_calls.append((padding, max_length))
        if len(features) != 1:
            raise AssertionError("one authored target should be passed as one existing feature")
        self.last_input_ids = list(features[0]["input_ids"])
        return {"input_ids": FakeTensor(max_length), "attention_mask": FakeTensor(max_length)}


class H7ShadowTests(unittest.TestCase):
    def test_checkpoint_manifest_matches_all_six_loader_pins(self) -> None:
        manifest = json.loads(Path(__file__).with_name("h7-siglip2-asset-lock.json").read_text())
        self.assertEqual(manifest["model_id"], h7.MODEL_ID)
        self.assertEqual(manifest["revision"], h7.MODEL_REVISION)
        self.assertEqual(manifest["license"], "apache-2.0")
        self.assertEqual(
            {entry["path"]: (entry["sha256"], entry["bytes"]) for entry in manifest["files"]},
            h7.EXPECTED_ASSETS,
        )

    def test_asset_loader_rejects_mutable_or_unpinned_file_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            asset_dir = Path(temporary)
            for name in h7.ASSET_FILES:
                (asset_dir / name).write_bytes(b"not the pinned checkpoint")
            with self.assertRaisesRegex(h7.ProbeError, "byte lock mismatch"):
                h7.build_asset_lock(asset_dir)

    def test_authored_target_is_tokenized_once_without_truncation_then_max_padded(self) -> None:
        for text, length in (("short", 3), ("exact-limit", 64)):
            tokenizer = FakeTokenizer({text: length})
            padded = h7.tokenize_padded_target(tokenizer, text, 64)
            self.assertEqual(padded["input_ids"].shape, (1, 64))
            self.assertEqual(tokenizer.encode_calls, [(text, False, False)])
            self.assertEqual(tokenizer.pad_calls, [("max_length", 64)])
            self.assertEqual(len(tokenizer.last_input_ids), length)

    def test_authored_target_overflow_fails_before_padding(self) -> None:
        tokenizer = FakeTokenizer({"overflow": 65})
        with self.assertRaisesRegex(h7.ProbeError, "exceeds"):
            h7.tokenize_padded_target(tokenizer, "overflow", 64)
        self.assertEqual(tokenizer.encode_calls, [("overflow", False, False)])
        self.assertEqual(tokenizer.pad_calls, [])

    def test_context_bbox_expands_actual_foreground_outward_and_clips(self) -> None:
        mask = np.zeros((100, 180), dtype=np.bool_)
        mask[30:50, 40:100] = True
        self.assertEqual(h7.context_crop_xyxy(mask, 180, 100), (25, 25, 115, 55))

        edge_mask = np.zeros((50, 80), dtype=np.bool_)
        edge_mask[0:4, 0:8] = True
        self.assertEqual(h7.context_crop_xyxy(edge_mask, 80, 50), (0, 0, 10, 5))

    def test_empty_and_invalid_packed_masks_are_rejected(self) -> None:
        with self.assertRaisesRegex(h7.ProbeError, "empty mask"):
            h7.context_crop_xyxy(np.zeros((3, 4), dtype=np.bool_), 4, 3)
        with self.assertRaisesRegex(h7.ProbeError, "byte length"):
            h7.unpack_packed_mask(b"", 4, 3)
        with self.assertRaisesRegex(h7.ProbeError, "padding bits"):
            h7.unpack_packed_mask(b"\xff", 3, 1)

    def test_views_keep_context_aspect_and_only_mask_outside_foreground(self) -> None:
        source = np.zeros((100, 180, 3), dtype=np.uint8)
        source[:] = (230, 20, 40)
        image = Image.fromarray(source, mode="RGB")
        mask = np.zeros((100, 180), dtype=np.bool_)
        mask[30:50, 40:100] = True
        clean, masked, geometry = h7.candidate_views(image, packed(mask))
        try:
            self.assertEqual(geometry.crop_xyxy, (25, 25, 115, 55))
            self.assertEqual(geometry.source_crop_size, (90, 30))
            self.assertEqual(geometry.resized_size, (512, 171))
            self.assertEqual(geometry.pad_ltrb, (0, 170, 0, 171))
            self.assertEqual(geometry.output_size, (512, 512))
            self.assertEqual(clean.getpixel((256, 256)), (230, 20, 40))
            self.assertEqual(masked.getpixel((256, 256)), (230, 20, 40))
            self.assertEqual(masked.getpixel((10, 256)), h7.GRAY)
            self.assertEqual(masked.getpixel((256, 30)), h7.GRAY)
            self.assertEqual(image.getpixel((60, 40)), (230, 20, 40))
        finally:
            clean.close()
            masked.close()
            image.close()

    def test_aspect_fit_is_bilinear_and_centered_with_deterministic_odd_padding(self) -> None:
        source = Image.new("RGB", (2, 1), (10, 20, 30))
        try:
            view, padding = h7.contain512(source)
            try:
                self.assertEqual(view.size, (512, 512))
                self.assertEqual(padding, (0, 128, 0, 128))
                self.assertEqual(view.getpixel((0, 127)), h7.GRAY)
                self.assertEqual(view.getpixel((0, 128)), (10, 20, 30))
            finally:
                view.close()
        finally:
            source.close()

    def test_raw_mean_similarity_and_stable_family_then_ordinal_ties(self) -> None:
        candidates = [candidate("U", 1), candidate("D", 1), candidate("D", 0), candidate("U", 0)]
        geometry = h7.CropGeometry((0, 0, 1, 1), (1, 1), (512, 512), (0, 0, 0, 0), (512, 512))
        scores = h7.rank_scores(
            candidates,
            [(0.3, 0.3), (0.3, 0.3), (0.7, 0.7), (0.7, 0.7)],
            [geometry] * 4,
        )
        by_alias = {score.alias: score for score in scores}
        self.assertEqual(by_alias["D00"].mean_cosine, 0.7)
        self.assertEqual(by_alias["D00"].global_rank, 1)
        self.assertEqual(by_alias["U00"].global_rank, 2)
        self.assertEqual(by_alias["D01"].global_rank, 3)
        self.assertEqual(by_alias["U01"].global_rank, 4)
        self.assertEqual(by_alias["D00"].family_rank, 1)
        self.assertEqual(by_alias["D01"].family_rank, 2)
        self.assertEqual(by_alias["D00"].clean_cosine, 0.7)
        self.assertEqual(by_alias["D00"].masked_cosine, 0.7)

    def test_invalid_and_nonfinite_scores_are_rejected_without_probability_conversion(self) -> None:
        geometry = h7.CropGeometry((0, 0, 1, 1), (1, 1), (512, 512), (0, 0, 0, 0), (512, 512))
        with self.assertRaisesRegex(h7.ProbeError, "non-finite"):
            h7.rank_scores([candidate("D", 0)], [(float("nan"), 0.0)], [geometry])
        with self.assertRaisesRegex(h7.ProbeError, "family"):
            h7.rank_scores([candidate("X", 0)], [(0.0, 0.0)], [geometry])


if __name__ == "__main__":
    unittest.main()
