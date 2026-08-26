/* ============================ 아무 형식이나 받아들이는 인제스터 ============================
 * 키 이름과 중첩 구조를 스스로 찾아서 위도·경도·시각을 뽑는다.
 * 우리 추출기 형식, GeoJSON, 구글 위치기록(latitudeE7), 구글 포토 takeout,
 * NDJSON, CSV/TSV를 같은 경로로 처리한다.
 * 무엇을 어떤 키에서 읽었는지 report로 돌려주므로, 잘못 읽으면 화면에서 바로 보인다.
 */
'use strict';

const normKey = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const tzOffsetMs = tz => {
  const m = /^([+\-])(\d{2}):?(\d{2})$/.exec(String(tz).trim());
  return m ? (m[1] === '-' ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60) * 1000 : 0;
};

// 앞에 있을수록 우선. 같은 순위면 얕은 곳이 이긴다.
const FIELDS = {
  lat: ['lat', 'latitude', 'latitudee7', 'gpslatitude', 'ycoord', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'longitudee7', 'gpslongitude', 'xcoord', 'x'],
  time: ['takenutc', 'gpsutc', 'taken', 'datetimeoriginal', 'phototakentime', 'creationtime',
         'timestampms', 'timestamp', 'datetime', 'capturedat', 'createdat', 'created',
         'date', 'time', 'when', 'begintimestamp'],
  tz: ['tz', 'offsettimeoriginal', 'utcoffset', 'timezone', 'offset', 'gmtoffset'],
  alt: ['alt', 'altitude', 'elevation', 'ele', 'gpsaltitude'],
  label: ['path', 'filepath', 'relativepath', 'file', 'filename', 'title', 'name', 'photo',
          'image', 'imageurl', 'url', 'src', 'id'],
};

/* ---------- 값 하나 찾기 ---------- */
function pickField(obj, names, wantObject) {
  let best = null;
  const walk = (o, d, prefix) => {
    if (!o || typeof o !== 'object' || d > 3) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === null || v === undefined || v === '') continue;
      const t = typeof v;
      const usable = t === 'number' || t === 'string' || t === 'boolean' ||
        (wantObject && t === 'object' && !Array.isArray(v));
      if (!usable) continue;
      const rank = names.indexOf(normKey(k));
      if (rank < 0) continue;
      if (!best || rank < best.rank || (rank === best.rank && d < best.depth)) {
        best = { rank, depth: d, key: prefix + k, value: v };
      }
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, d + 1, prefix + k + '.');
    }
  };
  walk(obj, 0, '');
  return best;
}
function atPath(obj, path) {
  let o = obj;
  for (const part of path.split('.')) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[part];
  }
  return o;
}

/* ---------- 값 해석 ---------- */
function toNum(v, key) {
  let n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9eE+\-.]/g, ''));
  if (!isFinite(n)) return NaN;
  if (/e7$/.test(normKey(key || ''))) n /= 1e7;          // 구글 위치기록
  else if (Math.abs(n) > 100000) n /= 1e7;               // E7인데 이름이 다른 경우
  return n;
}

const EXIF_DT = /^(\d{4})[:\-.](\d{2})[:\-.](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
const HAS_TZ = /(?:Z|[+\-]\d{2}:?\d{2})$/;

// 시각 -> {ms, text}. 표기가 없는 시각은 UTC로 간주해야 정렬이 흔들리지 않는다.
function toTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    for (const k of ['timestamp', 'timestampMs', 'value', 'ms', '$date', 'iso', 'formatted']) {
      if (v[k] !== undefined) { const r = toTime(v[k]); if (r) return r; }
    }
    return null;
  }
  if (typeof v === 'number') return fromEpoch(v);
  const s = String(v).trim();
  if (!s) return null;
  if (/^-?\d{9,17}$/.test(s)) return fromEpoch(+s);
  const m = EXIF_DT.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
    const tail = s.slice(m[0].length).trim();
    const tz = HAS_TZ.exec(tail);
    const ms = Date.parse(iso + (tz ? tz[0] : 'Z'));
    return isNaN(ms) ? null : { ms, text: iso, naive: !tz };
  }
  const explicit = HAS_TZ.test(s);
  let ms = Date.parse(explicit ? s : s + 'Z');
  if (isNaN(ms)) ms = Date.parse(s);
  if (isNaN(ms)) return null;
  return { ms, text: s.replace(/\.\d+/, '').replace(/(Z|[+\-]\d{2}:?\d{2})$/, ''), naive: !explicit };
}
function fromEpoch(n) {
  if (!isFinite(n) || n === 0) return null;
  const a = Math.abs(n);
  const ms = a > 1e14 ? n / 1000 : a > 1e11 ? n : a > 1e8 ? n * 1000 : null;   // µs / ms / s
  if (ms === null) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 1980 || d.getUTCFullYear() > 2100) return null;
  return { ms, text: d.toISOString().slice(0, 19), naive: false };
}

