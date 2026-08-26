/* ============================ 상태 ============================ */
const $ = id => document.getElementById(id);
const canvas = $('map'), ctx = canvas.getContext('2d', { alpha: false });
const tl = $('timeline'), tctx = tl.getContext('2d');
const tiles = new TileLayer();

let data = null, W = 0, H = 0;
let view = { cx: 0.5, cy: 0.5, z: 1.6 };
let progress = 1, playing = false, recording = false, hoverIdx = -1, pinIdx = -1;
let lastFrame = 0, phase = 0, needsDraw = true, buckets = null;
let sched = null, fitZ = 2, outro = null, intro = null;
let rawRecords = null, dataRange = null, lastRange = null;

const opts = {
  base: 'none', custom: '', mode: 'smooth', emph: 1.5, camera: 'auto',
  vertical: true, duration: 12, glow: true, dark: false, labels: true, zoom: 1,
  curve: true, routeColor: '',
};
const MODE_LABEL = { smooth: '이동 거리에 맞춰', even: '사진 순서대로', real: '실제 시간 흐름' };

const THEMES = {
  light: {
    sea: '#cfdae3', land: '#f6f7f6', landLine: '#a9b7c2',
    route: '#e8542f', flight: '#e8542f99', glow: 'rgba(232,84,47,.45)',
    dot: '#ffffff', dotRing: '#e8542f',
    head: '#ffffff', headRing: '#e8542f', headHalo: 'rgba(232,84,47,.28)',
    hudInk: '#16181a', hudDim: '#5c646c', hudFaint: '#8c949c',
    barBg: 'rgba(20,22,24,.14)', darkScrim: false, labelHalo: 'rgba(255,255,255,.92)',
  },
  dark: {
    sea: '#0e1216', land: '#212932', landLine: '#38434e',
    route: '#ff7a52', flight: '#ff7a5299', glow: 'rgba(255,122,82,.5)',
    dot: '#0f1418', dotRing: '#ff7a52',
    head: '#0f1418', headRing: '#ff7a52', headHalo: 'rgba(255,122,82,.3)',
    hudInk: '#f2f4f5', hudDim: '#9aa3ab', hudFaint: '#6b747c',
    barBg: 'rgba(255,255,255,.16)', darkScrim: true, labelHalo: 'rgba(10,14,18,.88)',
  },
};
const hexToRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
// routeColor가 비어 있으면 테마 기본색. 골랐으면 강조색 계열(선·점 테두리·현재 위치)만 그 색으로 바꾼다.
const C = () => {
  const t = THEMES[opts.dark ? 'dark' : 'light'];
  const c = opts.routeColor;
  if (!c) return t;
  return { ...t, route: c, flight: hexToRgba(c, .6), glow: hexToRgba(c, opts.dark ? .5 : .45),
           dotRing: c, headRing: c, headHalo: hexToRgba(c, opts.dark ? .3 : .28) };
};

/* ============================ 파일 읽기 ============================ */
function loadText(text, name) {
  // 실패해도 이전 시각화는 남긴다. 대신 리포트를 숨기고 어느 파일이 실패했는지 명시한다.
  const fail = msg => { $('report').classList.add('hide'); setStatus(`"${name}" — ${msg}`, true); };
  let got;
  try {
    got = ingest(text);                          // 형식은 인제스터가 알아서 맞춘다
  } catch (e) {
    fail(e.message || '파일을 해석하지 못했습니다.');
    return;
  }
  const d = prepare(got.records);
  if (!d.pts.length) {
    fail('지도에 표시할 수 있는 항목이 없습니다. 위치와 촬영 시각이 함께 담긴 파일인지 확인해 주세요.');
    return;
  }
  showReport(got.report);
  rawRecords = got.records;
  buildRangeControls();
  data = d;
  buckets = makeBuckets(d);
  sched = buildSchedule(d, opts.mode, opts.emph);
  $('drop').classList.add('loaded');
  $('panel').classList.remove('hide');
  resize();
  $('fileName').textContent = name;
  fitAll();
  progress = 1; playing = false; outro = null; intro = null;
  applySuggestedDuration();
  renderStats();
  setStatus(`사진 ${d.pts.length.toLocaleString('ko-KR')}장에 맞춰 영상 길이를 ${opts.duration}초로 잡았습니다 — 길이 슬라이더로 바꿀 수 있습니다.`);
  needsDraw = true;
}
// 요약 한 줄만 보여주고, 무엇을 어떤 키에서 읽었는지는 '자세히'에 접어둔다.
// 낯선 형식일수록 이게 있어야 믿고 쓴다 — GeoJSON 내부 키(__lat 등)는 사람 말로 바꿔 보여준다.
const KEY_NICE = { __lat: 'GeoJSON geometry', __lon: 'GeoJSON geometry',
                   __time: 'GeoJSON coordTimes', __alt: 'GeoJSON geometry' };
function showReport(r) {
  const k = r.keys || {};
  const nice = key => KEY_NICE[key] || key;
  const bits = [];
  if (k.lat === '__lat' && k.lon === '__lon') bits.push(`좌표 <code>GeoJSON geometry</code>`);
  else {
    if (k.lat) bits.push(`위도 <code>${esc(nice(k.lat))}</code>`);
    if (k.lon) bits.push(`경도 <code>${esc(nice(k.lon))}</code>`);
  }
  if (k.time) bits.push(`시각 <code>${esc(nice(k.time))}</code>`);
  if (k.alt) bits.push(`고도 <code>${esc(nice(k.alt))}</code>`);
  if (k.label) bits.push(`이름 <code>${esc(nice(k.label))}</code>`);
  const skip = [];
  if (r.noGeo) skip.push(`좌표 없음·범위 밖 ${r.noGeo.toLocaleString('ko-KR')}건`);
  if (r.noTime) skip.push(`촬영 시각 없음 ${r.noTime.toLocaleString('ko-KR')}건`);
  if (r.bad) skip.push(`읽을 수 없는 형식 ${r.bad.toLocaleString('ko-KR')}건`);
  const excluded = r.total - r.ok;
  const head = excluded
    ? `총 ${r.total.toLocaleString('ko-KR')}건 중 <b>${r.ok.toLocaleString('ko-KR')}</b>건을 인식했습니다 · ` +
      `<span class="skip">제외 ${excluded.toLocaleString('ko-KR')}건</span>`
    : `총 <b>${r.ok.toLocaleString('ko-KR')}</b>건의 위치와 시각을 모두 인식했습니다`;
  const body = [];
  if (bits.length) body.push(`읽은 키 — ${bits.join(' · ')}`);
  if (skip.length) body.push(`<span class="skip">제외 사유 — ${skip.join(' · ')}</span>`);
  if (r.swapped) body.push(`위도와 경도가 뒤바뀐 파일이라 ${r.swapped.toLocaleString('ko-KR')}건을 자동으로 바로잡았습니다.`);
  $('report').innerHTML =
    `<details><summary>${head}<span class="more">자세히</span></summary>` +
    `<div class="rbody">${body.join('<br>')}</div></details>`;
  $('report').classList.remove('hide');
}
const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

