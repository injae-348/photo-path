/* ============================ 투영 · 기하 ============================ */
'use strict';
const D2R = Math.PI / 180, R2D = 180 / Math.PI, EARTH = 6371.0088;

const mx = lon => (lon + 180) / 360;
const my = lat => {
  const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const xlon = x => x * 360 - 180;
const ylat = y => (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) * R2D;

function haversine(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * D2R, dLon = (bLon - aLon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * D2R) * Math.cos(bLat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ============================ 내장 벡터 해안선 ============================ */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64I = {}; for (let i = 0; i < 64; i++) B64I[B64[i]] = i;
function decodeRings(s) {
  let i = 0;
  const rd = () => {
    let v = 0, sh = 0, c;
    do { c = B64I[s[i++]]; v |= (c & 31) << sh; sh += 5; } while (c & 32);
    return (v & 1) ? -((v + 1) >> 1) : v >> 1;
  };
  const out = [];
  while (i < s.length) {
    const n = rd();
    // 날짜변경선을 지나는 링(유라시아·남극·피지 등)은 경도가 +180 <-> -180으로 튄다.
    // 그대로 그리면 지도를 가로지르는 가로줄이 생기므로, 경로 데이터와 같은 방식으로
    // 경도를 펼쳐서 이어 붙인다.
    const lon = new Float64Array(n), lat = new Float64Array(n);
    let x = 0, y = 0, off = 0;
    for (let k = 0; k < n; k++) {
      x += rd(); y += rd();
      const L = x / 100;
      if (k) { const d = (L + off) - lon[k - 1]; if (d > 180) off -= 360; else if (d < -180) off += 360; }
      lon[k] = L + off; lat[k] = y / 100;
    }
    // 지구를 한 바퀴 감는 링(남극)은 해안선만 있고 아래가 열려 있다.
    // 그냥 닫으면 시작점까지 가로줄이 그어지므로 지도 아래 끝을 따라 닫는다.
    const wrap = Math.round((lon[n - 1] - lon[0]) / 360) !== 0;
    const m = wrap ? n + 2 : n;
    const ring = new Float64Array(m * 2);
    for (let k = 0; k < n; k++) { ring[k * 2] = mx(lon[k]); ring[k * 2 + 1] = my(lat[k]); }
    if (wrap) {
      ring[n * 2] = mx(lon[n - 1]);       ring[n * 2 + 1] = 1;
      ring[(n + 1) * 2] = mx(lon[0]);     ring[(n + 1) * 2 + 1] = 1;
    }
    // 펼치는 과정에서 링 전체가 옆 세계로 밀려날 수 있다. 가운데가 [0,1)에 오도록 되돌린다.
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < m; k++) { const v = ring[k * 2]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const shift = -Math.floor((lo + hi) / 2);
    if (shift) for (let k = 0; k < m; k++) ring[k * 2] += shift;
    out.push(ring);
  }
  return out;
}

/* ============================ 데이터 준비 ============================ */
// 촬영 시각 파싱: 절대 시각(UTC)이 있으면 그것을, 없으면 로컬 문자열을 그대로 쓴다.
function timeOf(r) {
  if (typeof r.t === 'number' && isFinite(r.t)) return r.t;   // 인제스터가 이미 해석한 경우
  const s = r.takenUtc || r.gpsUtc;
  if (s) { const t = Date.parse(s); if (!isNaN(t)) return t; }
  if (r.taken) { const t = Date.parse(r.taken + 'Z'); if (!isNaN(t)) return t; }
  return NaN;
}

const FLIGHT_KMH = 200;      // 이보다 빠르면 비행/고속이동으로 간주해 점선 처리
const STOP_KM = 0.25;        // 이 안쪽은 같은 장소로 묶음
const GAP_DAYS = 30;         // 이만큼 벌어지면 경로를 끊음

// 반경 안에 이미 만들어진 군집이 있으면 흡수, 없으면 새로 연다.
// 격자로 후보를 좁혀서 10만 점에서도 선형에 가깝게 끝난다.
function clusterPlaces(pts, radiusKm, keepTimes) {
  const cell = radiusKm / 111;
  const grid = new Map();
  const out = [];
  for (const p of pts) {
    const gy = Math.floor(p.lat / cell), gx = Math.floor(p.ulon / cell);
    const span = Math.min(5, Math.ceil(1 / Math.max(0.12, Math.cos(p.lat * D2R))));
    let best = null, bd = radiusKm;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const arr = grid.get((gy + dy) + ':' + (gx + dx));
        if (!arr) continue;
        for (const pl of arr) {
          const d = haversine(pl.lat, pl.lon, p.lat, p.lon);
          if (d < bd) { bd = d; best = pl; }
        }
      }
    }
    if (best) {
      best.n++;
      if (p.t < best.t0) best.t0 = p.t;
      if (p.t > best.t1) best.t1 = p.t;
      if (keepTimes) best.ts.push(p.t);
    }
    else {
      const pl = { lat: p.lat, lon: p.lon, ulon: p.ulon, n: 1, t0: p.t, t1: p.t };
      if (keepTimes) pl.ts = [p.t];
      out.push(pl);
      const k = gy + ':' + gx;
      let arr = grid.get(k); if (!arr) grid.set(k, arr = []);
      arr.push(pl);
    }
  }
  return out;
}

function prepare(records) {
  const pts = [];
  let noTime = 0, noGps = 0;
  for (const r of records) {
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') { noGps++; continue; }
    const t = timeOf(r);
    if (isNaN(t)) { noTime++; continue; }
    pts.push({ lat: r.lat, lon: r.lon, t, path: r.path || '', taken: r.taken || '', tz: r.tz || '' });
  }
  pts.sort((a, b) => a.t - b.t);

  // 날짜변경선을 넘는 여행에서 경로가 지구를 가로지르지 않도록 경도를 펼친다
  let off = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const d = (pts[i].lon + off) - pts[i - 1].ulon;
      if (d > 180) off -= 360; else if (d < -180) off += 360;
    }
    pts[i].ulon = pts[i].lon + off;
    pts[i].x = mx(pts[i].ulon);
    pts[i].y = my(pts[i].lat);
  }

  // 구간 분류 + 누적 거리
  const legs = [];
  let total = 0, flightKm = 0, groundKm = 0;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const km = haversine(a.lat, a.lon, b.lat, b.lon);
    const hours = (b.t - a.t) / 3600000;
    const kmh = hours > 0.02 ? km / hours : (km > 1 ? Infinity : 0);
    let kind = 'move';
    // 연속한 두 사진이 300km 넘게 떨어져 있으면 걸어간 게 아니다.
    // 사이가 며칠씩 비면 시속이 낮게 나오므로 거리로 먼저 판정한다.
    if (km > 300 || (kmh > FLIGHT_KMH && km > 100)) kind = 'flight';
    else if (hours > GAP_DAYS * 24 && km > 50) kind = 'gap';
    else if (km < STOP_KM) kind = 'stay';
    legs.push({ i: i - 1, j: i, km, kind });
    total += km;
    if (kind === 'flight') flightKm += km; else if (kind === 'move') groundKm += km;
    cum[i] = total;
  }

  const places = clusterPlaces(pts, 1.5);    // 지도에 찍는 점
  const cities = clusterPlaces(pts, 40, true);   // "방문지 N곳" 과 이름표
  places.forEach(pl => { pl.x = mx(pl.ulon); pl.y = my(pl.lat); });
  cities.forEach(cl => {
    cl.x = mx(cl.ulon); cl.y = my(cl.lat);
    cl.label = nearestCity(cl.lat, cl.lon, 45);
  });

  return {
    pts, legs, cum, places, cities, noTime, noGps,
    total, flightKm, groundKm,
    t0: pts.length ? pts[0].t : 0,
    t1: pts.length ? pts[pts.length - 1].t : 0,
  };
}

