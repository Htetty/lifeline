"""Opt-in real artifact checks. A configured but broken model fails, never skips."""

import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import classifier


@unittest.skipUnless(os.environ.get("CLASSIFIER_TEST_MODEL_PATH"), "Set CLASSIFIER_TEST_MODEL_PATH for real local inference")
class LocalArtifactTests(unittest.TestCase):
    def test_real_load_reference_scores_reuse_truncation_and_async_adapter(self):
        cases = json.loads((Path(__file__).parent / "fixtures/classifier-reference.json").read_text())["cases"]
        service = classifier.LocalClassifier(os.environ["CLASSIFIER_TEST_MODEL_PATH"])
        with patch.object(classifier, "_load_model", wraps=classifier._load_model) as loader:
            results = []
            for case in cases:
                with self.subTest(text=case["text"]):
                    result = service.classify_text(case["text"])
                    self.assertEqual(result["status"], "ok")
                    self.assertEqual(tuple(result["scores"]), classifier.LABELS)
                    for label, expected in zip(classifier.LABELS, case["scores"]):
                        self.assertAlmostEqual(result["scores"][label], expected, delta=1e-4)
                    self.assertEqual(result["predicted_tags"], case["predicted_tags"])
                    self.assertEqual(result["threshold"], 0.5)
                    self.assertRegex(result["model_version"], r"^sha256:[0-9a-f]{64}$")
                    json.dumps(result, allow_nan=False)
                    results.append(result)
            self.assertEqual(len({result["model_version"] for result in results}), 1)
            self.assertEqual(service.classify_text(cases[0]["text"]), results[0])
            self.assertEqual(service._loaded.max_length, 256)
            long_text = "Fictional water covers the road. " * 100
            tokens = service._loaded.tokenizer(long_text, truncation=False)["input_ids"]
            self.assertGreater(len(tokens), 256)
            self.assertEqual(service.classify_text(long_text)["status"], "ok")
            with patch.object(classifier, "_default_classifier", service):
                self.assertEqual(asyncio.run(classifier.classify_text_async(cases[0]["text"])), results[0])
            self.assertEqual(loader.call_count, 1)


if __name__ == "__main__":
    unittest.main()