function setStatus(msg, bad) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status' + (bad ? ' bad' : '') + (msg ? '' : ' hide');
}
function pickFile(f) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), f.name);
  r.onerror = () => setStatus('파일을 여는 데 실패했습니다. 파일을 다시 선택해 주세요.', true);
  r.readAsText(f);
}
$('file').onchange = e => pickFile(e.target.files[0]);
$('dropBtn').onclick = () => $('file').click();
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) $('drop').classList.remove('over');
}));
document.addEventListener('drop', e => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); });

/* ============================ 뷰 ============================ */
// 범위를 화면에 담는 뷰를 계산해서 돌려준다 (HUD가 덮는 위/아래를 비워둔다)
function viewFor(x0, y0, x1, y1, pad, minZ) {
  const insetT = H * 0.25, insetB = H * 0.12, insetX = W * 0.09;
  const availW = Math.max(80, W - insetX * 2), availH = Math.max(80, H - insetT - insetB);
  const k = 1 + (pad || 0);
  const dx = Math.max(x1 - x0, 1e-9) * k, dy = Math.max(y1 - y0, 1e-9) * k;
  let z = Math.min(Math.log2(availW / (dx * 256)), Math.log2(availH / (dy * 256)));
  z = Math.max(minZ === undefined ? 0.6 : minZ, Math.min(CAM.maxZ, z));
  const s = 256 * Math.pow(2, z);
  return { z, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 - (insetT - insetB) / (2 * s) };
}
function allBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of data.pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}
function fitAll() {
  if (!data || !data.pts.length) return;
  const v = viewFor(...allBounds(), 0.12);
  fitZ = v.z;
  view.cx = v.cx; view.cy = v.cy; view.z = v.z;
  outro = null; intro = null;         // 이미 전체 뷰이므로 진행 중인 줌아웃·줌인은 무의미하다
  needsDraw = true;
}
// 자동 줌이 노리는 목표 뷰
function cameraTarget(h, p = progress) {
  const b = cameraBounds(data, sched, h, p, opts.duration);
  const minZ = Math.min(fitZ, 1.2);
  const base = viewFor(b[0], b[1], b[2], b[3], CAM.pad, minZ);
  if (opts.zoom <= 0.01) return base;
  // 대륙을 건너는 중에 확대까지 걸면 비행이 뭉개진다. 넓은 축척일수록 배율을 푼다.
  const taper = Math.max(0, Math.min(1, (base.z - CAM.boostFrom) / (CAM.boostFull - CAM.boostFrom)));
  const eff = opts.zoom * taper;
  if (eff <= 0.01) return base;
  // 범위를 현재 지점 쪽으로 수축시키면, 줌이 깊어지는 동시에 화면이 지점을 따라온다
  const k = Math.pow(2, -eff);
  return viewFor(h.x + (b[0] - h.x) * k, h.y + (b[1] - h.y) * k,
                 h.x + (b[2] - h.x) * k, h.y + (b[3] - h.y) * k, CAM.pad, minZ);
}
/* 카메라를 한 걸음 움직인다. 재생 루프와 '미리 받기' 계획이 똑같은 식을 써야
   계획한 타일과 실제로 화면에 나오는 타일이 어긋나지 않는다. */
function stepCamera(v, p, dt) {
  const h = headAt(data, sched, p);
  if (!h) return false;
  // 위치는 빠르게, 축척은 느긋하게 따라간다. 줌이 출렁이면 멀미가 난다.
  const kp = 1 - Math.pow(0.0016, dt);
  if (opts.camera === 'auto') {
    const t = cameraTarget(h, p);
    v.cx += (t.cx - v.cx) * kp;
    v.cy += (t.cy - v.cy) * kp;
    // 현재 지점을 화면 안에 두기 위한 축척 상한. 이걸 보간이 끝난 값에 곧바로
    // min 으로 걸면, 지점이 앞서 나갈 때마다 축척이 프레임 단위로 튀어 화면이
    // 흔들린다. 목표 쪽에 먼저 반영해서 기존 감속이 매끄럽게 흡수하게 한다.
    const ax = Math.abs(h.x - v.cx), ay = Math.abs(h.y - v.cy);
    let cap = Infinity;
    if (ax > 1e-12) cap = Math.min(cap, Math.log2(0.34 * W / (256 * ax)));
    if (ay > 1e-12) cap = Math.min(cap, Math.log2(0.30 * H / (256 * ay)));
    // 빠지는 건 빠르게, 들어가는 건 느긋하게.
    // 대칭으로 두면 화면이 아직 확대된 채로 지구 반대편까지 날아가 빈 화면이 된다.
    const kz = 1 - Math.pow(t.z < v.z ? 0.012 : 0.09, dt);
    v.z += (t.z - v.z) * kz;
    // 상한도 '즉시 자르기'가 아니라 빠른 감속으로 따라간다. 비행 구간에 들어서는
    // 순간 지점이 화면 밖으로 확 벗어나면서 상한이 몇 단계씩 떨어지는데, 그때
    // min 으로 곧바로 자르면 한 프레임에 축척이 통째로 바뀌어 화면이 크게 튄다.
    if (v.z > cap) v.z += (cap - v.z) * (1 - Math.pow(0.02, dt));
    v.z = Math.max(0.6, v.z);
  } else {
    v.cx += (h.x - v.cx) * kp;
    v.cy += (h.y - v.cy) * kp;
  }
  return true;
}

function snapCamera() {
  if (!data || opts.camera !== 'auto') return;
  const v = cameraTarget(headAt(data, sched, progress));
  view.cx = v.cx; view.cy = v.cy; view.z = v.z;
}

/* ============================ 기간 필터 ============================
 * 여러 해가 섞인 파일에서 "그 여행이 있던 기간만" 보고 싶을 때가 많다.
 * 원본 레코드를 그대로 들고 있다가, 고른 구간만 다시 준비해서 지도·통계·타임라인·
 * 추천 길이를 한꺼번에 새로 잡는다. 날짜는 ISO(YYYY-MM-DD)라 문자열 비교로 충분하다.
 */
function recDate(r) {
  const s = r.taken || r.takenUtc || r.gpsUtc;
  if (typeof s === 'string') { const m = /^\d{4}-\d{2}-\d{2}/.exec(s); if (m) return m[0]; }
  const t = timeOf(r);
  return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}