/* ============================ 재생 스케줄 ============================
 * 사진 한 장에 똑같은 시간을 주면, 산티아고 골목 147m와 스페인→한국 10,193km가
 * 같은 시간에 지나간다. 그래서 구간마다 가중치를 다르게 줘서 화면 시간을 나눈다.
 * 거리는 로그로 눌러 담는다 — 그대로 비례시키면 비행 하나가 영상의 90%를 먹는다.
 */
const EASE_KM = 3;          // 이보다 긴 구간은 가감속을 넣는다

function buildSchedule(data, mode, emph) {
  const n = data.pts.length;
  const acc = new Float64Array(Math.max(1, n));
  if (n < 2) return acc;
  const w = new Float64Array(n - 1);

  if (mode === 'real') {
    for (let i = 0; i < n - 1; i++) w[i] = Math.max(1, data.pts[i + 1].t - data.pts[i].t);
  } else if (mode === 'even') {
    w.fill(1);
  } else {
    const K = emph;                                   // 0 이면 사진 균등과 같아진다
    for (let i = 0; i < n - 1; i++) {
      const leg = data.legs[i];
      let x = 1 + K * Math.log2(1 + leg.km / 0.4);    // 기본 한 칸 + 거리분
      if (leg.kind === 'flight') x += K * (6 + 3 * Math.log2(1 + leg.km / 100));
      else if (leg.kind === 'gap') x += 2 * K;
      // 먼 길을 온 직후에는 잠깐 머문다 (도착의 호흡)
      if (i > 0 && data.legs[i - 1].km > 5 && leg.km < 1) x += 6 * K;
      w[i] = x;
    }
  }
  let s = 0;
  for (let i = 0; i < n - 1; i++) s += w[i];
  if (!(s > 0)) { for (let i = 0; i < n; i++) acc[i] = i / (n - 1); return acc; }
  let c = 0;
  for (let i = 0; i < n - 1; i++) { c += w[i]; acc[i + 1] = c / s; }
  acc[n - 1] = 1;
  return acc;
}

