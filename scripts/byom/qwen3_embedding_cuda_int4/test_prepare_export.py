import json
import tempfile
import unittest
from pathlib import Path

from prepare_export import prepare_export


class PrepareExportTests(unittest.TestCase):
    def test_copies_sentence_config_and_sets_tied_embeddings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()

            sentence_config = source / "config_sentence_transformers.json"
            sentence_config.write_text(
                '{"prompts": {"query": "query: "}}\n',
                encoding="utf-8",
            )
            model_config = output / "config.json"
            model_config.write_text(
                '{"tie_word_embeddings": false, "hidden_size": 1024}\n',
                encoding="utf-8",
            )

            prepare_export(source, output)

            self.assertEqual(
                (output / "config_sentence_transformers.json").read_bytes(),
                sentence_config.read_bytes(),
            )
            updated_config = json.loads(model_config.read_text(encoding="utf-8"))
            self.assertTrue(updated_config["tie_word_embeddings"])
            self.assertEqual(updated_config["hidden_size"], 1024)

    def test_missing_source_config_does_not_change_export(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            model_config = output / "config.json"
            model_config.write_text(
                '{"tie_word_embeddings": false}\n',
                encoding="utf-8",
            )
            original_config = model_config.read_bytes()

            with self.assertRaises(FileNotFoundError):
                prepare_export(source, output)

            self.assertEqual(model_config.read_bytes(), original_config)
            copied_sentence_config = output / "config_sentence_transformers.json"
            self.assertFalse(copied_sentence_config.exists())

    def test_invalid_export_config_does_not_copy_source_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            source_config = source / "config_sentence_transformers.json"
            source_config.write_text("{}", encoding="utf-8")
            output_config = output / "config.json"
            output_config.write_text("[]", encoding="utf-8")

            with self.assertRaises(ValueError):
                prepare_export(source, output)

            copied_sentence_config = output / "config_sentence_transformers.json"
            self.assertFalse(copied_sentence_config.exists())

    def test_removes_olive_manifest_with_build_directory_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            (source / "config_sentence_transformers.json").write_text("{}", encoding="utf-8")
            (output / "config.json").write_text("{}", encoding="utf-8")
            manifest = output / "model_config.json"
            manifest.write_text(
                json.dumps(
                    {
                        "type": "onnxmodel",
                        "config": {
                            "model_path": str(output),
                            "onnx_file_name": "model.onnx",
                            "model_attributes": {"additional_files": [str(source / "tokenizer.json")]},
                        },
                    }
                ),
                encoding="utf-8",
            )

            prepare_export(source, output)

            self.assertFalse(manifest.exists())
            self.assertTrue((output / "config_sentence_transformers.json").exists())

    def test_refuses_unrecognized_manifest_without_changing_export(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            (source / "config_sentence_transformers.json").write_text("{}", encoding="utf-8")
            model_config = output / "config.json"
            model_config.write_text('{"tie_word_embeddings": false}', encoding="utf-8")
            manifest = output / "model_config.json"
            manifest.write_text('{"type": "other"}', encoding="utf-8")

            with self.assertRaises(ValueError):
                prepare_export(source, output)

            self.assertTrue(manifest.exists())
            self.assertFalse((output / "config_sentence_transformers.json").exists())
            self.assertFalse(json.loads(model_config.read_text(encoding="utf-8"))["tie_word_embeddings"])


if __name__ == "__main__":
    unittest.main()
