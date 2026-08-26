/* ============================ 타일 레이어 ============================ */
const TILE_SOURCES = {
  light: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
           sub: 'abcd', max: 19, attr: '© OpenStreetMap · © CARTO' },
  dark:  { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
           sub: 'abcd', max: 19, attr: '© OpenStreetMap · © CARTO' },
  osm:   { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
           sub: '', max: 19, attr: '© OpenStreetMap contributors' },
  voyager: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
             sub: 'abcd', max: 19, attr: '© OpenStreetMap · © CARTO' },
};

class TileLayer {
  constructor() {
    this.cache = new Map();      // key -> {img, t}
    this.max = 600;
    this.tainted = false;
    this.loading = 0;
    this.src = TILE_SOURCES.light;
    this.custom = '';
    this.onload = null;
  }
  setSource(name, custom) {
    this.src = TILE_SOURCES[name] || TILE_SOURCES.light;
    this.custom = custom || '';
    this.cache.forEach(v => { v.img.onload = v.img.onerror = null; });
    this.cache.clear();
  }
  url(z, x, y) {
    const tpl = this.custom || this.src.url;
    const s = this.src.sub ? this.src.sub[(x + y) % this.src.sub.length] : '';
    const r = (window.devicePixelRatio > 1.3 && !this.custom) ? '@2x' : '';
    return tpl.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', r);
  }
  get(z, x, y) {
    const key = z + '/' + x + '/' + y;
    const hit = this.cache.get(key);
    if (hit) { hit.t = performance.now(); return hit.img; }
    const img = new Image();
    img.crossOrigin = 'anonymous';           // 오염되지 않아야 영상으로 뽑을 수 있다
    img.decoding = 'async';
    this.loading++;
    img.onload = () => { this.loading--; img.ok = true; this.onload && this.onload(); };
    img.onerror = () => { this.loading--; img.failed = true; };
    img.src = this.url(z, x, y);
    this.cache.set(key, { img, t: performance.now() });
    if (this.cache.size > this.max) {
      const dead = [...this.cache.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 120);
      dead.forEach(([k, v]) => { v.img.onload = v.img.onerror = null; this.cache.delete(k); });
    }
    return img;
  }
  peek(z, x, y) { const h = this.cache.get(z + '/' + x + '/' + y); return h && h.img.ok ? h.img : null; }

  draw(ctx, view, W, H) {
    const iz = Math.max(0, Math.min(this.src.max, Math.round(view.z)));
    const n = 1 << iz;
    const scale = 256 * Math.pow(2, view.z - iz);
    const cxp = view.cx * n * scale, cyp = view.cy * n * scale;
    const x0 = Math.floor((cxp - W / 2) / scale), x1 = Math.floor((cxp + W / 2) / scale);
    const y0 = Math.max(0, Math.floor((cyp - H / 2) / scale));
    const y1 = Math.min(n - 1, Math.floor((cyp + H / 2) / scale));
    let drawn = 0, missing = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const sx = tx * scale - cxp + W / 2, sy = ty * scale - cyp + H / 2;
        const img = this.get(iz, wx, ty);
        if (img.ok) { ctx.drawImage(img, sx, sy, scale + 1, scale + 1); drawn++; continue; }
        missing++;
        // 아직 안 온 타일은 상위 줌 타일의 해당 사분면으로 임시로 채운다
        for (let up = 1; up <= 4; up++) {
          const pz = iz - up; if (pz < 0) break;
          const p = this.peek(pz, wx >> up, ty >> up);
          if (!p) continue;
          const f = 1 << up, sub = 256 / f;
          ctx.drawImage(p, (wx % f) * sub, (ty % f) * sub, sub, sub, sx, sy, scale + 1, scale + 1);
          break;
        }
      }
    }
    return { drawn, missing };
  }
}

/* ============================ 벡터 배경 ============================ */
function drawLand(ctx, view, W, H, fill, stroke) {
  const s = 256 * Math.pow(2, view.z);
  const kMin = Math.floor((view.cx * s - W / 2) / s), kMax = Math.floor((view.cx * s + W / 2) / s);
  ctx.beginPath();
  // 링은 펼친 경도를 쓰므로 화면 밖 한 세계까지 그려야 이음매에서 육지가 잘리지 않는다
  for (let k = kMin - 1; k <= kMax + 1; k++) {
    const ox = W / 2 - view.cx * s + k * s, oy = H / 2 - view.cy * s;
    for (const ring of LAND) {
      ctx.moveTo(ring[0] * s + ox, ring[1] * s + oy);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * s + ox, ring[i + 1] * s + oy);
      ctx.closePath();
    }
  }
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
}

/* ============================ 경로 ============================ */
// 화면 좌표로 투영하는 클로저. 펼쳐진 경도를 쓰므로 날짜변경선에서 끊기지 않는다.
function projector(view, W, H) {
  const s = 256 * Math.pow(2, view.z);
  return { s, X: x => (x - view.cx) * s + W / 2, Y: y => (y - view.cy) * s + H / 2 };
}

