import json
from pathlib import Path

LABELS = [
    "trapped_in_building",
    "stranded_in_vehicle",
    "water_rising",
    "mobility_assistance_needed",
]

# Locate the data relative to this script's location.
data_path = Path(__file__).resolve().parent.parent / "data" / "sample.jsonl"

seen_ids = set()
count = 0

with data_path.open(encoding="utf-8") as file:
    for line_number, line in enumerate(file, start=1):
        try:
            example = json.loads(line)

            scenario_id = example["scenario_id"]
            text = example["text"]
            labels = example["labels"]

            if not isinstance(scenario_id, str) or not scenario_id.strip():
                raise ValueError("scenario_id must be a nonempty string")

            if scenario_id in seen_ids:
                raise ValueError("duplicate scenario_id")

            if not isinstance(text, str) or not text.strip():
                raise ValueError("text must be a nonempty string")

            if not isinstance(labels, list) or len(labels) != len(LABELS):
                raise ValueError("labels must be a list of four numbers")

            if any(type(value) is not int or value not in (0, 1) for value in labels):
                raise ValueError("each label must be the integer 0 or 1")

            seen_ids.add(scenario_id)
            count += 1

        except (ValueError, KeyError, TypeError) as error:
            raise SystemExit(f"Error on line {line_number}: {error}")

if count == 0:
    raise SystemExit("Error: dataset is empty")

print(f"Success: checked {count} examples.")
print("Label order:", ", ".join(LABELS))