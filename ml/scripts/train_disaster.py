"""Train ModernBERT on train/validation only; optionally run a CPU pipeline check."""
import argparse
import gc
import json
import platform
from importlib.metadata import version

import torch
from transformers import (AutoModelForSequenceClassification, AutoTokenizer,
                          DataCollatorWithPadding, Trainer, TrainingArguments, set_seed)

from disaster_common import (LABELS, metrics_from_logits, ml_path, read_records,
                             select_device, tokenize_records, write_json)
from prepare_data import normalized_text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config_disaster.json")
    parser.add_argument("--device", choices=("cpu", "cuda"))
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args()
    config = json.loads(ml_path(args.config).read_text(encoding="utf-8"))
    device = "cpu" if args.smoke_test else (args.device or config["device"])
    select_device(device)
    for name in ("max_length", "batch_size", "epochs", "learning_rate"):
        if config[name] <= 0:
            raise ValueError(f"{name} must be positive")
    train_path = ml_path(config["train_file"])
    if not train_path.exists() and train_path == ml_path("data/processed/train.jsonl"):
        train_path = ml_path("data/processed/training.jsonl")
        print(f"Using legacy prepared filename: {train_path}")
    validation_path = ml_path(config["validation_file"])
    # Guard accidental standard test-file configuration without opening test data.
    if any(p.name == "test.jsonl" for p in (train_path, validation_path)):
        raise ValueError("Test split must never be configured as train or validation")
    train_rows, validation_rows = read_records(train_path), read_records(validation_path)
    train_text = {normalized_text(row["text"]) for row in train_rows}
    if train_text.intersection(normalized_text(row["text"]) for row in validation_rows):
        raise ValueError("Train/validation normalized text overlap: rerun preparation")
    if {r["source_id"] for r in train_rows} & {r["source_id"] for r in validation_rows}:
        raise ValueError("Train/validation source ID overlap")
    print(f"Validated all {len(train_rows)} train and {len(validation_rows)} validation records. Test data was not loaded.")
    output = ml_path(config["smoke_output_dir"] if args.smoke_test else config["output_dir"])
    if output == ml_path(config["output_dir"]) and args.smoke_test:
        raise ValueError("Smoke output must differ from full training output")
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output directory is not empty: {output}. Choose a new output directory in the config.")
    max_length = min(config["max_length"], 64) if args.smoke_test else config["max_length"]
    batch_size = 1 if args.smoke_test else config["batch_size"]
    set_seed(config["seed"])
    if args.smoke_test:
        print("PIPELINE CHECK ONLY: two CPU steps, not accuracy evidence.")
        torch.set_num_threads(min(4, torch.get_num_threads()))
        train_rows, validation_rows = train_rows[:4], validation_rows[:2]
    tokenizer = AutoTokenizer.from_pretrained(config["model_name"])
    train_data = tokenize_records(train_rows, tokenizer, max_length)
    validation_data = tokenize_records(validation_rows, tokenizer, max_length)
    model = AutoModelForSequenceClassification.from_pretrained(
        config["model_name"], num_labels=len(LABELS), problem_type="multi_label_classification",
        id2label=dict(enumerate(LABELS)), label2id={label: i for i, label in enumerate(LABELS)},
        attn_implementation="eager",
    )
    model.config.dataset_max_length = max_length
    model.config.pipeline_check = args.smoke_test
    model.config.decision_threshold = 0.5
    def compute_metrics(prediction):
        metrics = metrics_from_logits(prediction.predictions, prediction.label_ids)
        return {name: metrics[name] for name in ("micro_f1", "macro_f1")}
    strategy = "steps" if args.smoke_test else "epoch"
    training_args = TrainingArguments(
        output_dir=str(output / "checkpoints"), use_cpu=device == "cpu",
        seed=config["seed"], data_seed=config["seed"],
        per_device_train_batch_size=batch_size, per_device_eval_batch_size=batch_size,
        num_train_epochs=config["epochs"], max_steps=2 if args.smoke_test else -1,
        learning_rate=config["learning_rate"], eval_strategy=strategy, save_strategy=strategy,
        eval_steps=2 if args.smoke_test else None, save_steps=2 if args.smoke_test else 500,
        load_best_model_at_end=True, metric_for_best_model="macro_f1", greater_is_better=True,
        save_total_limit=1, logging_steps=1 if args.smoke_test else 100,
        report_to="none", dataloader_pin_memory=device == "cuda", optim="adamw_torch",
    )
    trainer = Trainer(model=model, args=training_args, train_dataset=train_data,
                      eval_dataset=validation_data, processing_class=tokenizer,
                      data_collator=DataCollatorWithPadding(tokenizer), compute_metrics=compute_metrics)
    trainer.train()
    trainer.save_model(str(output))
    tokenizer.save_pretrained(output)
    write_json(output / "run_info.json", {
        "config": config, "device": device, "pipeline_check": args.smoke_test,
        "effective_max_length": max_length, "effective_batch_size": batch_size,
        "train_records": len(train_rows), "validation_records": len(validation_rows),
        "train_path": str(train_path), "validation_path": str(validation_path),
        "best_checkpoint": trainer.state.best_model_checkpoint,
        "best_validation_macro_f1": trainer.state.best_metric,
        "python": platform.python_version(),
        "versions": {name: version(name) for name in
                     ("torch", "transformers", "datasets", "accelerate", "scikit-learn")},
    })
    if args.smoke_test:
        subset = output / "smoke_validation.jsonl"
        subset.write_text("".join(json.dumps(row) + "\n" for row in validation_rows), encoding="utf-8")
        # Free training optimizer/model memory before independent reloads.
        del trainer, model
        gc.collect()
        from evaluate import evaluate
        from predict import predict
        metrics = evaluate(output, subset, output / "smoke_metrics.json", batch_size=1)
        assert metrics["records"] == len(validation_rows)
        prediction = predict(output, validation_rows[0]["text"])
        assert tuple(prediction["model_scores"]) == LABELS
        print("Smoke training, best-model save, evaluation reload and prediction reload passed. Not accuracy evidence.")
    print(f"Saved best model and tokenizer: {output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(f"Training failed: {error}")
