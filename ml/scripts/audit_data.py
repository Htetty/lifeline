"""Read-only disaster dataset audit; exports review messages from training only."""
import argparse
import hashlib
import json
from importlib.metadata import version
from itertools import combinations

import numpy as np
from transformers import AutoTokenizer

from disaster_common import LABELS, ml_path, read_records, write_json
from prepare_data import normalized_text


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def label_counts(rows):
    total = len(rows)
    result = {}
    for i, label in enumerate(LABELS):
        positive = sum(row["labels"][i] for row in rows)
        result[label] = {
            "positive": positive, "negative": total - positive,
            "positive_percent": 100 * positive / total,
            "negative_percent": 100 * (total - positive) / total,
        }
    return result


def token_lengths(rows, tokenizer, max_length):
    lengths = []
    for start in range(0, len(rows), 128):
        encoded = tokenizer(
            [row["text"] for row in rows[start:start + 128]],
            add_special_tokens=True, truncation=False, padding=False,
            return_attention_mask=False, return_token_type_ids=False,
        )
        lengths.extend(map(len, encoded["input_ids"]))
    exceeded = sum(length > max_length for length in lengths)
    return {
        "min": min(lengths), "mean": float(np.mean(lengths)),
        "median": float(np.median(lengths)),
        "p90": float(np.percentile(lengths, 90)),
        "p95": float(np.percentile(lengths, 95)),
        "p99": float(np.percentile(lengths, 99)), "max": max(lengths),
        "exceeding_max_length": exceeded,
        "exceeding_max_length_percent": 100 * exceeded / len(lengths),
    }


