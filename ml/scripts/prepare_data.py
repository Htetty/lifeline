"""Download and prepare the original Disaster Response Messages splits.

Uses only the Python standard library. See ml/DATA_SOURCES.md for policies.
"""

import csv
import json
import shutil
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from disaster_labels import LABELS

ML_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = ML_DIR / "data" / "raw"
PROCESSED_DIR = ML_DIR / "data" / "processed"
BASE_URL = "https://raw.githubusercontent.com/rmunro/disaster_response_messages/main/"
# First occurrence in this order wins, unless any labels conflict.
PRIORITY = ("test", "validation", "training")


def normalized_text(text):
    """Ignore Unicode compatibility differences, case and whitespace only."""
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def download(split):
    filename = f"disaster_response_{split}.csv"
    path = RAW_DIR / filename
    if path.is_file():
        print(f"Reusing {path}")
        return path
    url = BASE_URL + filename
    temporary = path.with_suffix(".csv.part")
    print(f"Downloading {url}")
    try:
        with urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary.replace(path)
    except (OSError, URLError) as error:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(
            f"Download failed for {url}: {error}\n"
            f"Manually save that URL as {path}, then rerun this script.\n"
            "See ml/DATA_SOURCES.md for all three download links."
        ) from error
    return path


def read_split(path, split, issues):
    records = []
    counts = Counter()
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source, strict=True)
        header = next(reader, [])
        required = ("id", "split", "message", *LABELS)
        if len(header) != len(set(header)) or any(c not in header for c in required):
            raise ValueError(f"{path}: missing required or duplicate columns; expected {required}")
        for values in reader:
            counts["input"] += 1
            location = {"split": split, "line": reader.line_num}
            if len(values) != len(header):
                reason = "empty row" if not values else "wrong number of CSV fields"
            else:
                row = dict(zip(header, values))
                location["source_id"] = row["id"]
                errors = []
                if not row["id"].strip():
                    errors.append("empty id")
                # The upstream training CSV says 'train', unlike the README.
                expected_split = "train" if split == "training" else split
                if row["split"] != expected_split:
                    errors.append(f"split is {row['split']!r}, expected {expected_split!r}")
                if not normalized_text(row["message"]):
                    errors.append("empty message")
                for label in LABELS:
                    if row[label] not in ("0", "1"):
                        errors.append(f"{label} must be 0 or 1, got {row[label]!r}")
                reason = "; ".join(errors)
            if reason:
                counts["invalid"] += 1
                issues.append({"kind": "invalid_row", **location, "reason": reason})
                continue
            records.append((location, {
                "source_id": row["id"],
                "text": row["message"],
                "labels": [int(row[label]) for label in LABELS],
            }))
    return records, counts


def deduplicate(splits, issues):
    groups = defaultdict(list)
    for split in PRIORITY:
        for location, record in splits[split]:
            groups[normalized_text(record["text"])].append((location, record))
    kept = {split: [] for split in PRIORITY}
    for group in groups.values():
        conflicting = len({tuple(record["labels"]) for _, record in group}) > 1
        if conflicting:
            issues.append({
                "kind": "conflicting_labels",
                "action": "removed entire normalized-text group",
                "rows": [{**loc, "labels": rec["labels"]} for loc, rec in group],
            })
            continue
        location, record = group[0]
        kept[location["split"]].append(record)
        for removed, _ in group[1:]:
            issues.append({"kind": "duplicate_removed", "removed": removed, "kept": location})
    return kept


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    issues = []
    splits, counts = {}, {}
    # Read and validate every split before replacing any processed output.
    for split in PRIORITY:
        splits[split], counts[split] = read_split(download(split), split, issues)
    kept = deduplicate(splits, issues)
    if any(not records for records in kept.values()):
        raise ValueError("A split has no valid records after cleaning; no outputs written")
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    for split in ("training", "validation", "test"):
        records = kept[split]
        filename = "train" if split == "training" else split
        path = PROCESSED_DIR / f"{filename}.jsonl"
        with path.open("w", encoding="utf-8") as output:
            for record in records:
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"\n{split}: input={counts[split]['input']}, invalid={counts[split]['invalid']}, "
              f"duplicate/conflict removals={len(splits[split]) - len(records)}, kept={len(records)}")
        for index, label in enumerate(LABELS):
            positives = sum(record["labels"][index] for record in records)
            print(f"  {label}: positive={positives}, negative={len(records) - positives}")
    report = PROCESSED_DIR / "preparation_report.json"
    report.write_text(json.dumps({
        "label_order": LABELS,
        "input_counts": counts,
        "issue_counts": dict(Counter(issue["kind"] for issue in issues)),
        "issues": issues,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"\nIssues: {dict(Counter(issue['kind'] for issue in issues))}")
    print(f"Every invalid row, duplicate removal and conflicting group is listed in {report}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, csv.Error) as error:
        sys.exit(f"Preparation failed: {error}")
