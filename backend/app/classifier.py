"""Optional local ModernBERT topic inference; never an incident-fact extractor.

Use ``await classify_text_async(text)`` from async FastAPI handlers. The synchronous
``classify_text(text)`` interface is for worker threads and local scripts.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict

LABELS = ("request", "search_and_rescue", "medical_help", "floods")
log = logging.getLogger(__name__)


class ClassificationResult(TypedDict):
    status: Literal["ok", "disabled", "unavailable"]
    scores: dict[str, float] | None
    predicted_tags: list[str] | None
    threshold: float | None
    model_version: str | None


@dataclass(frozen=True)
class _LoadedModel:
    tokenizer: Any
    model: Any
    torch: Any
    max_length: int
    threshold: float
    model_version: str

    def predict(self, text: str) -> dict[str, float]:
        inputs = self.tokenizer(
            text, truncation=True, max_length=self.max_length, return_tensors="pt"
        )
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits
            if tuple(logits.shape) != (1, len(LABELS)):
                raise ValueError("Unexpected classifier output shape")
            if not self.torch.isfinite(logits).all().item():
                raise ValueError("Nonfinite classifier logits")
            scores = self.torch.sigmoid(logits)[0].tolist()
        return dict(zip(LABELS, scores))


def _validate_metadata(config: dict) -> tuple[int, float]:
    if (
        config.get("model_type") != "modernbert"
        or config.get("problem_type") != "multi_label_classification"
        or config.get("pipeline_check") is not False
        or config.get("id2label") != {str(i): label for i, label in enumerate(LABELS)}
        or config.get("label2id") != {label: i for i, label in enumerate(LABELS)}
    ):
        raise ValueError("Expected the trained four-label ModernBERT artifact")
    max_length = config.get("dataset_max_length")
    max_positions = config.get("max_position_embeddings")
    threshold = config.get("decision_threshold")
    if (
        type(max_length) is not int or type(max_positions) is not int
        or not 0 < max_length <= max_positions
    ):
        raise ValueError("Invalid saved token length")
    if type(threshold) not in (int, float) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError("Invalid saved decision threshold")
    return max_length, float(threshold)


def _artifact_version(path: Path) -> str:
    """Fingerprint inference assets once, without copying weights into the repo."""
    digest = hashlib.sha256()
    for name in (
        "config.json", "model.safetensors", "tokenizer.json",
        "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json",
    ):
        asset = path / name
        if not asset.is_file():
            continue  # Optional tokenizer metadata; required assets checked at load.
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(str(asset.stat().st_size).encode("ascii") + b"\0")
        with asset.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _load_model(model_path: str) -> _LoadedModel:
    path = Path(model_path).expanduser().resolve()
    for name in ("config.json", "model.safetensors", "tokenizer.json"):
        if not (path / name).is_file():
            raise FileNotFoundError(f"Missing classifier asset: {name}")
    config = json.loads((path / "config.json").read_text(encoding="utf-8"))
    max_length, threshold = _validate_metadata(config)

    # Optional dependencies: importing this module never imports torch/transformers.
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    # Matches the working CPU reference; this setting applies process-wide.
    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(
        path, local_files_only=True, trust_remote_code=False
    )
    model, loading_info = AutoModelForSequenceClassification.from_pretrained(
        path, local_files_only=True, trust_remote_code=False, use_safetensors=True,
        attn_implementation="eager", reference_compile=False, output_loading_info=True,
    )
    if any(loading_info.get(key) for key in (
        "missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"
    )):
        raise ValueError("Model weights do not exactly match the saved architecture")
    model = model.to("cpu").eval()
    return _LoadedModel(tokenizer, model, torch, max_length, threshold, _artifact_version(path))


class LocalClassifier:
    """One lazily loaded model per instance; a failed load is attempted only once.

    Instances serialize loading and inference to bound local CPU/memory use.
    Pass no path to disable. Create a new instance (or restart the process) to
    recover after fixing model files/dependencies. Inference errors affect only
    that prediction, and do not discard a successfully loaded model.
    """

    def __init__(self, model_path: str | Path | None = None):
        self._model_path = str(model_path).strip() if model_path is not None else ""
        self._lock = threading.Lock()
        self._load_attempted = False
        self._loaded: _LoadedModel | None = None

    def classify_text(self, text: str) -> ClassificationResult:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        if not text.strip():
            raise ValueError("text must be nonempty")
        with self._lock:
            result: ClassificationResult = {
                "status": "disabled" if not self._model_path else "unavailable",
                "scores": None, "predicted_tags": None,
                "threshold": None, "model_version": None,
            }
            if not self._model_path:
                return result
            if not self._load_attempted:
                self._load_attempted = True
                try:
                    self._loaded = _load_model(self._model_path)
                except Exception as error:
                    # Do not log caller text, local paths, or dependency exception contents.
                    log.warning("Classifier load unavailable (%s)", type(error).__name__)
            if self._loaded is None:
                return result
            result["threshold"] = self._loaded.threshold
            result["model_version"] = self._loaded.model_version
            try:
                scores = self._loaded.predict(text)
                if tuple(scores) != LABELS or any(
                    not math.isfinite(value) or not 0 <= value <= 1 for value in scores.values()
                ):
                    raise ValueError("Invalid classifier scores")
            except Exception as error:
                log.warning("Classifier inference unavailable (%s)", type(error).__name__)
                return result
            result.update(
                status="ok", scores=scores,
                predicted_tags=[label for label in LABELS if scores[label] >= self._loaded.threshold],
            )
            return result


_default_classifier: LocalClassifier | None = None
_default_lock = threading.Lock()


def _get_classifier() -> LocalClassifier:
    global _default_classifier
    with _default_lock:
        if _default_classifier is None:
            _default_classifier = LocalClassifier(os.environ.get("CLASSIFIER_MODEL_PATH"))
        return _default_classifier


def classify_text(text: str) -> ClassificationResult:
    """Synchronous inference. Reads CLASSIFIER_MODEL_PATH on the first call only."""
    return _get_classifier().classify_text(text)


async def classify_text_async(text: str) -> ClassificationResult:
    """FastAPI adapter: offload model loading, lock waits, and inference to a thread."""
    return await asyncio.to_thread(classify_text, text)
