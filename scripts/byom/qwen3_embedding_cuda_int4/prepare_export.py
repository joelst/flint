import argparse
import json
import shutil
from pathlib import Path


def prepare_export(source: Path, output: Path) -> None:
    source_sentence_config = source / "config_sentence_transformers.json"
    output_sentence_config = output / "config_sentence_transformers.json"
    output_model_config = output / "config.json"
    olive_manifest = output / "model_config.json"

    if not source_sentence_config.is_file():
        raise FileNotFoundError(source_sentence_config)
    if not output_model_config.is_file():
        raise FileNotFoundError(output_model_config)

    model_config = json.loads(output_model_config.read_text(encoding="utf-8"))
    if not isinstance(model_config, dict):
        raise ValueError(f"{output_model_config} must contain a JSON object")

    if olive_manifest.exists():
        manifest = json.loads(olive_manifest.read_text(encoding="utf-8"))
        if (
            not isinstance(manifest, dict)
            or manifest.get("type") != "onnxmodel"
            or not isinstance(manifest.get("config"), dict)
            or manifest["config"].get("onnx_file_name") != "model.onnx"
        ):
            raise ValueError(f"{olive_manifest} is not the expected Olive ONNX manifest")

    shutil.copyfile(source_sentence_config, output_sentence_config)
    model_config["tie_word_embeddings"] = True
    output_model_config.write_text(
        json.dumps(model_config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    if olive_manifest.exists():
        olive_manifest.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare_export(args.source, args.output)


if __name__ == "__main__":
    main()
