import json
from pathlib import Path

from datasets import Dataset, Sequence, Value
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    Trainer,
    TrainingArguments,
    set_seed,
)

# Keep the label order consistent with your dataset.
LABELS = [
    "trapped_in_building",
    "stranded_in_vehicle",
    "water_rising",
    "mobility_assistance_needed",
]

# Load settings from the shared configuration file.
ML_DIR = Path(__file__).resolve().parent.parent

with (ML_DIR / "config.json").open(encoding="utf-8") as file:
    config = json.load(file)

MODEL_NAME = config["model_name"]
DATA_PATH = ML_DIR / config["data_file"]
OUTPUT_DIR = ML_DIR / config["output_dir"]

set_seed(42)

# 1. Read the practice examples.
print("Loading sample data...")

with DATA_PATH.open(encoding="utf-8") as file:
    examples = [json.loads(line) for line in file]

dataset = Dataset.from_list(examples)

# 2. Convert text into model inputs.
print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)


def tokenize_examples(batch):
    inputs = tokenizer(
        batch["text"],
        truncation=True,
        max_length=config["max_length"],
    )

    # Multi-label training requires floating-point labels.
    inputs["labels"] = [
        [float(value) for value in labels]
        for labels in batch["labels"]
    ]

    return inputs


tokenized_data = dataset.map(
    tokenize_examples,
    batched=True,
    remove_columns=dataset.column_names,
)

# Explicitly keep labels as float32 tensors.
tokenized_data = tokenized_data.cast_column(
    "labels",
    Sequence(Value("float32")),
)
tokenized_data.set_format("torch")

# 3. Load the pretrained model with our new classifier.
print("Loading model...")
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL_NAME,
    num_labels=len(LABELS),
    problem_type="multi_label_classification",
    id2label=dict(enumerate(LABELS)),
    label2id={label: index for index, label in enumerate(LABELS)},
    attn_implementation="eager",
)

# 4. Configure a tiny CPU training check.
training_args = TrainingArguments(
    output_dir=str(OUTPUT_DIR),
    use_cpu=config["use_cpu"],
    per_device_train_batch_size=config["batch_size"],
    max_steps=config["max_steps"],
    learning_rate=config["learning_rate"],
    logging_steps=1,
    save_strategy="no",
    report_to="none",
    dataloader_pin_memory=False,
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized_data,
    data_collator=DataCollatorWithPadding(tokenizer=tokenizer),
)

# 5. Train briefly, then save the model and tokenizer.
print(f"Starting {config['max_steps']} training steps...")
trainer.train()

trainer.save_model(str(OUTPUT_DIR))
tokenizer.save_pretrained(str(OUTPUT_DIR))

print(f"Success: practice model saved to {OUTPUT_DIR}")
print("This checks the pipeline; it is not an evaluated flood classifier.")