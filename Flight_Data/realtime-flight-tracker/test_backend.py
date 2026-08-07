from __future__ import annotations

import time
import threading
import unittest

from backend import COLLECTION_BBOX, FlightTracker, LGA_LAT, LGA_LON


def state_vector(
    icao24: str,
    timestamp: float,
    distance_nm: float,
    altitude_ft: float,
    vertical_fpm: float,
    on_ground: bool = False,
    speed_kt: float = 150,
) -> list[object]:
    latitude = LGA_LAT + distance_nm / 60.0
    altitude_m = altitude_ft / 3.28084
    velocity_ms = speed_kt / 1.943844
    vertical_ms = vertical_fpm / 196.8504
    return [
        icao24,
        "TEST123",
        "United States",
        timestamp,
        timestamp,
        LGA_LON,
        latitude,
        altitude_m,
        on_ground,
        velocity_ms,
        180.0,
        vertical_ms,
        None,
        altitude_m,
        None,
        False,
        0,
    ]


class FlightTrackerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tracker = FlightTracker()
        self.base = time.time()

    def ingest(self, state: list[object], offset: int) -> None:
        source_time = int(self.base + offset)
        self.tracker.ingest({"time": source_time, "states": [state]}, received_at=self.base + offset)

    def test_collection_box_stays_below_one_credit_boundary(self) -> None:
        area = (COLLECTION_BBOX["lamax"] - COLLECTION_BBOX["lamin"]) * (
            COLLECTION_BBOX["lomax"] - COLLECTION_BBOX["lomin"]
        )
        self.assertLess(area, 25.0)
        self.assertGreater(area, 24.8)

    def test_arrival_becomes_confirmed_in_final_zone(self) -> None:
        points = [(12, 6000), (10, 5000), (9, 4000), (7, 2500)]
        for index, (distance, altitude) in enumerate(points):
            timestamp = self.base + index * 30
            self.ingest(state_vector("abc123", timestamp, distance, altitude, -1000), index * 30)

        snapshot = self.tracker.snapshot(now=self.base + 90)
        self.assertEqual(len(snapshot["flights"]), 1)
        flight = snapshot["flights"][0]
        self.assertEqual(flight["status"], "confirmed")
        self.assertEqual(flight["direction"], "arrival")
        self.assertEqual(flight["current"]["phase"], "final_approach")
        self.assertEqual(flight["current"]["frequency_mhz"], 118.7)
        self.assertAlmostEqual(flight["track"][-1]["altitude_ft"], 2500, delta=1)
        self.assertEqual(flight["signal_v2"]["version"], 2)
        self.assertEqual(len(flight["signal_v2"]["predicted_timeline"]), 30)
        self.assertEqual(
            flight["signal_v2"]["current"]["most_likely_frequency_mhz"],
            118.7,
        )
        history = self.tracker.signal_history("ABC123", since=self.base + 88)
        self.assertEqual([point["timestamp"] for point in history["points"]], [self.base + 89, self.base + 90])

    def test_departure_becomes_confirmed_after_initial_zone(self) -> None:
        points = [
            (0.2, 50, 0, True, 10),
            (1.0, 600, 1000, False, 140),
            (2.0, 1500, 1000, False, 170),
            (4.0, 2500, 1000, False, 200),
        ]
        for index, (distance, altitude, vertical, on_ground, speed) in enumerate(points):
            timestamp = self.base + index * 30
            self.ingest(
                state_vector("def456", timestamp, distance, altitude, vertical, on_ground, speed),
                index * 30,
            )

        flight = self.tracker.snapshot(now=self.base + 90)["flights"][0]
        self.assertEqual(flight["status"], "confirmed")
        self.assertEqual(flight["direction"], "departure")
        self.assertEqual(flight["current"]["phase"], "initial_departure")

    def test_confirmed_flight_outside_40_nm_is_future_research(self) -> None:
        points = [
            (0.2, 50, 0, True, 10),
            (1.0, 600, 1000, False, 140),
            (2.0, 1500, 1000, False, 170),
            (4.0, 2500, 1000, False, 200),
            (41.0, 9000, 1000, False, 300),
        ]
        for index, (distance, altitude, vertical, on_ground, speed) in enumerate(points):
            timestamp = self.base + index * 30
            self.ingest(
                state_vector("fed987", timestamp, distance, altitude, vertical, on_ground, speed),
                index * 30,
            )

        flight = self.tracker.snapshot(now=self.base + 120)["flights"][0]
        current = flight["current"]
        self.assertEqual(current["phase"], "outside_current_rule")
        self.assertIsNone(current["frequency_mhz"])
        self.assertEqual(current["frequency_status"], "Future Research")
        self.assertEqual(flight["signal_v2"]["current"]["inferred_phase"], "unknown")
        self.assertIsNone(flight["signal_v2"]["current"]["most_likely_frequency_mhz"])
        self.assertIsNone(flight["signal_v2"]["current"]["total_loss_db"])

    def test_async_building_work_does_not_block_tracker_snapshot(self) -> None:
        class BlockingBuildingProvider:
            source_name = "blocking_test"

            def __init__(self) -> None:
                self.started = threading.Event()
                self.release = threading.Event()

            def obstruction(self, *args: float) -> dict:
                self.started.set()
                self.release.wait(timeout=2)
                return {
                    "building_data_status": "available",
                    "building_blocked": False,
                    "blocking_building_count": 0,
                    "dominant_building_id": None,
                    "dominant_building_height_m": None,
                    "building_height_status": None,
                    "worst_clearance_m": None,
                    "fresnel_radius_m": None,
                    "diffraction_v": None,
                    "building_loss_db": 0.0,
                }

        provider = BlockingBuildingProvider()
        tracker = FlightTracker(provider, asynchronous_signal=True)
        try:
            for index, (distance, altitude) in enumerate(
                [(12, 6000), (10, 5000), (9, 4000), (7, 2500)]
            ):
                timestamp = self.base + index * 30
                tracker.ingest(
                    {
                        "time": int(timestamp),
                        "states": [state_vector("async1", timestamp, distance, altitude, -1000)],
                    },
                    received_at=timestamp,
                )

            self.assertTrue(provider.started.wait(timeout=1))
            started = time.perf_counter()
            snapshot = tracker.snapshot(now=self.base + 90)
            elapsed = time.perf_counter() - started

            self.assertLess(elapsed, 0.25)
            self.assertEqual(snapshot["source_time"], int(self.base + 90))
            self.assertEqual(len(snapshot["flights"]), 1)
        finally:
            provider.release.set()
            tracker.close()


if __name__ == "__main__":
    unittest.main()
