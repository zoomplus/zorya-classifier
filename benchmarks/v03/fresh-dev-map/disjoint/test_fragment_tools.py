from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from fragment_tools import create_new_output_dir, select_predeclared_cell_box, study_input, write_immutable_json


class FragmentToolsTests(unittest.TestCase):
    def test_only_predeclared_instance_gets_reference_box(self) -> None:
        proofs = [
            {"sourceCellXY": [4, 5], "matchTopLeftXY": [160, 190]},
            {"sourceCellXY": [7, 5], "matchTopLeftXY": [256, 190]},
            {"sourceCellXY": [10, 5], "matchTopLeftXY": [352, 190]},
            {"sourceCellXY": [7, 10], "matchTopLeftXY": [256, 350]},
        ]
        boxes = select_predeclared_cell_box([7, 10], proofs, box_width=32, box_height=32)
        self.assertEqual(boxes, [{"left": 256, "top": 350, "width": 32, "height": 32}])
        self.assertEqual(select_predeclared_cell_box(None, [], 32, 32), [])
        with self.assertRaisesRegex(ValueError, "absent source target"):
            select_predeclared_cell_box(None, proofs, 32, 32)
        with self.assertRaisesRegex(ValueError, "expected one pixel proof"):
            select_predeclared_cell_box([99, 99], proofs, 32, 32)

    def test_output_is_new_only_and_immutable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            study = root / "study"
            (repo / "benchmarks").mkdir(parents=True)
            (repo / "AGENTS.md").write_text("test repo marker\n")
            (study / "exports").mkdir(parents=True)
            output = create_new_output_dir(study, study / "exports" / "fragment-v1", repo)
            manifest = write_immutable_json(output, "rows.json", [{"id": "preselected"}])
            before = hashlib.sha256(manifest.read_bytes()).hexdigest()
            self.assertEqual(manifest.stat().st_mode & 0o777, 0o444)
            with self.assertRaises(FileExistsError):
                create_new_output_dir(study, output, repo)
            self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), before)
            with self.assertRaises(FileExistsError):
                write_immutable_json(output, "rows.json", [{"id": "replacement"}])
            self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), before)

    def test_rejects_output_inside_checkout_and_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            study = root / "study"
            outside = root / "outside"
            (repo / "benchmarks").mkdir(parents=True)
            (repo / "AGENTS.md").write_text("test repo marker\n")
            (study / "exports").mkdir(parents=True)
            outside.mkdir()
            (outside / "secret.json").write_text("{}\n")
            with self.assertRaisesRegex(ValueError, "outside the repository"):
                create_new_output_dir(study, repo / "generated", repo)

            (study / "escape.json").symlink_to(outside / "secret.json")
            with self.assertRaisesRegex(ValueError, "escapes --study-root"):
                study_input(study, "escape.json")

            (study / "external-parent").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "below --study-root"):
                create_new_output_dir(study, study / "external-parent" / "new-output", repo)


if __name__ == "__main__":
    unittest.main()