const fmtD = d => d ? `${+d.slice(0, 4)}. ${+d.slice(5, 7)}. ${+d.slice(8, 10)}.` : '';
const clampD = d => !dataRange ? d : (d < dataRange[0] ? dataRange[0] : (d > dataRange[1] ? dataRange[1] : d));

function buildRangeControls() {
  const dates = [];
  for (const r of rawRecords) { const d = recDate(r); if (d) dates.push(d); }
  dates.sort();
  if (dates.length < 2 || dates[0] === dates[dates.length - 1]) {   // 하루치뿐이면 고를 것이 없다
    $('rangeBar').classList.add('hide'); dataRange = lastRange = null; return;
  }
  dataRange = [dates[0], dates[dates.length - 1]];
  lastRange = [dataRange[0], dataRange[1]];
  const f = $('dateFrom'), t = $('dateTo');
  f.min = t.min = dataRange[0]; f.max = t.max = dataRange[1];
  f.value = dataRange[0]; t.value = dataRange[1];
  // 연도 버튼은 데이터에 실제로 있는 해만. 한 해뿐이면 버튼 자체가 의미 없다.
  const years = [...new Set(dates.map(d => d.slice(0, 4)))].sort();
  $('yearChips').innerHTML = years.length < 2 ? '' :
    years.map(y => `<button type="button" class="chip" data-y="${y}">${y}</button>`).join('') +
    '<button type="button" class="chip" data-y="all">전체</button>';
  $('rangeBar').classList.remove('hide');
  updateRangeInfo(rawRecords.length);
}
function updateRangeInfo(shown) {
  const a = $('dateFrom').value, b = $('dateTo').value;
  const whole = !dataRange || (a <= dataRange[0] && b >= dataRange[1]);
  $('rangeInfo').textContent = whole
    ? `전체 기간 · 사진 ${shown.toLocaleString('ko-KR')}장`
    : `사진 ${shown.toLocaleString('ko-KR')}장 (전체 ${rawRecords.length.toLocaleString('ko-KR')}장 중)`;
  // 지금 고른 구간과 딱 맞는 버튼만 눌린 상태로
  $('yearChips').querySelectorAll('.chip').forEach(c => {
    const y = c.dataset.y;
    const on = y === 'all' ? whole
      : (!whole && a === clampD(y + '-01-01') && b === clampD(y + '-12-31'));
    c.classList.toggle('on', on);
  });
}
function applyRangeFilter() {
  if (!rawRecords || !dataRange) return;
  let a = $('dateFrom').value || dataRange[0], b = $('dateTo').value || dataRange[1];
  if (a > b) {                                  // 뒤집어 고르면 조용히 바로잡는다
    if (a !== lastRange[0]) { b = a; $('dateTo').value = b; }
    else { a = b; $('dateFrom').value = a; }
  }
  const whole = a <= dataRange[0] && b >= dataRange[1];
  const recs = whole ? rawRecords
    : rawRecords.filter(r => { const d = recDate(r); return d && d >= a && d <= b; });
  const d = prepare(recs);
  if (!d.pts.length) {                          // 빈 화면으로 만들지 않고 이전 선택으로 되돌린다
    $('dateFrom').value = lastRange[0]; $('dateTo').value = lastRange[1];
    setStatus(`${fmtD(a)} ~ ${fmtD(b)} 사이에는 지도에 표시할 사진이 없습니다.`, true);
    updateRangeInfo(data ? data.pts.length : 0);
    return;
  }
  lastRange = [a, b];
  data = d; buckets = makeBuckets(d); sched = buildSchedule(d, opts.mode, opts.emph);
  hoverIdx = pinIdx = -1; $('tip').classList.add('hide');
  playing = false; outro = null; intro = null; progress = 1;
  $('play').textContent = '▶ 재생';
  fitAll();
  applySuggestedDuration();
  renderStats();
  updateRangeInfo(d.pts.length);
  setStatus(whole ? '' :
    `${fmtD(a)} ~ ${fmtD(b)} 사진 ${d.pts.length.toLocaleString('ko-KR')}장만 그립니다. 영상 길이도 그에 맞춰 ${opts.duration}초로 잡았습니다.`);
  needsDraw = true;
}

/* ============================ 타일 미리 받기 ============================
 * 온라인 배경에서는 타일이 카메라를 못 따라오면 지도가 뒤늦게 나타난다.
 * 재생 중에는 앞으로 갈 자리를, 줌아웃 직전에는 최종 화면을 미리 요청해 둔다.
 */
let prefetchT = 0, warmCheckT = 0;
function viewAt(p) {
  if (!data || !sched) return null;
  const h = headAt(data, sched, p);
  if (!h) return null;
  return opts.camera === 'auto' ? cameraTarget(h, p) : { cx: h.x, cy: h.y, z: view.z };
}
function prefetchAhead(dt) {
  if (opts.base === 'none' || !data) return;
  // 이미 통째로 받아뒀다면 앞당겨 받을 필요가 없다. 오히려 계획에 없는 타일을
  // 끌어와 캐시를 밀어내므로 받아둔 것이 도로 쫓겨난다.
  if (warmedKey === warmKey()) return;
  prefetchT += dt;
  if (prefetchT < 0.25) return;
  prefetchT = 0;
  // 1.8초 뒤 화면을 미리 받는다. 재생이 끝나갈 무렵엔 줌아웃 도착지도 함께.
  const ahead = Math.min(1, progress + 1.8 / Math.max(2, opts.duration));
  tiles.prefetch(viewAt(ahead), W, H);
  if (progress > 0.8) tiles.prefetch(viewFor(...allBounds(), 0.12), W, H);
}

/* ============================ 지도 통째로 미리 받기 ============================
 * 재생 경로는 이미 다 알고 있다. 영상이 지나갈 화면들을 미리 훑어 필요한 타일을
 * 한 번에 받아두면, 녹화 중에 타일이 늦게 도착해 지도가 비는 일이 아예 없다.
 * (화면에 들어와야 요청하는 방식으로는 빠른 구간을 절대 따라잡지 못한다.)
 */
let warming = false, warmedKey = '';
// 미리 받아둔 계획이 지금 설정에도 유효한지 가리는 열쇠. 하나라도 바뀌면 경로가 달라진다.
const warmKey = () => [opts.base, opts.duration, opts.mode, opts.emph, opts.camera, opts.zoom,
                       opts.vertical, W, H, data ? data.pts.length : 0].join('|');