function bowedArc(ctx, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  const bow = Math.min(len * 0.18, 160);
  ctx.quadraticCurveTo((x1 + x2) / 2 - dy / len * bow, (y1 + y2) / 2 + dx / len * bow, x2, y2);
}

// 카트멀-롬 스플라인. 꺾임을 곡선으로 다듬되 사진 지점은 전부 통과한다.
function splinePath(ctx, p) {
  ctx.moveTo(p[0].x, p[0].y);
  if (p.length === 2) { ctx.lineTo(p[1].x, p[1].y); return; }
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], d = p[i + 2] || c;
    ctx.bezierCurveTo(b.x + (c.x - a.x) / 6, b.y + (c.y - a.y) / 6,
                      c.x - (d.x - b.x) / 6, c.y - (d.y - b.y) / 6, c.x, c.y);
  }
}

function drawRoute(ctx, data, view, W, H, upto, C, opt) {
  const { X, Y } = projector(view, W, H);
  const pts = data.pts, legs = data.legs;
  const last = Math.min(upto.i, pts.length - 2);
  const w = opt.lineWidth;

  // 지상 이동: 하나의 굵은 선. 화면상 1.2px 미만 이동은 건너뛴다(10만 점에서도 프레임 유지).
  ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.setLineDash([]);
  if (opt.glow) { ctx.shadowColor = C.glow; ctx.shadowBlur = w * 2.4; }
  ctx.strokeStyle = C.route;
  ctx.beginPath();
  if (opt.curve) {
    // 곡선 모드: 이어지는 구간을 모았다가 스플라인으로 그린다. 구간 분리 규칙은 아래와 같다.
    const run = [];
    const flush = () => { if (run.length > 1) splinePath(ctx, run); run.length = 0; };
    let px = NaN, py = NaN;
    for (let i = 0; i <= last + 1; i++) {
      const leg = i > 0 ? legs[i - 1] : null;
      const isHead = i === last + 1;
      const fx = isHead ? X(upto.x) : X(pts[i].x), fy = isHead ? Y(upto.y) : Y(pts[i].y);
      if (!leg || leg.kind === 'gap' || leg.kind === 'flight') flush();
      else if (!isHead && Math.abs(fx - px) < 1.2 && Math.abs(fy - py) < 1.2) continue;
      run.push({ x: fx, y: fy }); px = fx; py = fy;
    }
    flush();
  } else {
    let px = NaN, py = NaN, open = false;
    for (let i = 0; i <= last + 1; i++) {
      const leg = i > 0 ? legs[i - 1] : null;
      const x = X(pts[i].x), y = Y(pts[i].y);
      const isHead = i === last + 1;
      const fx = isHead ? X(upto.x) : x, fy = isHead ? Y(upto.y) : y;
      if (!leg || leg.kind === 'gap' || leg.kind === 'flight') { open = false; }
      if (!open) { ctx.moveTo(fx, fy); open = true; px = fx; py = fy; continue; }
      if (!isHead && Math.abs(fx - px) < 1.2 && Math.abs(fy - py) < 1.2) continue;
      ctx.lineTo(fx, fy); px = fx; py = fy;
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 비행/고속 구간: 살짝 휜 점선
  ctx.strokeStyle = C.flight;
  ctx.lineWidth = Math.max(1.5, w * 0.7);
  ctx.setLineDash([w * 1.6, w * 1.8]);
  ctx.beginPath();
  for (let i = 0; i <= last; i++) {
    const leg = legs[i];
    if (!leg || leg.kind !== 'flight') continue;
    const a = pts[leg.i], b = pts[leg.j];
    const x1 = X(a.x), y1 = Y(a.y);
    const bx = i === last ? X(upto.x) : X(b.x), by = i === last ? Y(upto.y) : Y(b.y);
    ctx.moveTo(x1, y1); bowedArc(ctx, x1, y1, bx, by);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPlaces(ctx, data, view, W, H, tNow, C, opt) {
  const { X, Y } = projector(view, W, H);
  const k = opt.dotScale;
  ctx.lineWidth = Math.max(1.5, 2 * k);
  for (const pl of data.places) {
    if (pl.t0 > tNow) continue;
    const x = X(pl.x), y = Y(pl.y);
    if (x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
    const r = Math.min(16 * k, (2.6 + Math.log2(pl.n + 1) * 1.5) * k);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    ctx.fillStyle = C.dot; ctx.fill();
    ctx.strokeStyle = C.dotRing; ctx.stroke();
  }
}

function drawHead(ctx, x, y, C, opt, phase) {
  const k = opt.dotScale;
  const pulse = 1 + 0.4 * Math.sin(phase * 3.2);
  ctx.beginPath(); ctx.arc(x, y, 17 * k * pulse, 0, 6.2832);
  ctx.fillStyle = C.headHalo; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 10 * k, 0, 6.2832);
  ctx.fillStyle = C.headHalo; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, 6 * k, 0, 6.2832);
  ctx.fillStyle = C.head; ctx.fill();
  ctx.lineWidth = 2.5 * k; ctx.strokeStyle = C.headRing; ctx.stroke();
}

/* ============================ HUD (캔버스에 직접 그림 → 녹화본에 포함) ============================ */
function scrim(ctx, W, H, from, dark) {
  const top = from === 'top';
  const h = H * (top ? 0.26 : 0.15);
  const a = top ? 0.80 : 0.55;
  const g = top ? ctx.createLinearGradient(0, 0, 0, h) : ctx.createLinearGradient(0, H, 0, H - h);
  const c = dark ? '0,0,0' : '255,255,255';
  g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, top ? 0 : H - h, W, h);
}

function drawHUD(ctx, W, H, info, C, opt) {
  const u = opt.hud;                       // 기준 글자 크기
  const pad = u * 1.1;
  const F = (w, s) => `${w} ${s}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';

  scrim(ctx, W, H, 'top', C.darkScrim);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.hudDim; ctx.font = F(600, u * 0.62);
  ctx.fillText(info.label, pad, pad + u * 0.62);
  ctx.fillStyle = C.hudInk; ctx.font = F(700, u * 1.5);
  ctx.fillText(info.date, pad, pad + u * 2.35);

  ctx.font = F(700, u * 1.15);
  ctx.fillStyle = C.route;
  const km = info.km;
  ctx.fillText(km, pad, pad + u * 3.85);
  const kmW = ctx.measureText(km).width;
  ctx.font = F(600, u * 0.62); ctx.fillStyle = C.hudDim;
  ctx.fillText('  누적 이동', pad + kmW, pad + u * 3.85);

  scrim(ctx, W, H, 'bottom', C.darkScrim);
  const bh = Math.max(3, u * 0.085);
  ctx.fillStyle = C.hudDim; ctx.font = F(600, u * 0.62);
  ctx.fillText(info.foot, pad, H - bh - u * 0.7);

  ctx.textAlign = 'right';
  ctx.font = F(500, u * 0.44); ctx.fillStyle = C.hudFaint;
  ctx.fillText(info.attr, W - pad, H - bh - u * 0.7);
  ctx.textAlign = 'left';

  // 영상 진행 막대 — 화면 맨 아래 가장자리
  ctx.fillStyle = C.barBg; ctx.fillRect(0, H - bh, W, bh);
  ctx.fillStyle = C.route; ctx.fillRect(0, H - bh, W * info.p, bh);
}

/* ============================ 도시 이름표 ============================ */
function drawLabels(ctx, data, view, W, H, tNow, C, opt, max) {
  const { X, Y } = projector(view, W, H);
  const u = opt.hud;
  // 같은 도시 이름이 여러 군집에 붙으면 사진이 가장 많은 것 하나만 남긴다
  const byName = new Map();
  for (const c of data.cities) {
    if (!c.label || c.t0 > tNow) continue;
    const prev = byName.get(c.label);
    if (!prev || prev.n < c.n) byName.set(c.label, c);
  }
  const cand = [...byName.values()].sort((a, b) => b.n - a.n).slice(0, max || 12);
  const boxes = [];
  const nameSize = u * 0.46, subSize = u * 0.34;
  ctx.lineJoin = 'round'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const c of cand) {
    const x = X(c.x), y = Y(c.y);
    if (x < -80 || x > W + 80 || y < -40 || y > H + 40) continue;
    ctx.font = `700 ${nameSize}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    const nw = ctx.measureText(c.label).width;
    ctx.font = `600 ${subSize}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    const shown = countUpTo(c, tNow) || c.n;
    const sub = shown + '장';
    const sw = ctx.measureText(sub).width;
    const tw = nw + sw + u * 0.22;
    // 오른쪽 끝에 걸리면 점 왼쪽에 붙인다
    const flip = x + u * 0.3 + tw > W - u * 0.5;
    const bx = flip ? x - u * 0.3 - tw : x + u * 0.3, by = y - u * 0.5;
    if (bx < u * 0.3) continue;
    const box = [bx - 3, by - nameSize * 0.8, bx + tw + 3, by + nameSize * 0.8];
    if (boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
    boxes.push(box);

    ctx.lineWidth = Math.max(2.5, u * 0.13);
    ctx.strokeStyle = C.labelHalo;
    ctx.font = `700 ${nameSize}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    ctx.strokeText(c.label, bx, by);
    ctx.fillStyle = C.hudInk; ctx.fillText(c.label, bx, by);
    ctx.font = `600 ${subSize}px -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
    ctx.strokeText(sub, bx + nw + u * 0.22, by + nameSize * 0.06);
    ctx.fillStyle = C.route; ctx.fillText(sub, bx + nw + u * 0.22, by + nameSize * 0.06);
  }
  ctx.textBaseline = 'alphabetic';
}
