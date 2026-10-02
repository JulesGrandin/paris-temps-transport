const DATA_URL = new URL("./data/commute_map_data.json?v=rer-c-stitch", import.meta.url).toString();
const MIN_VIEWPORT_SCALE = 0.22;
const MAX_VIEWPORT_SCALE = 3.6;
const VIEWPORT_ZOOM_STEP = 1.32;
const DEFAULT_VIEWPORT_SCALE = 0.72 / VIEWPORT_ZOOM_STEP;
const PANEL_PADDING = 22;
const ROUTE_LINE_WIDTH = 2.05;
const WEIGHT_BLUR_PASSES = 2;
const WEIGHT_BLUR_RADIUS = 2;
const HOVER_DEADBAND = 12;
const PIN_HIT_RADIUS = 32;
const PIN_TAP_SLOP = 8;
const REACHABILITY_THRESHOLD_MINUTES = 30;
const OUTLINE_OPTIONS = [15, 30, 45, 60];
const DEFAULT_OUTLINE_MINUTES = [15, 30];
const OUTLINE_WIDTHS = { 15: 1.1, 30: 1.9, 45: 2.75, 60: 3.6 };
const OUTLINE_LABEL_DIRS = {
  15: [-0.92, -0.78],
  30: [0.72, -0.7],
  45: [-0.12, -1],
  60: [-0.88, -0.42],
};
const DEFAULT_MAX_TIME_MINUTES = 40;
const DEFAULT_ORIGIN = {
  lat: 48.874729,
  lon: 2.295510,
  label: "Charles De Gaulle-Étoile",
};
const SHARE_DECIMALS = 5;

const state = {
  data: null,
  ready: false,
  outlineMinutes: [...DEFAULT_OUTLINE_MINUTES],
  maxTransitTime: DEFAULT_MAX_TIME_MINUTES,
  viewportScale: DEFAULT_VIEWPORT_SCALE,
  viewportCenter: null,
  originPoint: null,
  originLabel: null,
  pinned: false,
  probePoint: null,
  probePinned: false,
  heatmapFrom: "origin",
  currentRender: null,
  dragTarget: null,
  dragPointerId: null,
  dragMoved: false,
  dragStartScreen: null,
  pinHits: { origin: null, probe: null },
  dirty: false,
};

const mapCanvas = document.getElementById("mapCanvas");
const mapStage = document.getElementById("mapStage");
const ctx = mapCanvas.getContext("2d");
const statusText = document.getElementById("statusText");
const reachText = document.getElementById("reachText");
const legend = document.getElementById("legend");
const legendMax = document.getElementById("legendMax");
const maxTimeInput = document.getElementById("maxTimeInput");
const maxTimeLabel = document.getElementById("maxTimeLabel");
const helpPanel = document.getElementById("helpPanel");
const sharePanel = document.getElementById("sharePanel");
const shareUrl = document.getElementById("shareUrl");
const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
const settingsClose = document.getElementById("settingsClose");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function bilerpPoint(p00, p10, p01, p11, tx, ty) {
  return [
    lerp(lerp(p00[0], p10[0], tx), lerp(p01[0], p11[0], tx), ty),
    lerp(lerp(p00[1], p10[1], tx), lerp(p01[1], p11[1], tx), ty),
  ];
}

