"""Shared dataset labels, validation, tokenization and metrics."""
import json
from pathlib import Path

import numpy as np
import torch
from datasets import Dataset, Sequence, Value
from sklearn.metrics import f1_score, precision_recall_fscore_support

from disaster_labels import LABELS

ML_DIR = Path(__file__).resolve().parent.parent
THRESHOLD = 0.5


def ml_path(value):
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (ML_DIR / path).resolve()


def select_device(name):
    if name not in ("cpu", "cuda"):
        raise ValueError("device must be cpu or cuda")
    if name == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but unavailable. Install CUDA-enabled PyTorch on an NVIDIA machine, or use --device cpu.")
    return torch.device(name)


def read_records(path):
    records, ids = [], set()
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("record must be an object")
                if not isinstance(row.get("source_id"), str) or not row["source_id"].strip():
                    raise ValueError("source_id must be a nonempty string")
                if row["source_id"] in ids:
                    raise ValueError("duplicate source_id")
                if not isinstance(row.get("text"), str) or not row["text"].strip():
                    raise ValueError("text must be nonempty")
                labels = row.get("labels")
                if not isinstance(labels, list) or len(labels) != len(LABELS):
                    raise ValueError("labels must have four values")
                if any(type(x) is not int or x not in (0, 1) for x in labels):
                    raise ValueError("labels must be integers 0 or 1")
            except (ValueError, TypeError) as error:
                raise ValueError(f"{path}:{number}: {error}") from error
            ids.add(row["source_id"])
            records.append(row)
    if not records:
        raise ValueError(f"{path}: empty dataset")
    return records


def tokenize_records(records, tokenizer, max_length):
    dataset = Dataset.from_list(records)
    def tokenize(batch):
        result = tokenizer(batch["text"], truncation=True, max_length=max_length)
        result["labels"] = [[float(x) for x in labels] for labels in batch["labels"]]
        return result
    dataset = dataset.map(tokenize, batched=True, remove_columns=dataset.column_names)
    dataset = dataset.cast_column("labels", Sequence(Value("float32"), length=len(LABELS)))
    dataset.set_format("torch")
    return dataset


def metrics_from_logits(logits, labels):
    # sigmoid(logit) >= 0.5 is exactly logit >= 0; avoids exponential overflow.
    predicted = np.asarray(logits) >= 0
    labels = np.asarray(labels, dtype=int)
    precision, recall, f1, support = precision_recall_fscore_support(
        labels, predicted, average=None, zero_division=0
    )
    return {
        "label_order": list(LABELS),
        "threshold": THRESHOLD,
        "zero_division": 0,
        "records": len(labels),
        "per_label": {
            label: {"precision": float(precision[i]), "recall": float(recall[i]),
                    "f1": float(f1[i]), "positive_support": int(support[i])}
            for i, label in enumerate(LABELS)
        },
        "micro_f1": float(f1_score(labels, predicted, average="micro", zero_division=0)),
        "macro_f1": float(f1_score(labels, predicted, average="macro", zero_division=0)),
    }


def check_model_labels(config):
    actual = tuple(config.id2label.get(i) for i in range(config.num_labels))
    if actual != LABELS or config.label2id != {label: i for i, label in enumerate(LABELS)}:
        raise ValueError(f"Model label mappings do not match dataset order {LABELS}; found {actual}")


def check_dataset_label_order(data_path, metadata_path=None, model_config=None):
    """Require the dataset's declaration; never infer or reorder vector positions."""
    data_path = Path(data_path)
    metadata_path = (Path(metadata_path) if metadata_path is not None
                     else data_path.parent / "preparation_report.json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(
            f"Cannot verify label order for {data_path}: missing or unreadable "
            f"dataset metadata {metadata_path}: {error}"
        ) from error
    declared = metadata.get("label_order") if isinstance(metadata, dict) else None
    if declared != list(LABELS):
        raise ValueError(
            f"Dataset label order mismatch for {data_path} in {metadata_path}: "
            f"expected {list(LABELS)}, found {declared!r}. "
            "A label_order declaration is required; labels will not be reordered."
        )
    if model_config is not None:
        actual = [model_config.id2label.get(i) for i in range(model_config.num_labels)]
        if actual != declared:
            raise ValueError(
                f"Dataset/model label order mismatch for {data_path}: "
                f"dataset declares {declared}, saved model id2label is {actual}. "
                "Labels will not be reordered."
            )
        check_model_labels(model_config)
    return metadata_path


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
