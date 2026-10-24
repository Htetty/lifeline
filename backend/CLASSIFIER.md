# Local topic classifier — voice-bridge interface

`app.classifier` serves the trained four-label ModernBERT model locally. It has no
endpoint and does not import backend settings, Claude, Convex, or a voice SDK.
The voice-bridge owner registers/calls it; `app/main.py` is unchanged.

## Configure and run

Optional dependencies are separate from the application's baseline requirements:

```sh
# From the repository root, using the Python environment that will run FastAPI:
python -m pip install -r backend/requirements.txt -r backend/requirements-classifier.txt
export CLASSIFIER_MODEL_PATH=/Users/htetty/Models/lifeline/disaster_49320174
```

The checked local environment is Python 3.12.11, PyTorch 2.6.0, Transformers
4.57.6 on macOS CPU. No training, dataset, scikit-learn, or accelerator packages
are needed for this service. Model weights stay outside the repository.

`CLASSIFIER_MODEL_PATH` is the only classifier environment variable. Supply a
local directory (absolute path recommended; `~` is expanded). An unset/empty
value disables inference. A configured but missing/broken directory returns
`unavailable`. Set the environment before the first call; it is read once per
process. This module does not load `.env` itself. The existing application already
loads `backend/.env`; standalone callers must export their environment or load it.

Loading is lazy: importing the module and disabled calls do not import ML
dependencies or touch model files. The first enabled call loads once; subsequent
calls reuse the tokenizer and model. Workers have independent model instances,
so multiple server processes multiply model memory use. A failed load is cached
to avoid repeatedly trying expensive imports/loading on each utterance. Restart
the process after fixing dependencies, paths, or assets. Do not replace files
under a running instance.

## Exact Python interface

```python
# When running from backend/, or with backend/ on PYTHONPATH:
from app.classifier import ClassificationResult, classify_text, classify_text_async

# In an async FastAPI handler or voice-bridge task:
result: ClassificationResult = await classify_text_async(text)

# In a synchronous worker or local script:
result = classify_text(text)
```

Both functions accept one nonempty string and return a plain, JSON-serializable
dictionary with exactly these keys:

| Key | `status == "ok"` | `disabled` or `unavailable` |
| --- | --- | --- |
| `status` | `"ok"` | `"disabled"` or `"unavailable"` |
| `scores` | Four named floats in `[0, 1]`: `request`, `search_and_rescue`, `medical_help`, `floods` | `null` |
| `predicted_tags` | List of label names whose score is **at least** the saved threshold, in the order above; may be `[]` | `null` |
| `threshold` | Saved `decision_threshold` (`0.5` for the supplied artifact) | `null` before successful load; retained if prediction fails after loading |
| `model_version` | `sha256:<64 hex digits>`, a content fingerprint of the inference assets | `null` before successful load; retained if prediction fails after loading |

The fingerprint includes config, weights, tokenizer, and available tokenizer
metadata. It is independent of the directory name and is computed once at load.
It identifies the loaded artifact, not a call, incident, schema version, or model
accuracy claim. The human-readable artifact name here is `disaster_49320174`.

Check `status` before using results. A successful empty tag list means the model
ran and no score reached the threshold. Null scores/tags mean no classification
was produced; do not convert them to an empty successful result or reuse a
previous utterance's scores.

```python
if result["status"] == "ok":
    advisory_topics = result["predicted_tags"]  # [] is a valid prediction
else:
    advisory_topics = None  # classifier absent/unavailable; continue normal intake
```

Non-string input raises `TypeError`; an empty/whitespace-only string raises
`ValueError`, even when disabled. The bridge should validate or skip blank STT
events. Valid text is passed through unchanged; tokenization truncates at the
saved `dataset_max_length` (256 tokens for this artifact). Classify caller text
deliberately: the service accepts exactly what it is given and does not assemble
transcripts, remove assistant speech, remember facts, or resolve corrections.
Each prediction replaces advisory topics for that input; combining them across
utterances is a separate bridge decision.

Use **`await classify_text_async(...)` from async code**. It offloads the whole
synchronous call, including cold loading and lock waits, with `asyncio.to_thread`.
Calling synchronous `classify_text` directly inside `async def` would block the
event loop. Calls serialize inside one instance to bound concurrent model work;
the bridge controls admission/backpressure and whether to await classification
alongside extraction. Cancelling an async waiter does not stop an already running
worker-thread prediction. No startup hook, route, queue, or timeout policy is
registered by this module.

For an independently configured instance, synchronous callers can use
`LocalClassifier(model_path).classify_text(text)`. Async callers must offload that
method too. Reuse instances; constructing one per utterance defeats model reuse.

## Loading and failure behavior

The supported export contains `config.json`, `model.safetensors`, and
`tokenizer.json`, with its optional tokenizer metadata. This initial loader
supports the supplied single-file safetensors export, not sharded or pickle
weights. All loads use local files only and disable remote custom code.

The loader rejects the practice/smoke model, missing training marker, wrong label
order or inverse mapping, wrong architecture/problem type, invalid token length
or threshold, and missing/unexpected/mismatched weights. It uses CPU, eager
attention, `reference_compile=False`, evaluation mode, and `torch.inference_mode()`
to match the working local reference. At load it sets PyTorch CPU threads to four;
this is a **process-wide** PyTorch setting.

Missing files, missing optional packages, incompatible/corrupt models, and runtime
prediction errors return `unavailable` without breaking normal application
imports or intake. Malformed/nonfinite model outputs also return `unavailable`.
After successful loading, a failed prediction does not discard the model: the
next call can succeed. Logging includes the failure stage and exception class,
but no caller text, paths, scores, or raw exception contents. No fallback model,
remote download, keyword rule, retraining, or threshold override is used.

## Interpretation limits

Tags are **advisory topics**, not confirmed incident facts, a count of people,
hazard verification, a rescue priority, or permission to dispatch. Scores are
uncalibrated sigmoid model outputs, not calibrated probabilities. Keep them
separate from caller-evidenced extraction and dispatcher-approved actions.

The supplied reference predicts `search_and_rescue` and `medical_help` for:
“We are safe. Nobody is injured and we do not need rescue or medical help.”
It also predicts `request` for a flooding description without an explicit request.
These weaknesses are preserved in the diagnostic fixture, not concealed with
keyword/negation rules. Input truncation can omit a later correction or negation.
The six fictional diagnostics demonstrate loading/parity, not accuracy on calls.

## Verification

From the repository root, focused tests need only the Python standard library:

```sh
python3 -m unittest discover -s backend/tests -p 'test_classifier*.py' -v
```

The real-artifact check is opt-in and skips only when its path is unset. With a
configured but missing/incompatible model it fails. Reuse the existing working
local ML environment without installing anything:

```sh
CLASSIFIER_TEST_MODEL_PATH=/Users/htetty/Models/lifeline/disaster_49320174 \
  /Users/htetty/Models/lifeline/.venv/bin/python -m unittest discover \
  -s backend/tests -p 'test_classifier*.py' -v
```

The real check compares all four scores and tags for six fictional messages to
the supplied working reference (absolute score tolerance `1e-4`), including an
empty successful result and the known negation failure. It also checks repeated
predictions reuse one load, long-input inference, and the async adapter against
the same real model. Focused tests cover concurrent reuse, off-event-loop loading
and prediction, missing files/dependencies, invalid artifacts/outputs, failure
recovery, blank inputs, and distinction between empty/disabled/unavailable.
