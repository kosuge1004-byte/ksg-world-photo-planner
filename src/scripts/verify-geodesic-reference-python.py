#!/usr/bin/env python3
"""Independently verify the JavaScript Karney reference constants.

This script does not participate in the application runtime. It uses the
Python GeographicLib implementation as an independent test oracle for the
reference values consumed by verify-geodesic-comparison.mjs.
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass

from geographiclib.geodesic import Geodesic

DISTANCE_TOLERANCE_METERS = 1e-6
BEARING_TOLERANCE_DEGREES = 1e-10


@dataclass(frozen=True)
class Case:
    name: str
    start: tuple[float, float]
    end: tuple[float, float]
    expected_distance_meters: float
    expected_initial_bearing_degrees: float


CASES = (
    Case("short_local", (35.183, 136.857), (35.184, 136.859), 213.2924484060868, 58.65715047893593),
    Case("nagoya_tokyo", (35.1815, 136.9066), (35.6812, 139.7671), 265591.87388393166, 77.12488365196589),
    Case("dateline", (35.0, 179.9), (35.0, -179.9), 18257.63087971887, 89.94264231710821),
    Case("near_antipodal", (0.0, 0.0), (0.5, 179.5), 19936288.578965314, 25.67187286829187),
)


def normalize_bearing(value: float) -> float:
    return value % 360.0


def normalize_signed_angle(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def main() -> int:
    failed = False
    for case in CASES:
        result = Geodesic.WGS84.Inverse(
            case.start[0], case.start[1], case.end[0], case.end[1]
        )
        distance_error = result["s12"] - case.expected_distance_meters
        bearing_error = normalize_signed_angle(
            normalize_bearing(result["azi1"]) - case.expected_initial_bearing_degrees
        )
        passed = (
            math.isfinite(result["s12"])
            and math.isfinite(result["azi1"])
            and abs(distance_error) <= DISTANCE_TOLERANCE_METERS
            and abs(bearing_error) <= BEARING_TOLERANCE_DEGREES
        )
        failed = failed or not passed
        print(
            f"{case.name}: {'PASS' if passed else 'FAIL'} "
            f"distance_error_m={distance_error:.12g} "
            f"bearing_error_deg={bearing_error:.12g}"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
