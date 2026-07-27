from __future__ import annotations

import json
import math
import csv
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from v2_signal import NoBuildingProvider, SignalV2Engine


LGA_LAT = 40.77724222
LGA_LON = -73.87260555

# 24.9 square degrees: deliberately below OpenSky's published 25 sq-degree
# one-credit boundary to avoid ambiguity at the exact tier edge.
COLLECTION_BBOX = {
    "lamin": 38.6061,
    "lomin": -76.7397,
    "lamax": 42.9484,
    "lomax": -71.0055,
}
CLASSIFICATION_RADIUS_NM = 40.0
POLL_INTERVAL_SECONDS = 30
TRACK_RETENTION_SECONDS = 60 * 60
ACTIVE_TIMEOUT_SECONDS = 90
VERTICAL_TOLERANCE_FPM = 200.0
RADIAL_TREND_TOLERANCE_NM = 0.05
OBSERVATIONS_TO_CLASSIFY = 3

TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
STATES_URL = "https://opensky-network.org/api/states/all"
RULES_PATH = Path(__file__).resolve().parent.parent / "Rule" / "FrequencyMatching" / "lga_frequency_rules.csv"


def load_frequency_rules(path: Path = RULES_PATH) -> dict[str, dict[str, Any]]:
    numeric_fields = {
        "priority",
        "frequency_mhz",
        "min_distance_nm",
        "max_distance_nm",
        "min_altitude_ft",
        "max_altitude_ft",
        "max_ground_speed_kt",
    }
    rules: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for source in csv.DictReader(handle):
            rule: dict[str, Any] = dict(source)
            for field_name in numeric_fields:
                value = rule.get(field_name)
                rule[field_name] = float(value) if value not in {None, ""} else None
            rules[str(rule["rule_id"])] = rule
    required = {"LGA_GROUND", "LGA_ARR_FINAL", "LGA_DEP_INITIAL", "LGA_ARR_APPROACH", "LGA_DEP_CLIMB"}
    missing = required.difference(rules)
    if missing:
        raise RuntimeError(f"Frequency rules are missing required IDs: {', '.join(sorted(missing))}")
    return rules


FREQUENCY_RULES = load_frequency_rules()


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_nm = 3440.065
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius_nm * math.asin(math.sqrt(a))


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _safe_index(values: list[Any], index: int) -> Any:
    return values[index] if index < len(values) else None


@dataclass
class AircraftRecord:
    icao24: str
    history: deque[dict[str, Any]] = field(default_factory=deque)
    status: str = "unknown"
    direction: str = "unknown"
    arrival_streak: int = 0
    departure_streak: int = 0
    seen_ground_anchor: bool = False
    seen_initial_departure_zone: bool = False
    last_seen: float = 0.0


@dataclass(frozen=True)
class SignalJob:
    icao24: str
    observation: dict[str, Any]
    direction: str
    status: str