function triangleArea(a, b, c) {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

function quadArea(p00, p10, p11, p01) {
  return Math.abs(triangleArea(p00, p10, p11) + triangleArea(p00, p11, p01));
}

function barycentricWeights(point, a, b, c) {
  const area = triangleArea(a, b, c);
  if (Math.abs(area) < 1e-6) return null;
  const wA = triangleArea(point, b, c) / area;
  const wB = triangleArea(a, point, c) / area;
  const wC = triangleArea(a, b, point) / area;
  if (wA < -1e-4 || wB < -1e-4 || wC < -1e-4) return null;
  return [wA, wB, wC];
}

function interpolateTriangle(weights, a, b, c) {
  return [
    weights[0] * a[0] + weights[1] * b[0] + weights[2] * c[0],
    weights[0] * a[1] + weights[1] * b[1] + weights[2] * c[1],
  ];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const intersects = y1 > point[1] !== y2 > point[1] && point[0] < ((x2 - x1) * (point[1] - y1)) / ((y2 - y1) || 1e-12) + x1;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
}

function pointInLand(point) {
  return state.data.boroughs.some((borough) => borough.polygons.some((polygon) => pointInPolygon(point, polygon)));
}

function worldToLonLat(point) {
  const lat0 = state.data.meta.lat0;
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.cos((lat0 * Math.PI) / 180);
  return { lon: point[0] / metersPerDegLon, lat: point[1] / metersPerDegLat };
}

function lonLatToWorld(lon, lat) {
  const lat0 = state.data.meta.lat0;
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.cos((lat0 * Math.PI) / 180);
  return [lon * metersPerDegLon, lat * metersPerDegLat];
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "< 1 min";
  return `${Math.round(minutes)} min`;
}

function formatCoord(value) {
  return Number(value).toFixed(SHARE_DECIMALS);
}

function heatmapColor(minutes, alpha = 0.58) {
  const t = clamp(minutes / state.maxTransitTime, 0, 1);
  const stops = [
    { t: 0, color: [220, 69, 37] },
    { t: 0.2, color: [244, 127, 46] },
    { t: 0.4, color: [255, 196, 79] },
    { t: 0.62, color: [248, 232, 156] },
    { t: 0.8, color: [149, 188, 211] },
    { t: 1, color: [74, 103, 141] },
  ];
  let left = stops[0];
  let right = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      left = stops[i];
      right = stops[i + 1];
      break;
    }
  }
  const mix = (t - left.t) / (right.t - left.t || 1);
  const rgb = left.color.map((value, i) => Math.round(value + (right.color[i] - value) * mix));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function boundsCenter(bounds) {
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

function viewBounds() {
  return state.data.meta.parisBounds || state.data.meta.bounds;
}

function defaultCenter() {
  return boundsCenter(viewBounds());
}

function fitScaleFor(bounds, width, height) {
  const [minX, minY, maxX, maxY] = bounds;
  return Math.min((width - PANEL_PADDING * 2) / (maxX - minX), (height - PANEL_PADDING * 2) / (maxY - minY));
}

function minViewportScale(width, height) {
  const fitParis = fitScaleFor(viewBounds(), width, height);
  const fitAll = fitScaleFor(state.data.meta.bounds, width, height);
  return clamp(fitAll / fitParis, MIN_VIEWPORT_SCALE, 1);
}

function buildTransform(bounds, width, height, zoom, centerPoint) {
  const [minX, minY, maxX, maxY] = bounds;
  const scale = Math.min((width - PANEL_PADDING * 2) / (maxX - minX), (height - PANEL_PADDING * 2) / (maxY - minY)) * zoom;
  const [centerX, centerY] = centerPoint || defaultCenter();
  return {
    scale,
    toScreen(point) {
      return [width / 2 + (point[0] - centerX) * scale, height / 2 - (point[1] - centerY) * scale];
    },
    toWorld(x, y) {
      return [centerX + (x - width / 2) / scale, centerY - (y - height / 2) / scale];
    },
  };
}

function nearestStations(point, count) {
  return state.data.stations
    .map((station, index) => ({
      index,
      name: station.name,
      walkMinutes: distance(point, station.point) / state.data.meta.walkMetersPerMinute + state.data.meta.stationAccessPenalty,
    }))
    .sort((a, b) => a.walkMinutes - b.walkMinutes)
    .slice(0, count);
}

function runDijkstra(origin) {
  const { routeStates, stationStates, adjacency, routeWaits, meta } = state.data;
  const distances = new Array(routeStates.length).fill(Infinity);
  const visited = new Array(routeStates.length).fill(false);
  const seeds = nearestStations(origin, meta.originStationCount);

  for (const seed of seeds) {
    for (const routeStateIndex of stationStates[seed.index] || []) {
      const wait = routeWaits[routeStates[routeStateIndex].routeId] ?? meta.defaultBoardWait;
      distances[routeStateIndex] = Math.min(distances[routeStateIndex], seed.walkMinutes + wait);
    }
  }

  for (let step = 0; step < routeStates.length; step += 1) {
    let current = -1;
    let best = Infinity;
    for (let i = 0; i < distances.length; i += 1) {
      if (!visited[i] && distances[i] < best) {
        best = distances[i];
        current = i;
      }
    }
    if (current === -1) break;
    visited[current] = true;
    for (const [toIndex, weight] of adjacency[current]) {
      const candidate = distances[current] + weight;
      if (candidate < distances[toIndex]) distances[toIndex] = candidate;
    }
  }
  return { distances, seeds };
}

function estimateTravel(origin, distances, destination, nearby = null) {
  const walk = state.data.meta.walkMetersPerMinute;
  const access = state.data.meta.stationAccessPenalty;
  let best = distance(origin, destination) / walk;
  const stations = nearby || nearestStations(destination, state.data.meta.cellNearestStations);
  for (const station of stations) {
    const index = station.index ?? station[0];
    const walkMinutes =
      station.walkMinutes ?? distance(destination, state.data.stations[index].point) / walk + access;
    for (const routeStateIndex of state.data.stationStates[index] || []) {
      best = Math.min(best, distances[routeStateIndex] + walkMinutes);
    }
  }
  return best;
}

function summarizeReachability(origin, distances) {
  const access = state.data.meta.stationAccessPenalty;
  const walk = state.data.meta.walkMetersPerMinute;
  let reachable = 0;
  for (let index = 0; index < state.data.stations.length; index += 1) {
    let best = distance(origin, state.data.stations[index].point) / walk + access;
    for (const routeStateIndex of state.data.stationStates[index] || []) {
      best = Math.min(best, distances[routeStateIndex] + access);
    }
    if (best <= REACHABILITY_THRESHOLD_MINUTES) reachable += 1;
  }
  return { reachable, total: state.data.stations.length };
}

function computeWarp(origin, { fast = false } = {}) {
  const { distances, seeds } = runDijkstra(origin);
  const { gridCols, gridRows, bounds } = state.data.meta;
  const [minX, minY, maxX, maxY] = bounds;
  const cellW = (maxX - minX) / gridCols;
  const cellH = (maxY - minY) / gridRows;
  const minuteGrid = Array.from({ length: gridRows }, () => new Array(gridCols).fill(Infinity));
  const validMask = Array.from({ length: gridRows }, () => new Array(gridCols).fill(false));

  for (const cellIndex of state.data.mask) {
    if (cellIndex === -1) continue;
    const cell = state.data.cells[cellIndex];
    minuteGrid[cell.row][cell.col] = estimateTravel(origin, distances, cell.point, cell.access);
    validMask[cell.row][cell.col] = true;
  }

  let smoothed = minuteGrid.map((row) => row.slice());
  const blurPasses = fast ? 1 : WEIGHT_BLUR_PASSES;
  for (let pass = 0; pass < blurPasses; pass += 1) {
    const next = Array.from({ length: gridRows }, () => new Array(gridCols).fill(Infinity));
    for (let row = 0; row < gridRows; row += 1) {
      for (let col = 0; col < gridCols; col += 1) {
        if (!validMask[row][col]) continue;
        let total = 0;
        let count = 0;
        for (let y = Math.max(0, row - WEIGHT_BLUR_RADIUS); y <= Math.min(gridRows - 1, row + WEIGHT_BLUR_RADIUS); y += 1) {
          for (let x = Math.max(0, col - WEIGHT_BLUR_RADIUS); x <= Math.min(gridCols - 1, col + WEIGHT_BLUR_RADIUS); x += 1) {
            if (!validMask[y][x]) continue;
            total += smoothed[y][x];
            count += 1;
          }
        }
        next[row][col] = count ? total / count : smoothed[row][col];
      }
    }
    smoothed = next;
  }

  return {
    distances,
    seeds,
    reachability: fast ? null : summarizeReachability(origin, distances),
    minutes: smoothed,
    validMask,
    cellW,
    cellH,
    bounds,
  };
}

function createCanvasBacking(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function tracePolygon(drawCtx, polygon, projectPoint) {
  for (const ring of polygon) {
    drawCtx.moveTo(...projectPoint(ring[0]));
    for (let i = 1; i < ring.length; i += 1) drawCtx.lineTo(...projectPoint(ring[i]));
    drawCtx.closePath();
  }
}

function drawPolyline(drawCtx, points, projectPoint) {
  if (points.length < 2) return;
  drawCtx.beginPath();
  drawCtx.moveTo(...projectPoint(points[0]));
  for (let i = 1; i < points.length; i += 1) drawCtx.lineTo(...projectPoint(points[i]));
  drawCtx.stroke();
}

function drawBasemap(drawCtx, projectPoint) {
  drawCtx.fillStyle = "#c5d0db";
  for (const borough of state.data.boroughs) {
    for (const polygon of borough.polygons) {
      drawCtx.beginPath();
      tracePolygon(drawCtx, polygon, projectPoint);
      drawCtx.fill();
    }
  }

  for (const polygon of state.data.parks) {
    drawCtx.beginPath();
    tracePolygon(drawCtx, polygon, projectPoint);
    drawCtx.fillStyle = "#d4e4c6";
    drawCtx.strokeStyle = "#a9c49a";
    drawCtx.lineWidth = 0.5;
    drawCtx.fill();
    drawCtx.stroke();
  }

  for (const route of state.data.routes) {
    drawCtx.strokeStyle = route.color;
    drawCtx.lineWidth = ROUTE_LINE_WIDTH;
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
    drawPolyline(drawCtx, route.points, projectPoint);
  }
}

function drawDepartmentLimits(drawCtx, projectPoint) {
  drawCtx.strokeStyle = "#d8d8d8";
  drawCtx.lineWidth = 1.05;
  drawCtx.lineJoin = "round";
  drawCtx.lineCap = "round";
  for (const borough of state.data.boroughs) {
    const rings = borough.outline?.length ? borough.outline : [];
    for (const ring of rings) {
      if (ring.length < 2) continue;
      drawCtx.beginPath();
      drawCtx.moveTo(...projectPoint(ring[0]));
      for (let i = 1; i < ring.length; i += 1) drawCtx.lineTo(...projectPoint(ring[i]));
      drawCtx.closePath();
      drawCtx.stroke();
    }
  }
}

function drawStations(drawCtx, projectPoint) {
  for (const station of state.data.stations) {
    const [x, y] = projectPoint(station.point);
    drawCtx.beginPath();
    drawCtx.arc(x, y, 1.4, 0, Math.PI * 2);
    drawCtx.fillStyle = "#fff";
    drawCtx.fill();
    drawCtx.lineWidth = 0.55;
    drawCtx.strokeStyle = "#5a6e84";
    drawCtx.stroke();
  }
}

function drawHeatmap(drawCtx, warp, projectPoint) {
  const { minutes, validMask } = warp;
  for (let row = 0; row < minutes.length; row += 1) {
    for (let col = 0; col < minutes[row].length; col += 1) {
      if (!validMask[row][col]) continue;
      const p00 = projectPoint([warp.bounds[0] + col * warp.cellW, warp.bounds[1] + row * warp.cellH]);
      const p10 = projectPoint([warp.bounds[0] + (col + 1) * warp.cellW, warp.bounds[1] + row * warp.cellH]);
      const p11 = projectPoint([warp.bounds[0] + (col + 1) * warp.cellW, warp.bounds[1] + (row + 1) * warp.cellH]);
      const p01 = projectPoint([warp.bounds[0] + col * warp.cellW, warp.bounds[1] + (row + 1) * warp.cellH]);
      drawCtx.beginPath();
      drawCtx.moveTo(...p00);
      drawCtx.lineTo(...p10);
      drawCtx.lineTo(...p11);
      drawCtx.lineTo(...p01);
      drawCtx.closePath();
      drawCtx.fillStyle = heatmapColor(minutes[row][col]);
      drawCtx.fill();
    }
  }
}

function cellValue(minutes, validMask, row, col, threshold) {
  if (row < 0 || col < 0 || row >= minutes.length || col >= minutes[0].length || !validMask[row][col]) {
    return threshold + 1;
  }
  return minutes[row][col];
}

function interpolateThreshold(a, va, b, vb, threshold) {
  const t = clamp((threshold - va) / (vb - va || 1e-9), 0, 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function contourSegments(warp, threshold) {
  const { minutes, validMask, bounds, cellW, cellH } = warp;
  const center = (row, col) => [bounds[0] + (col + 0.5) * cellW, bounds[1] + (row + 0.5) * cellH];
  const segments = [];
  for (let row = 0; row < minutes.length - 1; row += 1) {
    for (let col = 0; col < minutes[row].length - 1; col += 1) {
      const bl = center(row, col);
      const br = center(row, col + 1);
      const tr = center(row + 1, col + 1);
      const tl = center(row + 1, col);
      const vbl = cellValue(minutes, validMask, row, col, threshold);
      const vbr = cellValue(minutes, validMask, row, col + 1, threshold);
      const vtr = cellValue(minutes, validMask, row + 1, col + 1, threshold);
      const vtl = cellValue(minutes, validMask, row + 1, col, threshold);
      const code =
        (vbl <= threshold ? 1 : 0) |
        (vbr <= threshold ? 2 : 0) |
        (vtr <= threshold ? 4 : 0) |
        (vtl <= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const bottom = () => interpolateThreshold(bl, vbl, br, vbr, threshold);
      const right = () => interpolateThreshold(br, vbr, tr, vtr, threshold);
      const top = () => interpolateThreshold(tl, vtl, tr, vtr, threshold);
      const left = () => interpolateThreshold(bl, vbl, tl, vtl, threshold);
      const pairs = {
        1: [left, bottom],
        2: [bottom, right],
        3: [left, right],
        4: [right, top],
        5: [left, top, bottom, right],
        6: [bottom, top],
        7: [left, top],
        8: [left, top],
        9: [bottom, top],
        10: [left, bottom, right, top],
        11: [right, top],
        12: [left, right],
        13: [bottom, right],
        14: [left, bottom],
      }[code];
      for (let i = 0; i < pairs.length; i += 2) {
        segments.push([pairs[i](), pairs[i + 1]()]);
      }
    }
  }
  return segments;
}

function pointKey(point) {
  return `${point[0].toFixed(1)},${point[1].toFixed(1)}`;
}

function ringLength(ring) {
  let length = 0;
  for (let i = 1; i < ring.length; i += 1) length += distance(ring[i - 1], ring[i]);
  return length;
}

function chainContourRings(segments) {
  const adjacency = new Map();
  const addEdge = (a, b) => {
    const ka = pointKey(a);
    const kb = pointKey(b);
    if (ka === kb) return;
    if (!adjacency.has(ka)) adjacency.set(ka, []);
    adjacency.get(ka).push([ka, a, kb, b]);
  };
  for (const [a, b] of segments) {
    addEdge(a, b);
    addEdge(b, a);
  }
  const used = new Set();
  const edgeKey = (ka, kb) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
  const rings = [];
  for (const [startKey, edges] of adjacency.entries()) {
    for (const [, startPoint, firstKey, firstPoint] of edges) {
      if (used.has(edgeKey(startKey, firstKey))) continue;
      const ring = [startPoint];
      let currentKey = firstKey;
      let currentPoint = firstPoint;
      used.add(edgeKey(startKey, firstKey));
      while (currentKey !== startKey) {
        ring.push(currentPoint);
        const next = (adjacency.get(currentKey) || []).find(([, , nextKey]) => !used.has(edgeKey(currentKey, nextKey)));
        if (!next) break;
        used.add(edgeKey(currentKey, next[2]));
        currentKey = next[2];
        currentPoint = next[3];
      }
      if (ring.length >= 14) rings.push(ring);
    }
  }
  rings.sort((a, b) => ringLength(b) - ringLength(a));
  return rings;
}

function contourLabelSite(ring, origin, dir, projectPoint, width, height) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const from = ring[i];
    const to = ring[i + 1];
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const [x, y] = projectPoint(mid);
    if (x < 36 || y < 28 || x > width - 36 || y > height - 28) continue;
    const align = (mid[0] - origin[0]) * dir[0] + (mid[1] - origin[1]) * dir[1];
    const score = align + distance(from, to) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      const screenFrom = projectPoint(from);
      const screenTo = projectPoint(to);
      best = { world: mid, screen: [x, y], tangent: [screenTo[0] - screenFrom[0], screenTo[1] - screenFrom[1]] };
    }
  }
  return best;
}

function drawContourLabel(drawCtx, site, text) {
  let angle = Math.atan2(site.tangent[1], site.tangent[0]);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  drawCtx.save();
  drawCtx.translate(site.screen[0], site.screen[1]);
  drawCtx.rotate(angle);
  drawCtx.font = "700 12px Outfit, sans-serif";
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";
  drawCtx.strokeStyle = "rgba(255,252,247,0.94)";
  drawCtx.lineWidth = 5;
  drawCtx.lineJoin = "round";
  drawCtx.strokeText(text, 0, 0);
  drawCtx.fillStyle = "#111111";
  drawCtx.fillText(text, 0, 0);
  drawCtx.restore();
}

function drawOutline(drawCtx, warp, projectPoint) {
  const rect = mapCanvas.getBoundingClientRect();
  const origin = heatmapSourcePoint() || defaultCenter();
  const labels = [];
  drawCtx.strokeStyle = "#111111";
  drawCtx.lineJoin = "round";
  drawCtx.lineCap = "round";
  for (const threshold of [...state.outlineMinutes].sort((a, b) => a - b)) {
    const segments = contourSegments(warp, threshold);
    if (!segments.length) continue;
    const rings = chainContourRings(segments);
    drawCtx.lineWidth = OUTLINE_WIDTHS[threshold] || 2;
    drawCtx.beginPath();
    for (const [a, b] of segments) {
      drawCtx.moveTo(...projectPoint(a));
      drawCtx.lineTo(...projectPoint(b));
    }
    drawCtx.stroke();
    const mainRing = rings[0];
    if (!mainRing) continue;
    const site = contourLabelSite(mainRing, origin, OUTLINE_LABEL_DIRS[threshold] || [1, 0], projectPoint, rect.width, rect.height);
    if (site) labels.push({ site, text: `${threshold} min` });
  }
  for (const label of labels) drawContourLabel(drawCtx, label.site, label.text);
}

function drawMarker(drawCtx, screen, color, radius = 6) {
  drawCtx.beginPath();
  drawCtx.arc(screen[0], screen[1], radius + 7, 0, Math.PI * 2);
  drawCtx.fillStyle = `${color}33`;
  drawCtx.fill();
  drawCtx.beginPath();
  drawCtx.arc(screen[0], screen[1], radius, 0, Math.PI * 2);
  drawCtx.fillStyle = color;
  drawCtx.fill();
  drawCtx.lineWidth = 2;
  drawCtx.strokeStyle = "#fff";
  drawCtx.stroke();
}

function drawLabelBubble(drawCtx, screen, lines, color) {
  const padX = 12;
  const padY = 8;
  const lineHeight = 16;
  drawCtx.font = "600 13px Outfit, sans-serif";
  drawCtx.textAlign = "center";
  drawCtx.textBaseline = "middle";
  const width = Math.ceil(Math.max(...lines.map((line) => drawCtx.measureText(line).width))) + padX * 2;
  const height = padY * 2 + lines.length * lineHeight;
  const canvasWidth = mapCanvas.getBoundingClientRect().width;
  const canvasHeight = mapCanvas.getBoundingClientRect().height;
  const x = clamp(screen[0] + 14, 8, canvasWidth - width - 8);
  const y = clamp(screen[1] - height - 10, 8, canvasHeight - height - 8);
  drawCtx.fillStyle = "rgba(255,252,247,0.94)";
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = 1.2;
  drawCtx.beginPath();
  if (typeof drawCtx.roundRect === "function") {
    drawCtx.roundRect(x, y, width, height, 10);
  } else {
    drawCtx.rect(x, y, width, height);
  }
  drawCtx.fill();
  drawCtx.stroke();
  drawCtx.fillStyle = "#1c2f42";
  lines.forEach((line, i) => {
    drawCtx.fillText(line, x + width / 2, y + padY + lineHeight * i + lineHeight / 2);
  });
  drawCtx.textAlign = "left";
  drawCtx.textBaseline = "alphabetic";
  return { x, y, width, height };
}

function nearestStationName(point) {
  return nearestStations(point, 1)[0]?.name || "Paris";
}

function heatmapSourcePoint() {
  if (state.heatmapFrom === "probe" && state.probePoint) return state.probePoint;
  return state.originPoint;
}

function heatmapOtherPoint() {
  const source = heatmapSourcePoint();
  if (!source) return null;
  if (source === state.probePoint) return state.originPoint;
  return state.probePoint;
}

function syncStatus(warp, travelMinutes) {
  const source = heatmapSourcePoint();
  if (!source) {
    statusText.textContent = "Survolez la carte pour choisir un départ.";
    reachText.textContent = "Choisissez un point pour voir la part du réseau joignable en 30 minutes.";
    return;
  }
  const sourceName = state.heatmapFrom === "origin" && state.originLabel ? state.originLabel : nearestStationName(source);
  const other = heatmapOtherPoint();
  if (Number.isFinite(travelMinutes) && other) {
    statusText.textContent = `${formatMinutes(travelMinutes)} entre ${sourceName} et ${nearestStationName(other)}`;
  } else {
    const prefix = state.pinned ? "Carte depuis" : "Près de";
    statusText.textContent = `${prefix} ${sourceName}`;
  }
  if (warp?.reachability) {
    const { reachable, total } = warp.reachability;
    const percent = Math.round((reachable / total) * 100);
    reachText.textContent = `${percent} % des stations métro/RER sont joignables en ${REACHABILITY_THRESHOLD_MINUTES} minutes depuis ce point.`;
  }
}

function nearestLandPoint(point) {
  if (!point) return null;
  if (pointInLand(point)) return point;
  let best = null;
  let bestDistance = Infinity;
  for (const cell of state.data.cells) {
    const next = distance(point, cell.point);
    if (next < bestDistance) {
      bestDistance = next;
      best = cell.point;
    }
  }
  return best;
}

function screenHitsPin(screen, hit) {
  if (!hit) return false;
  if (distance(screen, hit.screen) <= PIN_HIT_RADIUS) return true;
  const { x, y, width, height } = hit.label;
  return screen[0] >= x - 6 && screen[0] <= x + width + 6 && screen[1] >= y - 6 && screen[1] <= y + height + 6;
}

function syncCursor(screen = null) {
  if (state.dragTarget) {
    mapCanvas.style.cursor = "grabbing";
    return;
  }
  if (screen && hitPin(screen)) {
    mapCanvas.style.cursor = "grab";
    return;
  }
  mapCanvas.style.cursor = "crosshair";
}

function drawMap() {
  if (!state.ready) return;
  const { width, height } = createCanvasBacking(mapCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#efe6d6";
  ctx.fillRect(0, 0, width, height);

  const source = heatmapSourcePoint();
  const other = heatmapOtherPoint();
  const warp = source ? computeWarp(source, { fast: Boolean(state.dragTarget) }) : null;
  const parisBounds = viewBounds();
  const scaleMul = clamp(state.viewportScale, minViewportScale(width, height), MAX_VIEWPORT_SCALE);
  const focus = scaleMul > 1.02 ? (state.probePoint && state.originPoint ? [(state.originPoint[0] + state.probePoint[0]) / 2, (state.originPoint[1] + state.probePoint[1]) / 2] : source || defaultCenter()) : defaultCenter();
  const transform = buildTransform(parisBounds, width, height, scaleMul, focus);
  const projectPoint = (point) => transform.toScreen(point);

  drawBasemap(ctx, projectPoint);
  if (warp) drawHeatmap(ctx, warp, projectPoint);
  drawDepartmentLimits(ctx, projectPoint);
  drawStations(ctx, projectPoint);
  if (warp && state.outlineMinutes.length) drawOutline(ctx, warp, projectPoint);

  let travelMinutes = null;
  if (warp && other) travelMinutes = estimateTravel(source, warp.distances, other);
  state.pinHits = { origin: null, probe: null };

  if (state.probePoint) {
    const probeIsSource = state.heatmapFrom === "probe";
    const probeScreen = projectPoint(state.probePoint);
    drawMarker(ctx, probeScreen, "#1c2f42", probeIsSource || state.dragTarget === "probe" ? 7 : 5);
    const probeLines = probeIsSource
      ? ["Arrivée", nearestStationName(state.probePoint)]
      : [formatMinutes(travelMinutes), `vers ${nearestStationName(state.probePoint)}`];
    const probeLabel = drawLabelBubble(ctx, probeScreen, probeLines, "#1c2f42");
    state.pinHits.probe = { screen: probeScreen, label: probeLabel };
  }
  if (state.originPoint) {
    const originIsSource = state.heatmapFrom !== "probe" || !state.probePoint;
    const originScreen = projectPoint(state.originPoint);
    drawMarker(ctx, originScreen, "#c44b2b", state.pinned || state.dragTarget === "origin" ? 7 : 6);
    const originName = state.originLabel || nearestStationName(state.originPoint);
    const originLines = originIsSource
      ? ["Départ", originName]
      : [formatMinutes(travelMinutes), originName];
    const originLabel = drawLabelBubble(ctx, originScreen, originLines, "#c44b2b");
    state.pinHits.origin = { screen: originScreen, label: originLabel };
  }

  state.currentRender = { warp, transform };
  legend.hidden = !warp;
  legendMax.textContent = `${state.maxTransitTime} min`;
  syncStatus(warp, travelMinutes);
  state.dirty = false;
}

function requestDraw() {
  if (state.dirty) return;
  state.dirty = true;
  requestAnimationFrame(drawMap);
}

function pointerToWorld(event) {
  const rect = mapCanvas.getBoundingClientRect();
  const screen = [event.clientX - rect.left, event.clientY - rect.top];
  if (!state.currentRender) return { screen, world: null };
  const world = state.currentRender.transform.toWorld(screen[0], screen[1]);
  return { screen, world };
}

function hitPin(screen) {
  const originHit = state.pinned && screenHitsPin(screen, state.pinHits.origin);
  const probeHit = state.probePoint && screenHitsPin(screen, state.pinHits.probe);
  if (originHit && probeHit) {
    return distance(screen, state.pinHits.origin.screen) <= distance(screen, state.pinHits.probe.screen) ? "origin" : "probe";
  }
  if (originHit) return "origin";
  if (probeHit) return "probe";
  return null;
}

function setOrigin(world, { pin = false, label = null, silent = false } = {}) {
  const snapped = nearestLandPoint(world);
  if (!snapped) return;
  state.originPoint = snapped;
  state.originLabel = label;
  state.pinned = pin;
  requestDraw();
  if (!silent) syncUrl();
}

function setProbe(world, pinned = false, { silent = false } = {}) {
  const snapped = nearestLandPoint(world);
  if (!snapped) return;
  state.probePoint = snapped;
  state.probePinned = pinned;
  requestDraw();
  if (!silent) syncUrl();
}

function endDrag(event) {
  if (!state.dragTarget) return;
  const moved = state.dragMoved;
  const target = state.dragTarget;
  state.dragTarget = null;
  state.dragPointerId = null;
  state.dragMoved = false;
  state.dragStartScreen = null;
  try {
    if (event && mapCanvas.hasPointerCapture(event.pointerId)) mapCanvas.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }
  if (!moved && target === "origin") {
    /* keep the pin; a click without drag just selects it */
  }
  syncUrl();
  requestDraw();
  syncCursor();
}

function parsePair(value) {
  if (!value) return null;
  const match = String(value).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return lonLatToWorld(Number(match[2]), Number(match[1]));
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.originPoint) {
    const { lat, lon } = worldToLonLat(state.originPoint);
    params.set("origin", `${formatCoord(lat)},${formatCoord(lon)}`);
  }
  if (state.probePoint) {
    const { lat, lon } = worldToLonLat(state.probePoint);
    params.set("distance", `${formatCoord(lat)},${formatCoord(lon)}`);
  }
  const outline = [...state.outlineMinutes].sort((a, b) => a - b);
  const defaultOutline = DEFAULT_OUTLINE_MINUTES.join(",");
  if (!outline.length) params.set("outline", "0");
  else if (outline.join(",") !== defaultOutline) params.set("outline", outline.join(","));
  if (state.maxTransitTime !== DEFAULT_MAX_TIME_MINUTES) params.set("max", String(state.maxTransitTime));
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function restoreUrl() {
  const params = new URLSearchParams(location.search);
  const origin = parsePair(params.get("origin"));
  const probe = parsePair(params.get("distance"));
  const outlineParam = params.get("outline");
  if (outlineParam === "0") {
    state.outlineMinutes = [];
  } else if (outlineParam === "1") {
    state.outlineMinutes = [...DEFAULT_OUTLINE_MINUTES];
  } else if (outlineParam) {
    state.outlineMinutes = outlineParam
      .split(",")
      .map(Number)
      .filter((value) => OUTLINE_OPTIONS.includes(value));
  }
  syncOutlineToggles();
  const max = Number(params.get("max"));
  if (Number.isFinite(max) && max >= 20 && max <= 90) {
    state.maxTransitTime = max;
    maxTimeInput.value = String(max);
    maxTimeLabel.textContent = `Temps max. ${max} min`;
  }
  if (origin) {
    setOrigin(origin, { pin: true });
  } else {
    setOrigin(lonLatToWorld(DEFAULT_ORIGIN.lon, DEFAULT_ORIGIN.lat), {
      pin: true,
      label: DEFAULT_ORIGIN.label,
    });
  }
  if (probe) setProbe(probe, true);
}

mapCanvas.addEventListener("pointermove", (event) => {
  const { screen, world } = pointerToWorld(event);
  if (!world) return;
  if (state.dragTarget && state.dragPointerId === event.pointerId) {
    if (state.dragStartScreen && distance(screen, state.dragStartScreen) > PIN_TAP_SLOP) {
      state.dragMoved = true;
    }
    if (state.dragTarget === "origin") {
      setOrigin(world, { pin: true, label: null, silent: true });
    } else {
      setProbe(world, true, { silent: true });
    }
    syncCursor(screen);
    return;
  }
  syncCursor(screen);
  if (!state.pinned) {
    if (state.originPoint && distance(state.originPoint, world) < HOVER_DEADBAND) return;
    setOrigin(world, { silent: true });
    return;
  }
  if (!state.probePinned && !hitPin(screen)) {
    if (state.probePoint && distance(state.probePoint, world) < HOVER_DEADBAND) return;
    setProbe(world, false, { silent: true });
  }
});

mapCanvas.addEventListener("pointerdown", (event) => {
  const { screen, world } = pointerToWorld(event);
  if (!world) return;
  const hit = hitPin(screen);
  const target = hit || (state.pinned ? "probe" : "origin");
  event.preventDefault();
  state.dragTarget = target;
  state.dragPointerId = event.pointerId;
  state.dragMoved = false;
  state.dragStartScreen = screen;
  state.heatmapFrom = target;
  mapCanvas.setPointerCapture(event.pointerId);
  if (hit) {
    requestDraw();
  } else if (target === "origin") {
    setOrigin(world, { pin: true, label: null, silent: true });
  } else {
    setProbe(world, true, { silent: true });
  }
  syncCursor(screen);
});

mapCanvas.addEventListener("pointerup", endDrag);
mapCanvas.addEventListener("pointercancel", endDrag);

mapCanvas.addEventListener("dblclick", (event) => {
  const { screen } = pointerToWorld(event);
  const hit = hitPin(screen);
  if (hit === "probe") {
    state.probePoint = null;
    state.probePinned = false;
    state.heatmapFrom = "origin";
    requestDraw();
    syncUrl();
  } else if (hit === "origin") {
    state.originPoint = null;
    state.originLabel = null;
    state.pinned = false;
    state.probePoint = null;
    state.probePinned = false;
    state.heatmapFrom = "origin";
    requestDraw();
    syncUrl();
  }
});

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) sharePanel.hidden = true;
}

settingsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setSettingsOpen(settingsPanel.hidden);
});
settingsClose.addEventListener("click", () => setSettingsOpen(false));
document.addEventListener("click", (event) => {
  if (settingsPanel.hidden) return;
  if (settingsPanel.contains(event.target) || settingsButton.contains(event.target)) return;
  setSettingsOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsPanel.hidden) setSettingsOpen(false);
});