function planTiles() {
  if (!data || !sched || opts.base === 'none') return [];
  const seen = new Set(), out = [];
  const add = v => {
    for (const t of tiles.enumerate(v, W, H)) {
      const k = t[0] + '/' + t[1] + '/' + t[2];
      if (seen.has(k)) continue; seen.add(k); out.push(t);
    }
  };
  const wide = viewFor(...allBounds(), 0.12);
  if (opts.camera === 'fixed') { add(view); return out; }   // 고정 카메라는 지금 화면이 전부다

  // 재생을 실제로 한 번 돌려보되 그리지는 않는다. 카메라가 목표를 감속해 따라가므로
  // 목표 지점만 훑으면 그 사이를 지나는 축척들을 통째로 놓친다.
  const FPS = 60, dt = 1 / FPS;   // 실제 재생과 프레임 간격을 맞춰야 궤적이 덜 어긋난다
  const sim = { cx: wide.cx, cy: wide.cy, z: wide.z };
  const to = playTarget();
  // ① 인트로 — 넓은 화면에서 시작 지점으로 파고드는 동안
  const from = { cx: wide.cx, cy: wide.cy,
                 z: Math.max(0.6, Math.min(wide.z, to.z - INTRO.minZoom)) };
  const idur = Math.min(INTRO.maxSec, INTRO.minSec + Math.abs(to.z - from.z) * INTRO.perStop);
  for (let t = 0; t <= idur; t += dt * 3) {
    const u = Math.min(1, t / idur);
    const ep = easeIO(Math.min(1, u / INTRO.panEnd));
    const ez = easeIO(Math.max(0, (u - INTRO.zoomFrom) / (1 - INTRO.zoomFrom)));
    add({ cx: from.cx + (to.cx - from.cx) * ep, cy: from.cy + (to.cy - from.cy) * ep,
          z: from.z + (to.z - from.z) * ez });
  }
  // ② 본 재생 — 프레임 단위로 카메라를 실제와 같은 식으로 굴린다
  sim.cx = to.cx; sim.cy = to.cy; sim.z = to.z;
  const dur = Math.max(2, opts.duration);
  let k = 0;
  for (let p = 0; p <= 1; p += dt / dur) {
    stepCamera(sim, p, dt);
    if ((k++ % 2) === 0) add(sim);        // 두 프레임에 한 번만 담아도 화면이 겹쳐 충분하다
  }
  // ③ 줌아웃 — 마지막 화면에서 전체 경로 화면까지
  for (let t = 0; t <= 1.8; t += dt * 3) {
    const u = Math.min(1, t / 1.8), e = easeIO(u);
    add({ cx: sim.cx + (wide.cx - sim.cx) * e, cy: sim.cy + (wide.cy - sim.cy) * e,
          z: sim.z + (wide.z - sim.z) * e });
  }
  add(wide);
  return out;
}
function warmTiles(after) {
  if (warming) return;
  const plan = planTiles();
  if (!plan.length) { if (after) after(); return; }
  tiles.max = Math.max(1400, plan.length + 500);   // 받아둔 타일이 도로 쫓겨나지 않게
  warming = true;
  $('warm').disabled = true;
  let i = 0;
  const total = plan.length;
  const tick = () => {
    if (!warming) return;
    while (i < total && tiles.loading < 24) { const t = plan[i++]; tiles.get(t[0], t[1], t[2]); }
    const done = plan.reduce((a, t) => a + (tiles.ready(t[0], t[1], t[2]) ? 1 : 0), 0);
    $('warmN').textContent = `지도 받는 중 ${done.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}`;
    if (done >= total || (i >= total && tiles.loading === 0)) {
      warming = false; $('warm').disabled = false;
      warmedKey = warmKey();
      $('warmN').textContent = `지도 ${done.toLocaleString('ko-KR')}장 준비됨`;
      needsDraw = true;
      if (after) after();
      return;
    }
    setTimeout(tick, 120);
  };
  tick();
}
function updateWarmUI() {
  const on = opts.base !== 'none';
  $('warm').classList.toggle('hide', !on);
  if (!on) { $('warmN').textContent = ''; warming = false; warmedKey = ''; }
}

/* ============================ 시작 줌인 ============================
 * 재생을 누르자마자 시작 지점으로 순간이동하면 "어디에서 시작하는지"가 남지 않는다.
 * 전체 경로가 보이는 자리에서 천천히 줌인해 들어간 다음 경로를 그리기 시작한다.
 */
// 자리를 먼저 잡고(panEnd까지) 그 다음에 파고든다(zoomFrom부터).
// 이동과 확대를 같은 곡선으로 섞으면 중간에 시작 지점이 화면 밖으로 밀려나 빈 화면이 된다.
const INTRO = { minSec: 1.6, maxSec: 4.0, perStop: 0.26, minZoom: 1.6, panEnd: 0.45, zoomFrom: 0.3 };
const easeIO = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
function playTarget() {
  const h = headAt(data, sched, 0);
  return opts.camera === 'auto' ? cameraTarget(h) : { cx: h.x, cy: h.y, z: view.z };
}
function startIntro() {
  intro = null;
  if (!data || !data.pts.length) return;
  if (opts.camera === 'fixed') { snapCamera(); return; }   // 고정 카메라는 사용자가 잡아둔 화면을 존중한다
  const to = playTarget();
  const wide = viewFor(...allBounds(), 0.12);
  // 경로가 좁은 지역이라 전체 뷰와 시작 뷰가 비슷해도, 최소 이만큼은 넓은 데서 들어온다
  const from = { cx: wide.cx, cy: wide.cy,
                 z: Math.max(0.6, Math.min(wide.z, to.z - INTRO.minZoom)) };
  view.cx = from.cx; view.cy = from.cy; view.z = from.z;
  intro = { t: 0, from, to,
            dur: Math.min(INTRO.maxSec, INTRO.minSec + Math.abs(to.z - from.z) * INTRO.perStop) };
  // 인트로가 도는 1.6~4초 동안 도착지 타일을 미리 받아둔다
  if (opts.base !== 'none') { tiles.prefetch(from, W, H); tiles.prefetch(to, W, H); }
  needsDraw = true;
}

/* ============================ 추천 길이 ============================
 * 사진이 늘면 길이도 늘어야 하지만 비례로 늘리면 금방 지루해진다.
 * 400장 = 12초를 기준점으로 제곱근에 맞춰 늘린다. (1,000장 19초 · 2,000장 27초 · 10,000장 60초)
 */
