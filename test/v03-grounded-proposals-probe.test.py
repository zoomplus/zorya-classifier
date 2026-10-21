import hashlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "benchmarks" / "v03" / "grounded-proposals-probe.py"
SPEC = importlib.util.spec_from_file_location("grounded_proposals_probe", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class Coordinates(list):
    def min(self):
        return min(self)

    def max(self):
        return max(self)


class SparseMask:
    def nonzero(self):
        return Coordinates([1, 3, 3]), Coordinates([2, 4, 5])


class GroundedProposalProbeTests(unittest.TestCase):
    def test_fixed_cohort_has_exact_twelve_case_ids(self):
        self.assertEqual(len(PROBE.EXPECTED_CASE_IDS), 12)
        self.assertEqual(PROBE.EXPECTED_CASE_IDS[0], "pilot-v03-photo-01")
        self.assertEqual(PROBE.EXPECTED_CASE_IDS[4], "pilot-v03-ui-01")
        self.assertEqual(PROBE.EXPECTED_CASE_IDS[8], "pilot-v03-map-01")
        self.assertEqual(PROBE.EXPECTED_CASE_IDS[-1], "pilot-v03-map-04")

    def test_manifest_pins_accept_only_original_or_format_only_fixed_hash(self):
        photo_hashes = PROBE.MANIFESTS["photo.json"]["sha256"]
        self.assertIn("daa1759c5a08b7abf827641843df80e6b777fae8c0c04ac651fa7435235003fa", photo_hashes)
        self.assertIn("ee1d36d254f3aeddd9b9739143754dfbdc3409e155ab76334e10cf04e0bfb44b", photo_hashes)
        self.assertEqual(len(PROBE.MANIFESTS["photo.json"]["ids"]), 4)

    def test_target_normalization_uses_only_fixed_authored_grammar(self):
        self.assertEqual(PROBE.normalize_target("Car"), "Car")
        self.assertEqual(
            PROBE.normalize_target(
                "the Forward navigation button in the Geany toolbar, including its whole visible button background and border"
            ),
            "Forward navigation button",
        )
        self.assertEqual(
            PROBE.normalize_target(
                "the visible body sprite of unit type Explorer in the main Freeciv map canvas; exclude health bars and selection brackets"
            ),
            "Explorer unit",
        )
        with self.assertRaises(PROBE.ProbeError):
            PROBE.normalize_target("the object visible on the left")

    def test_fixed_thresholds_and_candidate_cap_are_not_score_sorted(self):
        self.assertEqual(PROBE.BOX_THRESHOLD, 0.15)
        self.assertEqual(PROBE.TEXT_THRESHOLD, 0.15)
        self.assertEqual(PROBE.MAX_CANDIDATES, 36)
        detections = [{"score": (100 - index) / 100, "detector_index": index} for index in range(40)]
        bounded, truncated = PROBE.bound_detections(detections)
        self.assertEqual([item["detector_index"] for item in bounded], list(range(36)))
        self.assertEqual(truncated, 4)
        self.assertEqual(detections[0]["score"], 1.0)

    def test_detector_boxes_must_remain_on_source_canvas(self):
        self.assertEqual(PROBE.validate_box([1, 2, 10, 20], 10, 20), [1.0, 2.0, 10.0, 20.0])
        with self.assertRaises(PROBE.ProbeError):
            PROBE.validate_box([1, 2, 11, 20], 10, 20)
        with self.assertRaises(PROBE.ProbeError):
            PROBE.validate_box([float("nan"), 2, 5, 6], 10, 20)

    def test_mask_bounds_are_half_open_and_empty_masks_have_no_box(self):
        self.assertEqual(PROBE.mask_bbox(SparseMask()), [2, 1, 6, 4])
        self.assertIsNone(PROBE.mask_bbox(type("Empty", (), {"nonzero": lambda self: ([], [])})()))

    def test_cuda_allocator_is_initialized_before_peak_tracking(self):
        events = []

        class FakeCuda:
            def init(self):
                events.append("init")

            def set_device(self, device):
                events.append(("set_device", device))

            def synchronize(self, device):
                events.append(("synchronize", device))

            def reset_peak_memory_stats(self, device):
                events.append(("reset_peak_memory_stats", device))

        class FakeTorch:
            cuda = FakeCuda()

        PROBE.initialize_cuda_peak_tracking(FakeTorch, "cuda:0")
        self.assertEqual(
            events,
            [
                "init",
                ("set_device", "cuda:0"),
                ("synchronize", "cuda:0"),
                ("reset_peak_memory_stats", "cuda:0"),
            ],
        )

    def test_fail_fast_marks_the_full_remaining_denominator(self):
        cases = [{"caseId": f"case-{index}"} for index in range(3)]
        statuses = [{"case_id": case["caseId"], "status": "not_started"} for case in cases]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / "cases").mkdir()
            PROBE.mark_remaining_not_run(output, cases, statuses, 0, "case-0")
            self.assertEqual(statuses[1]["status"], "not_run_after_first_error")
            self.assertEqual(statuses[2]["status"], "not_run_after_first_error")
            for index in (1, 2):
                row_path = output / "cases" / f"case-{index}.json"
                self.assertTrue(row_path.is_file())
                self.assertEqual(PROBE.sha256_file(row_path), statuses[index]["row_sha256"])

    def test_asset_verifier_hashes_only_the_declared_local_files(self):
        item = {
            "repo": "example/model",
            "revision": "0123456789abcdef",
            "directory": "tiny",
            "filename": "weights.safetensors",
            "size": 4,
            "sha256": hashlib.sha256(b"test").hexdigest(),
        }
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            path = assets / "tiny" / "weights.safetensors"
            path.parent.mkdir()
            path.write_bytes(b"test")
            with patch.object(PROBE, "MODEL_FILES", (item,)):
                result = PROBE.verify_assets(assets)
            self.assertEqual(result["verified_files"][0]["actual_sha256"], item["sha256"])

    @unittest.skipUnless(os.name == "posix", "owned process-group deadlines require POSIX")
    def test_owned_worker_deadline_terminates_only_its_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child.pid"
            child_code = (
                "import os,time,pathlib; "
                f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); "
                "time.sleep(10)"
            )
            with (Path(directory) / "worker.log").open("wb") as log:
                status, elapsed_ms, message, _ = PROBE.run_owned_child(
                    [sys.executable, "-c", child_code], log, 0.1
                )
            self.assertEqual(status, "timeout")
            self.assertIn("absolute deadline", message)
            self.assertGreaterEqual(elapsed_ms, 50)
            pid = int(pid_file.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_probe_source_has_no_evaluator_or_semantic_selector_imports(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("pilot-truth", source)
        self.assertNotIn("evaluator-data", source)
        self.assertNotIn("DecisionPort", source)
        self.assertNotIn("openai", source.lower())


if __name__ == "__main__":
    unittest.main()
