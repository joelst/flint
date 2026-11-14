"""Convert pinned BEIR SciFact corpus, queries, and test judgments for live retrieval."""

import argparse
import csv
import json
from pathlib import Path

import pyarrow.parquet as parquet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--queries", type=Path, required=True)
    parser.add_argument("--qrels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    corpus = [
        {"id": row["_id"], "text": f"{row['title']} {row['text']}".strip()}
        for row in parquet.read_table(args.corpus).to_pylist()
    ]
    queries = [
        {"id": row["_id"], "text": row["text"]}
        for row in parquet.read_table(args.queries).to_pylist()
    ]
    with args.qrels.open(encoding="utf-8", newline="") as stream:
        qrels = [
            {"queryId": row["query-id"], "docId": row["corpus-id"], "score": int(row["score"])}
            for row in csv.DictReader(stream, delimiter="\t")
        ]
    if len(corpus) != 5183 or len(queries) != 1109 or len(qrels) != 339:
        raise ValueError("SciFact corpus, queries, or test judgment count differs from the pinned input.")
    args.output.write_text(
        json.dumps({"corpus": corpus, "queries": queries, "qrels": qrels}, ensure_ascii=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
