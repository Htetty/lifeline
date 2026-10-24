"""Evaluate a saved disaster model at fixed threshold 0.5 (no tuning)."""
import argparse
import json

import torch
from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

from disaster_common import (check_dataset_label_order, metrics_from_logits, ml_path,
                             read_records, select_device, write_json)


def evaluate(model_dir, data_path, output_path, device="cpu", batch_size=4, metadata_path=None):
    device = select_device(device)
    if batch_size < 1:
        raise ValueError("batch size must be positive")
    # Fail before loading model weights or computing predictions.
    check_dataset_label_order(data_path, metadata_path)
    model_config = AutoConfig.from_pretrained(model_dir, local_files_only=True)
    check_dataset_label_order(data_path, metadata_path, model_config)
    records = read_records(data_path)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_dir, local_files_only=True, attn_implementation="eager"
    ).to(device)
    max_length = getattr(model.config, "dataset_max_length", 256)
    model.eval()
    logits = []
    with torch.inference_mode():
        for start in range(0, len(records), batch_size):
            batch = records[start:start + batch_size]
            inputs = tokenizer([row["text"] for row in batch], padding=True,
                               truncation=True, max_length=max_length, return_tensors="pt").to(device)
            logits.extend(model(**inputs).logits.cpu().tolist())
    metrics = metrics_from_logits(logits, [row["labels"] for row in records])
    metrics.update(model_dir=str(model_dir), data_path=str(data_path),
                   pipeline_check=bool(getattr(model.config, "pipeline_check", False)))
    write_json(output_path, metrics)
    if metrics["pipeline_check"]:
        print("PIPELINE CHECK ONLY: these metrics are not accuracy evidence.")
    print(json.dumps(metrics, indent=2))
    print(f"Saved metrics: {output_path}")
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, help="Path relative to ml/ or absolute")
    parser.add_argument("--data", required=True, help="JSONL path relative to ml/ or absolute")
    parser.add_argument("--output", required=True, help="Metrics JSON path relative to ml/ or absolute")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--metadata", help="Dataset metadata JSON; defaults to preparation_report.json beside the data")
    args = parser.parse_args()
    evaluate(ml_path(args.model_dir), ml_path(args.data), ml_path(args.output), args.device,
             args.batch_size, ml_path(args.metadata) if args.metadata else None)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(f"Evaluation failed: {error}")
