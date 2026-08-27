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
/* 구간을 지나는 속도 곡선. 앞뒤 r 만큼을 가감속에 쓰고 가운데는 일정한 속도로 지난다.
 * 스무스스텝 계열은 가운데 속도가 1.5~1.9배까지 치솟아, 먼 구간이 '휙' 하고 선 하나로
 * 지나가 버린다. 순항 구간을 두면 최고 속도가 1/(1-r) 로 묶여 경로가 눈에 남는다. */
function cruise(f, r) {
  if (!(r > 0.001)) return f;
  const V = 1 / (1 - r);
  const ramp = u => V * (0.5 * u - (r / (2 * Math.PI)) * Math.sin(Math.PI * u / r));
  if (f <= r) return ramp(f);
  if (f >= 1 - r) return 1 - ramp(1 - f);
  return V * (r / 2 + (f - r));
}
// 짧은 구간은 거의 직선(사진에서 사진으로), 멀수록 천천히 떠서 천천히 내린다.
// 거리로 매끄럽게 잇는다 — "몇 km 부터"로 나누면 그 경계에서 움직임이 달라져 튄다.
const easeRatio = km => 0.36 * km / (km + 20);

/* ---- 먼 구간 늘려 주기 ----
 * 먼 구간은 화면에서 가장 많이 움직이는데 시간은 가장 적게 받는다. 그래서 몇 프레임
 * 만에 선 하나가 그어지고 끝난다. 거리에 따라 시간을 더 얹되, 영상 전체 길이는
 * 정해져 있으므로 '몇 배를 곱했나'가 아니라 '실제로 몇 배 오래 보이나'로 맞춘다.
 * 배수 A 를 걸면 총합이 1+(A-1)q 배로 불어나 실제 배수는 A/(1+(A-1)q) 로 줄어든다.
 * 그래서 q(먼 구간이 지금 차지하는 비중)를 먼저 재고 A 를 거꾸로 푼다. 사진 몇 장짜리
 * 산책이든 대륙을 넘나드는 여행이든 같은 체감 배수가 나온다.
 * 이미 먼 구간이 영상을 채우고 있으면 더 내줄 시간이 없으므로 상한에서 멈춘다. */
const STRETCH = 3.1;        // 먼 구간이 실제로 차지할 시간 배수 (아래 붙잡아 두기에 조금 떼주고 2.5~3배)
const STRETCH_KM = 150;     // 이 거리쯤에서 배수가 절반 걸린다
const SHRINK_MIN = 0.45;    // 그 대가로 가까운 구간이 줄어드는 한계
const ARRIVE_SEC = 1.8;     // 도착 직후 붙잡아 둘 시간 (초) — 카메라가 내려앉는 동안
const ARRIVE_N = 24;        // 그 시간을 나눠 담을 사진 수
const ARRIVE_CAP = 0.3;     // 붙잡아 두기가 영상에서 차지할 수 있는 최대 비율

function stretchLong(w, legs) {
  const n = w.length;
  const g = new Float64Array(n);
  let sum = 0, q = 0;
  for (let i = 0; i < n; i++) {
    g[i] = legs[i].km / (legs[i].km + STRETCH_KM);
    sum += w[i]; q += w[i] * g[i];
  }
  if (!(sum > 0.000001) || !(q > 0)) return;
  q /= sum;
  const den = 1 - STRETCH * q;
  // 늘린 만큼은 가까운 구간에서 빼 온다. 골목을 지나는 속도가 두 배 넘게 빨라지면
  // 그건 그것대로 어지러우므로, 되푼 배수를 그 한계에서 한 번 더 자른다.
  const room = 1 + (1 / SHRINK_MIN - 1) / q;
  const A = Math.min(room, den > 0.02 ? STRETCH * (1 - q) / den : Infinity);
  for (let i = 0; i < n; i++) w[i] *= 1 + (A - 1) * g[i];
}

/* ---- 도착 직후 붙잡아 두기 ----
 * 먼 길을 온 직후에도 카메라는 아직 축척을 되찾는 중이다. 대륙을 건너오면 십여 단계를
 * 내려와야 하는데, 그 동안 사진이 우수수 지나가면 화면이 그 동네에 내려앉았을 때
 * 이미 경로가 다 그려져 있다. 그래서 도착 뒤 몇 장에 걸쳐 시간을 나눠 얹어, 카메라가
 * 내려앉는 동안 머리가 기어가게 한다.
 *
 * 이건 '가중치 몇 배'가 아니라 '몇 초'의 문제다 — 카메라가 내려오는 데 걸리는 시간은
 * 사진이 몇 장이든 같기 때문이다. 그래서 초 단위로 잡고 가중치로 되푼다.
 * 배분량 B 를 얹으면 총합이 sum+B 가 되므로, 얹은 몫이 정확히 sec 초가 되려면
 * B = sec*sum/(dur-sec) 이다. 다 합쳐서 영상의 ARRIVE_CAP 을 넘지 않게 자른다. */