function suggestDuration(n) {
  return Math.max(8, Math.min(60, Math.round(12 * Math.sqrt(n / 400))));
}
function updateDurHint() {
  if (!data) { $('durAuto').classList.add('hide'); return; }
  const s = suggestDuration(data.pts.length);
  $('durAuto').textContent = '추천 ' + s + '초';
  $('durAuto').classList.toggle('hide', Math.abs(s - opts.duration) < 1);
}
function applySuggestedDuration() {
  if (!data) return;
  opts.duration = suggestDuration(data.pts.length);
  $('dur').value = opts.duration;
  $('durN').textContent = opts.duration + '초';
  updateDurHint();
}

/* ============================ 리사이즈 ============================ */
function resize() {
  if (opts.vertical) { W = 1080; H = 1920; }
  else {
    const r = $('stage').getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(320, Math.round(r.width * dpr));
    H = Math.max(240, Math.round(r.height * dpr));
  }
  canvas.width = W; canvas.height = H;
  const tr = tl.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  tl.width = Math.round(tr.width * dpr); tl.height = Math.round(tr.height * dpr);
  needsDraw = true;
}
window.addEventListener('resize', resize);

/* ============================ 그리기 ============================ */
function drawScale() {
  return {
    lineWidth: Math.max(2.5, Math.min(W, H) * 0.0062),
    dotScale: Math.max(0.75, Math.min(W, H) / 780),
    hud: Math.round(Math.min(W, H) * 0.052),
    glow: opts.glow,
    curve: opts.curve,
  };
}

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0;
  lastFrame = ts; phase += dt;

  if (intro && (playing || recording)) {
    // 지도를 직접 만지면(카메라가 고정으로 바뀐다) 인트로는 즉시 사용자에게 양보한다
    if (opts.camera === 'fixed') intro = null;
    else {
      intro.t += dt;
      const u = Math.min(1, intro.t / intro.dur);
      const ep = easeIO(Math.min(1, u / INTRO.panEnd));
      const ez = easeIO(Math.max(0, (u - INTRO.zoomFrom) / (1 - INTRO.zoomFrom)));
      view.cx = intro.from.cx + (intro.to.cx - intro.from.cx) * ep;
      view.cy = intro.from.cy + (intro.to.cy - intro.from.cy) * ep;
      view.z  = intro.from.z  + (intro.to.z  - intro.from.z)  * ez;
      needsDraw = true;
      if (u >= 1) intro = null;
    }
  } else if (playing && data) {
    progress += dt / Math.max(2, opts.duration);
    if (progress >= 1) {
      progress = 1; playing = false;
      $('play').textContent = '▶ 재생';
      // 끝나면 전체 경로가 보일 때까지 줌아웃한 뒤에 녹화를 마친다. 고정 카메라일 땐 그대로 둔다.
      if (opts.camera !== 'fixed') {
        outro = { t: 0, dur: 1.8, from: { cx: view.cx, cy: view.cy, z: view.z },
                  to: viewFor(...allBounds(), 0.12) };
        if (opts.base !== 'none') tiles.prefetch(outro.to, W, H);
      } else if (recording) stopRecording();
    }
    needsDraw = true;
  }
  if (outro) {
    if (opts.camera === 'fixed') {          // 줌아웃 중에 지도를 만지면 사용자에게 양보한다
      outro = null; if (recording) stopRecording();
    } else {
      outro.t += dt;
      const u = Math.min(1, outro.t / outro.dur);
      const e = u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      view.cx = outro.from.cx + (outro.to.cx - outro.from.cx) * e;
      view.cy = outro.from.cy + (outro.to.cy - outro.from.cy) * e;
      view.z = outro.from.z + (outro.to.z - outro.from.z) * e;
      needsDraw = true;
      if (u >= 1) { outro = null; if (recording) stopRecording(); }
    }
  }
  if ((playing || recording) && !intro) prefetchAhead(dt);
  // 설정이 바뀌면 받아둔 계획은 더 이상 맞지 않는다 — 표시를 지운다
  warmCheckT += dt;
  if (warmCheckT > 0.5) {
    warmCheckT = 0;
    if (warmedKey && warmedKey !== warmKey()) { warmedKey = ''; if (!warming) $('warmN').textContent = ''; }
  }
  if (data && !outro && !intro && opts.camera !== 'fixed' && (playing || recording)) {
    if (stepCamera(view, progress, dt)) needsDraw = true;
  }
  if (tiles.loading > 0) needsDraw = true;
  if (!needsDraw) return;
  needsDraw = false;
  draw();
  drawTimeline();
}

function draw() {
  const col = C(), o = drawScale();
  ctx.fillStyle = col.sea; ctx.fillRect(0, 0, W, H);

  if (opts.base === 'none') drawLand(ctx, view, W, H, col.land, col.landLine);
  else {
    drawLand(ctx, view, W, H, col.land, 'transparent');   // 타일 도착 전 밑그림
    tiles.draw(ctx, view, W, H);
  }
  if (!data) { drawEmpty(col, o); return; }

  const h = headAt(data, sched, progress);
  drawRoute(ctx, data, view, W, H, h, col, o);
  drawPlaces(ctx, data, view, W, H, h.t, col, o);
  const { X, Y } = projector(view, W, H);
  if (progress < 1 || playing || recording || outro) drawHead(ctx, X(h.x), Y(h.y), col, o, phase);

  if (opts.labels) drawLabels(ctx, data, view, W, H, h.t, col, o, opts.vertical ? 9 : 12);

  const idx = pinIdx >= 0 ? pinIdx : hoverIdx;
  if (idx >= 0 && idx < data.pts.length) {
    const p = data.pts[idx];
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 9 * o.dotScale, 0, 6.2832);
    ctx.strokeStyle = col.route; ctx.lineWidth = 2.5 * o.dotScale; ctx.stroke();
  }

  drawHUD(ctx, W, H, {
    label: MODE_LABEL[opts.mode] || '',
    date: fmtDate(h.t),
    km: fmtKm(h.km),
    foot: `사진 ${Math.min(data.pts.length, h.i + 1 + Math.round(h.f)).toLocaleString('ko-KR')} / ${data.pts.length.toLocaleString('ko-KR')}장 · 방문지 ${data.cities.filter(c => c.t0 <= h.t).length}곳`,
    // 저작자 표시는 어떤 배경에서도 비우지 않는다. 직접 지정한 서버도 대개 OSM 데이터를 쓴다.
    attr: opts.base === 'none' ? 'Natural Earth'
        : (tiles.custom ? ($('customAttr').value.trim() || DEFAULT_ATTR) : tiles.src.attr),
    p: progress,
  }, col, o);
}