function syncOutlineToggles() {
  for (const minutes of OUTLINE_OPTIONS) {
    const input = document.querySelector(`[data-outline="${minutes}"]`);
    if (input) input.checked = state.outlineMinutes.includes(minutes);
  }
}

document.getElementById("outlineOptions").addEventListener("change", () => {
  state.outlineMinutes = OUTLINE_OPTIONS.filter((minutes) => {
    const input = document.querySelector(`[data-outline="${minutes}"]`);
    return Boolean(input?.checked);
  });
  requestDraw();
  syncUrl();
});
maxTimeInput.addEventListener("input", (event) => {
  state.maxTransitTime = Number(event.target.value);
  maxTimeLabel.textContent = `Temps max. ${state.maxTransitTime} min`;
  requestDraw();
  syncUrl();
});
document.getElementById("helpButton").addEventListener("click", () => {
  helpPanel.hidden = !helpPanel.hidden;
});
document.getElementById("zoomInButton").addEventListener("click", () => {
  const { width, height } = mapCanvas.getBoundingClientRect();
  state.viewportScale = clamp(state.viewportScale * VIEWPORT_ZOOM_STEP, minViewportScale(width, height), MAX_VIEWPORT_SCALE);
  requestDraw();
});
document.getElementById("zoomOutButton").addEventListener("click", () => {
  const { width, height } = mapCanvas.getBoundingClientRect();
  state.viewportScale = clamp(state.viewportScale / VIEWPORT_ZOOM_STEP, minViewportScale(width, height), MAX_VIEWPORT_SCALE);
  requestDraw();
});
document.getElementById("fullscreenButton").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else mapStage.requestFullscreen();
});
document.getElementById("shareButton").addEventListener("click", () => {
  sharePanel.hidden = !sharePanel.hidden;
  shareUrl.textContent = location.href;
  if (!sharePanel.hidden) setSettingsOpen(false);
});
document.getElementById("copyLinkButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  document.getElementById("copyLinkButton").textContent = "Copié";
  setTimeout(() => {
    document.getElementById("copyLinkButton").textContent = "Copier le lien";
  }, 1400);
});
document.getElementById("locateButton").addEventListener("click", () => {
  if (!navigator.geolocation) {
    statusText.textContent = "Géolocalisation indisponible.";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const world = lonLatToWorld(position.coords.longitude, position.coords.latitude);
      if (!pointInLand(world)) {
        statusText.textContent = "Votre position est hors de la carte.";
        return;
      }
      setOrigin(world, { pin: true, label: "Ma position" });
    },
    () => {
      statusText.textContent = "Impossible de lire la position.";
    },
  );
});
window.addEventListener("resize", requestDraw);

async function init() {
  const response = await fetch(DATA_URL);
  state.data = await response.json();
  state.ready = true;
  restoreUrl();
  state.dirty = false;
  requestDraw();
}

init();