class FlightTracker:
    def __init__(
        self,
        building_provider: NoBuildingProvider | None = None,
        asynchronous_signal: bool = False,
    ) -> None:
        self._lock = threading.RLock()
        self._records: dict[str, AircraftRecord] = {}
        self._signal_v2 = SignalV2Engine(building_provider)
        self._asynchronous_signal = asynchronous_signal
        self._signal_cache_lock = threading.RLock()
        self._signal_snapshots: dict[str, dict[str, Any]] = {}
        self._signal_histories: dict[str, dict[str, Any]] = {}
        self._signal_condition = threading.Condition()
        self._pending_signal_jobs: dict[str, SignalJob] = {}
        self._signal_active_ids: set[str] = set()
        self._signal_stopping = False
        self._signal_thread: threading.Thread | None = None
        self._source_time: int | None = None
        self._service_status: dict[str, Any] = {
            "state": "starting",
            "message": "Waiting for the first OpenSky response",
            "last_poll_at": None,
            "next_poll_at": None,
            "remaining_credits": None,
            "signal_state": "starting" if asynchronous_signal else "synchronous",
            "signal_message": (
                "Waiting for eligible OpenSky observations" if asynchronous_signal else None
            ),
        }
        if self._asynchronous_signal:
            self._signal_thread = threading.Thread(
                target=self._run_signal_worker,
                name="signal-v2-worker",
                daemon=True,
            )
            self._signal_thread.start()

    def update_service_status(self, **values: Any) -> None:
        with self._lock:
            self._service_status.update(values)

    def ingest(self, payload: dict[str, Any], received_at: float | None = None) -> None:
        received_at = received_at or time.time()
        source_time = int(payload.get("time") or received_at)
        states = payload.get("states") or []

        signal_jobs: list[SignalJob] = []
        with self._lock:
            self._source_time = source_time
            for state in states:
                if not isinstance(state, list):
                    continue
                signal_job = self._ingest_state(state, source_time, received_at)
                if signal_job is not None:
                    signal_jobs.append(signal_job)
            self._expire_old_records(received_at)
            active_ids = set(self._records)

        if self._asynchronous_signal:
            self._enqueue_signal_jobs(signal_jobs, active_ids)
        else:
            for job in signal_jobs:
                self._process_signal_job(job, publish_cache=False)

    def _ingest_state(
        self,
        state: list[Any],
        source_time: int,
        received_at: float,
    ) -> SignalJob | None:
        icao24 = str(_safe_index(state, 0) or "").strip().lower()
        latitude = _number(_safe_index(state, 6))
        longitude = _number(_safe_index(state, 5))
        if not icao24 or latitude is None or longitude is None:
            return

        time_position = _number(_safe_index(state, 3))
        last_contact = _number(_safe_index(state, 4))
        observed_at = float(time_position or last_contact or source_time)
        if source_time - observed_at > 90:
            return

        record = self._records.setdefault(icao24, AircraftRecord(icao24=icao24))
        previous = record.history[-1] if record.history else None
        if previous and observed_at <= previous["timestamp"]:
            record.last_seen = received_at
            return

        baro_altitude_m = _number(_safe_index(state, 7))
        geo_altitude_m = _number(_safe_index(state, 13))
        altitude_m = baro_altitude_m if baro_altitude_m is not None else geo_altitude_m
        altitude_ft = altitude_m * 3.28084 if altitude_m is not None else None
        velocity_ms = _number(_safe_index(state, 9))
        speed_kt = velocity_ms * 1.943844 if velocity_ms is not None else None
        vertical_ms = _number(_safe_index(state, 11))
        vertical_fpm = vertical_ms * 196.8504 if vertical_ms is not None else None
        distance_nm = haversine_nm(latitude, longitude, LGA_LAT, LGA_LON)

        if vertical_fpm is None and previous and altitude_ft is not None and previous["altitude_ft"] is not None:
            elapsed_minutes = (observed_at - previous["timestamp"]) / 60.0
            if elapsed_minutes > 0:
                vertical_fpm = (altitude_ft - previous["altitude_ft"]) / elapsed_minutes

        distance_delta_nm = None
        if previous:
            distance_delta_nm = distance_nm - previous["distance_nm"]

        observation = {
            "timestamp": observed_at,
            "latitude": latitude,
            "longitude": longitude,
            "altitude_m": altitude_m,
            "baro_altitude_m": baro_altitude_m,
            "geo_altitude_m": geo_altitude_m,
            "altitude_ft": altitude_ft,
            "speed_kt": speed_kt,
            "heading_deg": _number(_safe_index(state, 10)),
            "vertical_fpm": vertical_fpm,
            "distance_nm": distance_nm,
            "distance_delta_nm": distance_delta_nm,
            "on_ground": bool(_safe_index(state, 8)),
            "callsign": str(_safe_index(state, 1) or "").strip() or None,
            "origin_country": str(_safe_index(state, 2) or "").strip() or None,
        }
        record.history.append(observation)
        record.last_seen = received_at
        self._trim_history(record, received_at)
        self._update_classification(record, observation)
        return SignalJob(
            icao24=record.icao24,
            observation=dict(observation),
            direction=record.direction,
            status=record.status,
        )

    def _enqueue_signal_jobs(self, jobs: list[SignalJob], active_ids: set[str]) -> None:
        with self._signal_condition:
            for job in jobs:
                self._pending_signal_jobs[job.icao24] = job
            self._signal_active_ids = active_ids
            pending_count = len(self._pending_signal_jobs)
            if jobs:
                self._signal_condition.notify()
        if jobs:
            self.update_service_status(
                signal_state="queued",
                signal_message=f"{pending_count} newest aircraft observations pending",
            )

    def _run_signal_worker(self) -> None:
        while True:
            with self._signal_condition:
                self._signal_condition.wait_for(
                    lambda: self._signal_stopping or bool(self._pending_signal_jobs)
                )
                if self._signal_stopping:
                    return
                jobs = list(self._pending_signal_jobs.values())
                self._pending_signal_jobs.clear()
                active_ids = set(self._signal_active_ids)

            self.update_service_status(
                signal_state="processing",
                signal_message=f"Processing {len(jobs)} newest aircraft observations",
            )
            processing_error: Exception | None = None
            for job in jobs:
                if self._signal_stopping:
                    return
                try:
                    self._process_signal_job(job, publish_cache=True)
                except Exception as exc:
                    processing_error = exc
                    self.update_service_status(
                        signal_state="error",
                        signal_message=f"Version 2 signal processing failed: {exc}",
                    )
            self._signal_v2.expire(active_ids)
            with self._signal_condition:
                pending_count = len(self._pending_signal_jobs)
            if processing_error is None or pending_count:
                self.update_service_status(
                    signal_state="queued" if pending_count else "current",
                    signal_message=(
                        f"{pending_count} newest aircraft observations pending"
                        if pending_count
                        else "Version 2 signal data is current"
                    ),
                )

    def _process_signal_job(self, job: SignalJob, publish_cache: bool) -> None:
        self._signal_v2.ingest_actual(
            job.icao24,
            job.observation,
            job.direction,
            job.status,
        )
        if not publish_cache:
            return
        signal_snapshot = self._signal_v2.snapshot(
            job.icao24,
            float(job.observation["timestamp"]),
        )
        signal_history = self._signal_v2.history(job.icao24)
        with self._signal_cache_lock:
            if signal_snapshot is not None:
                self._signal_snapshots[job.icao24] = signal_snapshot
            if signal_history is not None:
                self._signal_histories[job.icao24] = signal_history

    def close(self) -> None:
        if not self._signal_thread:
            return
        with self._signal_condition:
            self._signal_stopping = True
            self._pending_signal_jobs.clear()
            self._signal_condition.notify_all()
        self._signal_thread.join(timeout=5)

    def _update_classification(self, record: AircraftRecord, current: dict[str, Any]) -> None:
        distance_nm = current["distance_nm"]
        altitude_ft = current["altitude_ft"]
        speed_kt = current["speed_kt"]
        vertical_fpm = current["vertical_fpm"]
        delta_nm = current["distance_delta_nm"]
        inside_scope = distance_nm <= CLASSIFICATION_RADIUS_NM

        low_and_slow = (
            distance_nm <= 1.5
            and altitude_ft is not None
            and altitude_ft <= 250
            and speed_kt is not None
            and speed_kt <= 50
        )
        if distance_nm <= 1.5 and (current["on_ground"] or low_and_slow):
            record.seen_ground_anchor = True

        arrival_signal = bool(
            inside_scope
            and altitude_ft is not None
            and altitude_ft <= 10_000
            and vertical_fpm is not None
            and vertical_fpm <= -VERTICAL_TOLERANCE_FPM
            and delta_nm is not None
            and delta_nm <= -RADIAL_TREND_TOLERANCE_NM
        )
        departure_signal = bool(
            inside_scope
            and altitude_ft is not None
            and altitude_ft <= 15_000
            and vertical_fpm is not None
            and vertical_fpm >= VERTICAL_TOLERANCE_FPM
            and delta_nm is not None
            and delta_nm >= RADIAL_TREND_TOLERANCE_NM
        )

        record.arrival_streak = record.arrival_streak + 1 if arrival_signal else 0
        record.departure_streak = record.departure_streak + 1 if departure_signal else 0

        if departure_signal and distance_nm <= 5 and altitude_ft is not None and altitude_ft <= 3_000:
            record.seen_initial_departure_zone = True

        if record.status != "confirmed":
            if record.arrival_streak >= OBSERVATIONS_TO_CLASSIFY:
                record.status = "probable"
                record.direction = "arrival"
            elif record.departure_streak >= OBSERVATIONS_TO_CLASSIFY:
                record.status = "probable"
                record.direction = "departure"

            if (
                record.status == "probable"
                and record.direction == "arrival"
                and arrival_signal
                and distance_nm <= 8
                and altitude_ft is not None
                and altitude_ft <= 3_000
            ):
                record.status = "confirmed"
            elif (
                record.status == "probable"
                and record.direction == "departure"
                and departure_signal
                and record.seen_initial_departure_zone
            ):
                record.status = "confirmed"

    def _phase_for(self, record: AircraftRecord, current: dict[str, Any]) -> dict[str, Any]:
        distance_nm = current["distance_nm"]
        altitude_ft = current["altitude_ft"]
        speed_kt = current["speed_kt"]
        vertical_fpm = current["vertical_fpm"]

        if distance_nm > CLASSIFICATION_RADIUS_NM:
            return {
                "phase": "outside_current_rule",
                "service": None,
                "frequency_mhz": None,
                "frequency_status": "Future Research",
                "phase_scope": "outside_current_rule",
                "facility_id": None,
                "matched_rule_id": None,
                "assignment_confidence": "low",
                "assignment_method": "rule_based_prototype",
            }

        low_and_slow = (
            distance_nm <= 1.5
            and altitude_ft is not None
            and altitude_ft <= 250
            and speed_kt is not None
            and speed_kt <= 50
        )
        if distance_nm <= 1.5 and (current["on_ground"] or low_and_slow):
            return self._phase(record, "LGA_GROUND")

        if record.direction == "arrival" and vertical_fpm is not None and vertical_fpm <= -VERTICAL_TOLERANCE_FPM:
            if distance_nm <= 8 and altitude_ft is not None and altitude_ft <= 3_000:
                return self._phase(record, "LGA_ARR_FINAL")
            if distance_nm <= 40 and altitude_ft is not None and altitude_ft <= 10_000:
                return self._phase(record, "LGA_ARR_APPROACH")

        if record.direction == "departure" and vertical_fpm is not None and vertical_fpm >= VERTICAL_TOLERANCE_FPM:
            if distance_nm <= 5 and altitude_ft is not None and altitude_ft <= 3_000:
                return self._phase(record, "LGA_DEP_INITIAL")
            if distance_nm <= 40 and altitude_ft is not None and altitude_ft <= 15_000:
                return self._phase(record, "LGA_DEP_CLIMB")

        return {
            "phase": "unknown",
            "service": None,
            "frequency_mhz": None,
            "frequency_status": "No current rule match",
            "phase_scope": "inside_40_nm",
            "facility_id": None,
            "matched_rule_id": None,
            "assignment_confidence": "low",
            "assignment_method": "rule_based_prototype",
        }

    @staticmethod
    def _phase(record: AircraftRecord, rule_id: str) -> dict[str, Any]:
        rule = FREQUENCY_RULES[rule_id]
        return {
            "phase": rule["phase"],
            "service": rule["service"],
            "frequency_mhz": rule["frequency_mhz"],
            "frequency_status": "Inferred representative frequency",
            "phase_scope": "inside_40_nm",
            "facility_id": rule["facility_id"],
            "matched_rule_id": rule_id,
            "assignment_confidence": "medium" if record.status == "confirmed" else "low",
            "assignment_method": "rule_based_prototype",
        }

    def _trim_history(self, record: AircraftRecord, now: float) -> None:
        cutoff = now - TRACK_RETENTION_SECONDS
        while record.history and record.history[0]["timestamp"] < cutoff:
            record.history.popleft()

    def _expire_old_records(self, now: float) -> None:
        expired: list[str] = []
        for icao24, record in self._records.items():
            self._trim_history(record, now)
            if not record.history or now - record.last_seen > TRACK_RETENTION_SECONDS:
                expired.append(icao24)
        for icao24 in expired:
            del self._records[icao24]
        if self._asynchronous_signal:
            with self._signal_cache_lock:
                for icao24 in expired:
                    self._signal_snapshots.pop(icao24, None)
                    self._signal_histories.pop(icao24, None)
        else:
            self._signal_v2.expire(set(self._records))

    def signal_history(self, icao24: str, since: float | None = None) -> dict[str, Any] | None:
        key = icao24.strip().lower()
        if self._asynchronous_signal:
            with self._signal_cache_lock:
                cached = self._signal_histories.get(key)
                if cached is None:
                    return None
                history = dict(cached)
                history["points"] = [
                    dict(point)
                    for point in cached["points"]
                    if since is None or float(point["timestamp"]) > float(since)
                ]
                history["since"] = since
                return history
        with self._lock:
            return self._signal_v2.history(key, since)

    @staticmethod
    def _advance_cached_signal(
        signal_snapshot: dict[str, Any] | None,
        now: float,
    ) -> dict[str, Any] | None:
        if signal_snapshot is None:
            return None
        result = dict(signal_snapshot)
        timeline = signal_snapshot.get("predicted_timeline") or []
        candidates = [point for point in timeline if float(point["timestamp"]) <= now]
        if candidates:
            result["current"] = dict(candidates[-1])
        else:
            result["current"] = dict(signal_snapshot["current"])
        result["generated_at"] = now
        return result

    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        now = now or time.time()
        signal_snapshots: dict[str, dict[str, Any]] = {}
        if self._asynchronous_signal:
            with self._signal_cache_lock:
                signal_snapshots = dict(self._signal_snapshots)
        with self._lock:
            self._expire_old_records(now)
            flights: list[dict[str, Any]] = []
            for record in self._records.values():
                if record.status not in {"probable", "confirmed"} or not record.history:
                    continue
                current = record.history[-1]
                phase = self._phase_for(record, current)
                flights.append(
                    {
                        "icao24": record.icao24,
                        "callsign": current["callsign"],
                        "origin_country": current["origin_country"],
                        "status": record.status,
                        "direction": record.direction,
                        "active": now - record.last_seen <= ACTIVE_TIMEOUT_SECONDS,
                        "last_seen": record.last_seen,
                        "current": {**current, **phase},
                        "track": [
                            {
                                "timestamp": point["timestamp"],
                                "longitude": point["longitude"],
                                "latitude": point["latitude"],
                                "altitude_m": point["altitude_m"] or 0.0,
                                "altitude_ft": point["altitude_ft"] or 0.0,
                                "distance_nm": point["distance_nm"],
                                "phase_scope": (
                                    "inside_40_nm"
                                    if point["distance_nm"] <= CLASSIFICATION_RADIUS_NM
                                    else "outside_current_rule"
                                ),
                            }
                            for point in record.history
                        ],
                        "signal_v2": (
                            self._advance_cached_signal(signal_snapshots.get(record.icao24), now)
                            if self._asynchronous_signal
                            else self._signal_v2.snapshot(record.icao24, now)
                        ),
                    }
                )
            flights.sort(key=lambda item: (item["status"] != "confirmed", item["current"]["distance_nm"]))
            return {
                "generated_at": now,
                "source_time": self._source_time,
                "poll_interval_seconds": POLL_INTERVAL_SECONDS,
                "track_retention_seconds": TRACK_RETENTION_SECONDS,
                "collection_bbox": COLLECTION_BBOX,
                "classification_radius_nm": CLASSIFICATION_RADIUS_NM,
                "service": dict(self._service_status),
                "flights": flights,
            }