function drawEmpty(col, o) {
  ctx.textAlign = 'center'; ctx.fillStyle = col.hudDim;
  ctx.font = `600 ${o.hud * 0.7}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  ctx.fillText('위치 기록이 담긴 JSON 파일을 끌어다 놓으세요', W / 2, H / 2);
  ctx.textAlign = 'left';
}

/* ============================ 타임라인 ============================ */
function makeBuckets(d) {
  const span = Math.max(1, d.t1 - d.t0);
  const N = 200;
  const step = span / N;
  const counts = new Uint32Array(N + 1);
  for (const p of d.pts) counts[Math.min(N, Math.floor((p.t - d.t0) / step))]++;
  let max = 1; for (const c of counts) if (c > max) max = c;
  return { counts, max, step, N };
}

function drawTimeline() {
  const w = tl.width, h = tl.height;
  const col = C();
  tctx.clearRect(0, 0, w, h);
  if (!data || !buckets) return;
  const dpr = w / tl.getBoundingClientRect().width;
  const padB = 16 * dpr;
  const bw = w / buckets.counts.length;
  const head = headAt(data, sched, progress);
  const tFrac = data.t1 > data.t0 ? (head.t - data.t0) / (data.t1 - data.t0) : progress;
  // 지나온 구간은 강조색, 앞으로 올 구간은 옅은 잉크 — 단일 계열이라 범례가 필요 없다
  for (let i = 0; i < buckets.counts.length; i++) {
    const c = buckets.counts[i];
    if (!c) continue;
    const bh = Math.max(1.5 * dpr, (h - padB) * Math.sqrt(c / buckets.max));
    const done = (i / buckets.counts.length) <= tFrac + 1e-9;
    tctx.fillStyle = done ? col.route : (opts.dark ? 'rgba(255,255,255,.16)' : 'rgba(20,22,24,.14)');
    tctx.fillRect(i * bw, h - padB - bh, Math.max(1, bw - 0.7 * dpr), bh);
  }
  tctx.fillStyle = opts.dark ? 'rgba(255,255,255,.14)' : 'rgba(20,22,24,.12)';
  tctx.fillRect(0, h - padB, w, 1 * dpr);

  const x = Math.max(0, Math.min(1, tFrac)) * w;
  tctx.fillStyle = col.route;
  tctx.fillRect(x - 1 * dpr, 0, 2 * dpr, h - padB);
  tctx.beginPath(); tctx.arc(x, h - padB, 4 * dpr, 0, 6.2832); tctx.fill();

  tctx.font = `500 ${10 * dpr}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  tctx.fillStyle = col.hudFaint;
  tctx.textAlign = 'left'; tctx.fillText(fmtDate(data.t0), 2 * dpr, h - 4 * dpr);
  tctx.textAlign = 'right'; tctx.fillText(fmtDate(data.t1), w - 2 * dpr, h - 4 * dpr);
  tctx.textAlign = 'left';
}

let scrubbing = false;
const scrubTo = e => {
  const r = tl.getBoundingClientRect();
  progress = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  playing = false; $('play').textContent = '▶ 재생';
  outro = null; intro = null;
  snapCamera();
  needsDraw = true;
};
tl.addEventListener('pointerdown', e => { scrubbing = true; tl.setPointerCapture(e.pointerId); scrubTo(e); });
tl.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
tl.addEventListener('pointerup', () => scrubbing = false);

/* ============================ 지도 조작 ============================ */
let dragging = false, dragX = 0, dragY = 0, moved = 0;
const cssScale = () => canvas.width / canvas.getBoundingClientRect().width;

canvas.addEventListener('pointerdown', e => {
  dragging = true; moved = 0; dragX = e.clientX; dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', e => {
  const k = cssScale();
  if (dragging) {
    const s = 256 * Math.pow(2, view.z);
    view.cx -= (e.clientX - dragX) * k / s; view.cy -= (e.clientY - dragY) * k / s;
    view.cy = Math.max(0, Math.min(1, view.cy));
    moved += Math.abs(e.clientX - dragX) + Math.abs(e.clientY - dragY);
    if (moved > 12 && opts.camera !== 'fixed') { opts.camera = 'fixed'; $('camera').value = 'fixed'; }
    dragX = e.clientX; dragY = e.clientY; needsDraw = true;
    return;
  }
  if (!data) return;
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
  const { X, Y } = projector(view, W, H);
  const h = headAt(data, sched, progress);
  let best = -1, bd = 18 * k * 18 * k;
  for (let i = 0; i <= h.i + 1 && i < data.pts.length; i++) {
    const dx = X(data.pts[i].x) - px, dy = Y(data.pts[i].y) - py;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  if (best !== hoverIdx) { hoverIdx = best; needsDraw = true; showTip(best, e); }
  else if (best >= 0) showTip(best, e);
});
canvas.addEventListener('pointerup', e => {
  dragging = false; canvas.style.cursor = 'grab';
  if (moved < 5) { pinIdx = hoverIdx; needsDraw = true; }
});
canvas.addEventListener('pointerleave', () => { hoverIdx = -1; $('tip').classList.add('hide'); needsDraw = true; });
canvas.addEventListener('wheel', e => {
  // 그냥 휠은 페이지 스크롤로 흘려보낸다 — 지도 위를 지나가며 스크롤하다 자동 줌이 꺼지는 사고 방지.
  // Ctrl(맥은 ⌘)+휠과 트랙패드 핀치(ctrlKey로 들어온다)만 지도 줌으로 받는다.
  if (!e.ctrlKey && !e.metaKey) { showWheelHint(); return; }
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), k = cssScale();
  const px = (e.clientX - r.left) * k - W / 2, py = (e.clientY - r.top) * k - H / 2;
  const s0 = 256 * Math.pow(2, view.z);
  const wx = view.cx + px / s0, wy = view.cy + py / s0;
  view.z = Math.max(0.6, Math.min(19, view.z - e.deltaY * (e.deltaMode ? 0.06 : 0.0022)));
  if (opts.camera !== 'fixed') { opts.camera = 'fixed'; $('camera').value = 'fixed'; }
  const s1 = 256 * Math.pow(2, view.z);
  view.cx = wx - px / s1; view.cy = wy - py / s1;
  needsDraw = true;
}, { passive: false });

let hintT = 0;
function showWheelHint() {
  const el = $('wheelHint');
  el.classList.add('show');
  clearTimeout(hintT);
  hintT = setTimeout(() => el.classList.remove('show'), 1100);
}

function showTip(i, e) {
  const tip = $('tip');
  if (i < 0) { tip.classList.add('hide'); return; }
  const p = data.pts[i];
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(p.taken || '');
  const when = m ? fmtDate(Date.parse(m[1] + 'T00:00:00Z')) + ' ' + m[2] : fmtDate(p.t, p.tz);
  const file = p.path ? String(p.path).split(/[\\/]/).pop() : '';   // 전체 경로 대신 파일명만
  tip.innerHTML = `<b>${esc(when)}${p.tz ? ' <span>' + esc(p.tz) + '</span>' : ''}</b>` +
    `<span>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>` +
    (file ? `<span class="pth">${esc(file)}</span>` : '');
  const r = $('stage').getBoundingClientRect();
  tip.style.left = Math.min(r.width - 20, Math.max(10, e.clientX - r.left)) + 'px';
  tip.style.top = Math.max(8, e.clientY - r.top - 12) + 'px';
  tip.classList.remove('hide');
}

