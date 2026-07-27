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

# Keep roughly one signal-history point per this many seconds instead of every
# one. SignalV2Engine backfills history to 1-second resolution (interpolating
# between each pair of 30s-apart observations), so an uncapped flight tracked
# for the whole run can carry ~1,800 points -- this bounds that.
HISTORY_DOWNSAMPLE_SECONDS = 10.0

# Safety ceiling for the published file. GitHub rejects any single file over
# 100MB outright, but a static site should never ship anywhere near that to
# every visitor's browser -- this is a last-resort valve, not the target size.
MAX_OUTPUT_BYTES = 20 * 1024 * 1024


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


def _strip_track(snapshot: dict) -> dict:
    """Drop each flight's cumulative `track` array before storing a snapshot.

    tracker.snapshot() embeds a flight's *entire* history-so-far in `track`.
    Storing that in every one of the ~60 snapshots collected per run makes the
    output grow quadratically with run length -- a real 30-minute run hit
    225MB this way. The frontend rebuilds a short trail client-side from
    consecutive snapshots' `current` positions instead, so `track` isn't
    needed in the published batch.
    """
    trimmed = dict(snapshot)
    trimmed["flights"] = [
        {key: value for key, value in flight.items() if key != "track"}
        for flight in snapshot.get("flights", [])
    ]
    return trimmed


def _downsample_points(points: list, interval_seconds: float) -> list:
    """Keep roughly one point per interval_seconds instead of every one."""
    if interval_seconds <= 0 or len(points) <= 2:
        return points
    kept = [points[0]]
    next_keep_at = float(points[0].get("timestamp") or 0) + interval_seconds
    for point in points[1:-1]:
        timestamp = point.get("timestamp")
        if timestamp is None or float(timestamp) >= next_keep_at:
            kept.append(point)
            next_keep_at = float(timestamp or next_keep_at) + interval_seconds
    kept.append(points[-1])
    return kept


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
            snapshots.append(_strip_track(tracker.snapshot()))
    finally:
        if poller:
            poller.stop()
        tracker.close()

    active_icao24 = sorted({flight["icao24"] for flight in snapshots[-1]["flights"]}) if snapshots else []
    signal_histories = {}
    for icao24 in active_icao24:
        history = tracker.signal_history(icao24)
        if history is None:
            continue
        history = dict(history)
        history["points"] = _downsample_points(history.get("points", []), HISTORY_DOWNSAMPLE_SECONDS)
        signal_histories[icao24] = history

    return {
        "batch_generated_at": time.time(),
        "interval_seconds": interval,
        "snapshots": snapshots,
        "signal_histories": signal_histories,
    }


def _serialize_with_size_limit(batch: dict) -> str:
    """Serialize the batch, progressively dropping the heaviest optional data
    if it's still over MAX_OUTPUT_BYTES, so an unexpected traffic spike
    degrades the payload instead of failing the workflow's commit/push."""
    body = json.dumps(batch, separators=(",", ":"), allow_nan=False)
    if len(body.encode("utf-8")) <= MAX_OUTPUT_BYTES:
        return body

    print(
        f"Warning: batch is {len(body.encode('utf-8'))} bytes, over the "
        f"{MAX_OUTPUT_BYTES}-byte safety ceiling -- dropping signal_histories."
    )
    trimmed = dict(batch)
    trimmed["signal_histories"] = {}
    body = json.dumps(trimmed, separators=(",", ":"), allow_nan=False)
    if len(body.encode("utf-8")) <= MAX_OUTPUT_BYTES:
        return body

    print(
        f"Warning: still {len(body.encode('utf-8'))} bytes after dropping "
        "signal_histories -- also dropping predicted_timeline from every snapshot."
    )
    trimmed["snapshots"] = [
        {
            **snapshot,
            "flights": [
                {
                    **flight,
                    "signal_v2": {**flight["signal_v2"], "predicted_timeline": []},
                }
                if flight.get("signal_v2")
                else flight
                for flight in snapshot.get("flights", [])
            ],
        }
        for snapshot in trimmed["snapshots"]
    ]
    return json.dumps(trimmed, separators=(",", ":"), allow_nan=False)


def main() -> int:
    args = parse_args()
    batch = collect_batch(args.credentials.resolve(), args.count, args.interval)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    body = _serialize_with_size_limit(batch)
    args.output.write_text(body, encoding="utf-8")
    print(f"Wrote {len(batch['snapshots'])} snapshots to {args.output} ({len(body.encode('utf-8'))} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
