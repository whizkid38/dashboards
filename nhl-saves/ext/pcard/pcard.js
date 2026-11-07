/* pcard.js — Hawkey full-screen player card (v1.0.0)
 *
 * Plugs into the existing board without changing it:
 *   - wraps the kit's showDetail(p) so the side panel gets a "Full card" button
 *   - double-click a row (or press F with a row selected) to open the card
 *   - ← / → step through the board in its current sort/filter order, Esc or the browser Back button closes
 * Tonight's numbers come from the same player object the side panel uses (p); history comes from
 * GET {API}/api/wk/player/<id> (pcard_api.py), loaded when the card opens.
 */
(function () {
  'use strict';
  if (window.__pcard) return;
  window.__pcard = true;

  const API = location.pathname.replace(/\/[^\/]*$/, '');
  const TABS = [['props', 'Props'], ['role', 'Role'], ['form', 'Form'], ['log', 'Log'], ['history', 'History'], ['schedule', 'Schedule']];
  const S = { p: null, last: null, pid: null, data: null, err: null, tab: 'props', line: null, scope: 'cur', open: false, req: 0 };
  const CACHE = new Map();
  const CACHE_MS = 5 * 60 * 1000;

  // ── formatting ────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
  const f = (v, d = 1) => ok(v) ? Number(v).toFixed(d) : '–';
  const pct = (v, d = 0) => ok(v) ? (Number(v) * 100).toFixed(d) + '%' : '–';
  const odds = o => ok(o) ? (Number(o) > 0 ? '+' : '') + Math.round(Number(o)) : '–';
  const sg = (v, d = 1) => ok(v) ? (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d) : '–';
  const mmss = m => { if (!ok(m)) return '–'; const s = Math.round(Number(m) * 60); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const md = d => { if (!d) return ''; const p = String(d).slice(0, 10).split('-'); return (+p[1]) + '/' + (+p[2]); };
  const fairOdds = p => !ok(p) || p <= 0 || p >= 1 ? null : (p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
  const evCls = v => !ok(v) ? '' : (v > 0 ? 'pc-pos-ev' : 'pc-neg-ev');
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const bookName = b => String(b || '').replace(/^betonlinea?g?$/i, 'BetOnline').replace(/_/g, ' ');
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const NOTE = { star_under: 'star-under filter', model_side: 'model leans other way', stale: 'stale price', started: 'game started' };

  // ── state from the kit's player object ────────────────────────────────────
  const linesOf = p => Object.keys(p.lines || {}).map(Number).filter(x => !Number.isNaN(x)).sort((a, b) => a - b);
  function primaryLine(p) {
    if (p._primary && ok(p._primary.line)) return Number(p._primary.line);
    const ls = linesOf(p); if (!ls.length) return 2.5;
    return ls.reduce((b, x) => Math.abs(x - (p.proj || 0)) < Math.abs(b - (p.proj || 0)) ? x : b, ls[0]);
  }
  const rowsOf = p => (p._rows || []).slice();
  function bestAt(p, side, line) {
    const r = rowsOf(p).filter(r => String(r.side).toLowerCase() === side && Number(r.line) === Number(line));
    return r.sort((a, b) => (b.ev_pct ?? -99) - (a.ev_pct ?? -99))[0] || null;
  }
  const pOver = (p, line) => { const v = (p.lines || {})[String(line)] ?? (p.lines || {})[Number(line).toFixed(1)]; return ok(v) ? Number(v) : null; };

  // ── log helpers ───────────────────────────────────────────────────────────
  const logRows = () => (S.data && S.data.log) || [];
  const scoped = sc => logRows().filter(r => sc === 'both' || r.season === sc);
  // goalie mode (Saves page): the stat is saves, and form / splits count starts only
  const isG = () => S.kind === 'goalie';
  const stat = r => isG() ? r.sv : r.sog;
  const UNIT = () => isG() ? 'SV' : 'SOG';
  const starts = rows => isG() ? rows.filter(r => r.gs) : rows;
  function rate(rows, line) {
    const g = starts(rows).filter(r => ok(stat(r)));
    if (!g.length) return null;
    const over = g.filter(r => stat(r) > line).length;
    const vol = r => isG() ? r.sa : r.att;
    return { n: g.length, over, pct: over / g.length, avg: avg(g.map(stat)), att: avg(g.filter(r => ok(vol(r))).map(vol)) };
  }

  // ── DOM scaffolding ───────────────────────────────────────────────────────
  let ov, topEl, wrap;
  function build() {
    ov = document.createElement('div');
    ov.id = 'pcard'; ov.hidden = true; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = `
      <div class="pc-top">
        <button type="button" data-a="close" title="Back to the board (Esc)">&larr; Board</button>
        <span class="pc-crumb">Hawkey Shots &middot; <b>Player card</b></span>
        <span class="pc-sp"></span>
        <span class="pc-kbd">&larr; &rarr; to step through the board</span>
        <button type="button" data-a="prev" title="Previous player (&larr;)">&lsaquo;</button>
        <span class="pc-pos" data-r="pos"></span>
        <button type="button" data-a="next" title="Next player (&rarr;)">&rsaquo;</button>
        <button type="button" data-a="close" title="Close (Esc)">&times;</button>
      </div>
      <div class="pc-scroll"><div class="pc-wrap"></div></div>`;
    document.body.appendChild(ov);
    topEl = ov.querySelector('.pc-top');
    wrap = ov.querySelector('.pc-wrap');
    ov.addEventListener('click', onClick);
  }

  function onClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const act = a.dataset.a;
    if (act === 'close') close();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
    else if (act === 'tab') { S.tab = a.dataset.v; renderBody(); }
    else if (act === 'line') { S.line = Number(a.dataset.v); renderBody(); renderStrip(); }
    else if (act === 'scope') { S.scope = a.dataset.v; renderBody(); }
  }

  // ── board rows (prev / next) ──────────────────────────────────────────────
  const boardRows = () => [...document.querySelectorAll('#tbody > tr[data-idx]')];
  function step(d) {
    const r = boardRows(); const i = r.findIndex(t => t.classList.contains('sel'));
    const j = i + d;
    if (i < 0 || j < 0 || j >= r.length) return;
    r[j].click();                       // the kit's own handler calls showDetail(p) -> we follow
    r[j].scrollIntoView({ block: 'nearest' });
  }
  function posLabel() {
    const r = boardRows(); const i = r.findIndex(t => t.classList.contains('sel'));
    const el = topEl.querySelector('[data-r=pos]');
    el.textContent = i >= 0 ? `${i + 1} / ${r.length}` : '';
    topEl.querySelector('[data-a=prev]').disabled = i <= 0;
    topEl.querySelector('[data-a=next]').disabled = i < 0 || i >= r.length - 1;
  }

  // ── open / close ──────────────────────────────────────────────────────────
  function open(p) {
    if (!p) return;
    const same = S.pid === String(p.id);
    S.p = p; S.pid = String(p.id);
    S.kind = (p.pos === 'G' || p.pos_group === 'G' || /\/saves\//.test(location.pathname)) ? 'goalie' : 'skater';
    if (!same) { S.line = primaryLine(p); S.data = null; S.err = null; }
    if (!S.open) {
      S.open = true; ov.hidden = false; document.body.classList.add('pc-lock');
      try { history.pushState({ pcard: true }, '', location.pathname + location.search + '#card'); } catch (_) { /* file:// */ }
    }
    if (!same) ov.querySelector('.pc-scroll').scrollTop = 0;
    render();
    if (!same || !S.data) load();
  }
  function close(fromPop) {
    if (!S.open) return;
    S.open = false; ov.hidden = true; document.body.classList.remove('pc-lock');
    if (!fromPop && history.state && history.state.pcard) history.back();
  }
  window.addEventListener('popstate', () => { if (S.open) close(true); });
  document.addEventListener('keydown', e => {
    const t = e.target; if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!S.open) { if ((e.key === 'f' || e.key === 'F') && S.last) { e.preventDefault(); open(S.last); } return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(-1); }
    else if (/^[1-6]$/.test(e.key)) { S.tab = TABS[+e.key - 1][0]; renderBody(); }
  });
  document.addEventListener('dblclick', e => {
    const tr = e.target.closest && e.target.closest('#tbody > tr[data-idx]');
    if (tr && S.last) { e.preventDefault(); open(S.last); }
  });

  async function load() {
    const pid = S.pid, id = ++S.req, p = S.p;
    const hit = CACHE.get(pid);
    if (hit && Date.now() - hit.t < CACHE_MS) { S.data = hit.d; render(); return; }
    try {
      const q = new URLSearchParams({ name: p.name || '', team: p.team || '', kind: S.kind });
      const r = await fetch(`${API}/api/wk/player/${encodeURIComponent(pid)}?${q}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || (r.status === 404 ? 'player endpoint not installed on the server' : 'HTTP ' + r.status));
      CACHE.set(pid, { t: Date.now(), d: j });
      if (id === S.req) { S.data = j; S.err = null; render(); }
    } catch (err) {
      if (id === S.req) { S.err = String(err.message || err); render(); }
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    if (!S.open || !S.p) return;
    posLabel();
    topEl.querySelector('.pc-crumb').innerHTML = `Hawkey ${isG() ? 'Saves' : 'Shots'} &middot; <b>Player card</b>`;
    wrap.innerHTML = `<div class="pc-hero" data-r="hero"></div><div class="pc-strip" data-r="strip"></div>
      <div class="pc-tabs" role="tablist" data-r="tabs"></div><div class="pc-body" data-r="body"></div>`;
    renderHero(); renderStrip(); renderBody();
  }
  const $ = r => wrap.querySelector(`[data-r=${r}]`);

  function nextGame() {
    const s = (S.data && S.data.schedule) || [];
    return s[0] || null;
  }
  function whenText(g) {
    if (!g || !g.start_utc) return '';
    const d = new Date(g.start_utc);
    return d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderHero() {
    const p = S.p, b = (S.data && S.data.bio) || {};
    const shot = b.headshot ? `<img src="${esc(b.headshot)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${esc(initials(p.name))}'}))">`
      : `<span>${esc(initials(p.name))}</span>`;
    const st = p.status || {};
    const stCls = /out|scratch|ir/i.test(st.kind || '') ? 'r' : /gtd|doubt|quest/i.test(st.kind || st.label || '') ? 'y' : 'g';
    const chips = [(st.label ? `<span class="pc-pill ${stCls}">${esc(st.label)}</span>` : '')]
      .concat((p.chips || []).map(c => `<span class="pc-pill ${c.kind === 'brass' ? 'b' : ''}">${esc(c.label)}</span>`)).join('');
    const age = b.birth_date ? Math.floor((Date.now() - new Date(b.birth_date)) / 31557600000) : null;
    const bio = [b.shoots ? `${isG() ? 'Catches' : 'Shoots'} ${b.shoots}` : '', b.height, b.weight ? `${b.weight} lb` : '', age ? `Age ${age}` : '',
      b.birth_place ? `Born ${b.birth_place}` : '', b.draft ? `Draft ${b.draft}` : ''].filter(Boolean).join(' · ');
    const g = nextGame();
    $('hero').innerHTML = `
      <div class="pc-shot">${shot}</div>
      <div style="min-width:0">
        <div class="pc-name" role="heading" aria-level="1">${esc(p.name)}</div>
        <div class="pc-sub"><b>${esc(p.pos || '')}</b><span class="pc-dot">·</span>${esc(p.team || '')}
          ${b.number ? `<span class="pc-dot">·</span>#${esc(b.number)}` : ''}
          ${ok(p.gp) ? `<span class="pc-dot">·</span>${esc(p.gp)} GP in model` : ''}</div>
        <div class="pc-bio">${esc(bio) || (S.data ? '' : '&nbsp;')}</div>
      </div>
      <div class="pc-game">
        <div class="pc-match">${esc(p.matchup || (p.opp ? (p.home ? 'vs ' : '@ ') + p.opp : ''))}</div>
        <div class="pc-when">${esc(whenText(g))}</div>
        <div class="pc-chips">${chips}</div>
      </div>`;
  }

  function renderStrip() {
    const p = S.p, x = p.x || {}, L = S.line;
    const o = bestAt(p, 'over', L), u = bestAt(p, 'under', L);
    const po = pOver(p, L);
    const cur = rate(scoped('cur'), L), l10 = rate(starts(scoped('both')).slice(0, 10), L);
    const priceTile = (lab, r) => `<div class="pc-tile"><div class="pc-tl">${lab} ${f(L, 1)}</div>
      <div class="pc-tv">${r ? odds(r.odds) : '–'}</div>
      <div class="pc-ts">${r ? `${esc(bookName(r.book))} · <b class="${evCls(r.ev_pct)}">EV ${sg(r.ev_pct, 1)}%</b>` : 'not priced'}</div></div>`;
    $('strip').innerHTML = `
      <div class="pc-tile lead"><div class="pc-tl">Our projection · ${isG() ? 'Saves' : 'SOG'}</div>
        <div class="pc-tv">${f(p.proj, 2)}</div>
        <div class="pc-ts">median ${f(p.med, 0)} · P10–P90 ${f(p.p10, 0)}–${f(p.p90, 0)}${p.overridden ? ' · <b>override</b>' : ''}</div></div>
      <div class="pc-tile"><div class="pc-tl">Line ${f(L, 1)}</div>
        <div class="pc-tv">${pct(po, 0)} <span style="font-size:13px" class="pc-muted">over</span></div>
        <div class="pc-ts">fair ${odds(fairOdds(po))} / ${odds(fairOdds(po == null ? null : 1 - po))}</div></div>
      ${priceTile('Best over', o)}${priceTile('Best under', u)}
      ${isG() ? `<div class="pc-tile"><div class="pc-tl">Proj. shots against</div><div class="pc-tv">${f(x.sa, 1)}</div>
        <div class="pc-ts">SA/60 ${f(x.sa60, 1)} · sv% ${f((x.sv_pct || 0) * 100, 1)} · pull ${pct(x.p_pull, 1)}</div></div>`
      : `<div class="pc-tile"><div class="pc-tl">Proj. TOI</div><div class="pc-tv">${mmss(x.toi)}</div>
        <div class="pc-ts">EV ${mmss(x.t_ev)} · PP ${mmss(x.t_pp)} · SH ${mmss(x.t_sh)}</div></div>`}
      <div class="pc-tile"><div class="pc-tl">Form vs ${f(L, 1)}</div>
        <div class="pc-tv">${l10 ? `${l10.over}/${l10.n}` : (S.data ? '–' : '…')}</div>
        <div class="pc-ts">${l10 ? `last ${l10.n}${isG() ? ' starts' : ''} · avg ${f(l10.avg, 1)}` : 'last 10'}${cur ? ` · season ${pct(cur.pct)}` : ''}</div></div>`;
  }

  function renderBody() {
    const counts = { props: rowsOf(S.p).length, log: scoped('cur').length, history: (S.data && S.data.plays_summary && S.data.plays_summary.n) || 0 };
    $('tabs').innerHTML = TABS.map(([k, lab]) => (k === 'role' && isG() ? ['role', 'Workload'] : [k, lab])).map(([k, lab]) => `<button type="button" class="pc-tab" role="tab" data-a="tab" data-v="${k}" aria-selected="${S.tab === k}">${lab}${counts[k] ? `<span class="pc-n">${counts[k]}</span>` : ''}</button>`).join('');
    const body = $('body');
    const needsData = S.tab !== 'props';
    let warn = '';
    if (S.err) warn = `<div class="pc-warn">History didn't load: ${esc(S.err)}. Tonight's numbers below are from the board.</div>`;
    if (needsData && !S.data && !S.err) { body.innerHTML = `<div class="pc-loading"><span class="pc-spin"></span>Loading game log and history…</div>`; return; }
    const fn = { props: tabProps, role: tabRole, form: tabForm, log: tabLog, history: tabHistory, schedule: tabSchedule }[S.tab];
    try { body.innerHTML = warn + fn(); } catch (e) { console.error('[pcard]', e); body.innerHTML = warn + `<div class="pc-empty">This section hit an error: ${esc(e.message)}</div>`; }
  }

  const sec = (title, note, inner, extra = '') => `<div class="pc-sec" ${extra}><h3>${title}</h3>${note ? `<p class="pc-note">${note}</p>` : ''}${inner}</div>`;
  const kitHTML = (name, p) => { try { const fn = window[name]; return typeof fn === 'function' ? fn(p) : ''; } catch (_) { return ''; } };
  function lineChips(withPrice) {
    const p = S.p;
    return `<div class="pc-chiprow"><span class="lbl">Line</span>${linesOf(p).map(L => {
      const prim = primaryLine(p) === L;
      return `<button type="button" class="pc-chip" data-a="line" data-v="${L}" aria-pressed="${S.line === L}">${f(L, 1)}${withPrice && prim ? '<span class="bk">book</span>' : ''}</button>`;
    }).join('')}</div>`;
  }

  // ── Props ─────────────────────────────────────────────────────────────────
  function tabProps() {
    const p = S.p;
    const rows = rowsOf(p).sort((a, b) => Number(a.line) - Number(b.line) || String(a.side).localeCompare(String(b.side)));
    const tbl = rows.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr>
        <th>Prop</th><th>Ours</th><th>Fair</th><th>Edge</th><th>Kelly</th><th>Best price</th><th>Books</th><th>Good to</th><th class="l">Status</th></tr></thead><tbody>
      ${rows.map(r => {
        const st = r.qualifies ? '<span class="pc-pill g">EV play</span>'
          : r.blocked ? `<span class="pc-pill y">${esc(NOTE[r.blocked_note] || r.blocked_note || 'blocked')}</span>`
          : r.started ? '<span class="pc-pill">started</span>' : r.stale ? '<span class="pc-pill y">stale</span>' : '<span class="pc-muted">—</span>';
        return `<tr class="${r.qualifies ? 'pc-q' : ''}"><td class="b">${String(r.side).toLowerCase() === 'over' ? 'Over' : 'Under'} ${f(r.line, 1)}${r.tier ? ` <span class="pc-pill b">${esc(r.tier)}</span>` : ''}</td>
          <td>${pct(r.model_prob, 1)}</td><td>${pct(r.fair_prob, 1)} <span class="pc-muted">${odds(fairOdds(r.fair_prob))}</span></td>
          <td class="${evCls(r.ev_pct)}"><b>${sg(r.ev_pct, 1)}%</b></td><td>${ok(r.kelly_pct) && r.kelly_pct > 0 ? f(r.kelly_pct, 2) + '%' : '–'}</td>
          <td class="b">${odds(r.odds)} <span class="pc-muted" style="font-weight:400">${esc(bookName(r.book))}</span></td>
          <td>${esc(r.n_books ?? '–')}</td><td>${odds(r.good_to)}</td><td class="l">${st}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="pc-empty">No prices on the board for this skater right now.</div>';

    // book x prop matrix from each row's quotes
    const cols = rows.map(r => ({ key: `${r.side}|${r.line}`, lab: `${String(r.side).toLowerCase() === 'over' ? 'O' : 'U'} ${f(r.line, 1)}`, q: r.quotes || [] }));
    const books = [...new Set(cols.flatMap(c => c.q.map(q => q.book)))].sort();
    const matrix = books.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Book</th>${cols.map(c => `<th>${c.lab}</th>`).join('')}</tr></thead><tbody>
      ${books.map(b => `<tr><td>${esc(bookName(b))}</td>${cols.map(c => {
        const q = c.q.find(q => q.book === b);
        return q ? `<td class="${evCls(q.ev_pct)}" title="EV ${sg(q.ev_pct, 1)}%">${q.qualifies ? '<b>' : ''}${odds(q.odds)}${q.qualifies ? '</b>' : ''}</td>` : '<td class="pc-muted">·</td>';
      }).join('')}</tr>`).join('')}</tbody></table></div>` : '';

    // the board's own ladder / distribution widgets (same look as the side panel) carry their own titles
    const kL = kitHTML('ladderHTML', p), kD = kitHTML('distHTML', p);
    const ladderSec = kL ? `<div class="pc-sec pc-kit">${kL}</div>` : sec('Line ladder', 'Model P(over) at every line.', ownLadder(p));
    const distSec = kD ? `<div class="pc-sec pc-kit">${kD}</div>` : sec('Shot distribution', `Probability of each ${UNIT()} count tonight.`, ownDist(p));
    const fac = factorsHTML(p);
    return sec(`Tonight's props <span class="pc-muted" style="letter-spacing:0">(${rows.length})</span>`, 'Every line the market run priced for him — green edge = +EV at that book; only <b>EV play</b> rows go to Discord and the Results tab.', tbl)
      + (matrix ? sec('Every book', 'Price at each book for each priced line (bold = qualifying).', matrix) : '')
      + `<div class="pc-grid2">${ladderSec}${distSec}</div>`
      + sec('What moves the projection', `Base ${f((p.x || {}).lambda_base, 2)} × factors → ${f(p.proj, 2)} projected ${isG() ? 'saves' : 'SOG'}.`, fac);
  }
  function ownLadder(p) {
    return `<table class="pc-t"><thead><tr><th>Line</th><th>P(over)</th><th>Fair O</th><th>Fair U</th></tr></thead><tbody>${linesOf(p).map(L => {
      const v = pOver(p, L); return `<tr><td class="b">${f(L, 1)}</td><td>${pct(v, 1)}</td><td>${odds(fairOdds(v))}</td><td>${odds(fairOdds(v == null ? null : 1 - v))}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  function ownDist(p) {
    const d = p.dist || []; if (!d.length) return '<div class="pc-empty">No distribution.</div>';
    return barChart(d.map((v, i) => ({ v: v * 100, top: v >= 0.005 ? (v * 100).toFixed(0) + '%' : '', l1: String(i), color: i > S.line ? 'var(--green,#1C7444)' : 'var(--border2,#CDC4B0)' })), { h: 170, minW: 360, fmt: v => v.toFixed(0) + '%' });
  }
  function factorsHTML(p) {
    const fs = (p.factors || []).filter(x => ok(x.value));
    const x = p.x || {};
    const extra = [];
    if (ok(x.level_k) && Math.abs(x.level_k - 1) > 1e-4) extra.push({ label: 'LEVEL k', value: x.level_k });
    const all = fs.concat(extra);
    if (!all.length) return '<div class="pc-empty">No multipliers on this projection.</div>';
    return all.map(fc => {
      const d = Number(fc.value) - 1, w = Math.min(Math.abs(d) / 0.15, 1) * 50;
      const col = d >= 0 ? 'var(--green,#1C7444)' : 'var(--red,#AE3328)';
      const pos = d >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      return `<div class="pc-fac"><span>${esc(String(fc.label).replace(/_/g, ' '))}</span><div class="t"><span class="c"></span><span class="f" style="${pos};background:${col}"></span></div><span class="n">×${f(fc.value, 3)}</span></div>`;
    }).join('');
  }

  // ── Role ──────────────────────────────────────────────────────────────────
  function tabRole() {
    if (isG()) return tabWorkload();
    const p = S.p, x = p.x || {};
    const tot = (x.t_ev || 0) + (x.t_pp || 0) + (x.t_sh || 0);
    const seg = (cls, v, lab) => v > 0 && tot > 0 ? `<div class="${cls}" style="flex:${v}" title="${lab} ${mmss(v)}">${v / tot > 0.09 ? `${lab} ${mmss(v)}` : ''}</div>` : '';
    const split = tot > 0 ? `<div class="pc-split">${seg('pc-ev', x.t_ev, 'EV')}${seg('pc-pp', x.t_pp, 'PP')}${seg('pc-sh', x.t_sh, 'SH')}</div>` : '';
    const mini = (k, v, s) => `<div class="pc-mini"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    const minis = `<div class="pc-minis" style="margin-top:14px">
      ${mini('Line slot', ok(x.line_slot) ? (p.pos_group === 'D' || p.pos === 'D' ? 'Pair ' : 'L') + x.line_slot : '–', x.lineup_source ? esc(x.lineup_source) : (x.confirmed ? 'confirmed' : 'projected'))}
      ${mini('PP unit', x.pp_slot ? esc(String(x.pp_slot).toUpperCase()) : (x.pp1 ? 'PP1' : '—'), '')}
      ${mini('SOG / 60', f(x.rate60, 2), 'effective-exposure rate')}
      ${mini('Own data', ok(x.data_share) ? pct(x.data_share) : '–', `${esc(x.n_hist ?? '–')} games vs prior`)}
      ${mini('Dispersion φ', f(x.phi, 1), 'NB2 shape')}
      ${mini('Back-to-back', x.b2b ? 'Yes' : 'No', '')}</div>`;

    const lg = logRows();
    if (!lg.length) return sec('Projected usage tonight', 'Minutes the model expects by game state.', split + minis) + sec('Recent ice time', '', '<div class="pc-empty">No game log for this skater yet.</div>');
    const last = lg.slice(0, 15).reverse();
    const toiChart = stackChart(last.map(r => ({ segs: [[r.ev || 0, 'var(--navy-ink,#14233A)'], [r.pp || 0, 'var(--brass,#A8843F)'], [r.sh || 0, 'var(--border2,#CDC4B0)']], top: mmss(r.toi), l1: (r.home ? '' : '@') + (r.opp || ''), l2: md(r.date) })), { h: 200, ref: x.toi, refLab: 'tonight ' + mmss(x.toi) });
    const hasND = lg.some(r => ok(r.line) || ok(r.pp_unit));
    const dep = `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Date</th><th class="l">Opp</th>${hasND ? '<th>Line</th><th>PP unit</th><th>PP share</th>' : ''}<th>TOI</th><th>EV</th><th>PP</th><th>SH</th><th>Shifts</th>${hasND ? '<th class="l">Linemates</th>' : ''}</tr></thead><tbody>
      ${lg.slice(0, 12).map(r => `<tr><td>${md(r.date)}</td><td class="l">${r.home ? 'vs' : '@'} ${esc(r.opp)}</td>
        ${hasND ? `<td>${ok(r.line) ? 'L' + r.line : '–'}</td><td>${ok(r.pp_unit) && r.pp_unit > 0 ? 'PP' + r.pp_unit : '–'}</td><td>${pct(r.pp_share)}</td>` : ''}
        <td class="b">${mmss(r.toi)}</td><td>${mmss(r.ev)}</td><td>${mmss(r.pp)}</td><td>${mmss(r.sh)}</td><td>${esc(r.shifts ?? '–')}</td>
        ${hasND ? `<td class="l pc-muted" style="white-space:normal;min-width:180px">${esc(r.mates || '')}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    const cur = scoped('cur').filter(r => ok(r.toi));
    const sum = k => cur.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const gp = cur.length, toi = sum('toi');
    const seasonMinis = gp ? `<div class="pc-minis">
      ${mini('TOI / GP', mmss(toi / gp), `${gp} GP this season`)}${mini('PP TOI / GP', mmss(sum('pp') / gp), '')}
      ${mini('SOG / 60', toi ? f(sum('sog') / toi * 60, 2) : '–', 'all situations')}
      ${mini('Attempts / GP', f(sum('att') / gp, 1), '')}${mini('SOG / attempt', sum('att') ? pct(sum('sog') / sum('att')) : '–', 'on-target rate')}
      ${hasND ? mini('PP1 games', `${cur.filter(r => r.pp_unit === 1).length}/${gp}`, '') : ''}</div>` : '<div class="pc-empty">No games yet this season.</div>';
    return `<div class="pc-grid2">${sec('Projected usage tonight', 'Minutes the model expects by game state.', split + minis)}${sec('This season', '', seasonMinis)}</div>`
      + sec('Recent ice time', 'Last 15 games — navy EV, brass PP, grey SH; dashed line is tonight\'s projected TOI.', `<div class="pc-tw">${toiChart}</div>`)
      + sec('Deployment log', hasND ? 'Line, PP unit and linemates from NHL_Data shift charts.' : 'Line / PP-unit detail appears once NHL_Data is on the Pi.', dep);
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  function tabForm() {
    const L = S.line, lg = logRows();
    if (!lg.length) return lineChips(true) + '<div class="pc-empty">No games logged for this player yet.</div>';
    const both = starts(scoped('both'));
    const mini = (lab, rr) => `<div class="pc-mini"><div class="k">${lab}</div><div class="v">${rr ? pct(rr.pct) : '–'}</div><div class="s">${rr ? `${rr.over}/${rr.n} over · avg ${f(rr.avg, 1)}` : 'no games'}</div></div>`;
    const minis = `<div class="pc-minis">${mini('Last 5', rate(both.slice(0, 5), L))}${mini('Last 10', rate(both.slice(0, 10), L))}${mini('Last 20', rate(both.slice(0, 20), L))}${mini('This season', rate(scoped('cur'), L))}${mini('Last season', rate(scoped('prev'), L))}</div>`;
    const last = both.slice(0, 20).reverse();
    const chart = barChart(last.map(r => ({
      v: stat(r) || 0, top: String(stat(r) ?? '–'), l1: (r.home ? '' : '@') + (r.opp || ''), l2: md(r.date),
      color: stat(r) > L ? 'var(--green,#1C7444)' : 'var(--red,#AE3328)', op: stat(r) > L ? 0.9 : (r.pulled ? 0.3 : 0.55), mark: r.proj
    })), { h: 220, ref: L, refLab: 'line ' + f(L, 1), minW: 560 });
    const opp = S.p.opp;
    const split = (isG() ? [
      ['Home', both.filter(r => r.home)], ['Away', both.filter(r => !r.home)],
      [`vs ${esc(opp || '—')}`, both.filter(r => r.opp === opp)],
      ...(both.some(r => r.dec) ? [['Won', both.filter(r => r.dec === 'W')], ['Lost (incl. OT)', both.filter(r => r.dec === 'L' || r.dec === 'O')]] : []),
      ['Played it out', both.filter(r => !r.pulled)], ['Pulled / left early', both.filter(r => r.pulled)],
    ] : [
      ['Home', both.filter(r => r.home)], ['Away', both.filter(r => !r.home)],
      [`vs ${esc(opp || '—')}`, both.filter(r => r.opp === opp)],
      ['PP time ≥ 2:00', both.filter(r => (r.pp || 0) >= 2)], ['PP time < 2:00', both.filter(r => (r.pp || 0) < 2)],
      ['TOI ≥ 18:00', both.filter(r => (r.toi || 0) >= 18)], ['TOI < 18:00', both.filter(r => ok(r.toi) && r.toi < 18)],
    ]).map(([lab, rr]) => { const x = rate(rr, L); return `<tr><td>${lab}</td><td>${x ? x.n : 0}</td><td class="b">${x ? f(x.avg, 2) : '–'}</td><td>${x ? pct(x.pct) : '–'}</td><td>${x && ok(x.att) ? f(x.att, 1) : '–'}</td></tr>`; }).join('');
    return lineChips(true) + minis
      + sec(`Last ${last.length} ${isG() ? 'starts' : 'games'} vs ${f(L, 1)}`, 'Green = went over, red = stayed under; ◆ = what we projected that day.' + (isG() ? ' Faded red = pulled or left early. Relief appearances are left out.' : ''), `<div class="pc-tw">${chart}</div>`)
      + sec('Splits', 'This season and last, against the selected line.', `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Split</th><th>${isG() ? 'GS' : 'GP'}</th><th>Avg ${UNIT()}</th><th>Over ${f(L, 1)}</th><th>${isG() ? 'Avg SA' : 'Attempts'}</th></tr></thead><tbody>${split}</tbody></table></div>`);
  }

  // ── Log ───────────────────────────────────────────────────────────────────
  function tabLog() {
    if (isG()) return tabLogG();
    const L = S.line;
    const chips = `<div class="pc-chiprow"><span class="lbl">Season</span>${[['cur', 'This season'], ['prev', 'Last season'], ['both', 'Both']].map(([k, l]) => `<button type="button" class="pc-chip" data-a="scope" data-v="${k}" aria-pressed="${S.scope === k}">${l}</button>`).join('')}</div>`;
    const rows = scoped(S.scope);
    if (!rows.length) return chips + lineChips(false) + '<div class="pc-empty">No games logged for this span.</div>';
    const hasND = rows.some(r => ok(r.line) || ok(r.pp_unit));
    let lastSeason = null;
    const body = rows.map(r => {
      let div = '';
      if (S.scope === 'both' && r.season !== lastSeason) { lastSeason = r.season; div = `<tr class="pc-div"><td colspan="${hasND ? 17 : 15}">${r.season === 'cur' ? 'This season' : 'Last season'}</td></tr>`; }
      const res = ok(r.sog) ? (r.sog > L ? '<span class="pc-hit">O</span>' : '<span class="pc-miss">U</span>') : '–';
      return div + `<tr><td>${md(r.date)}</td><td class="l">${r.home ? 'vs' : '@'} ${esc(r.opp)}</td><td>${mmss(r.toi)}</td><td>${mmss(r.ev)}</td><td>${mmss(r.pp)}</td><td>${mmss(r.sh)}</td>
        ${hasND ? `<td>${ok(r.line) ? 'L' + r.line : '–'}</td><td>${ok(r.pp_unit) && r.pp_unit > 0 ? r.pp_unit : '–'}</td>` : ''}
        <td>${r.att ?? '–'}</td><td class="b">${r.sog ?? '–'}</td><td>${r.g ?? '–'}</td><td>${r.a ?? '–'}</td><td>${r.hits ?? '–'}</td><td>${r.blk ?? '–'}</td><td>${r.pim ?? '–'}</td>
        <td>${f(r.proj, 2)}</td><td>${res}</td></tr>`;
    }).join('');
    return chips + lineChips(false) + sec('Game log', `Every stored game, newest first. O/U is against ${f(L, 1)}; Proj is what the model said that day.`,
      `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Date</th><th class="l">Opp</th><th>TOI</th><th>EV</th><th>PP</th><th>SH</th>${hasND ? '<th>Line</th><th>PPU</th>' : ''}<th>Att</th><th>SOG</th><th>G</th><th>A</th><th>Hits</th><th>Blk</th><th>PIM</th><th>Proj</th><th>${f(L, 1)}</th></tr></thead><tbody>${body}</tbody></table></div>`);
  }

  // ── History ───────────────────────────────────────────────────────────────
  function tabHistory() {
    const d = S.data || {}, a = d.accuracy, ps = d.plays_summary;
    const mini = (k, v, s, cls = '') => `<div class="pc-mini"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    const model = `<div class="pc-minis">
      ${mini('Projections graded', a ? a.n : '0', 'this season + last')}
      ${mini('MAE', a ? f(a.mae, 2) : '–', `${UNIT()} per ${isG() ? 'start' : 'game'}`)}
      ${mini('Bias', a ? sg(a.bias, 2) : '–', a ? (a.bias > 0 ? 'we run high on him' : 'we run low on him') : '')}
      ${mini('Avg proj / actual', a ? `${f(a.proj_mean, 2)} / ${f(a.actual_mean, 2)}` : '–', '')}
      ${mini('EV plays', ps ? `${ps.w}-${ps.l}${ps.p ? '-' + ps.p : ''}` : '0', 'qualifying, settled')}
      ${mini('Units', ps ? sg(ps.units, 2) + 'u' : '–', ps && ok(ps.roi) ? `ROI ${sg(ps.roi * 100, 1)}%` : 'flat 1u', ps ? (ps.units >= 0 ? 'pc-pos-ev' : 'pc-red') : '')}
      ${mini('CLV', ps && ok(ps.clv) ? sg(ps.clv, 1) + '%' : '–', 'avg vs close')}</div>`;
    const acc = starts(logRows()).filter(r => ok(r.proj) && ok(stat(r))).slice(0, 25).reverse();
    const accChart = acc.length ? barChart(acc.map(r => ({ v: stat(r), top: String(stat(r)), l1: (r.home ? '' : '@') + (r.opp || ''), l2: md(r.date), color: 'var(--border2,#CDC4B0)', op: 1, mark: r.proj })), { h: 200, minW: 520 }) : '<div class="pc-empty">No graded projections for him yet.</div>';
    const plays = d.plays || [];
    const ptbl = plays.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Date</th><th class="l">Play</th><th>Price</th><th>EV</th><th>Proj</th><th>${UNIT()}</th><th>Result</th><th>Units</th><th>CLV</th></tr></thead><tbody>
      ${plays.map(r => `<tr><td>${md(r.date)}</td><td class="l b">${String(r.side).toUpperCase() === 'OVER' ? 'Over' : 'Under'} ${f(r.line, 1)}</td><td>${odds(r.odds)} <span class="pc-muted">${esc(bookName(r.book))}</span></td>
        <td class="pc-pos-ev">${sg(r.ev_pct, 1)}%</td><td>${f(r.proj, 2)}</td><td class="b">${r.actual ?? '–'}</td>
        <td>${r.result === 'win' ? '<span class="pc-pill g">W</span>' : r.result === 'loss' ? '<span class="pc-pill r">L</span>' : '<span class="pc-pill">P</span>'}</td>
        <td class="${(r.units || 0) >= 0 ? 'pc-pos-ev' : 'pc-red'}"><b>${sg(r.units, 2)}</b></td><td class="${evCls(r.clv_pct)}">${ok(r.clv_pct) ? sg(r.clv_pct, 1) + '%' : '–'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="pc-empty">No qualifying EV plays on him have settled yet.</div>';
    const car = ((d.bio || {}).career) || [];
    const ctbl = car.length && isG() ? careerG(car) : car.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Season</th><th class="l">Team</th><th>GP</th><th>G</th><th>A</th><th>P</th><th>SOG</th><th>SOG/GP</th><th>SH%</th><th>TOI</th></tr></thead><tbody>
      ${car.map(s => `<tr><td>${esc(String(s.season).slice(0, 4) + '-' + String(s.season).slice(6, 8))}</td><td class="l">${esc(s.team)}</td><td>${s.gp ?? '–'}</td><td>${s.g ?? '–'}</td><td>${s.a ?? '–'}</td><td>${s.pts ?? '–'}</td><td>${s.shots ?? '–'}</td><td class="b">${f(s.sog_pg, 2)}</td><td>${ok(s.sh_pct) ? pct(s.sh_pct, 1) : '–'}</td><td>${esc(s.toi || '–')}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="pc-empty">${d.sources && d.sources.nhl_api === false ? 'NHL API didn\'t answer — career table will fill in on the next open.' : 'No NHL seasons on record.'}</div>`;
    return sec('Our model on him', 'Projection accuracy from the game log; plays are qualifying EV plays only (flat 1u), one per player/line/side.', model)
      + sec('Projected vs actual', `Bars = actual ${UNIT()}, ◆ = our projection that day (last 25 graded ${isG() ? 'starts' : 'games'}).`, `<div class="pc-tw">${accChart}</div>`)
      + sec(`Graded EV plays <span class="pc-muted" style="letter-spacing:0">(${plays.length})</span>`, '', ptbl)
      + sec('Career — NHL regular season', '', ctbl);
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  function tabSchedule() {
    const s = (S.data && S.data.schedule) || [];
    if (!s.length) return sec('Upcoming', '', `<div class="pc-empty">${S.data && S.data.sources && S.data.sources.nhl_api === false ? 'NHL API didn\'t answer — try again in a few minutes.' : 'No upcoming games found.'}</div>`);
    const both = starts(scoped('both'));
    const L = S.line;
    const rows = s.map(g => {
      const vs = both.filter(r => r.opp === g.opp); const x = rate(vs, L);
      const d = g.start_utc ? new Date(g.start_utc) : null;
      return `<tr><td>${d ? d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) : md(g.date)}</td><td>${d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–'}</td>
        <td class="l b">${g.home ? 'vs' : '@'} ${esc(g.opp)}</td><td>${x ? x.n : 0}</td><td>${x ? f(x.avg, 2) : '–'}</td><td>${x ? `${x.over}/${x.n}` : '–'}</td></tr>`;
    }).join('');
    return sec('Upcoming', `His recent history vs each opponent (this season + last), against ${f(L, 1)}.`,
      `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Date</th><th>Time</th><th class="l">Opponent</th><th>Met</th><th>Avg ${UNIT()}</th><th>Over ${f(L, 1)}</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }

  // ── goalie views ──────────────────────────────────────────────────────────
  function tabWorkload() {
    const p = S.p, x = p.x || {};
    const mini = (k, v, sub) => `<div class="pc-mini"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const st = p.status || {};
    const tonight = `<div class="pc-minis">
      ${mini('Starter', esc(st.label || '—'), esc(String(x.starter_source || '').replace(/_/g, ' ')))}
      ${mini('Proj. SA', f(x.sa, 1), `SA/60 ${f(x.sa60, 1)}`)}
      ${mini('Save % used', ok(x.sv_pct) ? f(x.sv_pct * 100, 1) : '–', `league ${ok(x.lg_sv) ? f(x.lg_sv * 100, 1) : '–'} · ${ok(x.sv_shots) ? Math.round(x.sv_shots) : '–'} shots`)}
      ${mini('P(win)', pct(x.p_win), 'from the moneyline')}
      ${mini('P(pulled)', pct(x.p_pull, 1), ok(x.pull_frac) ? `pulled start ≈ ${pct(x.pull_frac)} of a full night` : '')}
      ${mini('Starts in sample', esc(x.n_starts ?? '–'), '')}
      ${mini('Dispersion φ', f(x.phi, 1), 'NB2 shape')}
      ${mini('Back-to-back', x.b2b ? 'Yes' : 'No', '')}</div>`;
    const lg = logRows();
    if (!lg.length) return sec('Tonight', 'What the saves model assumes.', tonight) + sec('Recent workload', '', '<div class="pc-empty">No starts logged for this goalie yet.</div>');
    const last = starts(lg).slice(0, 15).reverse();
    const chart = stackChart(last.map(r => ({ segs: [[r.sv || 0, 'var(--navy-ink,#14233A)'], [r.ga || 0, 'var(--red,#AE3328)']], top: String(r.sa ?? '–'), l1: (r.home ? '' : '@') + (r.opp || ''), l2: md(r.date) })), { h: 210, ref: x.sa, refLab: 'tonight ' + f(x.sa, 1) + ' SA', fmt: v => String(v) });
    const cur = starts(scoped('cur'));
    const sum = k => cur.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const gs = cur.length, gp = scoped('cur').length;
    const toi = sum('toi');
    const season = gs ? `<div class="pc-minis">
      ${mini('Starts', `${gs}${gp > gs ? ` <span style="font-size:13px" class="pc-muted">+${gp - gs} relief</span>` : ''}`, '')}
      ${mini('Record', cur.some(r => r.dec) ? `${cur.filter(r => r.dec === 'W').length}-${cur.filter(r => r.dec === 'L').length}-${cur.filter(r => r.dec === 'O').length}` : '–', 'W-L-OT')}
      ${mini('SA / start', f(sum('sa') / gs, 1), toi ? `SA/60 ${f(sum('sa') / toi * 60, 1)}` : '')}
      ${mini('Saves / start', f(sum('sv') / gs, 1), '')}
      ${mini('Save %', sum('sa') ? f(sum('sv') / sum('sa') * 100, 1) : '–', '')}
      ${mini('Pulled', String(cur.filter(r => r.pulled).length), 'starts ended early')}</div>` : '<div class="pc-empty">No starts yet this season.</div>';
    return `<div class="pc-grid2">${sec('Tonight', 'What the saves model assumes for this start.', tonight)}${sec('This season', '', season)}</div>`
      + sec('Recent workload', 'Last 15 starts — navy = saves, red = goals against, number on top = shots against; dashed line is tonight\'s projected SA.', `<div class="pc-tw">${chart}</div>`);
  }
  function tabLogG() {
    const L = S.line;
    const chips = `<div class="pc-chiprow"><span class="lbl">Season</span>${[['cur', 'This season'], ['prev', 'Last season'], ['both', 'Both']].map(([k, l]) => `<button type="button" class="pc-chip" data-a="scope" data-v="${k}" aria-pressed="${S.scope === k}">${l}</button>`).join('')}</div>`;
    const rows = scoped(S.scope);
    if (!rows.length) return chips + lineChips(false) + '<div class="pc-empty">No games logged for this span.</div>';
    let lastSeason = null;
    const body = rows.map(r => {
      let div = '';
      if (S.scope === 'both' && r.season !== lastSeason) { lastSeason = r.season; div = `<tr class="pc-div"><td colspan="11">${r.season === 'cur' ? 'This season' : 'Last season'}</td></tr>`; }
      const res = !r.gs ? '<span class="pc-muted">relief</span>' : ok(r.sv) ? (r.sv > L ? '<span class="pc-hit">O</span>' : '<span class="pc-miss">U</span>') : '–';
      return div + `<tr><td>${md(r.date)}</td><td class="l">${r.home ? 'vs' : '@'} ${esc(r.opp)}</td><td>${r.gs ? 'GS' : '—'}${r.pulled ? ' <span class="pc-pill y">pulled</span>' : ''}</td><td>${esc(r.dec || '–')}</td>
        <td>${mmss(r.toi)}</td><td>${r.sa ?? '–'}</td><td class="b">${r.sv ?? '–'}</td><td>${r.ga ?? '–'}</td><td>${ok(r.svp) ? f(r.svp * 100, 1) : '–'}</td><td>${f(r.proj, 1)}</td><td>${res}</td></tr>`;
    }).join('');
    return chips + lineChips(false) + sec('Game log', `Every appearance, newest first. O/U is against ${f(L, 1)} saves (starts only); Proj is what the saves model said that day.`,
      `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Date</th><th class="l">Opp</th><th>Start</th><th>Dec</th><th>TOI</th><th>SA</th><th>SV</th><th>GA</th><th>SV%</th><th>Proj</th><th>${f(L, 1)}</th></tr></thead><tbody>${body}</tbody></table></div>`);
  }
  function careerG(car) {
    return `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Season</th><th class="l">Team</th><th>GP</th><th>GS</th><th>W-L-OT</th><th>SA</th><th>SA/GP</th><th>SV%</th><th>GAA</th><th>SO</th></tr></thead><tbody>
      ${car.map(s => `<tr><td>${esc(String(s.season).slice(0, 4) + '-' + String(s.season).slice(6, 8))}</td><td class="l">${esc(s.team)}</td><td>${s.gp ?? '–'}</td><td>${s.gs ?? '–'}</td>
        <td>${s.w ?? 0}-${s.l ?? 0}-${s.otl ?? 0}</td><td>${s.sa ?? '–'}</td><td class="b">${s.sa != null && s.gp ? f(s.sa / s.gp, 1) : '–'}</td>
        <td>${ok(s.svp) ? f(s.svp * 100, 1) : '–'}</td><td>${f(s.gaa, 2)}</td><td>${s.so ?? '–'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ── tiny SVG charts ───────────────────────────────────────────────────────
  function frame(n, o) {
    const padR = ok(o.ref) ? 78 : 10, W = Math.max(o.minW || 480, n * 50 + 40 + padR), H = o.h || 200, padL = 30, padT = 18, padB = 36;
    return { W, H, padL, padR, padT, padB, iw: W - padL - padR, ih: H - padT - padB };
  }
  function axis(F, max, fmt) {
    const ticks = []; const stepV = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : Math.ceil(max / 5);
    for (let v = 0; v <= max + 1e-9; v += stepV) {
      const y = F.padT + F.ih - (v / max) * F.ih;
      ticks.push(`<line x1="${F.padL}" x2="${F.W - F.padR}" y1="${y}" y2="${y}" style="stroke:var(--border,#E4DED1)" stroke-width="1"/><text x="${F.padL - 6}" y="${y + 3.5}" text-anchor="end" font-size="10">${fmt ? fmt(v) : v}</text>`);
    }
    return ticks.join('');
  }
  function barChart(bars, o = {}) {
    const n = bars.length; if (!n) return '';
    const F = frame(n, o);
    const vals = bars.map(b => Number(b.v) || 0).concat(bars.map(b => Number(b.mark) || 0)).concat([Number(o.ref) || 0]);
    const max = Math.max(1, Math.ceil(Math.max(...vals) * 1.15));
    const bw = F.iw / n, w = Math.min(26, bw * 0.68);
    const y = v => F.padT + F.ih - (v / max) * F.ih;
    let s = axis(F, max, o.fmt);
    bars.forEach((b, i) => {
      const cx = F.padL + bw * i + bw / 2, v = Number(b.v) || 0, top = y(v);
      s += `<rect x="${cx - w / 2}" y="${top}" width="${w}" height="${Math.max(0, F.padT + F.ih - top)}" rx="3" style="fill:${b.color || 'var(--navy-ink,#14233A)'};opacity:${b.op ?? 1}"><title>${esc(b.l2 || '')} ${esc(b.l1 || '')}: ${esc(b.top || v)}</title></rect>`;
      const myy = ok(b.mark) ? y(Number(b.mark)) : null;
      const ly = myy != null && Math.abs(myy - top) < 14 ? Math.min(top, myy - 6) - 4 : top - 4;
      if (b.top) s += `<text x="${cx}" y="${ly}" text-anchor="middle" font-size="10" font-weight="600" style="fill:var(--bright,#101C2E)">${esc(b.top)}</text>`;
      if (ok(b.mark)) { const my = myy; s += `<path d="M${cx} ${my - 5}L${cx + 5} ${my}L${cx} ${my + 5}L${cx - 5} ${my}Z" style="fill:var(--brass,#A8843F);stroke:var(--card,#fff)" stroke-width="1.5"><title>projected ${f(b.mark, 2)}</title></path>`; }
      if (b.l1) s += `<text x="${cx}" y="${F.H - 20}" text-anchor="middle" font-size="10" font-weight="600">${esc(b.l1)}</text>`;
      if (b.l2) s += `<text x="${cx}" y="${F.H - 7}" text-anchor="middle" font-size="9">${esc(b.l2)}</text>`;
    });
    if (ok(o.ref)) { const ry = y(Number(o.ref)); s += `<line x1="${F.padL}" x2="${F.W - F.padR}" y1="${ry}" y2="${ry}" style="stroke:var(--bright,#101C2E)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${F.W - F.padR + 6}" y="${ry + 3.5}" text-anchor="start" font-size="10" font-weight="600" style="fill:var(--bright,#101C2E)">${esc(o.refLab || '')}</text>`; }
    return `<svg class="pc-chart" viewBox="0 0 ${F.W} ${F.H}" style="min-width:${Math.min(F.W, o.minW || 480)}px;max-width:${F.W}px;margin:0 auto" role="img">${s}</svg>`;
  }
  function stackChart(bars, o = {}) {
    const n = bars.length; if (!n) return '';
    const F = frame(n, o);
    const tot = bars.map(b => b.segs.reduce((s, x) => s + (Number(x[0]) || 0), 0));
    const max = Math.max(5, Math.ceil(Math.max(...tot, Number(o.ref) || 0) * 1.12 / 5) * 5);
    const bw = F.iw / n, w = Math.min(26, bw * 0.68);
    const y = v => F.padT + F.ih - (v / max) * F.ih;
    let s = axis(F, max, o.fmt || (v => v + "'"));
    bars.forEach((b, i) => {
      const cx = F.padL + bw * i + bw / 2; let acc = 0;
      b.segs.forEach(([v, col]) => { v = Number(v) || 0; if (v <= 0) return; const y1 = y(acc + v), y0 = y(acc); s += `<rect x="${cx - w / 2}" y="${y1}" width="${w}" height="${Math.max(0, y0 - y1)}" style="fill:${col}"/>`; acc += v; });
      s += `<text x="${cx}" y="${y(acc) - 4}" text-anchor="middle" font-size="9.5" font-weight="600" style="fill:var(--bright,#101C2E)">${esc(b.top)}</text>`;
      s += `<text x="${cx}" y="${F.H - 20}" text-anchor="middle" font-size="10" font-weight="600">${esc(b.l1)}</text><text x="${cx}" y="${F.H - 7}" text-anchor="middle" font-size="9">${esc(b.l2)}</text>`;
    });
    if (ok(o.ref)) { const ry = y(Number(o.ref)); s += `<line x1="${F.padL}" x2="${F.W - F.padR}" y1="${ry}" y2="${ry}" style="stroke:var(--bright,#101C2E)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${F.W - F.padR + 6}" y="${ry + 3.5}" text-anchor="start" font-size="10" font-weight="600" style="fill:var(--bright,#101C2E)">${esc(o.refLab || '')}</text>`; }
    return `<svg class="pc-chart" viewBox="0 0 ${F.W} ${F.H}" style="min-width:${Math.min(F.W, o.minW || 480)}px;max-width:${F.W}px;margin:0 auto" role="img">${s}</svg>`;
  }

  // ── hook into the kit ─────────────────────────────────────────────────────
  const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>';
  function addButton() {
    const ds = document.querySelector('#d-content .ds');
    if (!ds || ds.querySelector('.pc-open-btn')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pc-open-btn'; b.title = 'Open the full player card (F)';
    b.innerHTML = ICON + 'Full card';
    b.addEventListener('click', e => { e.stopPropagation(); open(S.last); });
    ds.appendChild(b);
  }
  function hook() {
    const orig = window.showDetail;
    if (typeof orig !== 'function') return false;
    if (orig.__pcard) return true;
    const wrapped = function (p) {
      const r = orig.apply(this, arguments);
      try {
        if (p && p.id != null) {
          S.last = p; addButton();
          if (S.open) open(p);
        }
      } catch (e) { console.warn('[pcard]', e); }
      return r;
    };
    wrapped.__pcard = true;
    window.showDetail = wrapped;
    return true;
  }
  function init() {
    build();
    let tries = 0;
    (function retry() { if (!hook() && ++tries < 50) setTimeout(retry, 200); })();
    if (location.hash === '#card') { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* noop */ } }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.pcard = { open: p => open(p || S.last), close: () => close(), version: '1.1.1' };
})();