/* ============================ 통계 ============================ */
function renderStats() {
  const d = data;
  const byDay = new Map();
  for (const p of d.pts) {
    // 촬영지 현지 날짜로 센다 — p.t(UTC)로 자르면 자정 근처 사진이 하루 어긋난다
    const k = /^\d{4}-\d{2}-\d{2}/.test(p.taken) ? p.taken.slice(0, 10)
            : new Date(p.t + tzMs(p.tz)).toISOString().slice(0, 10);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  let topDay = '', topN = 0;
  byDay.forEach((v, k) => { if (v > topN) { topN = v; topDay = k; } });
  const rows = [
    ['총 이동거리', fmtKm(d.total)],
    ['지상 이동', fmtKm(d.groundKm)],
    ['비행·고속 구간', fmtKm(d.flightKm)],
    ['기간', fmtDays(d.t1 - d.t0)],
    ['사진', d.pts.length.toLocaleString('ko-KR') + '장'],
    ['방문지', d.cities.length.toLocaleString('ko-KR') + '곳'],
    ['가장 많이 찍은 날',
     topDay ? fmtDate(Date.parse(topDay + 'T00:00:00Z')) + ' (' + topN.toLocaleString('ko-KR') + '장)' : '–'],
  ];
  $('stats').innerHTML = rows.map(([k, v]) =>
    `<div class="st"><b>${v}</b><span>${k}</span></div>`).join('');
}

/* ============================ 컨트롤 ============================ */
$('play').onclick = () => {
  if (!data) return;
  outro = null;
  // 처음부터 재생할 때만 줌인 인트로를 넣는다. 일시정지 후 재개면 인트로를 이어서 재생한다.
  if (progress >= 1 && !intro) { progress = 0; startIntro(); }
  playing = !playing;
  $('play').textContent = playing ? '❚❚ 일시정지' : '▶ 재생';
  needsDraw = true;
};
// 잘못 눌렀을 때의 탈출구 — 일시정지와 달리 처음(전체 경로) 화면으로 완전히 되돌린다
$('stop').onclick = () => {
  if (!data) return;
  if (recording) {                 // 녹화 중 정지는 취소다. 잘못 누른 걸 저장까지 하면 더 성가시다.
    recAbort = true; recording = false;
    if (rec && rec.state !== 'inactive') rec.stop();
  }
  playing = false; outro = null; intro = null; progress = 1;
  $('play').textContent = '▶ 재생';
  fitAll();
};
$('fit').onclick = fitAll;
$('warm').onclick = () => warmTiles();
$('dateFrom').onchange = applyRangeFilter;
$('dateTo').onchange = applyRangeFilter;
$('yearChips').onclick = e => {
  const b = e.target.closest('button[data-y]');
  if (!b || !dataRange) return;
  if (b.dataset.y === 'all') { $('dateFrom').value = dataRange[0]; $('dateTo').value = dataRange[1]; }
  else { $('dateFrom').value = clampD(b.dataset.y + '-01-01');
         $('dateTo').value   = clampD(b.dataset.y + '-12-31'); }
  applyRangeFilter();
};
$('base').onchange = e => {
  opts.base = e.target.value;
  if (opts.base !== 'none') {
    tiles.setSource(opts.base, $('customUrl').value.trim());
    tiles.prefetch(view, W, H);                       // 지금 화면
    if (data) tiles.prefetch(viewFor(...allBounds(), 0.12), W, H);   // 전체 경로 화면
  }
  updateBaseNote(); updateWarmUI();
  needsDraw = true;
};
$('customUrl').oninput = e => {
  tiles.setSource(opts.base, e.target.value.trim());
  updateBaseNote();
  needsDraw = true;
};
$('customAttr').oninput = () => { updateBaseNote(); needsDraw = true; };

/* 지도 배경을 고를 때마다, 그 선택이 무엇을 밖으로 내보내는지 그 자리에서 알려준다. */
const BASE_PROVIDER = { smooth: 'Stadia Maps', smoothdark: 'Stadia Maps',
                        watercolor: 'Stadia Maps', osm: 'OpenStreetMap' };
// 밝은/어두운 짝 — 테마를 바꾸면 이 둘 사이에서만 따라 바뀐다 (오프라인은 절대 건드리지 않는다)
const THEME_PAIR = { smooth: 'smoothdark', smoothdark: 'smooth' };
function updateBaseNote() {
  const el = $('baseNote');
  if (!el) return;
  const custom = $('customUrl').value.trim();
  let host = '';
  if (custom) { try { host = new URL(custom.replace(/\{[^}]*\}/g, '0')).hostname; } catch (e) { host = ''; } }

  if (opts.base === 'none') {
    el.className = 'basenote off';
    el.innerHTML = custom
      ? '<b>지금은 지도를 인터넷에서 받아오지 않습니다.</b> 직접 지정한 서버로도 요청하지 않아요. ' +
        '그 서버를 쓰려면 위에서 온라인 지도를 하나 고르세요.'
      : '<b>지금은 지도를 인터넷에서 받아오지 않습니다.</b> 지도 그림이 프로그램 안에 들어 있어서, ' +
        '이 화면을 그리는 동안 밖으로 나가는 요청이 없어요.';
    return;
  }
  el.className = 'basenote on';
  const who = custom ? (host ? '직접 지정한 서버(' + host + ')' : '직접 지정한 서버')
                     : (BASE_PROVIDER[opts.base] || '지도 서버');
  el.innerHTML =
    '<b>' + who + '에서 지도 그림을 받아옵니다.</b> ' +
    '저작자 표시 <b>' + esc(custom ? ($('customAttr').value.trim() || DEFAULT_ATTR) : tiles.src.attr) +
    '</b> 가 영상·PNG 오른쪽 아래에 함께 찍힙니다 — 지우지 마세요. ' +
    '이때 그쪽 서버에는 <b>지금 어느 지역을 얼마나 확대해서 보고 있는지</b>와 접속 IP·브라우저 종류가 남을 수 있어요. ' +
    '재생 중에는 화면이 경로를 따라 움직이니, 이동한 지역의 대략적인 윤곽까지 남을 수 있습니다. ' +
    '사진 파일·좌표값·촬영 시각·파일 이름은 보내지 않습니다. ' +
    (custom ? '이 서버를 믿을 수 있는지는 직접 확인하세요. ' : '') +
    '신경 쓰이면 <b>내장 벡터 (오프라인)</b>로 되돌리면 됩니다.' +
    '<span class="warm"><b>● 영상 저장을 누르면 지도를 먼저 다 받아둔 뒤 녹화를 시작합니다.</b> ' +
    '지도 그림은 화면에 보이는 만큼 받아오기 때문에, 미리 받아두지 않으면 영상 중간에 지도가 ' +
    '비어 보일 수 있어서예요. 재생만 매끄럽게 보고 싶다면 <b>지도 미리 받기</b>를 눌러 두세요.</span>';
}
$('mode').onchange = e => {
  opts.mode = e.target.value;
  sched = data ? buildSchedule(data, opts.mode, opts.emph) : null;
  $('emphWrap').style.opacity = opts.mode === 'smooth' ? '1' : '.35';
  $('emph').disabled = opts.mode !== 'smooth';
  needsDraw = true;
};
$('emph').oninput = e => {
  opts.emph = (+e.target.value) / 100 * 3;
  $('emphN').textContent = e.target.value + '%';
  sched = data ? buildSchedule(data, opts.mode, opts.emph) : null;
  needsDraw = true;
};
$('camera').onchange = e => { opts.camera = e.target.value; intro = null; snapCamera(); needsDraw = true; };
$('zoom').oninput = e => {
  opts.zoom = +e.target.value;
  const x = Math.pow(2, opts.zoom);
  $('zoomN').textContent = (x < 10 ? x.toFixed(1).replace('.0', '') : Math.round(x)) + '배';
  snapCamera(); needsDraw = true;
};
$('glow').onchange = e => { opts.glow = e.target.checked; needsDraw = true; };
$('curve').onchange = e => { opts.curve = e.target.checked; needsDraw = true; };
$('routeColor').oninput = e => { opts.routeColor = e.target.value; needsDraw = true; };
$('colorReset').onclick = () => {
  opts.routeColor = '';
  $('routeColor').value = THEMES[opts.dark ? 'dark' : 'light'].route;
  needsDraw = true;
};
$('labels').onchange = e => { opts.labels = e.target.checked; needsDraw = true; };
$('dur').oninput = e => {
  opts.duration = +e.target.value; $('durN').textContent = e.target.value + '초';
  updateDurHint();
};
$('durAuto').onclick = applySuggestedDuration;
$('theme').onchange = e => {
  opts.dark = e.target.value === 'dark';
  document.body.dataset.theme = e.target.value;
  if (!opts.routeColor) $('routeColor').value = THEMES[opts.dark ? 'dark' : 'light'].route;
  // 밝은 지도를 쓰던 중이라면 어두운 짝으로 (그 반대도). 그 외 배경은 그대로 둔다.
  if (THEME_PAIR[opts.base]) {
    const want = opts.dark ? 'smoothdark' : 'smooth';
    if (want !== opts.base) {
      opts.base = want; $('base').value = want;
      tiles.setSource(want, $('customUrl').value.trim());
      updateBaseNote();
    }
  }
  needsDraw = true;
};
$('vertical').onchange = e => {
  opts.vertical = e.target.checked;
  $('stage').classList.toggle('vert', opts.vertical);
  resize(); fitAll();
};
$('png').onclick = () => {
  if (!checkClean()) return;
  canvas.toBlob(b => saveBlob(b, 'photo-map.png'), 'image/png');
};