/* ---------- 파일 -> 레코드 배열 ---------- */
function parseLoose(text) {
  const s = text.replace(/^﻿/, '').trim();
  if (!s) return null;
  if (s[0] === '{' || s[0] === '[') {
    try { return JSON.parse(s); } catch (e) { /* NDJSON일 수 있다 */ }
  }
  const lines = s.split(/\r?\n/);
  const objs = [];
  let jsonLines = 0;
  for (const line of lines) {
    const t = line.trim().replace(/,$/, '');
    if (!t || t === '[' || t === ']') continue;
    if (t[0] === '{' || t[0] === '[') {
      try { objs.push(JSON.parse(t)); jsonLines++; continue; } catch (e) {}
    }
  }
  if (jsonLines >= 1 && jsonLines >= lines.length * 0.5) return objs;
  const csv = parseCSV(lines);
  if (csv && csv.length) return csv;
  if (objs.length) return objs;
  throw new Error('파일을 읽지 못했습니다. JSON·GeoJSON·NDJSON·CSV 형식의 파일인지 확인해 주세요.');
}

function splitRow(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(v => v.trim());
}
function parseCSV(lines) {
  const head = lines.find(l => l.trim());
  if (!head) return null;
  const sep = (head.match(/\t/g) || []).length > (head.match(/,/g) || []).length ? '\t' : ',';
  const cols = splitRow(head, sep);
  if (cols.length < 2) return null;
  const keys = cols.map(normKey);
  const known = ['lat', 'latitude', 'lon', 'lng', 'longitude', 'time', 'timestamp', 'date', 'datetime', 'taken'];
  if (!keys.some(k => known.includes(k))) return null;
  const rows = [];
  let started = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!started) { started = true; continue; }
    const v = splitRow(line, sep);
    const o = {};
    cols.forEach((c, i) => { if (v[i] !== undefined && v[i] !== '') o[c] = v[i]; });
    rows.push(o);
  }
  return rows;
}

// 어디에 배열이 들어있든 찾아낸다
function findArray(root) {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  const preferred = ['features', 'photos', 'locations', 'items', 'records', 'data', 'results',
                     'points', 'entries', 'rows', 'list', 'timelineobjects', 'objects'];
  let best = null;
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 3) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        const rank = preferred.indexOf(normKey(k));
        const score = (rank < 0 ? 100 : rank) - Math.min(50, v.length / 20);
        if (!best || score < best.score) best = { score, arr: v };
      }
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, d + 1);
    }
  };
  walk(root, 0);
  if (best) return best.arr;
  const vals = Object.values(root).filter(v => v && typeof v === 'object');
  return vals.length > 1 ? vals : [root];
}

/* ---------- GeoJSON / 좌표배열 펼치기 ---------- */
function expandGeo(arr) {
  const out = [];
  let any = false;
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const g = it.geometry || (it.type && it.coordinates ? it : null);
    if (!g || !g.coordinates) { out.push(it); continue; }
    any = true;
    const props = Object.assign({}, it.properties || {}, it.props || {});
    const times = props.coordTimes || props.times || null;
    const push = (c, i) => {
      if (!Array.isArray(c) || typeof c[0] !== 'number') return;
      const r = Object.assign({}, props, { __lon: c[0], __lat: c[1] });
      if (typeof c[2] === 'number') r.__alt = c[2];
      if (times && times[i] !== undefined) r.__time = times[i];
      out.push(r);
    };
    const t = String(g.type || '').toLowerCase();
    if (t === 'point') push(g.coordinates, 0);
    else if (t === 'linestring' || t === 'multipoint') g.coordinates.forEach(push);
    else if (t === 'multilinestring' || t === 'polygon') g.coordinates.forEach(l => l.forEach(push));
    else out.push(it);
  }
  return any ? out : arr;
}

