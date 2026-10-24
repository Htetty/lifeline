# ML workflows

There are two separate workflows. `train.py` and `config.json` still use
`data/sample.jsonl` and the original practice labels. The new dataset workflow
uses `train_disaster.py`, `config_disaster.json`, and the four labels in
`scripts/disaster_labels.py`, in this order:
`request`, `search_and_rescue`, `medical_help`, `floods`.
See [DATA_SOURCES.md](DATA_SOURCES.md) for attribution, licensing, cleaning and
limitations. These data are written messages, not emergency call transcripts.

## Environment setup

Run the following from the repository root on macOS/Linux with Python 3.11.
Reuse `ml/.venv` if it already exists; do not recreate your working environment.
For a new environment:

```sh
python3.11 -m venv ml/.venv
ml/.venv/bin/python -m pip install --upgrade pip
ml/.venv/bin/python -m pip install -r ml/requirements-disaster.txt
```

For an NVIDIA teammate, install the CUDA-enabled PyTorch wheel matching their
machine using the command from the [official PyTorch installation selector](https://pytorch.org/get-started/locally/),
using `ml/.venv/bin/python -m pip` in place of `pip`, then run the requirements
command above. Check CUDA before training:

```sh
ml/.venv/bin/python -c "import torch; print(torch.__version__); print('CUDA available:', torch.cuda.is_available())"
```

The requirements file pins the successfully checked direct library versions,
with a platform-selectable PyTorch wheel. It is not a Mac environment lockfile.
The initial tokenizer/base-model load requires Hugging Face access unless the
model is already cached. Saved-model evaluation and prediction use local files.

## Prepare the data

```sh
ml/.venv/bin/python ml/scripts/prepare_data.py
```

This reuses the raw downloads and writes `data/processed/train.jsonl`,
`validation.jsonl`, `test.jsonl`, and `preparation_report.json`. Manual download
links and certificate-error guidance are in [DATA_SOURCES.md](DATA_SOURCES.md).
Older preparations named the training file `training.jsonl`; the trainer uses
that file only if the configured default `train.jsonl` does not exist.
Preparation retains both flooding and non-flooding examples.

## CPU smoke test

```sh
ml/.venv/bin/python ml/scripts/train_disaster.py --smoke-test
```

This validates every train/validation record, then uses the first four training
records and first two validation records, with batch size 1 and maximum length
64 (or the configured length if smaller). It runs exactly two steps on CPU,
even if CUDA is configured. It saves under `outputs/disaster_smoke_test/`,
selects the checkpoint using validation macro F1, and independently reloads
for evaluation and prediction. `smoke_metrics.json` contains the tiny validation
check; `run_info.json` records settings, versions and selected checkpoint.
It never opens the test split. **These are pipeline checks, not accuracy evidence.**

Output directories must be empty or absent, to protect earlier models. To repeat
training or the smoke test, choose a new `output_dir` or `smoke_output_dir` in
`config_disaster.json`, or move the previous output directory elsewhere first.

You can also repeat just the reload checks without training again:

```sh
ml/.venv/bin/python ml/scripts/evaluate.py --model-dir outputs/disaster_smoke_test --data outputs/disaster_smoke_test/smoke_validation.jsonl --output outputs/disaster_smoke_test/reload_metrics.json --device cpu --batch-size 1
ml/.venv/bin/python ml/scripts/predict.py --model-dir outputs/disaster_smoke_test --text "We need medical help after the flood."
```

## Full training (teammate runs this)

Review `config_disaster.json` for paths, seed, token length, batch size, learning
rate, epochs and output directories. All configured paths and CLI data/model/
metrics paths resolve relative to `ml/`, or can be absolute. The script path in
these examples assumes the terminal is at the repository root.

On an NVIDIA CUDA machine:

```sh
ml/.venv/bin/python ml/scripts/train_disaster.py --config config_disaster.json --device cuda
```

CPU alternative (much slower for the full dataset):

```sh
ml/.venv/bin/python ml/scripts/train_disaster.py --config config_disaster.json --device cpu
```

CUDA requests fail clearly if unavailable. CPU mode explicitly avoids Mac MPS;
attention uses the eager implementation, without requiring Flash Attention.
Training uses float32 multilabel targets and binary cross-entropy with logits.
Validation runs after each epoch. The highest **validation macro F1** at fixed
sigmoid threshold 0.5 determines the best checkpoint, which is restored before
saving the model and tokenizer in `outputs/disaster_model/`. Label mappings,
maximum token length and threshold are saved in the model configuration.
Checkpoints remain under its `checkpoints/` directory. APIs use the installed
Transformers 4.57.6 `eval_strategy` and `processing_class` parameters; see the
[Transformers 4.57 Trainer documentation](https://huggingface.co/docs/transformers/v4.57.1/en/main_classes/trainer).

Only train and validation paths are configured for training; test data is never
loaded by the trainer. Do not put test data in either of those paths. If GPU
memory is insufficient, reduce `batch_size` or `max_length` in the config.

## Validation evaluation

```sh
ml/.venv/bin/python ml/scripts/evaluate.py --model-dir outputs/disaster_model --data data/processed/validation.jsonl --output outputs/disaster_model/validation_metrics.json --device cuda
```

Use `--device cpu` on a Mac or CPU machine. Evaluation reports per-label
precision, recall, F1 and positive support, plus micro and macro F1. Threshold
is fixed at 0.5; undefined precision/recall/F1 are explicitly zero. Macro F1
includes all four labels, including labels with zero support. Positive support
is the number of true positives in the dataset's annotations, regardless of
model predictions (not the true-positive confusion-matrix count).

## Final test evaluation

After settings and checkpoint selection are complete, run once for the final
held-out report:

```sh
ml/.venv/bin/python ml/scripts/evaluate.py --model-dir outputs/disaster_model --data data/processed/test.jsonl --output outputs/disaster_model/test_metrics.json --device cuda
```

Use `--device cpu` if needed. Do not use test metrics to tune thresholds,
hyperparameters or checkpoint selection. Evaluation does not update the model.

## Prediction

```sh
ml/.venv/bin/python ml/scripts/predict.py --model-dir outputs/disaster_model --text "We need medical help after the flood."
```

Prediction defaults to CPU; `--device cuda` is optional. It reads label names
from the saved model configuration and prints sigmoid **model scores**, which
are not calibrated probabilities, plus tags whose scores are at least 0.5.
An empty tag list is possible.

The original sample workflow still works:

```sh
ml/.venv/bin/python ml/scripts/check_data.py
ml/.venv/bin/python ml/scripts/train.py
ml/.venv/bin/python ml/scripts/predict.py --text "We are trapped upstairs and the water keeps rising."
```

Omitting `--model-dir` keeps the existing `outputs/smoke_test` practice model.
Those old labels are separate from the disaster dataset labels.

## Successful local checks

Python 3.11.9, PyTorch 2.14.1, Transformers 4.57.6, Datasets 5.0.1,
Accelerate 1.15.0, and scikit-learn 1.9.1 were used for the two-step CPU smoke
check and saved-model evaluation/prediction reloads. The exact Python version
and library versions for each new training run are recorded in `run_info.json`.
CUDA/full training and full validation/test evaluation have not been run here.
