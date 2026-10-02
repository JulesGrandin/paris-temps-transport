#!/usr/bin/env python3
"""Build the compact JSON bundle for the Paris metro/RER commute map."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
SITE_DATA_PATH = ROOT / "site" / "data" / "commute_map_data.json"

LAT0 = 48.8566
# Paris + petite couronne + first RER ring (CDG, Massy, Torcy, Versailles).
LON_MIN, LAT_MIN, LON_MAX, LAT_MAX = 2.08, 48.68, 2.70, 49.03
# Périphérique / Paris intra-muros (hors bois).
INTRA_LON_MIN, INTRA_LAT_MIN, INTRA_LON_MAX, INTRA_LAT_MAX = 2.249, 48.8155, 2.416, 48.9015
INTRA_PAD_METERS = 700.0

GRID_COLS = 128
GRID_ROWS = 128
WALK_METERS_PER_MINUTE = 80.0
STATION_ACCESS_PENALTY = 2.0
CELL_NEAREST_STATIONS = 4
ORIGIN_NEAREST_STATIONS = 5
DEFAULT_BOARD_WAIT = 2.5
TRANSFER_PENALTY = 4.0
INTER_COMPLEX_TRANSFER_PENALTY = 7.0
INTER_COMPLEX_WALK_RADIUS = 400.0
LINE_GAP_METERS = 4500.0
MIN_RING_DISTANCE = 90.0
MIN_LINE_DISTANCE = 55.0
SEGMENT_SNAP_METERS = 550.0
MIN_RIDE_MINUTES = 0.65

Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]


def lonlat_to_xy(lon: float, lat: float) -> Point:
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * math.cos(math.radians(LAT0))
    return lon * meters_per_deg_lon, lat * meters_per_deg_lat


def land_bounds(multipolygon: MultiPolygon, pad: float = 1200.0) -> Tuple[float, float, float, float]:
    xs = [x for polygon in multipolygon for ring in polygon for x, _ in ring]
    ys = [y for polygon in multipolygon for ring in polygon for _, y in ring]
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def round_point(point: Point) -> List[float]:
    return [round(point[0], 1), round(point[1], 1)]


def in_lonlat_bbox(lon: float, lat: float, pad: float = 0.0) -> bool:
    return (LON_MIN - pad) <= lon <= (LON_MAX + pad) and (LAT_MIN - pad) <= lat <= (LAT_MAX + pad)


def normalize_line(mode: str, indice: str, res_com: str) -> str | None:
    mode = (mode or "").strip().upper()
    res_com = (res_com or "").strip().upper()
    indice = (indice or "").strip()
    if mode not in {"METRO", "RER"}:
        return None
    if "TER" in res_com:
        return None
    indice_norm = indice.replace("7b", "7bis").replace("7B", "7bis")
    if res_com in {"METRO 7B", "METRO 7BIS"}:
        return "METRO 7BIS"
    if res_com.startswith("METRO") or res_com.startswith("RER"):
        return res_com.replace("7BISIS", "7BIS")
    return f"{mode} {indice_norm}"


def line_mode(line_id: str) -> str:
    return "RER" if line_id.startswith("RER") else "METRO"


def ride_speed(line_id: str) -> float:
    if line_id == "METRO 14":
        return 720.0
    if line_id.startswith("RER"):
        return 900.0
    return 470.0


def board_wait(line_id: str) -> float:
    return {
        "METRO 14": 1.8,
        "RER A": 4.0,
        "RER B": 4.5,
        "RER C": 6.0,
        "RER D": 6.0,
        "RER E": 5.0,
    }.get(line_id, 2.4 if line_id.startswith("METRO") else 5.5)


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def polygon_centroid(ring: Sequence[Point]) -> Point:
    area = ring_area(ring) or 1.0
    factor = 1.0 / (6.0 * area)
    cx = cy = 0.0
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx * factor, cy * factor


def simplify_polyline(points: Sequence[Point], min_distance: float) -> List[Point]:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for point in points[1:-1]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if points[-1] != simplified[-1]:
        simplified.append(points[-1])
    return simplified


def simplify_ring(ring: Sequence[Point], min_distance: float) -> Ring:
    if len(ring) <= 4:
        return list(ring)
    core = list(ring[:-1]) if ring[0] == ring[-1] else list(ring)
    simplified = [core[0]]
    for point in core[1:]:
        if math.hypot(point[0] - simplified[-1][0], point[1] - simplified[-1][1]) >= min_distance:
            simplified.append(point)
    if len(simplified) < 3:
        simplified = core[:3]
    simplified.append(simplified[0])
    return simplified


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        intersects = (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
        if intersects:
            inside = not inside
    return inside


def point_in_polygon(point: Point, polygon: Polygon) -> bool:
    if not polygon or not point_in_ring(point, polygon[0]):
        return False
    for hole in polygon[1:]:
        if point_in_ring(point, hole):
            return False
    return True


def point_in_multipolygon(point: Point, multipolygon: MultiPolygon) -> bool:
    return any(point_in_polygon(point, polygon) for polygon in multipolygon)


def coords_to_polygons(geometry: dict, min_distance: float | None = MIN_RING_DISTANCE) -> MultiPolygon:
    geom_type = geometry["type"]
    coords = geometry["coordinates"]
    if geom_type == "Polygon":
        polygons = [coords]
    elif geom_type == "MultiPolygon":
        polygons = coords
    else:
        return []
    converted: MultiPolygon = []
    for rings in polygons:
        polygon: Polygon = []
        for ring in rings:
            points = [lonlat_to_xy(lon, lat) for lon, lat in ring]
            if len(points) < 4:
                continue
            if points[0] != points[-1]:
                points.append(points[0])
            polygon.append(simplify_ring(points, min_distance) if min_distance else points)
        if polygon:
            converted.append(polygon)
    return converted


def _snap_point(point: Point, snap: float) -> Point:
    return (round(point[0] / snap) * snap, round(point[1] / snap) * snap)


def department_outline(polygons: MultiPolygon, snap: float = 20.0, simplify: float = 110.0) -> List[Ring]:
    """Cancel shared commune/arrondissement edges to keep the department perimeter."""
    counts: Counter[Tuple[Point, Point]] = Counter()
    for polygon in polygons:
        ring = polygon[0]
        raw = ring[:-1] if ring and ring[0] == ring[-1] else ring
        points: List[Point] = []
        for point in raw:
            snapped = _snap_point(point, snap)
            if not points or snapped != points[-1]:
                points.append(snapped)
        if len(points) >= 2 and points[0] == points[-1]:
            points.pop()
        if len(points) < 3:
            continue
        for i, start in enumerate(points):
            end = points[(i + 1) % len(points)]
            if start == end:
                continue
            key = (start, end) if start < end else (end, start)
            counts[key] += 1

    remaining = [edge for edge, count in counts.items() if count == 1]
    adjacency: Dict[Point, List[Point]] = defaultdict(list)
    for start, end in remaining:
        adjacency[start].append(end)
        adjacency[end].append(start)

    def edge_key(a: Point, b: Point) -> Tuple[Point, Point]:
        return (a, b) if a < b else (b, a)

    used: set[Tuple[Point, Point]] = set()
    rings: List[Ring] = []
    for origin, neighbors in adjacency.items():
        for first in neighbors:
            if edge_key(origin, first) in used:
                continue
            ring = [origin]
            prev, current = origin, first
            used.add(edge_key(prev, current))
            while current != origin:
                ring.append(current)
                nxt = next((node for node in adjacency[current] if edge_key(current, node) not in used), None)
                if nxt is None:
                    break
                prev, current = current, nxt
                used.add(edge_key(prev, current))
            if current == origin and len(ring) >= 4:
                ring.append(ring[0])
                rings.append(simplify_ring(ring, simplify))
    rings.sort(key=lambda item: abs(ring_area(item)), reverse=True)
    return rings[:6]


def paris_intramuros_bounds() -> Tuple[float, float, float, float]:
    min_x, min_y = lonlat_to_xy(INTRA_LON_MIN, INTRA_LAT_MIN)
    max_x, max_y = lonlat_to_xy(INTRA_LON_MAX, INTRA_LAT_MAX)
    return min_x - INTRA_PAD_METERS, min_y - INTRA_PAD_METERS, max_x + INTRA_PAD_METERS, max_y + INTRA_PAD_METERS


def feature_hits_bbox(geometry: dict, pad: float = 0.02) -> bool:
    geom_type = geometry["type"]
    coords = geometry["coordinates"]
    if geom_type == "Polygon":
        rings = coords
    elif geom_type == "MultiPolygon":
        rings = [ring for polygon in coords for ring in polygon]
    else:
        return False
    for ring in rings:
        for lon, lat in ring:
            if in_lonlat_bbox(lon, lat, pad=pad):
                return True
    return False


def geometry_centroid_lonlat(geometry: dict) -> Tuple[float, float] | None:
    geom_type = geometry["type"]
    coords = geometry["coordinates"]
    if geom_type == "Polygon":
        ring = coords[0]
    elif geom_type == "MultiPolygon":
        ring = max(coords, key=lambda polygon: len(polygon[0]))[0]
    else:
        return None
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def extract_land() -> Tuple[List[dict], MultiPolygon]:
    departments = [
        ("Paris", DATA_DIR / "arrondissements.geojson", True),
        ("Hauts-de-Seine", DATA_DIR / "communes_92.geojson", False),
        ("Seine-Saint-Denis", DATA_DIR / "communes_93.geojson", False),
        ("Val-de-Marne", DATA_DIR / "communes_94.geojson", False),
        ("Yvelines", DATA_DIR / "communes_78.geojson", False),
        ("Essonne", DATA_DIR / "communes_91.geojson", False),
        ("Val-d'Oise", DATA_DIR / "communes_95.geojson", False),
        ("Seine-et-Marne", DATA_DIR / "communes_77.geojson", False),
    ]
    boroughs = []
    all_polygons: MultiPolygon = []
    for name, path, is_paris in departments:
        payload = load_json(path)
        raw_polygons: MultiPolygon = []
        polygons: MultiPolygon = []
        for feature in payload["features"]:
            geometry = feature["geometry"]
            if not is_paris:
                centroid = geometry_centroid_lonlat(geometry)
                if centroid is None or not in_lonlat_bbox(*centroid, pad=0.01):
                    continue
            raw = coords_to_polygons(geometry, min_distance=None)
            raw_polygons.extend(raw)
            polygons.extend(
                [[simplify_ring(ring, MIN_RING_DISTANCE) for ring in polygon if len(ring) >= 4] for polygon in raw]
            )
        polygons = [polygon for polygon in polygons if polygon]
        if not polygons:
            continue
        largest = max((ring for polygon in polygons for ring in polygon[:1]), key=lambda ring: abs(ring_area(ring)))
        if is_paris and (DATA_DIR / "communes_75.geojson").exists():
            paris_feature = load_json(DATA_DIR / "communes_75.geojson")["features"][0]
            outlines = [
                simplify_ring(polygon[0], 110.0)
                for polygon in coords_to_polygons(paris_feature["geometry"], min_distance=None)
                if polygon
            ]
        else:
            outlines = department_outline(raw_polygons)
        boroughs.append(
            {
                "name": name,
                "polygons": [[[round_point(point) for point in ring] for ring in polygon] for polygon in polygons],
                "outline": [[round_point(point) for point in ring] for ring in outlines],
                "label": round_point(polygon_centroid(largest)),
            }
        )
        all_polygons.extend(polygons)
    return boroughs, all_polygons


def extract_parks() -> MultiPolygon:
    payload = load_json(DATA_DIR / "parks_paris.geojson")
    parks: MultiPolygon = []
    for feature in payload["features"]:
        parks.extend(coords_to_polygons(feature["geometry"]))
    return parks


def extract_stations() -> Tuple[List[dict], Dict[str, int]]:
    payload = load_json(DATA_DIR / "stations.geojson")
    grouped: Dict[str, dict] = {}
    for feature in payload["features"]:
        props = feature["properties"]
        line_id = normalize_line(props.get("mode"), props.get("indice_lig"), props.get("res_com"))
        if not line_id:
            continue
        lon, lat = feature["geometry"]["coordinates"]
        if not in_lonlat_bbox(lon, lat, pad=0.04):
            continue
        complex_id = str(props.get("id_ref_zdc") or props.get("nom_zdc") or props.get("nom_gares"))
        point = lonlat_to_xy(lon, lat)
        bucket = grouped.setdefault(
            complex_id,
            {
                "id": complex_id,
                "names": Counter(),
                "points": [],
                "routes": set(),
                "line_points": defaultdict(list),
            },
        )
        bucket["names"][props.get("nom_gares") or props.get("nom_zdc") or "Station"] += 1
        bucket["points"].append(point)
        bucket["routes"].add(line_id)
        bucket["line_points"][line_id].append(point)

    stations = []
    index_by_id = {}
    for complex_id, bucket in grouped.items():
        xs = [p[0] for p in bucket["points"]]
        ys = [p[1] for p in bucket["points"]]
        station = {
            "id": complex_id,
            "name": bucket["names"].most_common(1)[0][0],
            "point": (sum(xs) / len(xs), sum(ys) / len(ys)),
            "routes": sorted(bucket["routes"]),
            "line_points": {line: (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) for line, pts in bucket["line_points"].items()},
        }
        index_by_id[complex_id] = len(stations)
        stations.append(station)
    return stations, index_by_id


def polyline_length(points: Sequence[Point]) -> float:
    return sum(math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) for i in range(1, len(points)))


def nearest_station_on_line(point: Point, stations: Sequence[dict], line_id: str) -> Tuple[int | None, float]:
    best_index = None
    best_dist = SEGMENT_SNAP_METERS
    for index, station in enumerate(stations):
        if line_id not in station["routes"]:
            continue
        line_point = station["line_points"].get(line_id, station["point"])
        dist = math.hypot(point[0] - line_point[0], point[1] - line_point[1])
        if dist < best_dist:
            best_dist = dist
            best_index = index
    return best_index, best_dist


def extract_routes_and_edges(stations: Sequence[dict]) -> Tuple[List[dict], Dict[str, str], Dict[Tuple[int, int, str], float]]:
    payload = load_json(DATA_DIR / "traces.geojson")
    route_styles: Dict[str, str] = {}
    route_shapes: Dict[str, List[List[Point]]] = defaultdict(list)
    edges: Dict[Tuple[int, int, str], float] = {}

    for feature in payload["features"]:
        props = feature["properties"]
        line_id = normalize_line(props.get("mode"), props.get("indice_lig"), props.get("res_com"))
        if not line_id:
            continue
        color = f"#{(props.get('colourweb_hexa') or '888888').strip().lstrip('#')}"
        route_styles[line_id] = color
        coords = feature["geometry"]["coordinates"]
        if feature["geometry"]["type"] != "LineString" or len(coords) < 2:
            continue
        if not any(in_lonlat_bbox(lon, lat, pad=0.05) for lon, lat in coords):
            continue
        points = [lonlat_to_xy(lon, lat) for lon, lat in coords]
        route_shapes[line_id].append(simplify_polyline(points, MIN_LINE_DISTANCE))

        start = points[0]
        end = points[-1]
        a, da = nearest_station_on_line(start, stations, line_id)
        b, db = nearest_station_on_line(end, stations, line_id)
        if a is None or b is None or a == b:
            continue
        length = max(polyline_length(points), math.hypot(start[0] - end[0], start[1] - end[1]))
        minutes = max(MIN_RIDE_MINUTES, length / ride_speed(line_id))
        key = (min(a, b), max(a, b), line_id)
        prev = edges.get(key)
        if prev is None or minutes < prev:
            edges[key] = minutes

    routes = []
    for line_id, segments in sorted(route_shapes.items()):
        for segment in segments:
            if len(segment) >= 2:
                routes.append({"id": line_id, "color": route_styles.get(line_id, "#888888"), "points": [round_point(p) for p in segment]})
    return routes, route_styles, edges


def connect_line_gaps(stations: Sequence[dict], edges: Dict[Tuple[int, int, str], float]) -> None:
    by_line: Dict[str, List[int]] = defaultdict(list)
    for index, station in enumerate(stations):
        for line_id in station["routes"]:
            by_line[line_id].append(index)

    connected: Dict[str, Dict[int, set]] = defaultdict(lambda: defaultdict(set))
    for a, b, line_id in edges:
        connected[line_id][a].add(b)
        connected[line_id][b].add(a)

    def component(line_id: str, start: int) -> set:
        seen = {start}
        stack = [start]
        while stack:
            node = stack.pop()
            for nxt in connected[line_id][node]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    for line_id, indexes in by_line.items():
        while True:
            remaining = set(indexes)
            components: List[set] = []
            while remaining:
                start = remaining.pop()
                comp = component(line_id, start)
                remaining -= comp
                components.append(comp)
            if len(components) <= 1:
                break
            best = None
            for first, comp_a in enumerate(components):
                for comp_b in components[first + 1 :]:
                    for i in comp_a:
                        pi = stations[i]["line_points"].get(line_id, stations[i]["point"])
                        for j in comp_b:
                            pj = stations[j]["line_points"].get(line_id, stations[j]["point"])
                            dist = math.hypot(pi[0] - pj[0], pi[1] - pj[1])
                            if dist > LINE_GAP_METERS:
                                continue
                            if best is None or dist < best[0]:
                                best = (dist, i, j)
            if best is None:
                break
            dist, i, j = best
            key = (min(i, j), max(i, j), line_id)
            if key not in edges or dist / ride_speed(line_id) < edges[key]:
                edges[key] = max(MIN_RIDE_MINUTES, dist / ride_speed(line_id))
            connected[line_id][i].add(j)
            connected[line_id][j].add(i)


def build_graph(stations: Sequence[dict], edges: Dict[Tuple[int, int, str], float]):
    route_states = []
    station_states: List[List[int]] = [[] for _ in stations]
    state_lookup: Dict[Tuple[int, str], int] = {}

    for station_index, station in enumerate(stations):
        for line_id in station["routes"]:
            state_index = len(route_states)
            route_states.append({"stationIndex": station_index, "routeId": line_id})
            station_states[station_index].append(state_index)
            state_lookup[(station_index, line_id)] = state_index

    adjacency: List[List[List[float]]] = [[] for _ in route_states]

    def add_edge(src: int, dst: int, weight: float) -> None:
        adjacency[src].append([dst, round(weight, 3)])

    for (a, b, line_id), minutes in edges.items():
        sa = state_lookup.get((a, line_id))
        sb = state_lookup.get((b, line_id))
        if sa is None or sb is None:
            continue
        add_edge(sa, sb, minutes)
        add_edge(sb, sa, minutes)

    for station_index, states in enumerate(station_states):
        for i, src in enumerate(states):
            for dst in states[i + 1 :]:
                add_edge(src, dst, TRANSFER_PENALTY)
                add_edge(dst, src, TRANSFER_PENALTY)

    for i, a in enumerate(stations):
        for j in range(i + 1, len(stations)):
            b = stations[j]
            dist = math.hypot(a["point"][0] - b["point"][0], a["point"][1] - b["point"][1])
            if dist > INTER_COMPLEX_WALK_RADIUS:
                continue
            weight = dist / WALK_METERS_PER_MINUTE + INTER_COMPLEX_TRANSFER_PENALTY - TRANSFER_PENALTY
            for src in station_states[i]:
                for dst in station_states[j]:
                    add_edge(src, dst, weight)
                    add_edge(dst, src, weight)

    route_waits = {line_id: board_wait(line_id) for station in stations for line_id in station["routes"]}
    return route_states, station_states, adjacency, route_waits


def build_grid(all_polygons: MultiPolygon, stations: Sequence[dict], bounds: Tuple[float, float, float, float]):
    min_x, min_y, max_x, max_y = bounds
    cell_w = (max_x - min_x) / GRID_COLS
    cell_h = (max_y - min_y) / GRID_ROWS
    cells = []
    mask = [-1] * (GRID_COLS * GRID_ROWS)

    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            point = (min_x + (col + 0.5) * cell_w, min_y + (row + 0.5) * cell_h)
            if not point_in_multipolygon(point, all_polygons):
                continue
            nearby = sorted(
                (
                    (index, math.hypot(point[0] - station["point"][0], point[1] - station["point"][1]))
                    for index, station in enumerate(stations)
                ),
                key=lambda item: item[1],
            )[:CELL_NEAREST_STATIONS]
            cell_index = len(cells)
            cells.append(
                {
                    "row": row,
                    "col": col,
                    "point": round_point(point),
                    "access": [[index, round(dist, 1)] for index, dist in nearby],
                }
            )
            mask[row * GRID_COLS + col] = cell_index
    return cells, mask


def main() -> None:
    boroughs, all_polygons = extract_land()
    bounds = land_bounds(all_polygons)
    parks = extract_parks()
    stations, _ = extract_stations()
    routes, route_styles, edges = extract_routes_and_edges(stations)
    connect_line_gaps(stations, edges)
    route_states, station_states, adjacency, route_waits = build_graph(stations, edges)
    cells, mask = build_grid(all_polygons, stations, bounds)

    output = {
        "meta": {
            "lat0": LAT0,
            "bounds": [round(v, 1) for v in bounds],
            "parisBounds": [round(v, 1) for v in paris_intramuros_bounds()],
            "gridCols": GRID_COLS,
            "gridRows": GRID_ROWS,
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "stationAccessPenalty": STATION_ACCESS_PENALTY,
            "originStationCount": ORIGIN_NEAREST_STATIONS,
            "cellNearestStations": CELL_NEAREST_STATIONS,
            "defaultBoardWait": DEFAULT_BOARD_WAIT,
            "transferPenalty": TRANSFER_PENALTY,
            "interComplexTransferPenalty": INTER_COMPLEX_TRANSFER_PENALTY,
        },
        "boroughs": boroughs,
        "parks": [[[round_point(point) for point in ring] for ring in polygon] for polygon in parks],
        "routes": routes,
        "stations": [
            {
                "id": station["id"],
                "name": station["name"],
                "point": round_point(station["point"]),
                "routes": station["routes"],
            }
            for station in stations
        ],
        "routeStates": route_states,
        "stationStates": station_states,
        "routeWaits": route_waits,
        "adjacency": adjacency,
        "cells": cells,
        "mask": mask,
        "routeStyles": route_styles,
    }

    SITE_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SITE_DATA_PATH.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    print(
        f"Wrote {SITE_DATA_PATH} "
        f"({SITE_DATA_PATH.stat().st_size / 1_000_000:.2f} MB, "
        f"{len(stations)} stations, {len(route_states)} states, "
        f"{len(cells)} cells, {len(routes)} route segments)"
    )


if __name__ == "__main__":
    main()
