import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "benchmarks/v03/h5a-native-proposals.py"
SPEC = importlib.util.spec_from_file_location("h5a_under_test", SCRIPT)
assert SPEC and SPEC.loader
H5A = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(H5A)


class H5aNativeProposalTests(unittest.TestCase):
    def test_prompt_expansion_clips_sides_and_preserves_valid_box(self):
        self.assertEqual(H5A.expand_prompt_box([10, 20, 30, 60], 100, 100), [5.0, 10.0, 35.0, 70.0])
        self.assertEqual(H5A.expand_prompt_box([0, 0, 10, 10], 100, 100), [0.0, 0.0, 12.5, 12.5])

    def test_prompt_expansion_rejects_nonfinite_and_degenerate_boxes(self):
        with self.assertRaises(H5A.ProbeError):
            H5A.expand_prompt_box([0, 0, float("nan"), 10], 100, 100)
        with self.assertRaises(H5A.ProbeError):
            H5A.expand_prompt_box([1, 1, 1, 10], 100, 100)

    def test_aggregate_packed_mask_ceiling_includes_both_families(self):
        self.assertEqual(H5A.validate_mask_count(1280, 800, 36, 36), 9_216_000)
        with self.assertRaises(H5A.ProbeError):
            H5A.validate_mask_count(2304, 1024, 36, 36)
        with self.assertRaises(H5A.ProbeError):
            H5A.validate_mask_count(1280, 800, 37, 0)

    def test_zero_candidate_worker_timing_row_is_safe_after_v1_keyerror(self):
        # The preserved v1 producer indexed timing_ms on every worker result,
        # but no-candidate results omit that optional field.
        v1_result = {"omni": {"candidate_count": 0}}
        with self.assertRaises(KeyError):
            v1_result["timing_ms"]["worker_total"] = 4.0

        repaired_result = {"omni": {"candidate_count": 0}}
        repaired_result.setdefault("timing_ms", {})["worker_total"] = 4.0
        self.assertEqual(repaired_result["timing_ms"], {"worker_total": 4.0})
        self.assertIn(
            'native.setdefault("timing_ms", {})["worker_total"]',
            SCRIPT.read_text(encoding="utf-8"),
        )

    def test_owned_child_timeout_is_cancelled_and_joined(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "worker.log"
            started = __import__("time").monotonic()
            status, error, output = H5A.run_bounded(
                ["/usr/bin/python3", "-c", "import time; time.sleep(30)"], 1, log
            )
            self.assertEqual(status, "timeout")
            self.assertIn("deadline", error or "")
            self.assertEqual(output, b"")
            self.assertLess(__import__("time").monotonic() - started, 6)
            self.assertTrue(log.exists())


if __name__ == "__main__":
    unittest.main()