/* 진행도(0..1) -> 보간된 현재 위치와 인덱스 */
function headAt(data, acc, p) {
  const n = data.pts.length;
  if (!n) return null;
  const p0 = data.pts[0];
  if (n === 1) return { x: p0.x, y: p0.y, i: 0, f: 0, t: p0.t, km: 0 };
  p = Math.max(0, Math.min(1, p));
  let lo = 0, hi = n - 2;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (acc[m] <= p) lo = m; else hi = m - 1; }
  const i = lo;
  const span = acc[i + 1] - acc[i];
  const f = span > 0 ? Math.max(0, Math.min(1, (p - acc[i]) / span)) : 0;
  const a = data.pts[i], b = data.pts[i + 1];
  const leg = data.legs[i];
  // 긴 구간은 스르르 출발해 스르르 도착 — 순간이동처럼 보이지 않게
  const e = !leg || leg.km <= EASE_KM ? f
    : leg.km > 300 ? f * f * f * (f * (f * 6 - 15) + 10)   // 대륙 이동은 아주 천천히 떴다 내린다
    : f * f * (3 - 2 * f);
  return {
    x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e,
    i, f: e, t: a.t + (b.t - a.t) * e,
    km: data.cum[i] + (leg && leg.kind !== 'gap' ? leg.km * e : 0),
  };
}

/* ============================ 자동 줌 카메라 ============================
 * 지금 지점 주변 "한 동아리"의 범위를 잡아 그것만 화면에 담는다.
 * 비행/공백 구간을 만나면 뒤쪽 탐색을 끊어서, 착륙한 뒤에도 지구 전체가
 * 화면에 남아 있는 일이 없게 한다. 반대로 앞쪽으로는 비행 도착지를 한 번
 * 포함시켜서, 날아가기 직전에 미리 화면이 넓어지도록 한다.
 */
const CAM = {
  backSec: 1.5,     // 지나온 1.5초치를 화면에 남겨둔다
  fwdSec: 0.9,      // 다가올 0.9초치를 미리 잡는다 → 비행 직전에 화면이 먼저 넓어진다
                    // (더 길게 잡으면 출발지에 머무는 내내 화면이 넓어져 버린다)
  minBack: 5, minFwd: 2, maxStep: 500,
  maxZ: 18, pad: 0.34,
  boostFrom: 6, boostFull: 10,   // 이 축척 사이에서 확대 배율이 서서히 걸린다
};

function cameraBounds(data, acc, h, p, durSec) {
  const pts = data.pts, legs = data.legs, n = pts.length;
  let x0 = h.x, x1 = h.x, y0 = h.y, y1 = h.y;
  const add = q => {
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  };
  const d = Math.max(2, durSec || 20);
  const pMin = p - CAM.backSec / d, pMax = p + CAM.fwdSec / d;
  const i = Math.min(h.i, n - 1);

  // 뒤로: 비행이나 공백을 만나면 즉시 멈춘다.
  // (안 그러면 착륙한 뒤에도 출발지가 화면에 남아 계속 지구 전체가 보인다)
  for (let k = i, cnt = 0; k >= 0 && cnt < CAM.maxStep; k--, cnt++) {
    add(pts[k]);
    const leg = k > 0 ? legs[k - 1] : null;
    if (!leg || leg.kind === 'flight' || leg.kind === 'gap') break;
    if (cnt >= CAM.minBack && acc[k] < pMin) break;
  }
  // 앞으로: 비행이 창 안에 들어오면 도착지까지 담고 멈춘다.
  // 단 한 프레임에 통째로 담으면 그 순간 축척이 급히 빠지며 화면이 크게 흔들린다
  // (산티아고→마드리드 같은 구간에서 눈에 띈다). 비행이 다가올수록 도착지를
  // 조금씩 끌어당겨, 같은 변화를 앞선 여러 프레임에 나눠 담는다.
  for (let k = i + 1, cnt = 0; k < n && cnt < CAM.maxStep; k++, cnt++) {
    const leg = legs[k - 1];
    if (!leg || leg.kind === 'flight' || leg.kind === 'gap') {
      const w = leg ? Math.max(0, Math.min(1, (pMax - acc[k - 1]) * d / CAM.fwdSec)) : 1;
      add({ x: h.x + (pts[k].x - h.x) * w, y: h.y + (pts[k].y - h.y) * w });
      break;
    }
    add(pts[k]);
    if (cnt >= CAM.minFwd && acc[k] > pMax) break;
  }
  return [x0, y0, x1, y1];
}

