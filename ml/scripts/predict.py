"""Reload a local model and print model scores and tags at threshold 0.5."""
import argparse
import json

import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

from disaster_common import ml_path, select_device


def predict(model_dir, text, device="cpu"):
    device = select_device(device)
    if not text.strip():
        raise ValueError("text must be nonempty")
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_dir, local_files_only=True, attn_implementation="eager",
    ).to(device)
    model.eval()
    inputs = tokenizer(text, return_tensors="pt", truncation=True,
                       max_length=getattr(model.config, "dataset_max_length", 128)).to(device)
    with torch.inference_mode():
        scores = torch.sigmoid(model(**inputs).logits)[0].cpu().tolist()
    named_scores = {model.config.id2label[i]: score for i, score in enumerate(scores)}
    result = {"text": text, "model_scores": named_scores,
              "predicted_tags": [label for label, score in named_scores.items() if score >= 0.5],
              "threshold": 0.5}
    print("Model scores are not calibrated probabilities.")
    if getattr(model.config, "pipeline_check", False) or model_dir == ml_path("outputs/smoke_test"):
        print("PIPELINE CHECK ONLY: these scores are not accuracy evidence.")
    print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--text", required=True)
    parser.add_argument("--model-dir", default="outputs/smoke_test", help="Path relative to ml/ or absolute")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    predict(ml_path(args.model_dir), args.text, args.device)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(f"Prediction failed: {error}")