function arriveHold(w, legs, durSec) {
  const n = w.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i];
  const dur = Math.max(2, durSec || 12);
  if (!(sum > 0)) return;

  const at = [];                                  // [도착 구간 시작, 나눠 담을 장수, 초]
  let want = 0;
  for (let i = 0; i < n - 1; i++) {
    const g = legs[i].km / (legs[i].km + STRETCH_KM);
    if (g < 0.25) continue;                       // 가까운 구간은 카메라가 곧바로 따라온다
    // 도착지 주변 몇 장. 곧바로 또 먼 길을 떠나면 거기서 다시 넓어질 테니 그만둔다.
    let m = 0;
    while (m < ARRIVE_N && i + 1 + m < n && legs[i + 1 + m].km < legs[i].km * 0.3) m++;
    if (!m) continue;
    at.push([i + 1, m, ARRIVE_SEC * g]);
    want += ARRIVE_SEC * g;
  }
  if (!at.length) return;
  const scale = Math.min(1, dur * ARRIVE_CAP / want);   // 다 넣으면 영상을 다 먹는 경우
  const total = want * scale;
  const perSec = sum / (dur - total);                   // 1초에 해당하는 가중치
  for (const [k0, m, sec] of at) {
    const each = sec * scale * perSec / m;
    for (let k = 0; k < m; k++) w[k0 + k] += each;
  }
}

/* 비행 구간이 그리는 호. 지도 좌표에서 한 번 정해두고 머리 위치와 그림이 같은 곡선을
 * 쓴다. 따로 잡으면 머리가 선 옆에 떠서 날아간다. 먼 구간일수록 상대적으로 덜 휜다. */
function flightArc(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-9;
  const bow = 0.16 * len / (1 + 3 * len);
  return { cx: (a.x + b.x) / 2 - dy / len * bow, cy: (a.y + b.y) / 2 + dx / len * bow };
}