class OpenSkyError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class OpenSkyClient:
    def __init__(self, credentials_path: Path) -> None:
        self.credentials_path = credentials_path
        self.client_id, self.client_secret = self._load_credentials(credentials_path)
        self._token: str | None = None
        self._token_expires_at = 0.0

    @staticmethod
    def _load_credentials(path: Path) -> tuple[str, str]:
        """Load OpenSky credentials from a local file, falling back to
        OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET environment variables (used by
        the GitHub Actions snapshot workflow, which stores them as secrets
        instead of a checked-out credentials.json)."""
        if not path.is_file():
            env_client_id = os.environ.get("OPENSKY_CLIENT_ID")
            env_client_secret = os.environ.get("OPENSKY_CLIENT_SECRET")
            if env_client_id and env_client_secret:
                return env_client_id, env_client_secret
            raise OpenSkyError(f"Credentials file not found: {path}")

        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError as exc:
            raise OpenSkyError(f"Credentials file not found: {path}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise OpenSkyError(f"Could not read credentials file: {exc}") from exc

        client_id = data.get("clientId") or data.get("client_id")
        client_secret = data.get("clientSecret") or data.get("client_secret")
        if not client_id or not client_secret:
            raise OpenSkyError("credentials.json must contain clientId and clientSecret")
        return str(client_id), str(client_secret)

    def _get_token(self, force_refresh: bool = False) -> str:
        now = time.time()
        if not force_refresh and self._token and now < self._token_expires_at - 30:
            return self._token

        body = urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        ).encode("utf-8")
        request = Request(
            TOKEN_URL,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "LGA-Realtime-Flight-Tracker/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=20) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code == 401:
                message = "OpenSky rejected the API client ID or secret (HTTP 401)"
            else:
                message = f"OAuth token request failed with HTTP {exc.code}"
            raise OpenSkyError(message, exc.code) from exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise OpenSkyError(f"OAuth token request failed: {exc}") from exc

        token = result.get("access_token")
        if not token:
            raise OpenSkyError("OAuth response did not contain an access token")
        self._token = str(token)
        self._token_expires_at = now + int(result.get("expires_in", 1800))
        return self._token

    def fetch_states(self) -> tuple[dict[str, Any], dict[str, str]]:
        return self._fetch_states_once(force_refresh=False)

    def _fetch_states_once(self, force_refresh: bool) -> tuple[dict[str, Any], dict[str, str]]:
        token = self._get_token(force_refresh=force_refresh)
        query = urlencode(COLLECTION_BBOX)
        request = Request(
            f"{STATES_URL}?{query}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "LGA-Realtime-Flight-Tracker/1.0",
            },
        )
        try:
            with urlopen(request, timeout=25) as response:
                payload = json.loads(response.read().decode("utf-8"))
                headers = {key.lower(): value for key, value in response.headers.items()}
                return payload, headers
        except HTTPError as exc:
            if exc.code == 401 and not force_refresh:
                return self._fetch_states_once(force_refresh=True)
            retry_header = exc.headers.get("X-Rate-Limit-Retry-After-Seconds") if exc.headers else None
            retry_after = int(retry_header) if retry_header and retry_header.isdigit() else None
            raise OpenSkyError(f"OpenSky states request failed with HTTP {exc.code}", exc.code, retry_after) from exc
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise OpenSkyError(f"OpenSky states request failed: {exc}") from exc


