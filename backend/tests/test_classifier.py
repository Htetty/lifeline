"""Focused classifier checks; no ML packages, model, credentials or network needed."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import classifier


def saved_config():
    return {
        "model_type": "modernbert", "problem_type": "multi_label_classification",
        "pipeline_check": False,
        "id2label": {str(i): label for i, label in enumerate(classifier.LABELS)},
        "label2id": {label: i for i, label in enumerate(classifier.LABELS)},
        "dataset_max_length": 256, "max_position_embeddings": 8192,
        "decision_threshold": 0.5,
    }


def loaded_model(scores=None):
    if scores is None:
        scores = dict(zip(classifier.LABELS, (0.5, 0.49, 0.8, 0.1)))
    return SimpleNamespace(
        predict=Mock(return_value=scores), threshold=0.5, model_version="sha256:test"
    )


class ClassifierTests(unittest.TestCase):
    def test_import_and_disabled_mode_do_not_require_ml_or_backend_credentials(self):
        code = """
import sys
sys.modules['torch'] = None
sys.modules['transformers'] = None
from app.classifier import LocalClassifier
result = LocalClassifier().classify_text('A fictional message.')
assert result == dict(status='disabled', scores=None, predicted_tags=None,
                      threshold=None, model_version=None)
assert 'app.config' not in sys.modules
"""
        subprocess.run(
            [sys.executable, "-c", code], check=True,
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
        )

    def test_threshold_is_inclusive_and_result_is_json_serializable(self):
        with patch.object(classifier, "_load_model", return_value=loaded_model()):
            result = classifier.LocalClassifier("model").classify_text("Fictional message.")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["predicted_tags"], ["request", "medical_help"])
        self.assertEqual(tuple(result["scores"]), classifier.LABELS)
        self.assertEqual(result["threshold"], 0.5)
        self.assertEqual(result["model_version"], "sha256:test")
        json.dumps(result, allow_nan=False)

    def test_empty_success_is_distinct_from_disabled_and_unavailable(self):
        with patch.object(classifier, "_load_model", return_value=loaded_model(dict.fromkeys(classifier.LABELS, 0.1))):
            success = classifier.LocalClassifier("model").classify_text("Fictional message.")
        disabled = classifier.LocalClassifier().classify_text("Fictional message.")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertLogs(classifier.log, level="WARNING"):
                unavailable = classifier.LocalClassifier(directory).classify_text("Fictional message.")
        self.assertEqual(success["status"], "ok")
        self.assertEqual(success["predicted_tags"], [])
        for result, status in ((disabled, "disabled"), (unavailable, "unavailable")):
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["predicted_tags"])
            self.assertIsNone(result["scores"])

    def test_concurrent_calls_load_once_and_serialize_predictions(self):
        loaded = loaded_model()
        state = {"active": 0, "maximum": 0}

        def predict(text):
            state["active"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
            time.sleep(0.005)
            state["active"] -= 1
            return dict.fromkeys(classifier.LABELS, 0.1)

        loaded.predict.side_effect = predict
        service = classifier.LocalClassifier("model")
        with patch.object(classifier, "_load_model", return_value=loaded) as load:
            with ThreadPoolExecutor(max_workers=6) as workers:
                results = list(workers.map(service.classify_text, ["Fictional message."] * 12))
        self.assertEqual(load.call_count, 1)
        self.assertEqual(loaded.predict.call_count, 12)
        self.assertEqual(state["maximum"], 1)
        self.assertTrue(all(result["status"] == "ok" for result in results))

    def test_load_failures_are_unavailable_and_not_retried_on_each_utterance(self):
        for error in (ImportError("optional package absent"), OSError("bad weights"), RuntimeError("load failure")):
            with self.subTest(error=type(error).__name__):
                service = classifier.LocalClassifier("model")
                with patch.object(classifier, "_load_model", side_effect=error) as load:
                    with self.assertLogs(classifier.log, level="WARNING") as logs:
                        first = service.classify_text("Private fictional caller text.")
                        second = service.classify_text("Another fictional message.")
                self.assertEqual(first["status"], "unavailable")
                self.assertEqual(second, first)
                self.assertEqual(load.call_count, 1)
                self.assertNotIn("Private fictional caller text", "".join(logs.output))
                self.assertNotIn(str(error), "".join(logs.output))

    def test_inference_failure_does_not_return_stale_scores_and_can_recover(self):
        loaded = loaded_model()
        loaded.predict.side_effect = [
            dict.fromkeys(classifier.LABELS, 0.1), RuntimeError("prediction failed"),
            dict.fromkeys(classifier.LABELS, 0.9),
        ]
        service = classifier.LocalClassifier("model")
        with patch.object(classifier, "_load_model", return_value=loaded) as load:
            self.assertEqual(service.classify_text("First.")["status"], "ok")
            with self.assertLogs(classifier.log, level="WARNING"):
                failed = service.classify_text("Second.")
            recovered = service.classify_text("Third.")
        self.assertEqual(failed["status"], "unavailable")
        self.assertIsNone(failed["scores"])
        self.assertIsNone(failed["predicted_tags"])
        self.assertEqual(failed["threshold"], 0.5)
        self.assertEqual(failed["model_version"], "sha256:test")
        self.assertEqual(recovered["predicted_tags"], list(classifier.LABELS))
        self.assertEqual(load.call_count, 1)

    def test_nonfinite_wrong_shape_or_out_of_range_scores_are_unavailable(self):
        for bad in (float("nan"), float("inf"), -0.1, 1.1):
            with self.subTest(score=bad):
                with patch.object(classifier, "_load_model", return_value=loaded_model(dict.fromkeys(classifier.LABELS, bad))):
                    with self.assertLogs(classifier.log, level="WARNING"):
                        result = classifier.LocalClassifier("model").classify_text("Fictional.")
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["scores"])
        with patch.object(classifier, "_load_model", return_value=loaded_model({"request": 0.9})):
            with self.assertLogs(classifier.log, level="WARNING"):
                self.assertEqual(classifier.LocalClassifier("model").classify_text("Fictional.")["status"], "unavailable")

    def test_invalid_input_is_a_caller_error_before_loading(self):
        service = classifier.LocalClassifier("model")
        with patch.object(classifier, "_load_model") as load:
            for text in ("", " \n\t"):
                with self.assertRaises(ValueError):
                    service.classify_text(text)
            for text in (None, 12, []):
                with self.assertRaises(TypeError):
                    service.classify_text(text)
        load.assert_not_called()

    def test_incompatible_artifacts_are_rejected_before_loading_weights(self):
        bad_configs = []
        for key, value in (
            ("id2label", {str(i): label for i, label in enumerate(reversed(classifier.LABELS))}),
            ("label2id", {"wrong_label": 0}), ("pipeline_check", True),
            ("problem_type", "single_label_classification"), ("model_type", "bert"),
            ("dataset_max_length", 0), ("dataset_max_length", 9000),
            ("decision_threshold", None), ("decision_threshold", float("nan")),
        ):
            config = saved_config()
            config[key] = value
            bad_configs.append(config)
        missing_marker = saved_config()
        del missing_marker["pipeline_check"]
        bad_configs.append(missing_marker)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "model.safetensors").touch()
            (path / "tokenizer.json").write_text("{}")
            for config in bad_configs:
                with self.subTest(config=config):
                    (path / "config.json").write_text(json.dumps(config))
                    with self.assertRaises(ValueError):
                        classifier._load_model(directory)

    def test_public_service_reads_environment_once_and_reuses_instance(self):
        with patch.object(classifier, "_default_classifier", None):
            with patch.dict("os.environ", {"CLASSIFIER_MODEL_PATH": "model-one"}):
                with patch.object(classifier, "_load_model", return_value=loaded_model()) as load:
                    classifier.classify_text("First.")
                    with patch.dict("os.environ", {"CLASSIFIER_MODEL_PATH": "model-two"}):
                        classifier.classify_text("Second.")
            load.assert_called_once_with("model-one")

    def test_version_changes_with_weights_or_tokenizer_and_not_directory_name(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first"
            second = Path(directory) / "second"
            for path in (first, second):
                path.mkdir()
                for name in ("config.json", "model.safetensors", "tokenizer.json"):
                    (path / name).write_bytes(b"fictional fixture")
            version = classifier._artifact_version(first)
            self.assertEqual(version, classifier._artifact_version(second))
            (second / "model.safetensors").write_bytes(b"different fixture")
            self.assertNotEqual(version, classifier._artifact_version(second))
            (second / "model.safetensors").write_bytes(b"fictional fixture")
            (second / "tokenizer.json").write_bytes(b"different fixture")
            self.assertNotEqual(version, classifier._artifact_version(second))


class AsyncClassifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_loading_and_predictions_run_off_event_loop_and_reuse_model(self):
        loop_thread = threading.get_ident()
        loaded = loaded_model()
        threads = []

        def load(path):
            threads.append(threading.get_ident())
            return loaded

        def predict(text):
            threads.append(threading.get_ident())
            return dict.fromkeys(classifier.LABELS, 0.1)

        loaded.predict.side_effect = predict
        with patch.object(classifier, "_default_classifier", classifier.LocalClassifier("model")):
            with patch.object(classifier, "_load_model", side_effect=load) as loader:
                results = await asyncio.gather(
                    classifier.classify_text_async("First."), classifier.classify_text_async("Second.")
                )
        self.assertEqual(loader.call_count, 1)
        self.assertEqual(len(threads), 3)
        self.assertTrue(all(thread != loop_thread for thread in threads))
        self.assertTrue(all(result["status"] == "ok" for result in results))


if __name__ == "__main__":
    unittest.main()