def overlaps(splits):
    result = {}
    for left, right in combinations(splits, 2):
        left_rows, right_rows = splits[left], splits[right]
        ids = sorted({row["source_id"] for row in left_rows} &
                     {row["source_id"] for row in right_rows})
        indexes = []
        for rows in (left_rows, right_rows):
            index = {}
            for row in rows:
                index.setdefault(normalized_text(row["text"]), []).append(row["source_id"])
            indexes.append(index)
        shared = sorted(indexes[0].keys() & indexes[1].keys())
        result[f"{left}/{right}"] = {
            "source_id_overlap_count": len(ids), "source_ids": ids,
            "normalized_text_overlap_count": len(shared),
            # Retain references for investigation, without exporting held-out text.
            "normalized_text_overlaps": [
                {"normalized_text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                 left: indexes[0][text], right: indexes[1][text]} for text in shared
            ],
        }
    return result


def review_sample(training_rows, seed):
    """Stable hash ranking: independent of input ordering and random module versions."""
    samples = []
    for i, label in enumerate(LABELS):
        for value in (1, 0):
            candidates = [row for row in training_rows if row["labels"][i] == value]
            def rank(row):
                key = json.dumps([seed, label, value, row["source_id"], row["text"]],
                                 ensure_ascii=False, separators=(",", ":"))
                return hashlib.sha256(key.encode()).hexdigest(), row["source_id"]
            for row in sorted(candidates, key=rank)[:10]:
                samples.append({"split": "train", "review_label": label,
                                "review_value": value, "source_id": row["source_id"],
                                "text": row["text"], "labels": row["labels"],
                                "label_order": list(LABELS)})
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config_disaster.json")
    parser.add_argument("--test-data", default="data/processed/test.jsonl")
    parser.add_argument("--preparation-report", default="data/processed/preparation_report.json")
    parser.add_argument("--local-files-only", action="store_true", help="Use cached tokenizer only")
    args = parser.parse_args()
    config_path = ml_path(args.config)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    # Fixed location is already ignored by ml/outputs/ in .gitignore.
    output = ml_path("outputs/data_audit")
    report = {"label_order": list(LABELS), "status": "incomplete", "issues": []}
    try:
        preparation_path = ml_path(args.preparation_report)
        preparation = json.loads(preparation_path.read_text(encoding="utf-8"))
        if preparation.get("label_order") != list(LABELS):
            raise ValueError("Preparation report label order disagrees with shared dataset labels")
        report["label_order_check"] = {
            "passed": True,
            "basis": "shared labels match preparation report; unnamed JSONL vectors cannot independently prove semantic order",
        }
        train_path = ml_path(config["train_file"])
        if not train_path.exists() and train_path == ml_path("data/processed/train.jsonl"):
            train_path = ml_path("data/processed/training.jsonl")
        paths = {"train": train_path, "validation": ml_path(config["validation_file"]),
                 "test": ml_path(args.test_data)}
        if len(set(paths.values())) != 3:
            raise ValueError("Train, validation and test paths must be distinct")
        max_length = config["max_length"]
        if type(max_length) is not int or max_length <= 0:
            raise ValueError("Configured max_length must be a positive integer")
        report.update({
            "config_sha256": file_hash(config_path),
            "preparation_report_sha256": file_hash(preparation_path),
            "inputs": {split: {"path": str(path), "sha256": file_hash(path)}
                       for split, path in paths.items()},
            "model_name": config["model_name"], "max_length": max_length,
            "seed": config["seed"],
            "token_length_policy": "Full untruncated tokens including special tokens, with no padding; percentiles use NumPy linear interpolation",
            "review_policy": "Training only; up to 10 per label/value, ranked by SHA256(seed,label,value,source_id,text). A message may appear in multiple groups; not a representative prevalence sample.",
            "versions": {name: version(name) for name in ("transformers", "tokenizers", "numpy")},
        })
        splits = {split: read_records(path) for split, path in paths.items()}
        report["record_validation"] = "passed: nonempty text/source IDs, unique within-split IDs, four integer binary labels"
        report["overlaps"] = overlaps(splits)
        tokenizer = AutoTokenizer.from_pretrained(config["model_name"], local_files_only=args.local_files_only)
        report["tokenizer_sha256"] = hashlib.sha256(tokenizer.backend_tokenizer.to_str().encode()).hexdigest()
        report["splits"] = {
            split: {"records": len(rows), "labels": label_counts(rows),
                    "token_lengths": token_lengths(rows, tokenizer, max_length)}
            for split, rows in splits.items()
        }
        for pair, checks in report["overlaps"].items():
            if checks["source_id_overlap_count"] or checks["normalized_text_overlap_count"]:
                report["issues"].append(f"Cross-split overlap in {pair}; see overlap references")
        # Confirm inputs remained identical throughout the audit, before exporting samples.
        for split, path in paths.items():
            if file_hash(path) != report["inputs"][split]["sha256"]:
                raise ValueError(f"{split} file changed during the audit; rerun on stable inputs")
        sample = review_sample(splits["train"], config["seed"])
        output.mkdir(parents=True, exist_ok=True)
        (output / "training_review.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in sample), encoding="utf-8")
        report["review_records"] = len(sample)
        report["review_unique_source_ids"] = len({row["source_id"] for row in sample})
        report["status"] = "issues_found" if report["issues"] else "passed"
    except (OSError, ValueError, KeyError, TypeError) as error:
        report["issues"].append(str(error))
        report["status"] = "failed"
        write_json(output / "audit_report.json", report)
        raise SystemExit(f"Audit failed: {error}. Details: {output / 'audit_report.json'}")
    lines = [f"Audit status: {report['status']}", f"Label order: {list(LABELS)}",
             "Binary labels and preparation-report order: passed",
             "Order caveat: JSONL vectors have no names; order relies on preparation metadata."]
    for split, stats in report["splits"].items():
        lines.append(f"\n{split}: {stats['records']} messages")
        for label, values in stats["labels"].items():
            lines.append(f"  {label}: positive {values['positive']} ({values['positive_percent']:.2f}%), "
                         f"negative {values['negative']} ({values['negative_percent']:.2f}%)")
        lengths = stats["token_lengths"]
        lines.append("  Tokens (including special tokens): " + ", ".join(
            f"{key}={lengths[key]:.1f}" for key in ("min", "mean", "median", "p90", "p95", "p99", "max")))
        lines.append(f"  Exceeding max_length={max_length}: {lengths['exceeding_max_length']} "
                     f"({lengths['exceeding_max_length_percent']:.2f}%)")
    for pair, checks in report["overlaps"].items():
        lines.append(f"\n{pair}: source-ID overlaps={checks['source_id_overlap_count']}, "
                     f"normalized-text overlaps={checks['normalized_text_overlap_count']}")
    lines.append(f"\nTraining-only review: {len(sample)} grouped examples, {report['review_unique_source_ids']} unique messages; seed={config['seed']}.")
    lines.append("Review sampling balances each label/value for inspection; it does not estimate prevalence.")
    lines.append(f"Saved results: {output}")
    summary = "\n".join(lines) + "\n"
    write_json(output / "audit_report.json", report)
    (output / "summary.txt").write_text(summary, encoding="utf-8")
    print(summary)
    if report["issues"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