function buildSchedule(data, mode, emph, durSec) {
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
    stretchLong(w, data.legs);
    arriveHold(w, data.legs, durSec);
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
  // 스르르 출발해 스르르 도착하되 가운데는 일정한 속도로 — 순간이동처럼 보이지 않게
  const e = leg ? cruise(f, easeRatio(leg.km)) : f;
  // 비행은 그림과 같은 호 위를 지나간다 (2차 베지에)
  let hx, hy;
  if (leg && leg.kind === 'flight') {
    const q = flightArc(a, b), u = 1 - e;
    hx = u * u * a.x + 2 * u * e * q.cx + e * e * b.x;
    hy = u * u * a.y + 2 * u * e * q.cy + e * e * b.y;
  } else {
    hx = a.x + (b.x - a.x) * e; hy = a.y + (b.y - a.y) * e;
  }
  return {
    x: hx, y: hy,
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
  fwdSec: 0.9,      // 다가올 0.9초치를 미리 잡는다
                    // (더 길게 잡으면 한자리에 머무는 내내 화면이 넓어져 버린다)
  perLevel: 0.30,   // 창 밖의 점을 놓아줄 때 축척 한 단계에 쓰는 시간 → 초당 3.3단계
  ramp: 0.5,        // 놓아주기 시작할 때 이만큼에 걸쳐 속도를 붙인다
  relMax: 14,       // 이 단계까지 줄면 사실상 화면 안이다 — 그만 본다
  holdFrac: 0.25,   // 비행·공백은 앞의 이만큼만 통째로 보여주고, 남은 동안 도착지로 들어온다
  minBack: 5, minFwd: 2, maxStep: 500,
  maxZ: 18, pad: 0.34,
  boostFrom: 6, boostFull: 10,   // 이 축척 사이에서 확대 배율이 서서히 걸린다
};

/* 창 밖으로 밀려난(또는 아직 다가오지 않은) 점을 얼마나 놓아줄지 — 단위는 '축척 단계'.
 * 밀려난 지 o 초일 때 축척이 몇 단계 들어와야 하는가를 돌려준다.
 * 거리를 선형으로 0 에 붙이면(=가중치를 1→0 으로 내리면) 마지막에 축척이 무한대로
 * 치솟았다가 잘라내는 순간 툭 튄다. 축척은 거리의 로그이므로, 단계 수를 시간에
 * 비례시켜야 눈에 보이는 속도가 일정해진다. 시작할 때만 ramp 로 속도를 붙인다. */
const release = o => o <= 0 ? 0 : (o * o / (o + CAM.ramp)) / CAM.perLevel;

/* 비행·공백(legs[k-1])의 출발지를 놓아주기 시작하는 진행도. 구간의 앞 holdFrac 동안은
 * 출발지와 도착지를 함께 보여주고, 남은 동안 도착지 축척으로 들어온다.
 * 착륙한 뒤에도 같은 시계를 이어 쓰므로 착륙하는 순간 축척이 튀지 않는다. */
const holdUntil = (acc, k) => acc[k - 1] + (acc[k] - acc[k - 1]) * CAM.holdFrac;

/* 점을 창에 넣었다 뺐다 하면 그 한 프레임에 범위가 계단처럼 바뀌고, 축척도 그만큼
 * 덜컹거린다. 그래서 넣고 빼는 대신 가중치 w(1→0)로 현재 지점 쪽으로 끌어당긴다.
 * w=1 이면 원래 자리, w=0 이면 범위에 아무 영향이 없다 — 그 사이를 매끄럽게 오가므로
 * 범위도, 따라서 축척도 매끄럽게 변한다. 비행·공백처럼 따로 손보던 자리도
 * 같은 규칙 하나로 처리된다. */
function cameraBounds(data, acc, h, p, durSec) {
  const pts = data.pts, legs = data.legs, n = pts.length;
  let x0 = h.x, x1 = h.x, y0 = h.y, y1 = h.y;
  const add = (q, w) => {
    if (w <= 0) return;
    const qx = h.x + (q.x - h.x) * w, qy = h.y + (q.y - h.y) * w;
    if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
    if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
  };
  const d = Math.max(2, durSec || 20);
  const i = Math.min(h.i, n - 1);

  // 뒤로: 지나간 지 오래된 점부터 놓아준다. 한 번에 끊으면 그 프레임에 축척이 통째로
  // 바뀌어 화면이 크게 튀고, 계속 들고 있으면 지나온 곳이 화면에 계속 남는다.
  let rel = 0;                                          // 놓아준 정도 (축척 단계, 늘기만 한다)
  // 비행·공백은 착륙한 뒤가 아니라 '날아가는 동안' 놓아준다. 착륙하고 나서야 줌이
  // 들어오면 카메라가 도착할 무렵엔 그 동네 경로가 이미 절반쯤 그려져 있다.
  const cur = legs[i];
  if (cur && (cur.kind === 'flight' || cur.kind === 'gap'))
    rel = release((p - holdUntil(acc, i + 1)) * d);
  for (let k = i, cnt = 0; k >= 0 && cnt < CAM.maxStep; k--, cnt++) {
    add(pts[k], Math.pow(2, -rel));
    const leg = k > 0 ? legs[k - 1] : null;
    if (!leg) break;
    rel = Math.max(rel, leg.kind === 'flight' || leg.kind === 'gap'
      ? release((p - holdUntil(acc, k)) * d)            // 이 구간을 놓아주기 시작한 지 몇 초
      : release(cnt >= CAM.minBack ? (p - acc[k]) * d - CAM.backSec : 0));
    if (rel > CAM.relMax) break;
  }
  // 앞으로: 다가올 점을 미리 담아 화면이 먼저 넓어지게 한다. 비행·공백의 도착지는
  // '출발지에 닿기까지 남은 시간'으로 끌어당기므로, 축척이 빠지는 속도가 뒤와 똑같이 묶인다.
  // 그 너머도 같은 만큼 더 놓아준 채로 계속 본다 — 도착지에서 끊어 버리면 착륙하는
  // 순간 다음 비행이 통째로 화면에 들어와 축척이 한 프레임에 빠진다.
  rel = 0;
  for (let k = i + 1, cnt = 0; k < n && cnt < CAM.maxStep; k++, cnt++) {
    const leg = legs[k - 1];
    if (!leg) break;
    if (leg.kind === 'flight' || leg.kind === 'gap') rel = Math.max(rel, release((acc[k - 1] - p) * d));
    add(pts[k], Math.pow(2, -rel));
    if (cnt >= CAM.minFwd) rel = Math.max(rel, release((acc[k] - p) * d - CAM.fwdSec));
    if (rel > CAM.relMax) break;
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
