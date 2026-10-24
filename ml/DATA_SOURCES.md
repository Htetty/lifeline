# Disaster Response Messages

Source: [Robert Munro's original repository](https://github.com/rmunro/disaster_response_messages).
The pipeline downloads only the three original CSVs from that repository's `main`
branch. Existing local CSVs are reused. To refresh, move the old raw CSVs aside
first. The branch can change; retain your raw files to reproduce a preparation run.

Attribution requested by the source:
Robert Munro. 2012. *Processing short message communications in low-resource
languages*. PhD dissertation, Stanford University. Stanford Digital Repository.
<https://purl.stanford.edu/cg721hb0673>.
Translations and annotations include work by Mission 4636 and Pakreport
participants; Joan Xiao helped remove sensitive and personally identifying data.

License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/),
as stated in the [source README](https://github.com/rmunro/disaster_response_messages#license)
and [LICENSE](https://github.com/rmunro/disaster_response_messages/blob/main/LICENSE).
When sharing adaptations, retain attribution, link the license, and indicate
changes. Our changes select four labels, convert CSV to JSONL, validate rows,
and remove duplicate/conflicting messages as described below.
The source asks that data not be combined to identify people and that any
remaining personally identifying messages be excluded and reported to the author.

## Label meanings and order

Each output `labels` list contains four integers in this exact order:

| Index | Source label | Source meaning (1=yes, 0=no) |
| --- | --- | --- |
| 0 | request | The message is a request for aid. |
| 1 | search_and_rescue | The message is about search and rescue. |
| 2 | medical_help | The message is about medical help. |
| 3 | floods | The message is related to flooding. |

These retain the source definitions. Medical help does not mean only medical
emergencies, and flooding does not imply that a person is trapped. These labels
are different from the labels in our existing practice sample and scripts.
No parent label is used to infer or change these four values. Missing, empty,
or nonbinary selected labels are reported and excluded, never filled with zero.
Both positive and negative examples for flooding are retained.

## Preparation and outputs

From the repository root, run:

```sh
ml/.venv/bin/python ml/scripts/prepare_data.py
```

No additional dependencies are needed (Python 3.11 standard library only).
Output files under `ml/data/processed/` are `train.jsonl`, `validation.jsonl`,
and `test.jsonl`. Each record has `source_id` (the original ID as a string),
`text` (the unchanged English `message` field), and `labels`.
The source training, validation and test assignments are preserved; rows are
never reassigned or randomly split. Source order is preserved within each split.
The training CSV's split column is `train` (the README calls it `training`);
the script validates this source spelling and writes `train.jsonl`.
The dataset trainer also accepts the older prepared `training.jsonl` filename
when the default `train.jsonl` is absent.

Invalid rows are excluded with their split, CSV ending line number, source ID
when available, and reason in `preparation_report.json`. Missing/duplicate headers,
unreadable CSVs, and empty resulting splits stop preparation clearly.
The report lists every duplicate removal and every member of each conflicting
group without copying message text. The terminal prints issue totals, input and
retained counts, and positive/negative counts for all four labels per split.

Duplicate comparison uses Unicode NFKC normalization, case folding, and collapsed
whitespace. Punctuation is preserved; this is not fuzzy matching. For equal label
vectors, keep the first test row, otherwise the first validation row, otherwise
the first training row. This handles duplicates both within and across splits.
If any selected label conflicts within a normalized-text group, exclude the
entire group, including any test rows, and flag all labels in the report. No
annotation is chosen arbitrarily. Raw CSVs are never edited.

Downloaded raw data, processed data, and the report are ignored by Git. The
existing `sample.jsonl`, configuration, and practice scripts are unchanged.
They still use their practice labels; this preparation step does not connect
the new dataset to training or start model training.

## Manual download if network access fails

Create `ml/data/raw/` and save these links there using the exact filenames:

- [disaster_response_training.csv](https://raw.githubusercontent.com/rmunro/disaster_response_messages/main/disaster_response_training.csv)
- [disaster_response_validation.csv](https://raw.githubusercontent.com/rmunro/disaster_response_messages/main/disaster_response_validation.csv)
- [disaster_response_test.csv](https://raw.githubusercontent.com/rmunro/disaster_response_messages/main/disaster_response_test.csv)

Use the raw CSV content, not the GitHub HTML page. Rerun the command above;
downloaded files are reused. Failed downloads use a temporary `.part` file so
an interrupted download is not treated as a complete CSV.
If Python reports `CERTIFICATE_VERIFY_FAILED`, downloading these same links in
your browser or with `curl --fail --location URL -o DESTINATION` is an alternative;
do not disable certificate verification.

## Limitations

These are **written messages, not emergency call transcripts**: SMS messages,
online message-board posts, and news headlines. Non-English messages use the
English translation, which can include summaries or translator exposition.
Performance on these data does not establish performance on spoken calls,
speech-recognition errors, current emergencies, or other locations/languages.
The historical events and annotation practices can introduce domain differences
and biases. Source annotations are retained without claiming they are perfect.
