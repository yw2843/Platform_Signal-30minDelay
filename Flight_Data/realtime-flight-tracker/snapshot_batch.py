"""One-shot batch collector for the GitHub Pages deployment.

GitHub Pages cannot run the persistent tracker in server.py, so this script is
invoked instead by a scheduled GitHub Actions workflow. It reuses the exact
same FlightTracker/OpenSkyClient/PollingService/SignalV2Engine pipeline as the
live local server, but instead of answering HTTP requests forever, it takes a
fixed number of tracker.snapshot() readings spaced by the same 30-second
cadence as PollingService, then writes them all to one JSON file and exits.

GitHub's own `schedule` cron trigger does not reliably fire every few
minutes (observed delays of 20+ minutes on this repo), so the workflow asks
for a run every 25 minutes but each run collects a full 30-minute window of
snapshots. The frontend always displays what happened 30 minutes ago and
ticks forward with the wall clock, so as long as a fresh 30-minute batch
lands within any 30-minute gap between runs, playback never runs dry.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from backend import POLL_INTERVAL_SECONDS, FlightTracker, OpenSkyClient, OpenSkyError, PollingService
from v2_signal import OpenMapTilesBuildingProvider

APP_DIR = Path(__file__).resolve().parent
FLIGHT_DATA_DIR = APP_DIR.parent
PROJECT_ROOT = FLIGHT_DATA_DIR.parent
DEFAULT_CREDENTIALS = FLIGHT_DATA_DIR / "credentials.json"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "flights-timeline.json"
DEFAULT_SNAPSHOT_COUNT = 60


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect a batch of flight-tracker snapshots for static publishing")
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--count",
        type=int,
        default=DEFAULT_SNAPSHOT_COUNT,
        help="Number of snapshots to record (default: 60, i.e. ~30 minutes at the default 30s interval)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=float(POLL_INTERVAL_SECONDS),
        help="Seconds between snapshots (default: matches PollingService's own 30s cadence)",
    )
    return parser.parse_args()


def collect_batch(credentials_path: Path, count: int, interval: float) -> dict:
    tracker = FlightTracker(building_provider=OpenMapTilesBuildingProvider(), asynchronous_signal=True)
    poller: PollingService | None = None
    try:
        try:
            client = OpenSkyClient(credentials_path)
        except OpenSkyError as exc:
            tracker.update_service_status(state="error", message=str(exc))
        else:
            poller = PollingService(tracker, client)
            poller.start()

        snapshots = []
        for _ in range(count):
            time.sleep(interval)
            snapshots.append(tracker.snapshot())
    finally:
        if poller:
            poller.stop()
        tracker.close()

    active_icao24 = sorted({flight["icao24"] for flight in snapshots[-1]["flights"]}) if snapshots else []
    signal_histories = {
        icao24: history
        for icao24, history in (
            (icao24, tracker.signal_history(icao24)) for icao24 in active_icao24
        )
        if history is not None
    }

    return {
        "batch_generated_at": time.time(),
        "interval_seconds": interval,
        "snapshots": snapshots,
        "signal_histories": signal_histories,
    }


def main() -> int:
    args = parse_args()
    batch = collect_batch(args.credentials.resolve(), args.count, args.interval)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(batch, separators=(",", ":"), allow_nan=False)
    args.output.write_text(body, encoding="utf-8")
    print(f"Wrote {len(batch['snapshots'])} snapshots to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
