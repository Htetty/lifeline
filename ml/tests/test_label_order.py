"""Metadata checks only: no training, model weights or predictions."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from disaster_common import check_dataset_label_order
from disaster_labels import LABELS


class LabelOrderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / 'train.jsonl'
        self.metadata = self.data.parent / 'preparation_report.json'
        self.model = SimpleNamespace(num_labels=4, id2label=dict(enumerate(LABELS)),
                                     label2id={label: i for i, label in enumerate(LABELS)})

    def declare(self, labels):
        self.metadata.write_text(json.dumps({'label_order': labels}), encoding='utf-8')

    def test_matching_order_passes(self):
        self.declare(list(LABELS))
        self.assertEqual(check_dataset_label_order(self.data, model_config=self.model), self.metadata)

    def test_mismatched_dataset_order_fails(self):
        self.declare(list(reversed(LABELS)))
        with self.assertRaisesRegex(ValueError, 'Dataset label order mismatch'):
            check_dataset_label_order(self.data)

    def test_mismatched_model_order_fails(self):
        self.declare(list(LABELS))
        self.model.id2label = dict(enumerate(reversed(LABELS)))
        with self.assertRaisesRegex(ValueError, 'Dataset/model label order mismatch'):
            check_dataset_label_order(self.data, model_config=self.model)

    def test_missing_metadata_fails(self):
        with self.assertRaisesRegex(ValueError, 'missing or unreadable dataset metadata'):
            check_dataset_label_order(self.data)

    def test_missing_declaration_fails(self):
        self.metadata.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'label_order declaration is required'):
            check_dataset_label_order(self.data)


if __name__ == '__main__':
    unittest.main(verbosity=2)
