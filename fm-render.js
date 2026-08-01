'use strict';
const { Resvg } = require('@resvg/resvg-js');
const path = require('path');
const fs = require('fs');

// Self-contained font lookup so the renderer has no dependency on the game module
// (keeps the require graph one-way: football.js -> fm-render.js).
const FONT_FILES = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']
  .map(n => [path.join(__dirname, 'fonts', n), path.join(__dirname, n)]
    .find(p => { try { return fs.existsSync(p); } catch { return false; } }))
  .filter(Boolean);

const W = 1000, H = 660;
const HUD = 78;                                   // top scoreboard height
const PX = 20, PY = HUD + 8;
const PW = W - PX * 2, PH = H - PY - 44;          // leave room for the ticker
const sx = (x) => PX + (x / 100) * PW;
const sy = (y) => PY + (y / 100) * PH;
const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ── pitch ─────────────────────────────────────────────────────────────── */
function pitch() {
  let s = `<rect width="${W}" height="${H}" fill="#0b1220"/>`;
  // turf + mown stripes
  const N = 14, sw = PW / N;
  for (let i = 0; i < N; i++)
    s += `<rect x="${PX + i*sw}" y="${PY}" width="${sw+0.5}" height="${PH}" fill="${i%2 ? '#3f9c46' : '#38903f'}"/>`;
  // subtle vignette so the middle pops
  s += `<rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" fill="url(#vig)"/>`;

  const L = '#f1f5f9', lw = 2.6, o = 0.92;
  const cx = PX + PW/2, cy = PY + PH/2;
  const boxW = PW*0.148, boxH = PH*0.56, gW = PW*0.052, gH = PH*0.26;
  const line = (x1,y1,x2,y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${L}" stroke-width="${lw}" opacity="${o}"/>`;
  const rect = (x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${L}" stroke-width="${lw}" opacity="${o}"/>`;
  s += rect(PX, PY, PW, PH) + line(cx, PY, cx, PY+PH);
  s += `<circle cx="${cx}" cy="${cy}" r="${PH*0.132}" fill="none" stroke="${L}" stroke-width="${lw}" opacity="${o}"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="3.4" fill="${L}" opacity="${o}"/>`;
  s += rect(PX, cy-boxH/2, boxW, boxH) + rect(PX+PW-boxW, cy-boxH/2, boxW, boxH);
  s += rect(PX, cy-gH/2, gW, gH)       + rect(PX+PW-gW, cy-gH/2, gW, gH);
  s += `<circle cx="${PX+boxW*0.70}" cy="${cy}" r="3.2" fill="${L}" opacity="${o}"/>`;
  s += `<circle cx="${PX+PW-boxW*0.70}" cy="${cy}" r="3.2" fill="${L}" opacity="${o}"/>`;
  // penalty arcs
  s += `<path d="M ${PX+boxW} ${cy-PH*0.075} A ${PH*0.132} ${PH*0.132} 0 0 1 ${PX+boxW} ${cy+PH*0.075}" fill="none" stroke="${L}" stroke-width="${lw}" opacity="${o}"/>`;
  s += `<path d="M ${PX+PW-boxW} ${cy-PH*0.075} A ${PH*0.132} ${PH*0.132} 0 0 0 ${PX+PW-boxW} ${cy+PH*0.075}" fill="none" stroke="${L}" stroke-width="${lw}" opacity="${o}"/>`;
  // corner arcs
  const ca = 13;
  s += `<path d="M ${PX} ${PY+ca} A ${ca} ${ca} 0 0 0 ${PX+ca} ${PY}" fill="none" stroke="${L}" stroke-width="2" opacity="${o}"/>`;
  s += `<path d="M ${PX+PW-ca} ${PY} A ${ca} ${ca} 0 0 0 ${PX+PW} ${PY+ca}" fill="none" stroke="${L}" stroke-width="2" opacity="${o}"/>`;
  s += `<path d="M ${PX} ${PY+PH-ca} A ${ca} ${ca} 0 0 1 ${PX+ca} ${PY+PH}" fill="none" stroke="${L}" stroke-width="2" opacity="${o}"/>`;
  s += `<path d="M ${PX+PW-ca} ${PY+PH} A ${ca} ${ca} 0 0 1 ${PX+PW} ${PY+PH-ca}" fill="none" stroke="${L}" stroke-width="2" opacity="${o}"/>`;
  // goals (behind the line)
  const gd = 13;
  s += `<rect x="${PX-gd}" y="${cy-gH*0.42}" width="${gd}" height="${gH*0.84}" fill="#e2e8f0" opacity="0.5" rx="2"/>`;
  s += `<rect x="${PX+PW}" y="${cy-gH*0.42}" width="${gd}" height="${gH*0.84}" fill="#e2e8f0" opacity="0.5" rx="2"/>`;
  return s;
}

/* ── shirt ─────────────────────────────────────────────────────────────── */
function shirt(x, y, num, colors, opts = {}) {
  const s = opts.scale || 1.5;
  const [fill, trim, txt] = colors;
  const w = 30*s, left = x - w/2, top = y - w/2;
  const p = (a,b) => `${(left+a*s).toFixed(1)},${(top+b*s).toFixed(1)}`;
  const body = `M ${p(8,3)} L ${p(11,1)} Q ${p(15,4)} ${p(19,1)} L ${p(22,3)} L ${p(29,8)} L ${p(25,13)}
    L ${p(23,11)} L ${p(23,28)} L ${p(7,28)} L ${p(7,11)} L ${p(5,13)} L ${p(1,8)} Z`;
  const ring = opts.onBall
    ? `<circle cx="${x}" cy="${y}" r="${19*s*0.72}" fill="none" stroke="#fde047" stroke-width="${2.6*s*0.6}" opacity="0.95"/>`
    : '';
  const shadow = `<ellipse cx="${x}" cy="${y + 15*s}" rx="${10*s}" ry="${3.2*s}" fill="#000" opacity="0.22"/>`;
  return `<g>${shadow}${ring}
    <path d="${body}" fill="${fill}" stroke="${trim}" stroke-width="${1.9*s}" stroke-linejoin="round"/>
    <text x="${x}" y="${y + 7*s}" text-anchor="middle" font-family="DejaVu Sans" font-size="${12.5*s}"
      font-weight="700" fill="${txt}">${num}</text></g>`;
}

/* ── ball with motion trail ────────────────────────────────────────────── */
function ball(x, y, trail = []) {
  let s = '';
  trail.slice(-5).forEach((t, i, arr) => {
    const k = (i + 1) / (arr.length + 1);
    s += `<circle cx="${sx(t.x)}" cy="${sy(t.y)}" r="${3 + k*4}" fill="#ffffff" opacity="${0.10 + k*0.22}"/>`;
  });
  const r = 9.5;
  s += `<ellipse cx="${x}" cy="${y + r*0.95}" rx="${r*0.85}" ry="${r*0.3}" fill="#000" opacity="0.3"/>`;
  s += `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" stroke="#0f172a" stroke-width="1.3"/>`;
  s += `<path d="M ${x} ${y-r*0.58} L ${x+r*0.55} ${y-r*0.12} L ${x+r*0.34} ${y+r*0.52}
    L ${x-r*0.34} ${y+r*0.52} L ${x-r*0.55} ${y-r*0.12} Z" fill="#0f172a"/>`;
  return s;
}

/* ── scoreboard ────────────────────────────────────────────────────────── */
function hud(st) {
  const { home, away, hg, ag, minute, poss } = st;
  const cx = W/2;
  let s = `<rect x="0" y="0" width="${W}" height="${HUD}" fill="#0b1220"/>`;
  // colour flashes for each side
  s += `<rect x="0" y="0" width="8" height="${HUD}" fill="${home.c[0]}"/>`;
  s += `<rect x="${W-8}" y="0" width="8" height="${HUD}" fill="${away.c[0]}"/>`;
  // names + score
  s += `<text x="${cx-118}" y="40" text-anchor="end" font-family="DejaVu Sans" font-size="23" font-weight="700" fill="#f8fafc">${esc(home.short)}</text>`;
  s += `<text x="${cx+118}" y="40" text-anchor="start" font-family="DejaVu Sans" font-size="23" font-weight="700" fill="#f8fafc">${esc(away.short)}</text>`;
  s += `<rect x="${cx-96}" y="12" width="192" height="44" rx="10" fill="#111c33" stroke="#1e293b" stroke-width="1.5"/>`;
  s += `<text x="${cx}" y="45" text-anchor="middle" font-family="DejaVu Sans" font-size="31" font-weight="700" fill="#fbbf24">${hg} – ${ag}</text>`;
  // clock pill
  s += `<rect x="18" y="16" width="74" height="34" rx="17" fill="#111c33" stroke="#1e293b" stroke-width="1.5"/>`;
  s += `<text x="55" y="39" text-anchor="middle" font-family="DejaVu Sans" font-size="17" font-weight="700" fill="#34d399">${minute}'</text>`;
  // possession bar
  const bw = 300, bx = cx - bw/2, by = HUD - 15, hp = clamp(poss, 5, 95);
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="7" rx="3.5" fill="${away.c[0]}"/>`;
  s += `<rect x="${bx}" y="${by}" width="${bw*hp/100}" height="7" rx="3.5" fill="${home.c[0]}"/>`;
  s += `<text x="${bx-10}" y="${by+7}" text-anchor="end" font-family="DejaVu Sans" font-size="12" fill="#94a3b8">${Math.round(hp)}%</text>`;
  s += `<text x="${bx+bw+10}" y="${by+7}" text-anchor="start" font-family="DejaVu Sans" font-size="12" fill="#94a3b8">${100-Math.round(hp)}%</text>`;
  // full club names, small
  s += `<text x="${cx-150}" y="66" text-anchor="end" font-family="DejaVu Sans" font-size="12" fill="#64748b">${esc(home.name)}</text>`;
  s += `<text x="${cx+150}" y="66" text-anchor="start" font-family="DejaVu Sans" font-size="12" fill="#64748b">${esc(away.name)}</text>`;
  return s;
}

/* ── bottom ticker ─────────────────────────────────────────────────────── */
function ticker(text) {
  const y = PY + PH + 8;
  return `<rect x="${PX}" y="${y}" width="${PW}" height="30" rx="8" fill="#0b1220" opacity="0.95"/>
    <text x="${PX+14}" y="${y+20}" font-family="DejaVu Sans" font-size="15" fill="#e2e8f0">${esc(text)}</text>`;
}

/* ── big event banner ──────────────────────────────────────────────────── */
function banner(ev) {
  if (!ev) return '';
  const map = {
    GOAL:  { t:'G O A L !', c:'#fbbf24', sub:null },
    SAVE:  { t:'SAVED!',    c:'#38bdf8', sub:null },
    MISS:  { t:'OFF TARGET',c:'#94a3b8', sub:null },
    POST:  { t:'OFF THE POST!', c:'#f472b6', sub:null },
    CHANCE:{ t:'BIG CHANCE', c:'#34d399', sub:null },
    HT:    { t:'HALF TIME',  c:'#e2e8f0', sub:null },
    FT:    { t:'FULL TIME',  c:'#e2e8f0', sub:null },
    KICK:  { t:'KICK OFF',   c:'#e2e8f0', sub:null },
  };
  const m = map[ev.type]; if (!m) return '';
  const cy = PY + PH/2;
  return `<rect x="${PX}" y="${cy-52}" width="${PW}" height="104" fill="#000" opacity="0.42"/>
    <text x="${W/2}" y="${cy+4}" text-anchor="middle" font-family="DejaVu Sans" font-size="54" font-weight="700"
      fill="${m.c}" stroke="#0b1220" stroke-width="2.5">${esc(m.t)}</text>
    ${ev.sub ? `<text x="${W/2}" y="${cy+38}" text-anchor="middle" font-family="DejaVu Sans" font-size="19" fill="#e2e8f0">${esc(ev.sub)}</text>` : ''}`;
}

/* ── main frame ────────────────────────────────────────────────────────── */
function frame(st) {
  const defs = `<defs>
    <radialGradient id="vig" cx="50%" cy="50%" r="72%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.28"/>
    </radialGradient></defs>`;
  let players = '';
  st.homePos.forEach((p, i) => players += shirt(sx(p.x), sy(p.y), p.num, st.home.c, { onBall: st.ballOwner === `H${i}` }));
  st.awayPos.forEach((p, i) => players += shirt(sx(p.x), sy(p.y), p.num, st.away.c, { onBall: st.ballOwner === `A${i}` }));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs}${pitch()}${players}${ball(sx(st.ball.x), sy(st.ball.y), st.trail)}
    ${hud(st)}${ticker(st.commentary || '')}${banner(st.event)}</svg>`;

  return new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
    fitTo: { mode: 'width', value: W },
  }).render().asPng();
}

module.exports = { frame, W, H };