/* ============================ 녹화 ============================ */
let rec = null, chunks = [], recAbort = false;
function checkClean() {
  try { ctx.getImageData(0, 0, 1, 1); return true; }
  catch (e) {
    setStatus('현재 지도 배경(외부 타일)은 브라우저 보안 정책 때문에 이미지·영상으로 저장할 수 없습니다. 지도 배경을 "내장 벡터 (오프라인)"로 바꾸면 항상 저장됩니다.', true);
    return false;
  }
}
$('record').onclick = () => {
  if (!data) return;
  if (recording) { stopRecording(); return; }
  if (!checkClean()) return;
  // 온라인 배경이면 영상이 지나갈 지도를 먼저 통째로 받아둔다.
  // 이미 받아둔 상태면 한 박자에 끝나고 바로 녹화로 넘어간다.
  if (opts.base !== 'none' && !warming) { warmTiles(beginRecording); return; }
  beginRecording();
};
function beginRecording() {
  // mp4(H.264)를 먼저 시도한다 — 릴스·쇼츠에 변환 없이 바로 올라간다. 미지원 브라우저는 webm으로 폴백.
  const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4',
                'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { setStatus('이 브라우저에서는 영상 저장이 지원되지 않습니다. 크롬이나 엣지에서 다시 시도해 주세요.', true); return; }
  const isMp4 = mime.startsWith('video/mp4');
  const stream = canvas.captureStream(30);
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    recording = false; $('record').textContent = '● 영상 저장';
    $('record').classList.remove('rec');
    if (recAbort) { recAbort = false; setStatus('녹화를 취소했습니다. 파일은 저장되지 않았습니다.'); return; }
    saveBlob(new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' }),
             isMp4 ? 'photo-map.mp4' : 'photo-map.webm');
    setStatus(isMp4 ? 'mp4로 저장했습니다. 릴스·쇼츠에 바로 올릴 수 있습니다.'
                    : 'webm으로 저장했습니다. 쇼츠(웹 업로드)는 그대로 되고, 릴스는 mp4로 변환이 필요합니다.');
  };
  rec.start();
  recAbort = false;
  recording = true; progress = 0; outro = null; startIntro(); playing = true;
  $('record').textContent = '■ 녹화 중지'; $('record').classList.add('rec');
  $('play').textContent = '❚❚ 일시정지';
  setStatus('녹화 중… 재생이 끝나면 자동으로 저장됩니다.');
}
function stopRecording() {
  playing = false; $('play').textContent = '▶ 재생';
  setTimeout(() => { if (rec && rec.state !== 'inactive') rec.stop(); }, 500);
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 6000);
}

/* ============================ 시작 ============================ */
tiles.onload = () => { needsDraw = true; };
if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) {
  // 다크 테마라고 해서 온라인 지도로 바꾸지는 않는다. 기본은 언제나 오프라인 지도다.
  opts.dark = true;
  $('theme').value = 'dark';
  $('routeColor').value = THEMES.dark.route;
  document.body.dataset.theme = 'dark';
}
$('base').value = opts.base;
if (opts.base !== 'none') tiles.setSource(opts.base, '');
updateBaseNote();
updateWarmUI();
resize();
requestAnimationFrame(frame);