/* ---------- 본체 ---------- */
function ingest(text) {
  const root = parseLoose(text);
  let arr = findArray(root);
  if (!Array.isArray(arr) || !arr.length) throw new Error('파일 안에서 위치 목록을 찾지 못했습니다. 사진 위치나 이동 기록이 담긴 파일인지 확인해 주세요.');
  arr = expandGeo(arr);

  const report = { total: arr.length, ok: 0, noGeo: 0, noTime: 0, bad: 0, keys: {}, swapped: 0, source: '' };
  const out = [];
  let plan = null, globalSwap = false;

  const resolve = (rec) => {
    // 이미 찾은 경로를 먼저 써보고, 안 맞으면 다시 탐색한다 (형식이 섞여 있어도 버틴다)
    if (plan) {
      const la = plan.lat ? toNum(atPath(rec, plan.lat), plan.lat) : NaN;
      const lo = plan.lon ? toNum(atPath(rec, plan.lon), plan.lon) : NaN;
      if (isFinite(la) && isFinite(lo)) return plan;
    }
    const lat = rec.__lat !== undefined ? { key: '__lat' } : pickField(rec, FIELDS.lat);
    const lon = rec.__lon !== undefined ? { key: '__lon' } : pickField(rec, FIELDS.lon);
    if (!lat || !lon) return null;
    const time = rec.__time !== undefined ? { key: '__time' } : pickField(rec, FIELDS.time, true);
    const p = {
      lat: lat.key, lon: lon.key,
      time: time ? time.key : null,
      tz: (pickField(rec, FIELDS.tz) || {}).key || null,
      alt: rec.__alt !== undefined ? '__alt' : (pickField(rec, FIELDS.alt) || {}).key || null,
      label: (pickField(rec, FIELDS.label) || {}).key || null,
    };
    plan = p;
    return p;
  };

  // 위경도 뒤바뀜은 한 건씩 판단하면 안 된다. 경도가 90 이하인 지역(유럽 등)에서는
  // 뒤바뀐 것도 정상으로 보이기 때문에, 파일 전체를 훑어 한 번에 결정한다.
  {
    let maxLat = 0, maxLon = 0, seen = 0;
    for (const rec of arr) {
      if (!rec || typeof rec !== 'object') continue;
      const p = resolve(rec);
      if (!p) continue;
      const la = Math.abs(toNum(atPath(rec, p.lat), p.lat));
      const lo = Math.abs(toNum(atPath(rec, p.lon), p.lon));
      if (isFinite(la)) maxLat = Math.max(maxLat, la);
      if (isFinite(lo)) maxLon = Math.max(maxLon, lo);
      if (++seen >= 2000) break;
    }
    if (maxLat > 90 && maxLon <= 90) globalSwap = true;      // 위도는 90을 넘을 수 없다
  }

  for (const rec of arr) {
    if (!rec || typeof rec !== 'object') { report.bad++; continue; }
    const p = resolve(rec);
    if (!p) { report.noGeo++; continue; }

    let la = toNum(atPath(rec, p.lat), p.lat);
    let lo = toNum(atPath(rec, p.lon), p.lon);
    if (!isFinite(la) || !isFinite(lo)) { report.noGeo++; continue; }
    if (globalSwap) { const t = la; la = lo; lo = t; report.swapped++; }
    if (Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) { report.noGeo++; continue; }

    let tv = p.time ? toTime(atPath(rec, p.time)) : null;
    if (!tv) {
      const alt = pickField(rec, FIELDS.time, true);       // 레코드마다 시각 키가 다를 수 있다
      if (alt) tv = toTime(alt.value);
    }
    if (!tv) { report.noTime++; continue; }

    const o = { lat: la, lon: lo, t: tv.ms, taken: tv.text };
    let tz = p.tz ? String(atPath(rec, p.tz) || '') : '';
    if (!/^[+\-]\d{2}:?\d{2}$/.test(tz)) {
      const alt = pickField(rec, FIELDS.tz);
      tz = alt ? String(alt.value || '') : '';
    }
    if (/^[+\-]\d{2}:?\d{2}$/.test(tz)) {
      o.tz = tz.length === 5 ? tz.slice(0, 3) + ':' + tz.slice(3) : tz;
      // 시간대 표기가 없는 로컬 시각 + 오프셋 필드 -> 진짜 시각으로 되돌린다
      if (tv.naive) o.t = tv.ms - tzOffsetMs(o.tz);
    }
    if (p.alt) { const a = toNum(atPath(rec, p.alt), p.alt); if (isFinite(a) && Math.abs(a) < 20000) o.alt = Math.round(a * 100) / 100; }
    if (p.label) { const l = atPath(rec, p.label); if (l !== undefined && l !== null) o.path = String(l).slice(0, 300); }
    out.push(o);
    report.ok++;
  }

  if (plan) report.keys = plan;
  report.source = Array.isArray(root) ? '배열' : (root && root.type ? String(root.type) : '객체');
  if (!out.length) {
    const why = [];
    if (report.noGeo) why.push(`좌표가 없는 항목이 ${report.noGeo.toLocaleString('ko-KR')}건`);
    if (report.noTime) why.push(`촬영 시각이 없는 항목이 ${report.noTime.toLocaleString('ko-KR')}건`);
    if (report.bad) why.push(`읽을 수 없는 형식이 ${report.bad.toLocaleString('ko-KR')}건`);
    throw new Error(
      `${report.total.toLocaleString('ko-KR')}건을 읽었지만` + (why.length ? ` ${why.join(', ')}이라` : '') +
      ` 지도에 표시할 항목이 없습니다. 위치와 촬영 시각이 함께 담긴 파일인지 확인해 주세요.`);
  }
  return { records: out, report };
}