/* ============================ 포맷 ============================ */
const KO = { m: ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'] };
function fmtDate(ms, tz) {
  const d = new Date(ms + (tz ? tzMs(tz) : 0));
  return d.getUTCFullYear() + '. ' + KO.m[d.getUTCMonth()] + ' ' + d.getUTCDate() + '일';
}
function fmtDateShort(ms) {
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}
function tzMs(tz) {
  const m = /^([+\-])(\d{2}):(\d{2})$/.exec(tz);
  return m ? (m[1] === '-' ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60) * 1000 : 0;
}
function fmtKm(km) {
  if (km < 1) return (km * 1000).toFixed(0) + ' m';
  if (km < 100) return km.toFixed(1) + ' km';
  return Math.round(km).toLocaleString('ko-KR') + ' km';
}
function fmtDays(ms) {
  const d = Math.round(ms / 86400000);
  if (d < 1) return '하루';
  if (d < 31) return d + '일';
  if (d < 365) return Math.round(d / 30.4) + '개월';
  return (d / 365.25).toFixed(1) + '년';
}


/* ============================ 도시 이름 (오프라인 내장) ============================ */
const CITIES = (() => {
  const names = CITY_NAMES.split('\n');
  let i = 0;
  const rd = () => {
    let v = 0, sh = 0, ch;
    do { ch = B64I[CITY_COORDS[i++]]; v |= (ch & 31) << sh; sh += 5; } while (ch & 32);
    return (v & 1) ? -((v + 1) >> 1) : v >> 1;
  };
  const lat = new Float32Array(names.length), lon = new Float32Array(names.length);
  const pop = new Float32Array(names.length);
  const grid = new Map();
  let x = 0, y = 0;
  for (let k = 0; k < names.length; k++) {
    y += rd(); x += rd();
    const tier = rd();
    lat[k] = y / 1000; lon[k] = x / 1000;
    pop[k] = 1000 * Math.pow(2, tier / 4);
    const key = Math.floor(lat[k]) + ':' + Math.floor(lon[k]);
    let a = grid.get(key); if (!a) grid.set(key, a = []);
    a.push(k);
  }
  return { names, lat, lon, pop, grid };
})();

/* 가장 가까운 이름이 늘 맞는 이름은 아니다. 광주 한복판에서 2km 옆 동네 이름이
   뽑히면 지도가 이상해지므로, 인구를 거리로 나눈 점수로 고른다. */
function nearestCity(la, lo, maxKm) {
  const r = Math.ceil(maxKm / 111) + 1;
  const gy = Math.floor(la), gx = Math.floor(lo);
  let best = -1, bestScore = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r * 2; dx <= r * 2; dx++) {
      const a = CITIES.grid.get((gy + dy) + ':' + (gx + dx));
      if (!a) continue;
      for (const k of a) {
        const d = haversine(CITIES.lat[k], CITIES.lon[k], la, lo);
        if (d > maxKm) continue;
        const score = CITIES.pop[k] / (1 + (d / 8) * (d / 8));
        if (score > bestScore) { bestScore = score; best = k; }
      }
    }
  }
  return best < 0 ? '' : CITIES.names[best];
}

/* 군집 안에서 지금까지 도달한 사진 수 (ts는 시간순이라 이분 탐색으로 끝난다) */
function countUpTo(cl, t) {
  const a = cl.ts;
  if (!a || !a.length || a[0] > t) return 0;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= t) lo = m; else hi = m - 1; }
  return lo + 1;
}

const LAND = decodeRings(LAND_ENC);