class PollingService:
    def __init__(self, tracker: FlightTracker, client: OpenSkyClient) -> None:
        self.tracker = tracker
        self.client = client
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="opensky-poller", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        consecutive_errors = 0
        while not self._stop.is_set():
            started = time.time()
            self.tracker.update_service_status(state="polling", message="Requesting OpenSky state vectors")
            wait_seconds = POLL_INTERVAL_SECONDS
            try:
                payload, headers = self.client.fetch_states()
                received_at = time.time()
                self.tracker.ingest(payload, received_at=received_at)
                consecutive_errors = 0
                remaining = headers.get("x-rate-limit-remaining")
                self.tracker.update_service_status(
                    state="online",
                    message="OpenSky data is current",
                    last_poll_at=received_at,
                    remaining_credits=int(remaining) if remaining and remaining.isdigit() else remaining,
                )
            except OpenSkyError as exc:
                consecutive_errors += 1
                if exc.status == 429:
                    wait_seconds = max(POLL_INTERVAL_SECONDS, exc.retry_after or 300)
                elif consecutive_errors > 1:
                    wait_seconds = min(300, POLL_INTERVAL_SECONDS * (2 ** min(consecutive_errors - 1, 3)))
                self.tracker.update_service_status(
                    state="error",
                    message=str(exc),
                    last_poll_at=started,
                )

            next_poll = time.time() + wait_seconds
            self.tracker.update_service_status(next_poll_at=next_poll)
            self._stop.wait(wait_seconds)
