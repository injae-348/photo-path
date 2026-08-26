/* ============================ 상태 ============================ */
const $ = id => document.getElementById(id);
const canvas = $('map'), ctx = canvas.getContext('2d', { alpha: false });
const tl = $('timeline'), tctx = tl.getContext('2d');
const tiles = new TileLayer();

let data = null, W = 0, H = 0;
let view = { cx: 0.5, cy: 0.5, z: 1.6 };
let progress = 1, playing = false, recording = false, hoverIdx = -1, pinIdx = -1;
let lastFrame = 0, phase = 0, needsDraw = true, buckets = null;
let sched = null, fitZ = 2, lastReport = null, outro = null;

const opts = {
  base: 'light', custom: '', mode: 'smooth', emph: 1.5, camera: 'auto',
  vertical: true, duration: 12, glow: true, dark: false, labels: true, zoom: 3.5,
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
  let got;
  try {
    got = ingest(text);                          // 형식은 인제스터가 알아서 맞춘다
  } catch (e) {
    setStatus(e.message || '파일을 해석하지 못했습니다.', true);
    return;
  }
  lastReport = got.report;
  showReport(got.report);
  const d = prepare(got.records);
  if (!d.pts.length) {
    setStatus('좌표와 시각을 모두 가진 항목이 없습니다.', true);
    return;
  }
  data = d;
  buckets = makeBuckets(d);
  sched = buildSchedule(d, opts.mode, opts.emph);
  $('drop').classList.add('loaded');
  $('panel').classList.remove('hide');
  resize();
  $('fileName').textContent = name;
  fitAll();
  progress = 1; playing = false; outro = null;
  renderStats();
  setStatus('');
  needsDraw = true;
}
// 무엇을 어떤 키에서 읽었는지 보여준다. 낯선 형식일수록 이게 있어야 믿고 쓴다.
function showReport(r) {
  const k = r.keys || {};
  const bits = [];
  if (k.lat) bits.push(`위도 <code>${esc(k.lat)}</code>`);
  if (k.lon) bits.push(`경도 <code>${esc(k.lon)}</code>`);
  if (k.time) bits.push(`시각 <code>${esc(k.time)}</code>`);
  if (k.alt) bits.push(`고도 <code>${esc(k.alt)}</code>`);
  if (k.label) bits.push(`이름 <code>${esc(k.label)}</code>`);
  const skip = [];
  if (r.noGeo) skip.push(`좌표 없음 ${r.noGeo}`);
  if (r.noTime) skip.push(`시각 없음 ${r.noTime}`);
  if (r.bad) skip.push(`형식 이상 ${r.bad}`);
  if (r.swapped) skip.push(`위경도 뒤바뀜 교정 ${r.swapped}`);
  $('report').innerHTML =
    `<b>${r.ok.toLocaleString('ko-KR')}</b> / ${r.total.toLocaleString('ko-KR')}건 인식` +
    (bits.length ? ' · ' + bits.join(' · ') : '') +
    (skip.length ? ` · <span class="skip">제외 ${skip.join(', ')}</span>` : '');
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
  r.onerror = () => setStatus('파일을 읽지 못했습니다.', true);
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
  outro = null;                       // 이미 전체 뷰이므로 진행 중인 줌아웃은 무의미하다
  needsDraw = true;
}
// 자동 줌이 노리는 목표 뷰
function cameraTarget(h) {
  const b = cameraBounds(data, sched, h, progress, opts.duration);
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
function snapCamera() {
  if (!data || opts.camera !== 'auto') return;
  const v = cameraTarget(headAt(data, sched, progress));
  view.cx = v.cx; view.cy = v.cy; view.z = v.z;
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

  if (playing && data) {
    progress += dt / Math.max(2, opts.duration);
    if (progress >= 1) {
      progress = 1; playing = false;
      $('play').textContent = '▶ 재생';
      // 끝나면 전체 경로가 보일 때까지 줌아웃한 뒤에 녹화를 마친다. 고정 카메라일 땐 그대로 둔다.
      if (opts.camera !== 'fixed') {
        outro = { t: 0, dur: 1.8, from: { cx: view.cx, cy: view.cy, z: view.z },
                  to: viewFor(...allBounds(), 0.12) };
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
  if (data && !outro && opts.camera !== 'fixed' && (playing || recording)) {
    const h = headAt(data, sched, progress);
    if (h) {
      // 위치는 빠르게, 축척은 느긋하게 따라간다. 줌이 출렁이면 멀미가 난다.
      const kp = 1 - Math.pow(0.0016, dt);
      if (opts.camera === 'auto') {
        const t = cameraTarget(h);
        // 빠지는 건 빠르게, 들어가는 건 느긋하게.
        // 대칭으로 두면 화면이 아직 확대된 채로 지구 반대편까지 날아가 빈 화면이 된다.
        const kz = 1 - Math.pow(t.z < view.z ? 0.012 : 0.09, dt);
        view.cx += (t.cx - view.cx) * kp;
        view.cy += (t.cy - view.cy) * kp;
        view.z += (t.z - view.z) * kz;
        // 그래도 못 따라가는 순간이 있으므로, 현재 지점은 무슨 일이 있어도 화면 안에 둔다
        const ax = Math.abs(h.x - view.cx), ay = Math.abs(h.y - view.cy);
        if (ax > 1e-12) view.z = Math.min(view.z, Math.log2(0.34 * W / (256 * ax)));
        if (ay > 1e-12) view.z = Math.min(view.z, Math.log2(0.30 * H / (256 * ay)));
        view.z = Math.max(0.6, view.z);
      } else {
        view.cx += (h.x - view.cx) * kp;
        view.cy += (h.y - view.cy) * kp;
      }
      needsDraw = true;
    }
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
    attr: opts.base === 'none' ? 'Natural Earth' : (tiles.custom ? '' : tiles.src.attr),
    p: progress,
  }, col, o);
}

function drawEmpty(col, o) {
  ctx.textAlign = 'center'; ctx.fillStyle = col.hudDim;
  ctx.font = `600 ${o.hud * 0.7}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
  ctx.fillText('추출기가 만든 JSON 파일을 끌어다 놓으세요', W / 2, H / 2);
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
  outro = null;
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
  tip.innerHTML = `<b>${p.taken ? p.taken.replace('T', ' ') : fmtDate(p.t)}${p.tz ? ' <span>' + p.tz + '</span>' : ''}</b>` +
    `<span>${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>` +
    (p.path ? `<span class="pth">${p.path}</span>` : '');
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
    const k = new Date(p.t).toISOString().slice(0, 10);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  let topDay = '–', topN = 0;
  byDay.forEach((v, k) => { if (v > topN) { topN = v; topDay = k; } });
  const rows = [
    ['총 이동거리', fmtKm(d.total)],
    ['지상 이동', fmtKm(d.groundKm)],
    ['비행·고속 구간', fmtKm(d.flightKm)],
    ['기간', fmtDays(d.t1 - d.t0)],
    ['사진', d.pts.length.toLocaleString('ko-KR') + '장'],
    ['방문지', d.cities.length.toLocaleString('ko-KR') + '곳'],
    ['가장 많이 찍은 날', topDay + ' (' + topN + '장)'],
    ['읽다 제외', ((lastReport ? lastReport.noGeo + lastReport.noTime + lastReport.bad : 0)).toLocaleString('ko-KR') + '건'],
  ];
  $('stats').innerHTML = rows.map(([k, v]) =>
    `<div class="st"><b>${v}</b><span>${k}</span></div>`).join('');
}

/* ============================ 컨트롤 ============================ */
$('play').onclick = () => {
  if (!data) return;
  outro = null;
  if (progress >= 1) { progress = 0; snapCamera(); }
  playing = !playing;
  $('play').textContent = playing ? '❚❚ 일시정지' : '▶ 재생';
  needsDraw = true;
};
$('fit').onclick = fitAll;
$('base').onchange = e => {
  opts.base = e.target.value;
  if (opts.base !== 'none') tiles.setSource(opts.base, $('customUrl').value.trim());
  needsDraw = true;
};
$('customUrl').oninput = e => {
  tiles.setSource(opts.base, e.target.value.trim());
  needsDraw = true;
};
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
$('camera').onchange = e => { opts.camera = e.target.value; snapCamera(); needsDraw = true; };
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
$('dur').oninput = e => { opts.duration = +e.target.value; $('durN').textContent = e.target.value + '초'; };
$('theme').onchange = e => {
  opts.dark = e.target.value === 'dark';
  document.body.dataset.theme = e.target.value;
  if (!opts.routeColor) $('routeColor').value = THEMES[opts.dark ? 'dark' : 'light'].route;
  if (opts.base !== 'none' && (opts.base === 'light' || opts.base === 'dark')) {
    const want = opts.dark ? 'dark' : 'light';
    $('base').value = want; opts.base = want; tiles.setSource(want, $('customUrl').value.trim());
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
let rec = null, chunks = [];
function checkClean() {
  try { ctx.getImageData(0, 0, 1, 1); return true; }
  catch (e) {
    setStatus('지도 타일이 CORS를 허용하지 않아 캔버스를 내보낼 수 없습니다. 배경을 "내장 벡터(오프라인)"로 바꾸면 저장됩니다.', true);
    return false;
  }
}
$('record').onclick = () => {
  if (!data) return;
  if (recording) { stopRecording(); return; }
  if (!checkClean()) return;
  // mp4(H.264)를 먼저 시도한다 — 릴스·쇼츠에 변환 없이 바로 올라간다. 미지원 브라우저는 webm으로 폴백.
  const mime = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4',
                'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { setStatus('이 브라우저는 캔버스 녹화를 지원하지 않습니다.', true); return; }
  const isMp4 = mime.startsWith('video/mp4');
  const stream = canvas.captureStream(30);
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    saveBlob(new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' }),
             isMp4 ? 'photo-map.mp4' : 'photo-map.webm');
    recording = false; $('record').textContent = '● 영상 저장';
    $('record').classList.remove('rec');
    setStatus(isMp4 ? 'mp4로 저장했습니다. 릴스·쇼츠에 바로 올릴 수 있습니다.'
                    : 'webm으로 저장했습니다. 쇼츠(웹 업로드)는 그대로 되고, 릴스는 mp4로 변환이 필요합니다.');
  };
  rec.start();
  recording = true; progress = 0; outro = null; snapCamera(); playing = true;
  $('record').textContent = '■ 녹화 중지'; $('record').classList.add('rec');
  $('play').textContent = '❚❚ 일시정지';
  setStatus('녹화 중… 재생이 끝나면 자동으로 저장됩니다.');
};
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
  opts.dark = true; opts.base = 'dark';
  $('theme').value = 'dark'; $('base').value = 'dark';
  $('routeColor').value = THEMES.dark.route;
  document.body.dataset.theme = 'dark';
}
tiles.setSource(opts.base, '');
resize();
requestAnimationFrame(frame);
