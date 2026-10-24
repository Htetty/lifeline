#!/usr/bin/env python3
"""Run isolated demo checks. Never loads project .env files or calls a deployment.

Existing dependencies are required; this script never installs them. Build/type
generation happens in a temporary dashboard copy, not production source files.
"""

import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]


def dashboard_checks(dependencies):
    """Return all check results, even when one fails; no .env files are copied."""
    with tempfile.TemporaryDirectory(prefix="lifeline-demo-build-") as directory:
        target = Path(directory) / "dashboard"
        target.mkdir()
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z", "--", "dashboard"], cwd=ROOT,
        ).decode().split("\0")
        for relative in filter(None, tracked):
            source = ROOT / relative
            if source.name.startswith(".env"):
                continue
            destination = Path(directory) / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        (target / "node_modules").symlink_to(dependencies, target_is_directory=True)
        # postinstall normally copies this worker. Reproduce that artifact in
        # the disposable copy without installing or editing the real dashboard.
        shutil.copy2(dependencies / "maplibre-gl/dist/maplibre-gl-worker.mjs", target / "public/maplibre-gl-worker.mjs")
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("CONVEX_", "NEXT_PUBLIC_", "ANTHROPIC_", "CARTESIA_"))
            and key not in {"BACKEND_SECRET", "VOICE_BRIDGE_TOKEN"}
        }
        environment.update(NEXT_PUBLIC_CONVEX_URL="http://127.0.0.1:9", NEXT_TELEMETRY_DISABLED="1", CI="1")
        commands = [
            ("dashboard route-type generation", ["node", str(dependencies / "next/dist/bin/next"), "typegen"]),
            ("dashboard TypeScript", ["node", str(dependencies / "typescript/bin/tsc"), "--noEmit", "--incremental", "false"]),
            # Webpack keeps the build inside the disposable copy when reused
            # node_modules is a symlink outside Turbopack's project root.
            ("dashboard production build (webpack)", ["node", str(dependencies / "next/dist/bin/next"), "build", "--webpack"]),
        ]
        results = []
        for label, command in commands:
            print(f"\nRUN {label} (temporary source copy; placeholder Convex URL)", flush=True)
            try:
                result = subprocess.run(command, cwd=target, env=environment, timeout=240)
                results.append((label, result.returncode == 0))
            except subprocess.TimeoutExpired:
                print(f"FAIL {label}: exceeded 240 seconds", flush=True)
                results.append((label, False))
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dashboard", action="store_true", help="also typecheck/build a disposable dashboard copy")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--strict", action="store_true", help="fail if any known application gap remains")
    modes.add_argument("--walkthrough", action="store_true", help="only print an explicitly mocked text demo")
    args = parser.parse_args()
    dependencies = Path(os.environ.get("LIFELINE_DASHBOARD_NODE_MODULES", ROOT / "dashboard/node_modules")).resolve()
    if not shutil.which("node") or not (dependencies / "typescript").is_dir():
        parser.error("Node and existing dashboard dependencies are required. See docs/demo-runbook.md; nothing was installed.")
    for name in ("fastapi", "httpx", "convex", "anthropic", "dotenv"):
        if importlib.util.find_spec(name) is None:
            parser.error(f"Missing existing backend dependency: {name}. Use the backend virtualenv; nothing was installed.")
    os.environ["LIFELINE_DASHBOARD_NODE_MODULES"] = str(dependencies)
    if args.walkthrough:
        os.environ["LIFELINE_DEMO_TRACE"] = "1"
    suite = unittest.defaultTestLoader.discover(
        str(ROOT / "tests/integration"), pattern="test_demo_flow.py",
    )
    if args.walkthrough:
        selected = unittest.TestSuite()
        for group in suite:
            for cases in group:
                for case in cases:
                    if case._testMethodName == "test_mocked_demo_walkthrough":
                        selected.addTest(case)
        suite = selected
    if not suite.countTestCases():
        parser.error("No integration tests discovered; refusing to report a successful validation.")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    build_results = dashboard_checks(dependencies) if args.dashboard else []
    print("\nAutomated only: no microphone, STT/TTS, audio interruption, live Claude, or deployed Convex verification.")
    if result.expectedFailures:
        print(f"KNOWN APPLICATION GAPS: {len(result.expectedFailures)} (expected failures are NOT acceptance passes)")
        for test, _traceback in result.expectedFailures:
            print(f"  {test.id()}")
    for label, passed in build_results:
        print(f"{'PASS' if passed else 'FAIL'} {label}")
    if not result.wasSuccessful() or any(not passed for _label, passed in build_results):
        return 1
    if args.strict and result.expectedFailures:
        print("FAIL strict demo gate: application gaps remain. Relay reproduction steps to the bridge owner.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
