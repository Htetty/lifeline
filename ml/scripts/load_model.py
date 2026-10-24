import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification

MODEL_NAME = "answerdotai/ModernBERT-base"

LABELS = [
    "trapped_in_building",
    "stranded_in_vehicle",
    "water_rising",
    "mobility_assistance_needed",
]

print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

print("Loading ModernBERT...")
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL_NAME,
    num_labels=len(LABELS),
    problem_type="multi_label_classification",
    id2label=dict(enumerate(LABELS)),
    label2id={label: index for index, label in enumerate(LABELS)},
    attn_implementation="eager",
)

# Use the CPU for this initial compatibility check.
model.to("cpu")
model.eval()

text = "We are trapped upstairs and the water keeps rising."

inputs = tokenizer(
    text,
    return_tensors="pt",
    truncation=True,
    max_length=256,
)

with torch.no_grad():
    outputs = model(**inputs)

print("Success: model loaded and processed a transcript.")
print("Output shape:", tuple(outputs.logits.shape))
print("These outputs are not useful predictions until fine-tuning.")