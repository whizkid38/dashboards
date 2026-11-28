/* ═══════════════════════════════════════════════════════════════════════════════════════
   wk-props.js — the one props dashboard (Whizkid Automations) · v1.0
   Projections (every player, the primary line + both prices + fair + EV in the row, click for the
   full projection, every quote and the line ladder) and Results (units up or down, CLV, R/E, by
   period / bucket / line / book, every graded play). Which sport this is comes from /api/wk/config;
   the page itself never changes between WhizShap, Hawkey Shots and Hawkey Saves.
   ═══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

// Path-prefix aware: '' on :5151, '/nfl' behind nginx, '/nhl/saves' for a board mounted under another.
const API = location.pathname.replace(/\/[^\/]*$/, '');
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lbl = s => esc(s).replace(/[λφσΣ]/g, m => `<span class="nocase">${m}</span>`);   // greek letters survive text-transform:uppercase

let CFG = null, DATA = null, RES = null;
let allProjs = [], allBoard = [], filtered = [];
let sortKey = 'proj', sortAsc = false, groupF = 'ALL', teamF = '', searchQ = '', evOnly = false, pricedOnly = false;
const toggles = {};                       // id -> bool (config.filters.toggles)
let ladderExpanded = new Set(), cur = null, viewingPeriod = '';
let serverOk = true, jobBusy = false;

// ── formatting ───────────────────────────────────────────────────────────────
const isNum = v => v !== null && v !== undefined && v !== '' && !isNaN(v);
const F = {
  n: (v, d = 2) => isNum(v) ? (+v).toFixed(d) : '—',
  pct: (v, d = 1) => isNum(v) ? ((+v) * 100).toFixed(d) + '%' : '—',
  sgn: (v, d = 2) => isNum(v) ? ((+v) > 0 ? '+' : '') + (+v).toFixed(d) : '—',
  units: (v, d = 2) => isNum(v) ? ((+v) > 0 ? '+' : '') + (+v).toFixed(d) + 'u' : '—',
  odds: o => isNum(o) ? ((+o) > 0 ? '+' : '') + Math.round(+o) : '—',
  int: v => isNum(v) ? String(Math.round(+v)) : '—',
  when: iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}); },
  day: d => { if (!d) return '—'; const t = new Date(String(d).slice(0, 10) + 'T12:00:00'); return isNaN(t) ? String(d) : t.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}); },
  ago: iso => { if (!iso) return ''; const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ' + (m % 60) + 'm ago'; return Math.floor(h / 24) + 'd ago'; },
};
function fmt(v, f, row) {
  if (!f || f === 'txt') return esc(v ?? '—');
  if (f === 'upper') return esc(String(v ?? '—').toUpperCase());
  if (f === 'flag') return v === true || String(v).toLowerCase() === 'true' || v === 1 ? 'YES' : (v == null || v === '' ? '—' : 'NO');
  if (f === 'warn') return v ? `<span style="color:var(--yellow)">${esc(v)}</span>` : '—';
  if (f === 'homeaway') return v === true ? 'HOME' : v === false ? 'AWAY' : '—';
  if (f === 'spread') { if (!isNum(v)) return '—'; const x = +v; return x === 0 ? 'PICK' : `<span style="color:${x < 0 ? 'var(--green)' : 'var(--red)'}">${x > 0 ? '+' : ''}${x.toFixed(1)}</span>`; }
  if (f === 'status') return v && v.label ? statusChip(v) : '—';
  if (f === 'day') return esc(F.day(v));
  if (f === 'odds') return F.odds(v);
  if (f === 'units') return F.units(v);
  if (f === 'pts100') return isNum(v) ? F.sgn((+v) * 100, 1) + ' pts' : '—';
  let m;
  if ((m = f.match(/^n(\d)$/))) return F.n(v, +m[1]);
  if ((m = f.match(/^pct(\d)$/))) return F.pct(v, +m[1]);
  if ((m = f.match(/^sgn(\d)$/))) return F.sgn(v, +m[1]);
  if ((m = f.match(/^sgnpct(\d)$/))) return isNum(v) ? F.sgn(v, +m[1]) + '%' : '—';
  if ((m = f.match(/^pm(\d)$/))) return isNum(v) ? '±' + (+v).toFixed(+m[1]) : '—';
  if ((m = f.match(/^min(\d)$/))) return isNum(v) ? (+v).toFixed(+m[1]) + '<span class="dimtxt"> min</span>' : '—';
  return esc(v ?? '—');
}
const cls = (v, good = x => x > 0, bad = x => x < 0) => !isNum(v) ? 'pdim' : good(+v) ? 'ppos' : bad(+v) ? 'pneg' : '';
function val(p, key) {                      // generic getter: 'proj' | 'x.toi' | 'line:2.5' | '_bookLine'
  if (!key) return null;
  if (key.startsWith('line:')) return p.lines ? p.lines[key.slice(5)] : null;
  if (key.startsWith('x.')) return p.x ? p.x[key.slice(2)] : null;
  return p[key];
}
function num(p, key, d = 0) { const v = val(p, key); return isNum(v) ? +v : d; }

// ── odds math (client side, for the ladder's model-only rows) ───────────────
const amFromP = p => (p == null || p <= 0 || p >= 1) ? null : (p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
const amToDec = a => a > 0 ? (a / 100 + 1) : (100 / Math.abs(a) + 1);
const evOf = (p, odds) => ((p * (amToDec(odds) - 1)) - (1 - p)) * 100;

// ── chips / cells ───────────────────────────────────────────────────────────
function statusChip(s) { return s && s.label ? `<span class="st st-${esc(s.kind || 'n')}" title="${esc(s.raw || '')}">${esc(s.label)}</span>` : ''; }
function posChip(p) { return p.pos ? `<span class="pos-chip pc-${esc(p.pos_group || '')}">${esc(p.pos)}</span>` : ''; }
function ovBadge(p) { return p.overridden ? `<span class="ov-badge" title="${esc('model λ ' + F.n(p.lambda_model) + (p.override && p.override.note ? ' · ' + p.override.note : ''))}">✎</span>` : ''; }
function extraChips(p) { return (p.chips || []).map(c => `<span class="tag tag-${esc(c.kind || 'brass')}">${esc(c.label)}</span>`).join(''); }
function fmtOdds(o) { return isNum(o) ? `<span class="mono-s">${F.odds(o)}</span>` : `<span class="mono-s dimtxt">—</span>`; }
function priceCell(odds, book, n) {
  if (!isNum(odds)) return `<span class="mono-s dimtxt">—</span>`;
  return `<div>${fmtOdds(odds)}${book ? `<div class="pmeta">${esc(book)}${n > 1 ? ` <span class="dimtxt">(${n})</span>` : ''}</div>` : ''}</div>`;
}
function evChip(ev, q, row) {
  if (!isNum(ev)) return `<span class="mono-s dimtxt">—</span>`;
  const s = ev > 0 ? '+' : '';
  if (row && row.stale && !row.started) return `<span class="mono-s dimtxt" style="font-weight:600" title="line pulled ${row.age_min != null ? Math.round(row.age_min) : '?'} min ago — ${CFG.features.pull_label || 'PULL ODDS'} to price it fresh">${s}${(+ev).toFixed(1)}% ⏱</span>`;
  if (row && row.blocked && !row.started) return `<span class="evc evc-p" title="${esc(row.blocked_note || 'blocked by a pipeline rule')}">${s}${(+ev).toFixed(1)}% ⚑</span>`;
  return `<span class="evc ${q ? 'evc-q' : ev >= 0 ? 'evc-p' : 'evc-n'}">${s}${(+ev).toFixed(1)}%</span>`;
}
function vcls(v) { const hi = CFG && CFG.product.sport === 'nfl' ? [5, 2.5] : CFG && CFG.product.stat === 'saves' ? [28, 22] : [3, 2]; return v >= hi[0] ? 'hi' : v >= hi[1] ? 'md' : 'lo'; }
function lineLabel(l) { const st = (CFG.prob_cards || {}).style; return st === 'plus' ? `${(+l + 0.5).toFixed(0)}+` : `O ${(+l).toFixed(1)}`; }

// ── theme / status / clock ──────────────────────────────────────────────────
$('theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  const c = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const nx = c === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', nx); try { localStorage.setItem('wk-theme', nx); } catch (e) {}
});
function setStatus() {
  const el = $('status-pill');
  if (jobBusy) { el.className = 'pill busy'; el.textContent = 'RUNNING…'; return; }
  if (!serverOk) { el.className = 'pill off'; el.textContent = 'OFFLINE'; el.title = `can't reach server.py on :${CFG ? CFG.port : '?'}`; return; }
  const at = DATA && DATA.meta && (DATA.meta.board_generated_at || DATA.meta.generated_at);
  const ageH = at ? (Date.now() - new Date(at).getTime()) / 3600000 : null;
  const staleAfter = CFG && CFG.product.period === 'week' ? 24 * 8 : 24;
  if (ageH != null && ageH > staleAfter) { el.className = 'pill stale'; el.textContent = 'STALE ' + F.ago(at); }
  else { el.className = 'pill live'; el.textContent = 'LIVE'; }
  el.title = at ? `board written ${new Date(at).toLocaleString()}` : '';
}
function tick() { $('clock').textContent = new Date().toLocaleTimeString('en-US', {hour12: false}) + ' LOCAL'; }
tick(); setInterval(tick, 1000);

const tip = $('tip');
function showTip(e, html) { tip.innerHTML = html; tip.style.display = 'block'; moveTip(e); }
function moveTip(e) { const p = 12; let x = e.clientX + p, y = e.clientY + p; const r = tip.getBoundingClientRect();
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - p; if (y + r.height > innerHeight - 8) y = e.clientY - r.height - p; tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
function hideTip() { tip.style.display = 'none'; }
document.addEventListener('mousemove', e => { if (tip.style.display === 'block') moveTip(e); });

// ── tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('nav .tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('nav .tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  t.classList.add('active'); $(`page-${t.dataset.page}`).classList.add('active');
  if (t.dataset.page === 'results' && !RES) loadResults();
}));

// ── config ───────────────────────────────────────────────────────────────────
async function loadConfig() {
  const r = await fetch(`${API}/api/wk/config`); CFG = await r.json();
  const P = CFG.product;
  document.title = `${P.name_a}${P.name_b} · Whizkid Automations`;
  $('logo').innerHTML = `${esc(P.name_a)}<b>${esc(P.name_b)}</b>`;
  $('hd').textContent = `${P.subtitle} · Whizkid Automations`;
  $('brand').title = P.name_a + P.name_b;
  if (CFG.switch && CFG.switch.length) { $('switch').style.display = ''; $('switch').innerHTML = CFG.switch.map(s => `<a href="${esc(s.href)}" class="${s.active ? 'on' : ''}">${esc(s.label)}</a>`).join(''); }
  $('foot-l').innerHTML = `<b>${esc(P.name_a + P.name_b)}</b> · Whizkid Automations · ${esc(P.pipeline || '')}`;
  $('period-label').textContent = CFG.product.period === 'week' ? 'FILE' : 'DATE';
  const g = (CFG.filters || {}).groups;
  if (g) { $('group-label').textContent = g.label; $('group-chips').innerHTML = `<div class="chip active" data-g="ALL">ALL</div>` + g.options.map(o => `<div class="chip" data-g="${esc(o)}">${esc(o)}</div>`).join(''); }
  else { $('group-label').style.display = 'none'; $('group-chips').style.display = 'none'; $('group-sep').style.display = 'none'; }
  $('sort-chips').innerHTML = (CFG.sort_chips || []).map((c, i) => `<div class="chip ${i === 0 ? 'active' : ''}" data-sort="${esc(c.key)}">${esc(c.label)}</div>`).join('');
  sortKey = (CFG.sort_chips || [{key: 'proj'}])[0].key;
  $('toggle-chips').innerHTML = ((CFG.filters || {}).toggles || []).map(t => `<div class="chip" data-t="${esc(t.id)}" data-k="${esc(t.key)}">${esc(t.label)}</div>`).join('');
  $('pull-btn').textContent = CFG.features.pull_label || 'PULL ODDS';
  $('pull-btn').title = CFG.features.pull_note || '';
  if (CFG.features.pull === false) $('pull-btn').style.display = 'none';
  if (CFG.features.discord === false) $('discord-btn').style.display = 'none';
  if (!CFG.features.periods) { $('period-select').style.display = 'none'; $('period-label').style.display = 'none'; }
  bindControls();
}

// ── periods + projections ────────────────────────────────────────────────────
async function loadPeriods() {
  try {
    const d = await (await fetch(`${API}/api/wk/periods`)).json();
    const sel = $('period-select'); const keep = sel.value;
    sel.innerHTML = (d.periods || [{value: '', label: 'latest'}]).map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
    sel.value = keep;
  } catch (e) {}
}
async function loadProjections(period = '') {
  try {
    const r = await fetch(`${API}/api/wk/projections${period ? '?period=' + encodeURIComponent(period) : ''}`);
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
    serverOk = true; viewingPeriod = period; DATA = d; ingest(d);
  } catch (e) {
    serverOk = false; setStatus();
    $('tbl-wrap').innerHTML = `<div class="empty err">ERROR LOADING PROJECTIONS<br><br><span style="font-size:12px">${esc(e.message)} — is server.py running on :${CFG ? CFG.port : '?'}?</span></div>`;
  }
}
function ingest(d, keepId = null) {
  allProjs = d.projections || []; allBoard = d.board || [];
  attachBoard();
  const m = d.meta || {};
  $('meta-pill').textContent = m.pill || `${allProjs.length} PLAYERS`; $('meta-pill').className = 'pill loaded';
  if (m.tag) { $('tag-pill').style.display = ''; $('tag-pill').textContent = m.tag; }
  const nOv = allProjs.filter(p => p.overridden).length;
  $('ov-pill').style.display = nOv ? '' : 'none'; $('ov-pill').textContent = `✎ ${nOv} OVERRIDE${nOv === 1 ? '' : 'S'}`;
  const sel = $('team-sel'); const keepTeam = teamF;
  sel.innerHTML = '<option value="">ALL</option>' + [...new Set(allProjs.map(p => p.team).filter(Boolean))].sort().map(t => `<option>${esc(t)}</option>`).join('');
  sel.value = keepTeam;
  $('discord-btn').disabled = false;
  const lp = m.lines_pulled;
  $('foot-m').innerHTML = lp && lp.at ? `Lines last pulled <b>${esc(new Date(lp.at).toLocaleString('en-US', {weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit'}))}</b>${lp.tag ? ' · ' + esc(lp.tag) : ''}${lp.games ? ` · ${lp.games} game${lp.games > 1 ? 's' : ''}` : ''} · ${F.ago(lp.at)}`
    : (m.board_generated_at ? `Board written <b>${esc(F.when(m.board_generated_at))}</b> · ${F.ago(m.board_generated_at)}` : '');
  setStatus();
  if (!allProjs.length) { $('tbl-wrap').innerHTML = `<div class="empty">NO PROJECTIONS FOUND<br><br><span style="font-size:12px">run the pipeline, then click ↻ REFRESH</span></div>`; return; }
  applyFilters(); renderTable();
  if (keepId != null) { const p = allProjs.find(x => String(x.id) === String(keepId)); if (p) showDetail(p); }
  else if (cur) { const p = allProjs.find(x => String(x.id) === String(cur.id)); if (p) showDetail(p, true); }
}
// attach the board to each player: primary line = the line the most books quote, ties → nearest the projection
function attachBoard() {
  const byId = {}, byName = {};
  allBoard.forEach(b => { if (b.player_id) (byId[b.player_id] = byId[b.player_id] || []).push(b); const n = (b.player || '').toLowerCase().trim(); (byName[n] = byName[n] || []).push(b); });
  allProjs.forEach(p => {
    const rows = byId[p.id] || byName[(p.name || '').toLowerCase().trim()] || [];
    const byLine = {};
    rows.forEach(r => { byLine[r.line] = byLine[r.line] || {line: r.line, n: 0}; byLine[r.line][r.side] = r; byLine[r.line].n = Math.max(byLine[r.line].n, r.n_books || (r.quotes || []).length || 1); });
    const board = Object.values(byLine).sort((a, b) => a.line - b.line);
    p._board = board; p._rows = rows;
    const primary = board.length ? board.slice().sort((a, b) => (b.n - a.n) || (Math.abs(a.line - p.proj) - Math.abs(b.line - p.proj)))[0] : null;
    p._primary = primary;
    p._bookLine = primary ? primary.line : null; p._extraLines = Math.max(board.length - 1, 0);
    const o = primary && primary.over, u = primary && primary.under;
    p._rowOver = o || null; p._rowUnder = u || null;
    p._priceOver = o ? o.odds : null; p._priceUnder = u ? u.odds : null;
    p._fairOver = o ? amFromP(o.fair_prob) : null; p._fairUnder = u ? amFromP(u.fair_prob) : null;
    p._evOver = o ? o.ev_pct : null; p._evUnder = u ? u.ev_pct : null;
    p._qualOver = !!(o && o.qualifies); p._qualUnder = !!(u && u.qualifies);
    const evs = rows.map(r => r.ev_pct).filter(isNum);
    p.best_ev = evs.length ? Math.max(...evs) : null;
    p._hasEv = rows.some(r => r.qualifies);
    p._priced = rows.length > 0;
  });
}

// ── filters / sort / table ───────────────────────────────────────────────────
function applyFilters() {
  const g = (CFG.filters || {}).groups;
  filtered = allProjs.filter(p => {
    if (g && groupF !== 'ALL' && p[g.key] !== groupF) return false;
    if (teamF && p.team !== teamF) return false;
    if (searchQ && !(p.name || '').toLowerCase().includes(searchQ.toLowerCase())) return false;
    if (evOnly && !p._hasEv) return false;
    if (pricedOnly && !p._priced) return false;
    for (const t of ((CFG.filters || {}).toggles || [])) if (toggles[t.id] && !val(p, t.key)) return false;
    return true;
  });
  filtered.sort((a, b) => { const av = val(a, sortKey), bv = val(b, sortKey); const an = isNum(av) ? +av : -Infinity, bn = isNum(bv) ? +bv : -Infinity; return sortAsc ? an - bn : bn - an; });
  $('n-res').textContent = filtered.length;
}
function renderTable() {
  const wrap = $('tbl-wrap');
  if (!filtered.length) { wrap.innerHTML = '<div class="empty">NO PLAYERS MATCH FILTERS</div>'; return; }
  const extra = CFG.columns || [];
  const head = [['name', 'PLAYER'], ['matchup', 'MATCHUP'], ['proj', 'PROJ'], ['p10', 'P10'], ['p90', 'P90'], ['_bookLine', 'BOOK LINE'],
    ['_priceOver', 'PRICE O'], ['_priceUnder', 'PRICE U'], ['_fairOver', 'FAIR O'], ['_fairUnder', 'FAIR U'], ['_evOver', 'EV OVER'], ['_evUnder', 'EV UNDER'],
    ...extra.map(c => [c.key, c.label])];
  wrap.innerHTML = `<table><thead><tr>${head.map(([k, l]) => `<th data-col="${esc(k)}" class="${sortKey === k ? 'sorted' : ''}">${esc(l)}${sortKey === k ? (sortAsc ? ' ▴' : ' ▾') : ''}</th>`).join('')}</tr></thead>
    <tbody id="tbody">${filtered.map((p, i) => {
      const projCell = p.overridden ? `<span class="num" style="color:var(--violet)">${F.n(p.proj)}</span><div class="pmeta">model ${F.n(p.lambda_model)}</div>` : `<span class="num ${vcls(p.proj)}">${F.n(p.proj)}</span>`;
      const bl = p._bookLine == null ? `<span class="mono-s dimtxt">NO LINE</span>` : `<span class="num">${(+p._bookLine).toFixed(1)}</span>${p._extraLines ? ` <span class="mono-s dimtxt">(+${p._extraLines})</span>` : ''}`;
      return `<tr data-idx="${i}" class="${p._hasEv ? 'has-ev' : ''} ${cur && String(cur.id) === String(p.id) ? 'sel' : ''}">
        <td><div class="pname">${esc(p.name)}${posChip(p)}${ovBadge(p)}${extraChips(p)}</div>
          <div class="pmeta">${esc(p.team || '')}${p.gp ? ` · ${p.gp}G` : ''} ${p.status && p.status.label && p.status.kind !== 'n' ? statusChip(p.status) : ''}</div></td>
        <td><span class="mono-s dimtxt">${esc(p.matchup || '—')}</span>${CFG.product.sport === 'nfl' ? ' &nbsp;' + fmt(p.x && p.x.spread, 'spread') : ''}</td>
        <td>${projCell}</td>
        <td><span class="mono-s">${F.n(p.p10, 1)}</span></td>
        <td><span class="mono-s">${F.n(p.p90, 1)}</span></td>
        <td>${bl}</td>
        <td>${priceCell(p._priceOver, p._rowOver && p._rowOver.book, p._rowOver && p._rowOver.n_books)}</td>
        <td>${priceCell(p._priceUnder, p._rowUnder && p._rowUnder.book, p._rowUnder && p._rowUnder.n_books)}</td>
        <td>${fmtOdds(p._fairOver)}</td><td>${fmtOdds(p._fairUnder)}</td>
        <td>${evChip(p._evOver, p._qualOver, p._rowOver)}</td><td>${evChip(p._evUnder, p._qualUnder, p._rowUnder)}</td>
        ${extra.map(c => `<td><span class="mono-s">${fmt(val(p, c.key), c.fmt, p)}</span></td>`).join('')}
      </tr>`; }).join('')}</tbody></table>`;
  wrap.querySelectorAll('#tbody tr').forEach(row => row.addEventListener('click', () => { showDetail(filtered[+row.dataset.idx]); }));
  wrap.querySelectorAll('thead th[data-col]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.col; if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = false; }
    document.querySelectorAll('#sort-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.sort === sortKey));
    applyFilters(); renderTable();
  }));
}

// ── detail panel ─────────────────────────────────────────────────────────────
function toggleLadder(id) { if (ladderExpanded.has(id)) ladderExpanded.delete(id); else ladderExpanded.add(id); if (cur) showDetail(cur, true); }
function ladderHTML(p) {
  const L = CFG.ladder || {lines: [], window: 3};
  const lines = new Set((L.lines || []).map(Number)); (p._board || []).forEach(b => lines.add(+b.line)); Object.keys(p.lines || {}).forEach(k => lines.add(+k));
  const all = [...lines].sort((a, b) => a - b);
  if (!all.length) return '';
  const center = p._bookLine != null ? p._bookLine : (Math.round(p.proj * 2) / 2);
  const expanded = ladderExpanded.has(p.id);
  const rows = expanded ? all : all.filter(l => Math.abs(l - center) <= (L.window || 3));
  const trs = rows.map(l => {
    const real = (p._board || []).find(b => +b.line === l) || null; const o = real && real.over, u = real && real.under;
    const mp = p.lines ? p.lines[String(l)] : null; const modelP = isNum(mp) ? +mp : null;
    const oOdds = o ? amFromP(o.fair_prob) : amFromP(modelP), uOdds = u ? amFromP(u.fair_prob) : (modelP != null ? amFromP(1 - modelP) : null);
    const prim = p._bookLine != null && l === p._bookLine; const dim = (o || u) ? '' : 'opacity:.6';
    const px = r => r ? `<div class="pmeta">${F.odds(r.odds)} ${esc(r.book || '')}${r.n_books > 1 ? ` (${r.n_books})` : ''}</div>` : '';
    return `<tr style="${prim ? 'background:var(--accent-soft)' : ''}"><td style="color:${prim ? 'var(--accent)' : 'var(--bright)'}">${l.toFixed(1)}${prim ? ' ★' : ''}</td>
      <td style="${dim}">${modelP != null ? F.pct(modelP, 0) : '—'}</td>
      <td style="${dim}">${fmtOdds(oOdds)}</td><td>${evChip(o ? o.ev_pct : null, o && o.qualifies, o)}${px(o)}</td>
      <td style="${dim}">${fmtOdds(uOdds)}</td><td>${evChip(u ? u.ev_pct : null, u && u.qualifies, u)}${px(u)}</td></tr>`;
  }).join('');
  const hasBook = (p._board || []).length > 0;
  return `<div class="ds"><div class="dsl"><span>ALTERNATE LINES</span><span class="dsl-act" onclick="toggleLadder('${esc(p.id)}')">${expanded ? 'SHOW LESS ▴' : `SHOW ALL ${all[0].toFixed(1)}–${all[all.length - 1].toFixed(1)} ▾`}</span></div>
    <div style="overflow-x:auto"><table class="bt-tbl ladder" style="margin-bottom:4px"><thead><tr><th>LINE</th><th>P(O)</th><th>FAIR O</th><th>EV O · BOOK</th><th>FAIR U</th><th>EV U · BOOK</th></tr></thead><tbody>${trs}</tbody></table></div>
    <div style="font-size:12px;color:var(--dim);line-height:1.5">${hasBook ? '<span style="color:var(--accent)">★</span> = primary line · dim rows = model estimate, no market posted · ⏱ = stale line · ⚑ = blocked by a pipeline rule' : 'no props matched this player — every price below is a model estimate, not a market'}</div></div>`;
}
function quotesHTML(p) {
  const rows = (p._rows || []).slice().sort((a, b) => a.line - b.line || a.side.localeCompare(b.side));
  if (!rows.length) return '';
  const html = rows.map(r => (r.quotes || [{book: r.book, odds: r.odds, ev_pct: r.ev_pct, qualifies: r.qualifies}]).map(q => `
    <div class="quote"><span style="flex:1"><b style="color:var(--bright)">${esc(r.side.toUpperCase())} ${(+r.line).toFixed(1)}</b> <span class="dimtxt">· ${esc(q.book || '')}</span></span>
      <span class="sv">${F.odds(q.odds)}</span>${evChip(q.ev_pct, q.qualifies, q.book === r.book ? r : null)}</div>`).join('')).join('');
  return `<div class="ds"><div class="dsl">EVERY PRICE ON THE BOARD</div>${html}
    ${(() => { const b = rows.slice().sort((a, c) => (c.ev_pct ?? -99) - (a.ev_pct ?? -99))[0]; return b && (isNum(b.good_to) || isNum(b.kelly_pct)) ? `<div class="pcsub">best line ${esc(b.side.toUpperCase())} ${(+b.line).toFixed(1)}: good to ${F.odds(b.good_to)}${isNum(b.kelly_pct) ? ` · Kelly ${F.n(b.kelly_pct, 2)}%` : ''}</div>` : ''; })()}</div>`;
}
function distHTML(p) {
  const D = CFG.detail || {};
  const lo = p.p10, hi = p.p90, med = p.med, rng = Math.max((isNum(hi) ? hi : 0) * 1.2, 8);
  const pct = v => `${Math.min(100, (v / rng) * 100).toFixed(1)}%`;
  const viz = isNum(lo) && isNum(hi) ? `<div class="mc-viz"><div class="mc-track"></div><div class="mc-rng" style="left:${pct(lo)};width:${((hi - lo) / rng * 100).toFixed(1)}%"></div><div class="mc-med" style="left:${pct(med)}"></div></div>
    <div class="mc-lbl"><span>P10:${F.n(lo, 1)}</span><span>P25:${F.n(p.p25, 1)}</span><span>MED:${F.n(med, 1)}</span><span>P75:${F.n(p.p75, 1)}</span><span>P90:${F.n(hi, 1)}</span></div>` : '';
  let hist = '';
  if (Array.isArray(p.dist) && p.dist.length) {
    let ks = p.dist.map((v, k) => ({k, v: +v || 0}));
    if (ks.length > 16) { const a = Math.max(0, Math.floor((p.p10 ?? 0) - 2)), b = Math.min(ks.length - 1, Math.ceil((p.p90 ?? ks.length) + 2)); ks = ks.slice(a, b + 1); }
    const mx = Math.max(...ks.map(x => x.v)) || 1, mode = ks.reduce((m, x) => x.v > m.v ? x : m, ks[0]).k;
    hist = `<div class="hist">${ks.map(x => `<div class="hb ${x.k === mode ? 'hb-mode' : ''}" data-k="${x.k}" data-v="${(x.v * 100).toFixed(1)}"><span class="hb-val">${(x.v * 100).toFixed(0)}%</span><div class="hb-f" style="height:${Math.max(1, x.v / mx * 72)}px"></div></div>`).join('')}</div>
      <div style="display:flex;gap:3px">${ks.map(x => `<div class="hb-lbl">${x.k}</div>`).join('')}</div><div class="pcsub" style="text-align:center">${esc(CFG.product.stat)} · the highlighted bar is the most likely count</div>`;
  }
  const stats = (D.dist_stats || []).filter(s => isNum(val(p, s.key)) || val(p, s.key)).map(s => `<div class="sr"><span class="sk">${esc(s.label)}</span><span class="sv">${fmt(val(p, s.key), s.fmt)}</span></div>`).join('');
  return `<div class="ds"><div class="dsl">${esc(D.dist_title || 'DISTRIBUTION')}</div>${viz}${hist}${stats ? `<div style="margin-top:6px">${stats}</div>` : ''}</div>`;
}
function rowsHTML(items, p) { return items.filter(c => { const v = val(p, c.key); return v !== null && v !== undefined && v !== '' && !(c.fmt === 'warn' && !v); })
  .map(c => `<div class="sr"><span class="sk">${lbl(c.label)}</span><span class="sv">${fmt(val(p, c.key), c.fmt)}</span></div>`).join(''); }
function evalHTML() {
  return `<div class="ds"><div class="dsl">EVALUATE A LINE</div>
    <div style="display:flex;gap:5px;margin-bottom:6px"><input class="fi" id="le-line" type="number" step="0.5" placeholder="LINE" style="width:64px"/><input class="fi" id="le-over" type="number" step="1" placeholder="OVER $" style="flex:1"/><input class="fi" id="le-under" type="number" step="1" placeholder="UNDER $" style="flex:1"/></div>
    <button class="btn navy" style="width:100%" id="le-go">CALC EV</button><div id="le-result" style="margin-top:8px"></div></div>`;
}
async function evaluateLine() {
  const p = cur, out = $('le-result'); if (!p || !out) return;
  const line = parseFloat($('le-line').value), over = parseInt($('le-over').value, 10), under = parseInt($('le-under').value, 10);
  if (isNaN(line) || (isNaN(over) && isNaN(under))) { out.innerHTML = `<div style="font-size:12.5px;color:var(--red)">ENTER A LINE AND AT LEAST ONE PRICE</div>`; return; }
  out.innerHTML = `<div class="pcsub">pricing…</div>`;
  try {
    const q = new URLSearchParams({player: p.id, line}); if (!isNaN(over)) q.set('over', over); if (!isNaN(under)) q.set('under', under); if (viewingPeriod) q.set('period', viewingPeriod);
    const r = await fetch(`${API}/api/wk/evaluate?${q}`); const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
    const bar = d.bar ?? 5;
    out.innerHTML = `<table class="bt-tbl" style="margin-bottom:0"><thead><tr><th></th><th>MODEL P</th><th>FAIR</th><th>YOUR $</th><th>EV</th><th>KELLY</th></tr></thead><tbody>
      ${d.sides.map(s => `<tr><td style="color:var(--bright)">${s.side === 'over' ? 'O' : 'U'} ${(+d.line).toFixed(1)}</td><td>${F.pct(s.p_win, 0)}</td><td>${fmtOdds(s.fair)}</td><td>${isNum(s.odds) ? fmtOdds(s.odds) : '<span class="dimtxt">—</span>'}</td>
        <td>${isNum(s.ev) ? evChip(s.ev, s.ev >= bar) : '<span class="dimtxt">—</span>'}</td><td>${isNum(s.kelly_pct) ? F.n(s.kelly_pct, 2) + '%' : '—'}</td></tr>`).join('')}</tbody></table>
      ${d.sides.flatMap(s => (s.flags || []).map(f => `<div class="flag ${f.block ? 'block' : ''}">${f.block ? '⛔ ' : '⚠ '}${esc(f.text)}</div>`)).join('')}
      <div style="font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5">${esc(d.lam_label || '')}${isNum(d.p_push) && d.p_push > 0 ? ` · push ${F.pct(d.p_push, 1)}` : ''}${isNum(d.hold_pct) ? ` · book hold ${F.n(d.hold_pct, 1)}%` : ''} · green at the ${bar}% bar${(d.notes || []).length ? '<br>' + d.notes.map(esc).join('<br>') : ''}</div>`;
  } catch (e) { out.innerHTML = `<div style="font-size:12.5px;color:var(--red)">${esc(e.message)}</div>`; }
}
function showDetail(p, keepScroll = false) {
  cur = p;
  document.querySelectorAll('#tbody tr').forEach(r => r.classList.toggle('sel', filtered[+r.dataset.idx] && String(filtered[+r.dataset.idx].id) === String(p.id)));
  const panel = $('detail-panel'); panel.classList.add('open'); $('d-empty').style.display = 'none';
  const el = $('d-content'); el.style.display = 'block'; const st = keepScroll ? panel.scrollTop : 0;
  const D = CFG.detail || {};
  const best = p._rows && p._rows.length ? p._rows.slice().sort((a, b) => (b.ev_pct ?? -99) - (a.ev_pct ?? -99))[0] : null;
  const bestCol = best ? (best.qualifies ? 'var(--green)' : (best.ev_pct ?? -1) >= 0 ? 'var(--yellow)' : 'var(--dim)') : 'var(--dim)';
  const projSub = p.overridden ? `<div class="pcsub">MODEL ${F.n(p.lambda_model)} → YOURS ${F.n(p.proj)}${p.override && p.override.note ? `<br>✎ ${esc(p.override.note)}` : ''}</div>` : '';
  const ctx = rowsHTML(D.context || [], p);
  const usage = rowsHTML(D.usage || [], p);
  const probs = ((CFG.prob_cards || {}).lines || []).map(l => { const v = p.lines ? p.lines[String(l)] : null; const pc = isNum(v) ? Math.round(v * 100) : null;
    return `<div class="oc ${pc == null ? 'cold' : pc >= 65 ? 'hot' : pc >= 45 ? 'warm' : 'cold'}"><div class="ol">${lineLabel(l)}</div><div class="op">${pc == null ? '—' : pc + '%'}</div></div>`; }).join('');
  const factors = (p.factors || []).map(f => { const v = +f.value, diff = v - 1, w = Math.min(Math.abs(diff) * 500, 50), col = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--dim)';
    return `<div class="fbar-row"><span class="fbar-label" title="${esc(f.label)}">${esc(f.label)}</span><div class="fbar-track"><div class="fbar-fill" style="left:${diff < 0 ? 50 - w : 50}%;width:${w}%;background:${col}"></div><div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border2)"></div></div><span class="fbar-val" style="color:${col}">${v.toFixed(3)}</span></div>`; }).join('');
  el.innerHTML = `
    <div class="ds"><div class="dname">${esc(p.name)}</div>
      <div class="dsub">${[p.pos, p.team, p.pos_group && p.pos_group !== p.pos ? p.pos_group : null, p.gp ? `${p.gp} GP` : null].filter(Boolean).map(esc).join(' · ')} ${p.status && p.status.label ? statusChip(p.status) : ''}${extraChips(p)}</div>
      <div class="dmatch">${esc(p.matchup || '')}</div></div>
    <div class="ds"><div class="dsl">PROJECTION</div><div class="pg">
      <div class="pc"><div class="pcl">${lbl(D.headline || 'PROJECTED')}${p.overridden ? ' · OVERRIDE' : ''}</div><div class="pcv ${p.overridden ? 'ov' : ''}">${F.n(p.proj)}</div>${projSub || `<div class="pcsub">median ${F.n(p.med, 0)} · P10–P90 ${F.n(p.p10, 0)}–${F.n(p.p90, 0)}</div>`}</div>
      <div class="pc"><div class="pcl">BEST EV</div><div class="pcv sm" style="color:${bestCol}">${best && isNum(best.ev_pct) ? F.sgn(best.ev_pct, 1) + '%' : '—'}</div>
        <div class="pcsub">${best ? `${esc(best.side.toUpperCase())} ${(+best.line).toFixed(1)} ${F.odds(best.odds)} · ${esc(best.book || '')}${best.qualifies ? ' · <b style="color:var(--green)">qualifies</b>' : ''}` : 'Not priced'}</div></div>
    </div></div>
    ${CFG.features.overrides ? ovEditorHTML(p) : ''}
    ${ctx ? `<div class="ds"><div class="dsl">GAME CONTEXT</div>${ctx}</div>` : ''}
    ${distHTML(p)}
    ${probs ? `<div class="ds"><div class="dsl">${(CFG.prob_cards || {}).style === 'plus' ? 'CHANCE OF REACHING' : 'OVER PROBABILITIES'}</div><div class="og">${probs}</div></div>` : ''}
    ${ladderHTML(p)}
    ${quotesHTML(p)}
    ${evalHTML()}
    ${usage ? `<div class="ds"><div class="dsl">${esc(D.usage_title || 'USAGE')}</div>${usage}</div>` : ''}
    ${factors ? `<div class="ds"><div class="dsl">FACTOR BREAKDOWN</div>${factors}<div class="pcsub">multipliers on λ · 1.000 is neutral</div></div>` : ''}`;
  el.querySelectorAll('.hb').forEach(b => { b.onmouseenter = e => showTip(e, `<b>${b.dataset.k} ${esc(CFG.product.stat)}</b> · ${b.dataset.v}%`); b.onmouseleave = hideTip; });
  $('le-go').addEventListener('click', evaluateLine);
  if ($('ov-box')) ovBind(); else ovState = null;
  panel.scrollTop = st;
}
$('d-close').addEventListener('click', () => { $('detail-panel').classList.remove('open'); });

// ── manual overrides (WhizShap only; config.features.overrides) ──────────────
let ovState = null;
function lgammaJS(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += c[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function nbPmf(k, lam, r) { if (!(r > 0) || r >= 1000) return Math.exp(k * Math.log(lam) - lam - lgammaJS(k + 1)); const q = r / (r + lam); return Math.exp(lgammaJS(k + r) - lgammaJS(r) - lgammaJS(k + 1) + r * Math.log(q) + k * Math.log(1 - q)); }
function nbPOver(lam, line, r) { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += nbPmf(k, lam, r); return Math.max(0, Math.min(1, 1 - c)); }
const fmtAm = o => o == null ? '—' : (o > 0 ? '+' : '') + o;
function nTeam(team) { return allProjs.filter(x => x.team === team).length; }
function ovEditorHTML(p) {
  const x = p.x || {}; const B = {lam: x.lam_model, plays: x.plays_model, share: x.share_model, tps: x.tps_model, r: x.r_model || 25};
  const editable = DATA && DATA.meta && DATA.meta.overrides && DATA.meta.overrides.enabled !== false && !viewingPeriod && p.id && B.lam && B.plays && B.share && B.tps;
  if (!editable) return '';
  const o = p.override || {};
  const plays = o.team_exp_plays != null ? +o.team_exp_plays : B.plays;
  const share = o.snaps != null ? o.snaps / plays : (o.share != null ? +o.share : B.share);
  ovState = {pid: String(p.id), team: p.team, B, plays, share, tps: o.tps != null ? +o.tps : B.tps, mode: o.snaps != null ? 'snaps' : (o.share != null ? 'share' : null)};
  const line = p._bookLine != null ? p._bookLine : Math.floor(B.lam) + 0.5; ovState.line = line;
  const pOm = nbPOver(B.lam, line, B.r); const teamOv = o.team_exp_plays != null;
  return `<div class="ds" id="ov-box"><div class="dsl">MODEL DECOMPOSITION ${p.overridden ? '<span class="ov-active">✎ OVERRIDE LIVE</span>' : ''}</div>
    <div class="ov-grid"><span class="ov-h"></span><span class="ov-h">MODEL</span><span class="ov-h">YOURS</span>
      <span class="ov-k">OPP PLAYS<small>${esc(p.opp || 'opp')} offence · all ${nTeam(p.team)} ${esc(p.team)} defenders${teamOv ? ' · <span class="ov-link" onclick="ovResetTeam()">reset</span>' : ''}</small></span>
      <span class="ov-m">${B.plays.toFixed(1)}</span><input class="ov-in" id="ov-plays" type="number" step="0.5" min="35" max="95" value="${plays.toFixed(1)}"/>
      <span class="ov-k">EXP SNAPS<small>plays × share — enter a snap cap here</small></span><span class="ov-m">${(B.plays * B.share).toFixed(1)}</span><input class="ov-in" id="ov-snaps" type="number" step="1" min="0" max="100" value="${(plays * share).toFixed(1)}"/>
      <span class="ov-k">SNAP SHARE<small>same number as a %; scales with plays</small></span><span class="ov-m">${(B.share * 100).toFixed(0)}%</span><input class="ov-in" id="ov-share" type="number" step="1" min="1" max="100" value="${(share * 100).toFixed(1)}"/>
      <span class="ov-k">TCK / SNAP<small>role change, e.g. moved to MIKE</small></span><span class="ov-m">${B.tps.toFixed(4)}</span><input class="ov-in" id="ov-tps" type="number" step="0.001" min="0" max="0.4" value="${ovState.tps.toFixed(4)}"/>
      <div class="ov-sep"></div>
      <span class="ov-k"><span class="nocase">λ</span> PROJECTED</span><span class="ov-m">${B.lam.toFixed(2)}</span><span class="ov-out" id="ov-lam">—</span>
      <span class="ov-k">P(OVER ${line.toFixed(1)})<small>${p._bookLine != null ? 'book line' : 'nearest line'} · NB model p</small></span><span class="ov-m">${(pOm * 100).toFixed(0)}%</span><span class="ov-out" id="ov-pover">—</span>
      <span class="ov-k">FAIR ODDS O/U</span><span class="ov-m" style="font-size:13px">${fmtAm(amFromP(pOm))}/${fmtAm(amFromP(1 - pOm))}</span><span class="ov-out" id="ov-fair" style="font-size:13px">—</span></div>
    <input class="ov-note" id="ov-note" maxlength="280" placeholder="why? e.g. 'reported ~30 snap limit'" value="${esc(o.note || '')}"/>
    <div class="ov-btns"><button class="ov-save" id="ov-save">✎ SAVE OVERRIDE</button><button class="ov-clear" id="ov-clear" ${p.overridden && (o.snaps != null || o.share != null || o.tps != null) ? '' : 'disabled data-off="1"'}>CLEAR</button></div>
    <div class="ov-status" id="ov-status"></div>
    <div class="ov-hint">Saving re-prices the board from the last prop pull (no API credits) and the board bets YOUR number. Every play logs λ model and λ yours; plays your edit kills are tracked as vetoes; Results scores you vs the model. Locked at kickoff.</div></div>`;
}
function ovLam() { const s = ovState, B = s.B; return Math.max(0.05, B.lam * (s.plays * s.share) / (B.plays * B.share) * (s.tps / B.tps)); }
function ovRefresh() {
  if (!ovState) return; const s = ovState, B = s.B, lam = ovLam(), pO = nbPOver(lam, s.line, B.r), chg = Math.abs(lam - B.lam) > 0.005;
  const set = (id, txt, c) => { const el = $(id); if (!el) return; el.textContent = txt; el.classList.toggle('chg', !!c); };
  set('ov-lam', lam.toFixed(2), chg); set('ov-pover', (pO * 100).toFixed(0) + '%', chg); set('ov-fair', `${fmtAm(amFromP(pO))}/${fmtAm(amFromP(1 - pO))}`, chg);
  const mark = (id, c) => $(id)?.classList.toggle('chg', !!c);
  mark('ov-plays', Math.abs(s.plays - B.plays) > 0.05); mark('ov-snaps', Math.abs(s.plays * s.share - B.plays * B.share) > 0.05); mark('ov-share', Math.abs(s.share - B.share) > 0.0005); mark('ov-tps', Math.abs(s.tps - B.tps) > 0.00005);
}
function ovBind() {
  if (!ovState) return; const s = ovState; const numv = id => { const v = parseFloat($(id).value); return isNaN(v) ? null : v; };
  $('ov-plays').addEventListener('input', () => { const v = numv('ov-plays'); if (v == null || v <= 0) return; if (s.mode === 'snaps') { const sn = numv('ov-snaps'); s.plays = v; s.share = Math.min(1, sn / v); $('ov-share').value = (s.share * 100).toFixed(1); } else { s.plays = v; $('ov-snaps').value = (s.plays * s.share).toFixed(1); } ovRefresh(); });
  $('ov-snaps').addEventListener('input', () => { const v = numv('ov-snaps'); if (v == null || v < 0) return; s.mode = 'snaps'; s.share = Math.min(1, v / s.plays); $('ov-share').value = (s.share * 100).toFixed(1); ovRefresh(); });
  $('ov-share').addEventListener('input', () => { const v = numv('ov-share'); if (v == null || v <= 0) return; s.mode = 'share'; s.share = Math.min(1, v / 100); $('ov-snaps').value = (s.plays * s.share).toFixed(1); ovRefresh(); });
  $('ov-tps').addEventListener('input', () => { const v = numv('ov-tps'); if (v == null || v <= 0) return; s.tps = v; ovRefresh(); });
  $('ov-save').addEventListener('click', ovSave); $('ov-clear').addEventListener('click', ovClear); ovRefresh();
}
async function ovCall(method, url, body) { const r = await fetch(`${API}${url}`, {method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); const d = await r.json().catch(() => ({error: `HTTP ${r.status}`})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; }
function ovBusy(on, msg, color) { ['ov-save', 'ov-clear'].forEach(id => { const b = $(id); if (b) b.disabled = on || (id === 'ov-clear' && b.dataset.off === '1'); }); const st = $('ov-status'); if (st) { st.textContent = msg || ''; st.style.color = color || 'var(--dim)'; } }
async function ovSave() {
  const s = ovState, B = s.B, p = cur, o = p.override || {}; const note = ($('ov-note').value || '').trim();
  const teamChanged = Math.abs(s.plays - B.plays) > 0.05, shareChanged = Math.abs(s.share - B.share) > 0.0005, tpsChanged = Math.abs(s.tps - B.tps) > 0.00005;
  const hadPlayer = o.snaps != null || o.share != null || o.tps != null; const calls = [];
  if (teamChanged && (o.team_exp_plays == null || Math.abs(o.team_exp_plays - s.plays) > 0.05)) calls.push(['POST', '/api/overrides/team', {team: p.team, exp_plays: +s.plays.toFixed(1), note}]);
  if (!teamChanged && o.team_exp_plays != null) calls.push(['DELETE', `/api/overrides/team/${encodeURIComponent(p.team)}`]);
  if (shareChanged || tpsChanged) { const body = {player_id: s.pid, note}; if (shareChanged) { if (s.mode === 'share') body.share = +s.share.toFixed(4); else body.snaps = +(s.share * s.plays).toFixed(1); } if (tpsChanged) body.tps = +s.tps.toFixed(4); calls.push(['POST', '/api/overrides/player', body]); }
  else if (hadPlayer) calls.push(['DELETE', `/api/overrides/player/${encodeURIComponent(s.pid)}`]);
  if (!calls.length) { ovBusy(false, 'nothing changed vs the model', 'var(--yellow)'); return; }
  if (teamChanged) { const st = $('ov-status'); if (!(st && st.dataset.teamOk === p.team)) { if (st) { st.dataset.teamOk = p.team; st.innerHTML = `OPP PLAYS changes all ${nTeam(p.team)} ${esc(p.team)} defenders — click SAVE again to confirm`; st.style.color = 'var(--yellow)'; } return; } }
  ovBusy(true, 'saving + re-pricing the board…');
  try { let d = null; for (const [m, u, b] of calls) d = await ovCall(m, u, b); await loadProjections(''); const st = $('ov-status'); if (st) { st.textContent = '✓ ' + (d.message || 'saved'); st.style.color = 'var(--green)'; } }
  catch (e) { ovBusy(false, '✗ ' + e.message, 'var(--red)'); }
}
async function ovClear() { const s = ovState; ovBusy(true, 'clearing…'); try { await ovCall('DELETE', `/api/overrides/player/${encodeURIComponent(s.pid)}`); await loadProjections(''); } catch (e) { ovBusy(false, '✗ ' + e.message, 'var(--red)'); } }
async function ovResetTeam() { const s = ovState; ovBusy(true, `resetting ${s.team} plays…`); try { await ovCall('DELETE', `/api/overrides/team/${encodeURIComponent(s.team)}`); await loadProjections(''); } catch (e) { ovBusy(false, '✗ ' + e.message, 'var(--red)'); } }

// ── results ──────────────────────────────────────────────────────────────────
let resPeriodF = '', resResultF = '';
function perfTable(t) {
  const rows = t.rows || [];
  if (!rows.length) return `<div class="section-hdr">${esc(t.title)}</div><div class="pcsub" style="margin-bottom:12px">no graded plays yet</div>`;
  return `<div class="section-hdr">${esc(t.title)}</div><table class="bt-tbl"><thead><tr><th>${esc(t.key_label || '')}</th><th>N</th><th>W-L-P</th><th>WIN%</th><th>UNITS</th><th>ROI</th><th>KELLY U</th><th>R/E</th><th>CLV</th><th>BEAT CLOSE</th><th>MEAN EV</th><th>BRIER</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td style="color:var(--bright)">${esc(r.label ?? r.key)}</td><td>${r.n}</td>
      <td><span class="ppos">${r.wins}</span>-<span class="pneg">${r.losses}</span>-<span class="pdim">${r.pushes}</span></td><td>${F.pct(r.win_rate, 0)}</td>
      <td class="${cls(r.units_flat)}">${F.units(r.units_flat)}</td><td class="${cls(r.roi_flat)}">${isNum(r.roi_flat) ? F.sgn(r.roi_flat * 100, 1) + '%' : '—'}</td>
      <td class="${cls(r.units_kelly)}">${F.units(r.units_kelly)}</td><td class="${cls(r.realized_over_ev, v => v >= 1, v => v < 0.5)}">${F.n(r.realized_over_ev, 2)}</td>
      <td class="${r.clv_n ? cls(r.clv_pct) : 'pdim'}">${r.clv_n ? F.sgn(r.clv_pct, 2) : '—'}</td>
      <td class="${r.clv_n ? cls(r.beat_close, v => v > 0.5, v => v < 0.5) : 'pdim'}">${r.clv_n ? F.pct(r.beat_close, 0) + ` <span class="pdim">(n=${r.clv_n})</span>` : '—'}</td>
      <td>${isNum(r.mean_ev_pct) ? F.sgn(r.mean_ev_pct, 1) + '%' : '—'}</td><td>${F.n(r.brier, 4)}</td></tr>`).join('')}</tbody></table>`;
}
function pnlChart(cum) {
  if (!cum || cum.length < 1) return '';
  const W = 900, H = 220, ML = 46, MR = 14, MT = 14, MB = 30;
  const xs = cum.map((_, i) => i), yF = cum.map(r => +r.cum_units || 0), yK = cum.map(r => +r.cum_kelly || 0);
  const all = [0, ...yF, ...yK]; const lo = Math.min(...all), hi = Math.max(...all); const span = (hi - lo) || 1;
  const sx = i => ML + (cum.length === 1 ? (W - ML - MR) / 2 : i / (cum.length - 1) * (W - ML - MR)), sy = v => MT + (hi - v) / span * (H - MT - MB);
  const path = ys => ys.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
  const ticks = 4, tv = Array.from({length: ticks + 1}, (_, i) => lo + span * i / ticks);
  const labels = cum.map((r, i) => (cum.length <= 12 || i % Math.ceil(cum.length / 12) === 0 || i === cum.length - 1) ? `<text x="${sx(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--dim)">${esc(String(r.label).replace(/^\d{4}-/, ''))}</text>` : '').join('');
  const dots = cum.map((r, i) => `<circle cx="${sx(i)}" cy="${sy(yF[i])}" r="4" fill="var(--brass)" stroke="var(--surface)" stroke-width="2" data-tip="<b>${esc(r.label)}</b> · ${r.n} plays · ${F.units(r.units)} on the ${esc(CFG.product.period)} · running ${F.units(r.cum_units)} flat / ${F.units(r.cum_kelly)} Kelly"/>`).join('');
  const area = `M${sx(0)},${sy(0)} ` + yF.map((v, i) => `L${sx(i)},${sy(v)}`).join(' ') + ` L${sx(cum.length - 1)},${sy(0)} Z`;
  const last = cum[cum.length - 1];
  return `<div class="pnl-chart"><svg viewBox="0 0 ${W} ${H}">
    ${tv.map(v => `<line x1="${ML}" x2="${W - MR}" y1="${sy(v)}" y2="${sy(v)}" stroke="var(--border)"/><text x="${ML - 6}" y="${sy(v) + 4}" text-anchor="end" font-size="11" fill="var(--dim)">${F.sgn(v, 1)}</text>`).join('')}
    <line x1="${ML}" x2="${W - MR}" y1="${sy(0)}" y2="${sy(0)}" stroke="var(--border2)" stroke-dasharray="4 4"/>
    <path d="${area}" fill="${last.cum_units >= 0 ? 'var(--green-soft)' : 'var(--red-soft)'}"/>
    <path d="${path(yK)}" fill="none" stroke="var(--dim)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <path d="${path(yF)}" fill="none" stroke="var(--brass)" stroke-width="2.5"/>${dots}${labels}</svg>
    <div class="pnl-legend"><span><i style="background:var(--brass)"></i>flat 1u per play · running ${F.units(last.cum_units)}</span><span><i style="background:var(--dim)"></i>Kelly-sized (1% Kelly = 1u) · running ${F.units(last.cum_kelly)}</span><span class="dimtxt">settled plays only · by ${esc(CFG.product.period)}</span></div></div>`;
}
function sectionHTML(s) {
  const k = s.kind;
  if (k === 'divider') return `<div class="block-hdr">${esc(s.title)}</div>${s.sub ? `<div class="res-sub" style="margin-bottom:12px">${s.sub}</div>` : ''}`;
  if (k === 'note') return `<div class="note">${s.html}</div>`;
  if (k === 'pre') return `<details><summary>${esc(s.title)}</summary><pre class="report">${esc(s.text)}</pre></details>`;
  if (k === 'cards') return `<div class="section-hdr">${esc(s.title)}</div><div class="stat-grid">${(s.cards || []).map(c => `<div class="stat-card"><div class="stat-label">${lbl(c.label)}</div><div class="stat-val ${esc(c.cls || '')} ${c.small ? 'sm' : ''}">${esc(c.value ?? '—')}</div><div class="stat-sub">${c.sub || ''}</div></div>`).join('')}</div>`;
  if (k === 'perf') return perfTable(s);
  if (k === 'bars') { const mx = Math.max(...(s.rows || []).map(r => +r.share || 0)) || 1; return `<div class="section-hdr">${esc(s.title)}</div>${(s.rows || []).map(r => `<div class="imp-row"><span class="imp-label">${esc(r.label)}</span><div class="imp-track"><div class="imp-fill" style="width:${(100 * (+r.share) / mx).toFixed(1)}%"></div></div><span class="imp-val">${((+r.share) * 100).toFixed(1)}%</span></div>`).join('')}`; }
  if (k === 'calibration') return `<div class="section-hdr">${esc(s.title)}</div>${calibrationSVG(s.rows)}`;
  if (k === 'table') {
    const rows = (s.rows || []).slice(0, s.limit || 400);
    const body = rows.length ? `<table class="bt-tbl"><thead><tr>${s.cols.map(c => `<th>${lbl(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${s.cols.map(c => {
      const v = r[c.key]; let cc = c.cls === 'posneg' ? cls(v) : c.cls === 'negpos' ? cls(v, x => x < 0, x => x > 0) : (c.cls || '');
      const sub = c.sub && r[c.sub] ? `<div class="pmeta">${esc(r[c.sub])}</div>` : '';
      return `<td class="${cc} ${c.key === 'note' || c.key === 'override_note' ? 'wrap' : ''}">${c.key === 'player_name' || c.key === 'player' ? `<span style="color:var(--bright)">${esc(v ?? '')}</span>` : fmt(v, c.fmt, r)}${sub}</td>`; }).join('')}</tr>`).join('')}</tbody></table>` : '<div class="pcsub" style="margin-bottom:12px">no rows yet</div>';
    const inner = `${body}${s.note ? `<div class="note">${s.note}</div>` : ''}`;
    return s.collapsed ? `<details><summary>${esc(s.title)} (${rows.length})</summary>${inner}</details>` : `<div class="section-hdr">${lbl(s.title)}</div>${inner}`;
  }
  return '';
}
function calibrationSVG(rows) {
  if (!rows || !rows.length) return '<div class="pcsub">no calibration data</div>';
  const W = 440, H = 260, M = 42; const pts = rows.map(r => ({x: +r.pred, y: +r.actual, n: r.n, bin: r.bin})).filter(p => !isNaN(p.x) && !isNaN(p.y));
  if (!pts.length) return '<div class="pcsub">no calibration data</div>';
  const lo = Math.min(...pts.map(p => Math.min(p.x, p.y)), 0), hi = Math.max(...pts.map(p => Math.max(p.x, p.y)), 1);
  const sx = v => M + ((v - lo) / (hi - lo)) * (W - M - 12), sy = v => H - M - ((v - lo) / (hi - lo)) * (H - M - 12);
  const path = pts.sort((a, b) => a.x - b.x).map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px"><line x1="${M}" y1="${H - M}" x2="${W - 12}" y2="${H - M}" stroke="var(--border2)"/><line x1="${M}" y1="12" x2="${M}" y2="${H - M}" stroke="var(--border2)"/>
    <line x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}" stroke="var(--border2)" stroke-dasharray="4 4"/><path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${pts.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5" fill="var(--brass)" stroke="var(--surface)" stroke-width="2" data-tip="bin ${esc(p.bin)} · predicted ${(p.x * 100).toFixed(1)}% · actual ${(p.y * 100).toFixed(1)}% · n=${p.n}"/>`).join('')}
    ${[0, .25, .5, .75, 1].filter(t => t >= lo && t <= hi).map(t => `<text x="${sx(t)}" y="${H - M + 14}" fill="var(--dim)" font-size="12" text-anchor="middle">${(t * 100).toFixed(0)}</text><text x="${M - 7}" y="${sy(t) + 3}" fill="var(--dim)" font-size="12" text-anchor="end">${(t * 100).toFixed(0)}</text>`).join('')}
    <text x="${(W + M) / 2}" y="${H - 4}" fill="var(--dim)" font-size="12" text-anchor="middle">Predicted %</text><text x="10" y="${H / 2}" fill="var(--dim)" font-size="12" text-anchor="middle" transform="rotate(-90 10 ${H / 2})">Actual %</text></svg>
    <div class="pcsub">the dashed line is perfect calibration — points above it mean the model is under-predicting</div>`;
}
function gradedTable(plays) {
  if (!plays || !plays.length) return '<div class="empty" style="padding:16px">NO GRADED PLAYS</div>';
  const periods = [...new Set(plays.map(p => p.period).filter(Boolean))];
  const rows = plays.filter(p => (!resPeriodF || p.period === resPeriodF) && (!resResultF || (p.result || 'open') === resResultF));
  const R = CFG.results || {}; const opt = (v, l) => `<option value="${v}" ${resResultF === v ? 'selected' : ''}>${l}</option>`;
  return `<div class="rfilt"><span class="cl">${esc(R.period_label || 'PERIOD')}</span><select id="res-period"><option value="">ALL</option>${periods.map(w => `<option value="${esc(w)}" ${w === resPeriodF ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>
      <span class="cl">RESULT</span><select id="res-result">${opt('', 'ALL')}${opt('win', 'WIN')}${opt('loss', 'LOSS')}${opt('push', 'PUSH')}${opt('open', 'OPEN (UNGRADED)')}${opt('void', 'VOID')}</select>
      <span class="n-results" style="margin-left:auto">SHOWING <span>${rows.length}</span> / ${plays.length}</span></div>
    <table class="bt-tbl"><thead><tr><th>${esc(R.period_label || 'WK')}</th><th>PLAYER</th><th>POS</th><th>BET</th><th>PRICE</th><th>BOOK</th><th>P MODEL</th><th>P MKT</th><th>P BET</th><th>EV</th><th>KELLY</th><th>${esc(R.proj_label || 'PROJ')}</th><th>${esc(R.actual_label || 'ACT')}</th><th>RESULT</th><th>UNITS</th><th>CLV</th>${CFG.product.sport !== 'nfl' ? '<th>MOVE</th>' : ''}</tr></thead>
      <tbody>${rows.map(p => { const res = p.result || 'open', settled = ['win', 'loss', 'push'].includes(res), rc = res === 'win' ? 'ppos' : res === 'loss' ? 'pneg' : 'pdim';
        return `<tr><td class="pdim">${esc(CFG.product.period === 'week' ? p.period_label : F.day(p.date))}</td>
          <td style="color:var(--bright)">${esc(p.player || '')}${p.note ? `<span class="ov-badge" title="${esc(p.note)}">✎</span>` : ''}<div class="pmeta">${esc(p.team || '')} vs ${esc(p.opp || '')}</div></td>
          <td>${esc(p.pos || '')}</td><td>${esc(String(p.side || '').toUpperCase().slice(0, 1))} ${F.n(p.line, 1)}</td><td>${F.odds(p.odds)}</td>
          <td class="pdim">${esc(p.book || '')}${p.n_books ? ` (${Math.round(p.n_books)})` : ''}</td><td>${F.pct(p.p_model, 0)}</td><td>${F.pct(p.p_mkt, 0)}</td><td>${F.pct(p.p_bet, 0)}</td>
          <td class="${cls(p.ev_pct)}">${isNum(p.ev_pct) ? F.sgn(p.ev_pct, 1) + '%' : '—'}</td><td>${isNum(p.kelly_pct) ? F.n(p.kelly_pct, 2) + '%' : '—'}</td>
          <td>${F.n(p.proj, 1)}${p.note && isNum(p.lambda_model) ? `<div class="pmeta">model ${F.n(p.lambda_model, 1)}</div>` : ''}</td>
          <td style="color:var(--bright)">${isNum(p.actual) ? F.n(p.actual, 0) : '—'}</td><td class="${rc}">${res.toUpperCase()}</td>
          <td class="${settled ? cls(p.units) : 'pdim'}">${settled ? F.units(p.units) : '—'}</td><td class="${cls(p.clv)}">${isNum(p.clv) ? F.sgn(p.clv, 2) : '—'}</td>
          ${CFG.product.sport !== 'nfl' ? `<td class="${cls(p.move)}">${isNum(p.move) ? F.sgn(p.move, 2) : '—'}</td>` : ''}</tr>`; }).join('')}</tbody></table>`;
}
function rebindResFilters() {
  $('res-period')?.addEventListener('change', e => { resPeriodF = e.target.value; $('graded-wrap').innerHTML = gradedTable(RES.plays); rebindResFilters(); });
  $('res-result')?.addEventListener('change', e => { resResultF = e.target.value; $('graded-wrap').innerHTML = gradedTable(RES.plays); rebindResFilters(); });
}
function renderResults() {
  const el = $('bt-content'), d = RES || {}, perf = d.performance || {}, has = !!d.has && (perf.n || 0) > 0, need = d.need || {clv: 50, re: 300, bucket: 500, brier: 500, roi: 2000};
  const gate = (v, n, nd, good = x => x > 0) => (!isNum(v) || n < nd) ? '' : good(+v) ? 'pos' : 'neg';
  const ready = (n, nd) => n >= nd ? `<span class="ready">n=${n} · readable</span>` : `<span class="early">n=${n} · too early (needs ~${nd})</span>`;
  const cum = d.cumulative || [], last = cum[cum.length - 1];
  const cards = has ? `<div class="stat-grid">
      <div class="stat-card hero"><div class="stat-label">UNITS — FLAT 1u PER PLAY</div><div class="stat-val ${cls(perf.units_flat) === 'ppos' ? 'pos' : cls(perf.units_flat) === 'pneg' ? 'neg' : ''}">${F.units(perf.units_flat)}</div>
        <div class="stat-sub">on ${perf.n}u staked · ROI ${isNum(perf.roi_flat) ? F.sgn(perf.roi_flat * 100, 1) + '%' : '—'}${last ? ` · last ${esc(CFG.product.period)} ${F.units(last.units)} (${last.n} plays)` : ''}<br>${ready(perf.n, need.roi)} — ROI needs thousands of plays; read CLV and R/E first</div></div>
      <div class="stat-card"><div class="stat-label">UNITS — KELLY-SIZED</div><div class="stat-val ${cls(perf.units_kelly) === 'ppos' ? 'pos' : cls(perf.units_kelly) === 'pneg' ? 'neg' : ''}">${F.units(perf.units_kelly)}</div>
        <div class="stat-sub">${isNum(perf.staked_kelly) ? `${F.n(perf.staked_kelly, 1)}u staked` : ''}${isNum(perf.roi_kelly) ? ` · ROI ${F.sgn(perf.roi_kelly * 100, 1)}%` : ''}<br>1% Kelly = 1u, the size the board recommends</div></div>
      <div class="stat-card"><div class="stat-label">CLV (MEAN)</div><div class="stat-val ${gate(perf.clv_pct, perf.clv_n || 0, need.clv)}">${perf.clv_n ? F.sgn(perf.clv_pct, 2) : '—'}</div>
        <div class="stat-sub">pts · beat close ${F.pct(perf.beat_close, 0)} · n=${perf.clv_n || 0} of ${perf.n}<br>${ready(perf.clv_n || 0, need.clv)}</div></div>
      <div class="stat-card"><div class="stat-label">REALIZED / EXPECTED</div><div class="stat-val ${gate(perf.realized_over_ev, perf.n, need.re, x => x >= 1)}">${F.n(perf.realized_over_ev, 2)}</div>
        <div class="stat-sub">${F.units(perf.units_flat)} vs ${F.units(perf.exp_units)} expected<br>${ready(perf.n, need.re)}</div></div>
      <div class="stat-card"><div class="stat-label">WIN RATE</div><div class="stat-val">${F.pct(perf.win_rate, 1)}</div>
        <div class="stat-sub">mean model p ${F.pct(perf.mean_model_prob, 1)} · mean EV ${isNum(perf.mean_ev_pct) ? F.sgn(perf.mean_ev_pct, 1) + '%' : '—'}${isNum(perf.wr_lo) ? `<br>95% ${F.pct(perf.wr_lo, 0)}–${F.pct(perf.wr_hi, 0)}` : ''}</div></div>
      <div class="stat-card"><div class="stat-label">PLAYS GRADED</div><div class="stat-val">${perf.n}</div>
        <div class="stat-sub"><span class="ppos">${perf.wins}W</span> · <span class="pneg">${perf.losses}L</span> · ${perf.pushes}P<br>${d.open || 0} open${d.void ? ` · ${d.void} void` : ''}</div></div>
      <div class="stat-card"><div class="stat-label">BRIER (SIDE)</div><div class="stat-val">${F.n(perf.brier, 4)}</div><div class="stat-sub">0.25 = coin flip · lower is better<br>${ready(perf.n, need.brier)}</div></div>
    </div>` : `<div class="empty" style="padding:24px">NO GRADED PLAYS YET<br><br><span style="font-size:12px">${esc(d.empty_hint || 'run the grader')}</span></div>`;
  const howto = has ? `<div class="note"><b>READ IN THIS ORDER.</b> <b>Units</b> is the scoreboard, not the verdict. <b>CLV</b> converges fastest (~${need.clv}–200 plays) — positive means the price beat the closing consensus.
    <b>R/E</b> = realized profit ÷ Σ(EV × stake): below 0.5 over ~${need.re} plays means the model's edge is overstated (w_model too high). <b>Edge buckets</b> (~${need.bucket}): higher-EV plays should win more than lower-EV plays; a flat curve means the edge is noise. <b>ROI</b> last — it needs thousands of plays to separate from variance.</div>` : '';
  const tables = d.tables || [];
  const full = tables.filter(t => !t.half), half = tables.filter(t => t.half);
  const secs = d.sections || [];
  // group consecutive half-width sections into the two-column grid
  let secHTML = '', buf = [];
  const flush = () => { if (buf.length) { secHTML += `<div class="two-col">${buf.map(s => `<div>${sectionHTML(s)}</div>`).join('')}</div>`; buf = []; } };
  secs.forEach(s => { if (s.half) buf.push(s); else { flush(); secHTML += sectionHTML(s); } }); flush();
  el.innerHTML = `
    <div class="res-toolbar"><div><div class="res-title">EV PLAY PERFORMANCE</div><div class="res-sub">${esc(d.subtitle || '')} · last graded ${esc(F.when(d.graded_at))}</div></div>
      <div class="res-right">${d.snapshot ? `<a class="btn" href="${esc(d.snapshot)}" target="_blank" style="text-decoration:none">SNAPSHOT ↗</a>` : ''}<button class="btn" id="res-reload">↻ RELOAD</button>
        ${CFG.features.grade !== false ? `<button class="btn navy" id="grade-btn" title="${esc(CFG.features.grade_note || '')}">▶ RUN GRADER</button>` : ''}<span class="jobmsg" id="grade-msg"></span></div></div>
    ${cards}${has ? pnlChart(cum) : ''}${howto}
    ${has ? full.map(perfTable).join('') + (half.length ? `<div class="two-col">${half.map(t => `<div>${perfTable(t)}</div>`).join('')}</div>` : '') : ''}
    <div class="section-hdr">GRADED PLAYS — ONE ROW PER BET</div><div id="graded-wrap">${gradedTable(d.plays)}</div>
    ${d.report_text ? `<details><summary>grading report</summary><pre class="report">${esc(d.report_text)}</pre></details>` : ''}
    ${secHTML}`;
  el.querySelectorAll('[data-tip]').forEach(x => { x.onmouseenter = e => showTip(e, x.dataset.tip); x.onmouseleave = hideTip; });
  $('res-reload').addEventListener('click', loadResults);
  $('grade-btn')?.addEventListener('click', () => runJob('grade', $('grade-btn'), $('grade-msg'), () => loadResults()));
  rebindResFilters();
}
async function loadResults() {
  const el = $('bt-content'); el.innerHTML = '<div class="empty">LOADING RESULTS…</div>';
  try { const r = await fetch(`${API}/api/wk/results`); const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`); RES = d; renderResults(); }
  catch (e) { el.innerHTML = `<div class="empty err">ERROR LOADING RESULTS<br><br><span style="font-size:12px">${esc(e.message)} — is server.py running?</span></div>`; }
}

// ── jobs (pull / grade) ──────────────────────────────────────────────────────
async function runJob(kind, btn, msg, onDone) {
  const label = btn.textContent; btn.disabled = true; msg.textContent = 'starting…'; msg.style.color = 'var(--dim)'; jobBusy = true; setStatus();
  const done = (ok, text) => { btn.disabled = false; btn.textContent = label; jobBusy = false; setStatus(); msg.style.color = ok ? 'var(--green)' : 'var(--red)'; msg.textContent = text; setTimeout(() => { msg.textContent = ''; }, 15000); };
  try {
    const r = await fetch(`${API}/api/wk/${kind}`, {method: 'POST'}); const d = await r.json().catch(() => ({}));
    if (r.status === 409) { msg.textContent = 'already running — waiting for it'; }
    else if (!r.ok) { done(false, d.error || `HTTP ${r.status}`); return; }
    btn.textContent = kind === 'pull' ? 'PULLING…' : 'GRADING…';
    const poll = setInterval(async () => {
      try {
        const s = await (await fetch(`${API}/api/wk/${kind}/status`)).json();
        if (s.running) { msg.textContent = kind === 'pull' ? 'pulling lines + re-pricing…' : 'ingesting finals + grading…'; return; }
        clearInterval(poll);
        if (s.code === 0) { done(true, s.message || (kind === 'pull' ? '✓ lines pulled' : '✓ graded')); if (onDone) onDone(); }
        else done(false, `${kind} exit ${s.code}${s.message ? ' — ' + s.message : ''}`);
      } catch (e) { clearInterval(poll); done(false, 'lost the server while polling'); }
    }, 3000);
  } catch (e) { done(false, 'network error'); }
}

// ── discord ──────────────────────────────────────────────────────────────────
$('discord-btn').addEventListener('click', async () => { const d = await (await fetch(`${API}/api/wk/discord`)).json(); $('disc-out').textContent = d.text || '—'; $('disc-modal').classList.add('open'); });
['disc-close', 'disc-close2'].forEach(id => $(id).addEventListener('click', () => $('disc-modal').classList.remove('open')));
$('copy-btn').addEventListener('click', () => { navigator.clipboard.writeText($('disc-out').textContent); $('copy-btn').textContent = 'COPIED!'; setTimeout(() => $('copy-btn').textContent = 'COPY', 2000); });

// ── controls ─────────────────────────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll('#group-chips .chip').forEach(c => c.addEventListener('click', () => { document.querySelectorAll('#group-chips .chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); groupF = c.dataset.g; applyFilters(); renderTable(); }));
  document.querySelectorAll('#sort-chips .chip').forEach(c => c.addEventListener('click', () => { document.querySelectorAll('#sort-chips .chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); if (sortKey === c.dataset.sort) sortAsc = !sortAsc; else { sortKey = c.dataset.sort; sortAsc = false; } applyFilters(); renderTable(); }));
  document.querySelectorAll('#toggle-chips .chip').forEach(c => c.addEventListener('click', () => { toggles[c.dataset.t] = !toggles[c.dataset.t]; c.classList.toggle('active', toggles[c.dataset.t]); applyFilters(); renderTable(); }));
  $('ev-only-btn').addEventListener('click', () => { evOnly = !evOnly; $('ev-only-btn').classList.toggle('active', evOnly); applyFilters(); renderTable(); });
  $('priced-only-btn').addEventListener('click', () => { pricedOnly = !pricedOnly; $('priced-only-btn').classList.toggle('active', pricedOnly); applyFilters(); renderTable(); });
  $('team-sel').addEventListener('change', e => { teamF = e.target.value; applyFilters(); renderTable(); });
  $('search-inp').addEventListener('input', e => { searchQ = e.target.value; applyFilters(); renderTable(); });
  $('refresh-btn').addEventListener('click', () => loadProjections($('period-select').value));
  $('period-select').addEventListener('change', e => { cur = null; $('d-content').style.display = 'none'; $('d-empty').style.display = ''; loadProjections(e.target.value); });
  $('pull-btn').addEventListener('click', () => runJob('pull', $('pull-btn'), $('pull-msg'), () => loadProjections($('period-select').value)));
}

// ── init ─────────────────────────────────────────────────────────────────────
(async function init() {
  try { await loadConfig(); } catch (e) { serverOk = false; setStatus(); $('tbl-wrap').innerHTML = `<div class="empty err">CAN'T REACH THE SERVER<br><br><span style="font-size:12px">${esc(e.message)}</span></div>`; return; }
  await loadPeriods(); await loadProjections('');
  setInterval(() => { if ($('page-projections').classList.contains('active') && !jobBusy) loadProjections($('period-select').value); }, 300000);
  setInterval(setStatus, 60000);
})();
