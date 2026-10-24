"""Atomic storage boundary for the Convex adapter; no provider or HTTP code."""

from copy import deepcopy
from threading import RLock
from typing import Protocol

CallKey = tuple[str, str]  # trusted Cartesia agent scope, verified Cartesia call ID


class StoreConflict(Exception):
    pass


class ReportStore(Protocol):
    def current(self, key: CallKey) -> dict | None: ...

    def history(self, key: CallKey) -> list[dict]: ...

    def receipt(self, key: CallKey, operation_id: str, fingerprint: str) -> dict | None: ...

    def apply(
        self, key: CallKey, operation_id: str, fingerprint: str,
        expected_version: int, snapshot: dict,
    ) -> dict: ...


class MemoryReportStore:
    """Single-process development only. All snapshots and receipts survive until restart."""

    def __init__(self):
        self._lock = RLock()
        self._snapshots: dict[CallKey, list[dict]] = {}
        self._receipts: dict[tuple[CallKey, str], tuple[str, dict]] = {}

    def current(self, key):
        with self._lock:
            history = self._snapshots.get(key, [])
            return deepcopy(history[-1]) if history else None

    def history(self, key):
        with self._lock:
            return deepcopy(self._snapshots.get(key, []))

    def receipt(self, key, operation_id, fingerprint):
        with self._lock:
            saved = self._receipts.get((key, operation_id))
            if saved is None:
                return None
            if saved[0] != fingerprint:
                raise StoreConflict("operation_id was already used for a different request")
            return deepcopy(saved[1])

    def apply(self, key, operation_id, fingerprint, expected_version, snapshot):
        with self._lock:
            previous_result = self.receipt(key, operation_id, fingerprint)
            if previous_result is not None:
                return previous_result
            previous = self.current(key)
            version = previous['version'] if previous else 0
            if expected_version != version:
                raise StoreConflict("stale expected_version; read report context and reconcile")
            if snapshot != previous:
                if snapshot['version'] != version + 1:
                    raise StoreConflict('new snapshot must increment version by exactly one')
                self._snapshots.setdefault(key, []).append(deepcopy(snapshot))
            result = {
                'report_id': snapshot['report_id'], 'version': snapshot['version'],
                'review_status': snapshot['review_status'], 'storage': 'memory',
            }
            self._receipts[(key, operation_id)] = (fingerprint, deepcopy(result))
            return result
