/* pcard.js — WhizShap full-screen player card (v1.0.0) — the NFL twin of Hawkey's hawkey/static/pcard/pcard.js
 *
 * Plugs into the shared props board without changing it:
 *   - wraps the board's showDetail(p) so the side panel gets a "Full card" button
 *   - double-click a row (or press F with a row selected) to open the card
 *   - ← / → step through the board in its current sort/filter order, Esc or the browser Back button closes
 * This week's numbers come from the same player object the side panel uses (p); history comes from
 * GET {API}/api/wk/player/<id> (blitz/pcard_api.py), loaded when the card opens.
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
  const fairOdds = p => !ok(p) || p <= 0 || p >= 1 ? null : (p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
  const evCls = v => !ok(v) ? '' : (v > 0 ? 'pc-pos-ev' : 'pc-neg-ev');
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const wkl = r => (r.post ? 'P' : 'W') + r.week;
  const spreadTxt = sp => !ok(sp) ? '–' : (+sp === 0 ? 'pick' : (+sp > 0 ? `fav ${f(Math.abs(sp), 1)}` : `dog ${f(Math.abs(sp), 1)}`));
  const NOTE = {};

  // ── state from the board's player object ─────────────────────────────────
  const linesOf = p => Object.keys(p.lines || {}).map(Number).filter(x => !Number.isNaN(x)).sort((a, b) => a - b);
  function primaryLine(p) {
    if (p._primary && ok(p._primary.line)) return Number(p._primary.line);
    const ls = linesOf(p); if (!ls.length) return 4.5;
    const c = Math.floor(p.proj || 4) + 0.5;
    return ls.reduce((b, x) => Math.abs(x - c) < Math.abs(b - c) ? x : b, ls[0]);
  }
  const rowsOf = p => (p._rows || []).slice();
  function bestAt(p, side, line) {
    const r = rowsOf(p).filter(r => String(r.side).toLowerCase() === side && Number(r.line) === Number(line));
    return r.sort((a, b) => (b.ev_pct ?? -99) - (a.ev_pct ?? -99))[0] || null;
  }
  const pOver = (p, line) => { const v = (p.lines || {})[String(line)] ?? (p.lines || {})[Number(line).toFixed(1)]; return ok(v) ? Number(v) : null; };

  // ── log helpers (stat = combined tackles) ─────────────────────────────────
  const logRows = () => (S.data && S.data.log) || [];
  const scoped = sc => logRows().filter(r => sc === 'both' || r.scope === sc);
  const games = rows => rows.filter(r => r.def_game && ok(r.tck));          // defensive snaps > 0 — the games a prop is about
  function rate(rows, line) {
    const g = games(rows);
    if (!g.length) return null;
    const over = g.filter(r => r.tck > line).length;
    return { n: g.length, over, pct: over / g.length, avg: avg(g.map(r => +r.tck)), snaps: avg(g.filter(r => ok(r.snaps)).map(r => +r.snaps)) };
  }

  // ── DOM scaffolding ───────────────────────────────────────────────────────
  let ov, topEl, wrap;
  function build() {
    ov = document.createElement('div');
    ov.id = 'pcard'; ov.hidden = true; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = `
      <div class="pc-top">
        <button type="button" data-a="close" title="Back to the board (Esc)">&larr; Board</button>
        <span class="pc-crumb">WhizShap &middot; <b>Player card</b></span>
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
  const selIdx = () => boardRows().findIndex(t => t.classList.contains('sel'));
  function step(d) {
    const r = boardRows(); const i = selIdx();
    const j = i + d;
    if (i < 0 || j < 0 || j >= r.length) return;
    r[j].click();                       // the board's own handler calls showDetail(p) -> we follow
    r[j].scrollIntoView({ block: 'nearest' });
  }
  function posLabel() {
    const r = boardRows(); const i = S.fromBoard ? selIdx() : -1;
    topEl.querySelector('[data-r=pos]').textContent = i >= 0 ? `${i + 1} / ${r.length}` : '';
    topEl.querySelector('[data-a=prev]').disabled = i <= 0;
    topEl.querySelector('[data-a=next]').disabled = i < 0 || i >= r.length - 1;
  }

  // ── open / close ──────────────────────────────────────────────────────────
  function open(p, opts = {}) {
    if (!p) return;
    const same = S.pid === String(p.id);
    S.p = p; S.pid = String(p.id); S.fromBoard = opts.fromBoard !== false;
    if (opts.tab) S.tab = opts.tab;
    if (!same) { S.line = opts.line != null ? Number(opts.line) : primaryLine(p); S.data = null; S.err = null; }
    else if (opts.line != null) S.line = Number(opts.line);
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
    if (!S.open) {
      const onBoard = document.getElementById('page-projections')?.classList.contains('active');
      if ((e.key === 'f' || e.key === 'F') && S.last && onBoard) { e.preventDefault(); open(S.last); }
      return;
    }
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
      const q = new URLSearchParams({ name: p.name || '', team: p.team || '' });
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
    wrap.innerHTML = `<div class="pc-hero" data-r="hero"></div><div class="pc-strip" data-r="strip"></div>
      <div class="pc-tabs" role="tablist" data-r="tabs"></div><div class="pc-body" data-r="body"></div>`;
    renderHero(); renderStrip(); renderBody();
  }
  const $ = r => wrap.querySelector(`[data-r=${r}]`);

  function nextGame() { const s = (S.data && S.data.schedule) || []; return s[0] || null; }
  function whenText(g) {
    if (!g || !g.kickoff) return '';
    const d = new Date(g.kickoff);
    return `Week ${g.week} · ` + d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' · ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderHero() {
    const p = S.p, b = (S.data && S.data.bio) || {};
    const shot = b.headshot ? `<img src="${esc(b.headshot)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${esc(initials(p.name))}'}))">`
      : `<span>${esc(initials(p.name))}</span>`;
    const st = p.status || {};
    const stCls = /out/i.test(st.kind || '') ? 'r' : /q/i.test(st.kind || '') ? 'y' : 'g';
    const chips = [(st.label ? `<span class="pc-pill ${stCls}">${esc(st.label)}</span>` : ''),
      (p.overridden ? `<span class="pc-pill v">✎ override</span>` : ''),
      (p._hasEv ? `<span class="pc-pill g">EV play</span>` : '')]
      .concat((p.chips || []).map(c => `<span class="pc-pill ${c.kind === 'brass' ? 'b' : ''}">${esc(c.label)}</span>`)).join('');
    const age = b.birth_date ? Math.floor((Date.now() - new Date(b.birth_date)) / 31557600000) : null;
    const bio = [b.height, b.weight ? `${b.weight} lb` : '', age ? `Age ${age}` : '', b.college ? esc(b.college) : '',
      b.draft ? `Draft ${b.draft}` : '', ok(b.exp) ? (b.exp > 0 ? `${b.exp} yr exp` : 'Rookie') : ''].filter(Boolean).join(' · ');
    const g = nextGame();
    $('hero').innerHTML = `
      <div class="pc-shot">${shot}</div>
      <div style="min-width:0">
        <div class="pc-name" role="heading" aria-level="1">${esc(p.name)}</div>
        <div class="pc-sub"><b>${esc(p.pos || '')}</b>${p.pos_group && p.pos_group !== p.pos ? `<span class="pc-dot">·</span>${esc(p.pos_group)}` : ''}<span class="pc-dot">·</span>${esc(p.team || '')}
          ${ok(b.number) ? `<span class="pc-dot">·</span>#${esc(b.number)}` : ''}
          ${ok(p.gp) && p.gp > 0 ? `<span class="pc-dot">·</span>${esc(p.gp)} games in model` : ''}</div>
        <div class="pc-bio">${bio || (S.data ? '' : '&nbsp;')}</div>
      </div>
      <div class="pc-game">
        <div class="pc-match">${esc(p.matchup || '')}</div>
        <div class="pc-when">${esc(whenText(g))}${p.x && ok(p.x.spread) ? ` · ${esc(spreadTxt(p.x.spread))} · total ${f(p.x.total, 1)}` : ''}</div>
        <div class="pc-chips">${chips}</div>
      </div>`;
  }

  function renderStrip() {
    const p = S.p, x = p.x || {}, L = S.line;
    const o = bestAt(p, 'over', L), u = bestAt(p, 'under', L);
    const po = pOver(p, L);
    const cur = rate(scoped('cur'), L), l10 = rate(games(scoped('both')).slice(0, 10), L);
    const priceTile = (lab, r) => `<div class="pc-tile"><div class="pc-tl">${lab} ${f(L, 1)}</div>
      <div class="pc-tv">${r && ok(r.odds) ? odds(r.odds) : '–'}</div>
      <div class="pc-ts">${r ? `${esc(r.book || '')} · <b class="${evCls(r.ev_pct)}">EV ${sg(r.ev_pct, 1)}%</b>${r.qualifies ? ' · <b class="pc-pos-ev">play</b>' : ''}` : 'not priced'}</div></div>`;
    const snaps = ok(x.exp_plays) && ok(x.share) ? x.exp_plays * x.share : null;
    $('strip').innerHTML = `
      <div class="pc-tile lead"><div class="pc-tl">Our projection · tackles</div>
        <div class="pc-tv">${f(p.proj, 2)}</div>
        <div class="pc-ts">median ${f(p.med, 0)} · P10–P90 ${f(p.p10, 0)}–${f(p.p90, 0)}${p.overridden ? ` · <b>override</b> (model ${f(p.lambda_model, 2)})` : ''}</div></div>
      <div class="pc-tile"><div class="pc-tl">Line ${f(L, 1)}</div>
        <div class="pc-tv">${pct(po, 0)} <span style="font-size:13px" class="pc-muted">over</span></div>
        <div class="pc-ts">fair ${odds(fairOdds(po))} / ${odds(fairOdds(po == null ? null : 1 - po))}</div></div>
      ${priceTile('Best over', o)}${priceTile('Best under', u)}
      <div class="pc-tile"><div class="pc-tl">Proj. snaps</div><div class="pc-tv">${f(snaps, 0)}</div>
        <div class="pc-ts">${f(x.exp_plays, 1)} opp plays × ${pct(x.share)} share · ${f(x.tps, 3)} TCK/snap</div></div>
      <div class="pc-tile"><div class="pc-tl">Form vs ${f(L, 1)}</div>
        <div class="pc-tv">${l10 ? `${l10.over}/${l10.n}` : (S.data ? '–' : '…')}</div>
        <div class="pc-ts">${l10 ? `last ${l10.n} · avg ${f(l10.avg, 1)}` : 'last 10'}${cur ? ` · season ${pct(cur.pct)}` : ''}</div></div>`;
  }

  function renderBody() {
    const counts = { props: rowsOf(S.p).length, log: games(scoped('cur')).length, history: ((S.data && S.data.plays_summary && S.data.plays_summary.n) || 0) + ((S.data && S.data.pending && S.data.pending.length) || 0), schedule: ((S.data && S.data.schedule) || []).length };
    $('tabs').innerHTML = TABS.map(([k, lab], i) => `<button type="button" class="pc-tab" role="tab" data-a="tab" data-v="${k}" aria-selected="${S.tab === k}" title="${i + 1}">${lab}${counts[k] ? `<span class="pc-n">${counts[k]}</span>` : ''}</button>`).join('');
    const body = $('body');
    const needsData = S.tab !== 'props';
    let warn = '';
    if (S.err) warn = `<div class="pc-warn">History didn't load: ${esc(S.err)}. This week's numbers below are from the board.</div>`;
    if (needsData && !S.data && !S.err) { body.innerHTML = `<div class="pc-loading"><span class="pc-spin"></span>Loading game log and history…</div>`; return; }
    const fn = { props: tabProps, role: tabRole, form: tabForm, log: tabLog, history: tabHistory, schedule: tabSchedule }[S.tab];
    try { body.innerHTML = warn + fn(); } catch (e) { console.error('[pcard]', e); body.innerHTML = warn + `<div class="pc-empty">This section hit an error: ${esc(e.message)}</div>`; }
  }

  const sec = (title, note, inner, extra = '') => `<div class="pc-sec" ${extra}><h3>${title}</h3>${note ? `<p class="pc-note">${note}</p>` : ''}${inner}</div>`;
  const kitHTML = (name, p) => { try { const fn = window[name]; return typeof fn === 'function' ? fn(p) : ''; } catch (_) { return ''; } };
  const mini = (k, v, s, cls = '') => `<div class="pc-mini"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  function lineChips(withBook) {
    const p = S.p, prim = primaryLine(p);
    return `<div class="pc-chiprow"><span class="lbl">Line</span>${linesOf(p).filter(L => L <= 13.5).map(L =>
      `<button type="button" class="pc-chip" data-a="line" data-v="${L}" aria-pressed="${S.line === L}">${f(L, 1)}${withBook && prim === L && p._primary ? '<span class="bk">book</span>' : ''}</button>`).join('')}</div>`;
  }
  const stateChip = x => {
    const m = { upcoming: '', live: 'y', final: 'b', awaiting_stats: 'y', void: 'r' }[x.state] ?? '';
    return `<span class="pc-pill ${m}">${esc(x.state_label || x.state)}</span>`;
  };

  // ── Props ─────────────────────────────────────────────────────────────────
  function tabProps() {
    const p = S.p;
    const rows = rowsOf(p).sort((a, b) => Number(a.line) - Number(b.line) || String(a.side).localeCompare(String(b.side)));
    const tbl = rows.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr>
        <th>Prop</th><th>Ours</th><th>Fair</th><th>Edge</th><th>Kelly</th><th>Best price</th><th>Books</th><th>Good to</th><th class="l">Status</th></tr></thead><tbody>
      ${rows.map(r => {
        const st = r.locked && r.qualifies ? '<span class="pc-pill g">EV play · locked</span>' : r.qualifies ? '<span class="pc-pill g">EV play</span>'
          : r.started ? '<span class="pc-pill">started</span>' : r.stale ? '<span class="pc-pill y">stale ⏱</span>'
          : r.blocked ? `<span class="pc-pill y" title="${esc(r.blocked_note || '')}">⚑ ${esc(String(r.skip_reason || 'blocked').replace(/_/g, ' '))}</span>`
          : r.skip_reason ? `<span class="pc-muted">${esc(String(r.skip_reason).replace(/_/g, ' '))}</span>` : '<span class="pc-muted">—</span>';
        return `<tr class="${r.qualifies ? 'pc-q' : ''}"><td class="b">${String(r.side).toLowerCase() === 'over' ? 'Over' : 'Under'} ${f(r.line, 1)}${r.tier && r.tier !== 'play' ? ` <span class="pc-pill b">${esc(r.tier)}</span>` : ''}</td>
          <td>${pct(r.model_prob, 1)}</td><td>${pct(r.fair_prob, 1)} <span class="pc-muted">${odds(fairOdds(r.fair_prob))}</span></td>
          <td class="${evCls(r.ev_pct)}"><b>${sg(r.ev_pct, 1)}%</b></td><td>${ok(r.kelly_pct) && r.kelly_pct > 0 ? f(r.kelly_pct, 2) + '%' : '–'}</td>
          <td class="b">${odds(r.odds)} <span class="pc-muted" style="font-weight:400">${esc(r.book || '')}</span></td>
          <td>${esc(r.n_books ?? '–')}</td><td>${odds(r.good_to)}</td><td class="l">${st}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="pc-empty">No prices on the board for him right now — the ladder below is the model alone.</div>';

    const pend = (S.data && S.data.pending) || [];
    const pendTbl = pend.length ? sec(`Logged plays on him <span class="pc-muted" style="letter-spacing:0">(${pend.length})</span>`, 'From the bet log, waiting on the grader — the same rows as the Plays tab.', playsTable(pend, true)) : '';
    const kL = kitHTML('ladderHTML', p), kD = kitHTML('distHTML', p);
    const ladderSec = kL ? `<div class="pc-sec pc-kit">${kL}</div>` : sec('Line ladder', 'Model P(over) at every line.', ownLadder(p));
    const distSec = kD ? `<div class="pc-sec pc-kit">${kD}</div>` : '';
    return pendTbl + sec(`This week's props <span class="pc-muted" style="letter-spacing:0">(${rows.length})</span>`, 'Every line the board priced for him, at the best price across books. Green edge = +EV; only <b>EV play</b> rows are logged, go to Discord and get graded.', tbl)
      + `<div class="pc-grid2">${ladderSec}${distSec}</div>`
      + sec('What moves the projection', 'λ = opponent plays × his snap share × tackles per snap, then calibration and the in-season level ratio.', decompHTML(p));
  }
  function ownLadder(p) {
    return `<table class="pc-t"><thead><tr><th>Line</th><th>P(over)</th><th>Fair O</th><th>Fair U</th></tr></thead><tbody>${linesOf(p).map(L => {
      const v = pOver(p, L); return `<tr><td class="b">${f(L, 1)}</td><td>${pct(v, 1)}</td><td>${odds(fairOdds(v))}</td><td>${odds(fairOdds(v == null ? null : 1 - v))}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  function decompHTML(p) {
    const x = p.x || {};
    const snaps = ok(x.exp_plays) && ok(x.share) ? x.exp_plays * x.share : null;
    const chain = `<div class="pc-chain">
      <div><span class="k">Opp plays</span><b>${f(x.exp_plays, 1)}</b></div><i>×</i>
      <div><span class="k">Snap share</span><b>${pct(x.share)}</b></div><i>=</i>
      <div><span class="k">Exp. snaps</span><b>${f(snaps, 1)}</b></div><i>×</i>
      <div><span class="k">TCK / snap</span><b>${f(x.tps, 4)}</b></div><i>→</i>
      <div class="lead"><span class="k">λ</span><b>${f(p.proj, 2)}</b></div></div>`;
    const minis = `<div class="pc-minis" style="margin-top:14px">
      ${mini('λ raw (booster)', f(x.lambda_raw, 2), 'before calibration')}
      ${mini('Level k', f(x.level_k, 3), 'in-season ratio')}
      ${mini('NB r', f(x.r, 1), 'dispersion (lower = wider)')}
      ${mini('Depth rank', ok(x.dc_rank) ? '#' + f(x.dc_rank, 0) : '–', 'latest chart')}
      ${mini('Avail. weight', f(x.f_injury, 2), 'diagnostic only')}
      ${mini('Vacated (diag)', f(x.vacated, 2), 'not in λ')}</div>`;
    const fs = (p.factors || []).filter(fc => ok(fc.value));
    const fac = fs.map(fc => {
      const d = Number(fc.value) - 1, w = Math.min(Math.abs(d) / 0.15, 1) * 50;
      const col = d >= 0 ? 'var(--green,#1C7444)' : 'var(--red,#AE3328)';
      const pos = d >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      return `<div class="pc-fac"><span>${esc(String(fc.label).replace(/_/g, ' '))}</span><div class="t"><span class="c"></span><span class="f" style="${pos};background:${col}"></span></div><span class="n">×${f(fc.value, 3)}</span></div>`;
    }).join('');
    return chain + minis + fac;
  }

  // ── Role ──────────────────────────────────────────────────────────────────
  function tabRole() {
    const p = S.p, x = p.x || {};
    const snaps = ok(x.exp_plays) && ok(x.share) ? x.exp_plays * x.share : null;
    const tonight = `<div class="pc-minis">
      ${mini('Exp. snaps', f(snaps, 1), `${pct(x.share)} of ${f(x.exp_plays, 1)} plays`)}
      ${mini('TCK / snap', f(x.tps, 4), 'EB-shrunk rate')}
      ${mini('Depth rank', ok(x.dc_rank) ? '#' + f(x.dc_rank, 0) : '–', '')}
      ${mini('L10 snaps', f(x.l10_snaps, 0), `L10 tackles ${f(x.l10, 2)}`)}
      ${mini('Injury', esc(p.injury || '—'), p.status && p.status.raw && p.status.raw !== p.injury ? esc(p.status.raw) : '')}</div>`;
    const lg = logRows();
    if (!lg.length) return sec('This week', 'What the model expects.', tonight) + sec('Recent usage', '', '<div class="pc-empty">No game log for him yet.</div>');
    const cur = games(scoped('cur'));
    const sum = k => cur.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const gp = cur.length, sn = sum('snaps'), tk = sum('tck');
    const mt = cur.filter(r => ok(r.missed)), mts = mt.reduce((s, r) => s + (+r.missed || 0), 0), mtk = mt.reduce((s, r) => s + (+r.tck || 0), 0);
    const rs = cur.filter(r => ok(r.run_share));
    const season = gp ? `<div class="pc-minis">
      ${mini('Snaps / G', f(sn / gp, 1), `${gp} games this season`)}
      ${mini('Snap %', pct(avg(cur.filter(r => ok(r.snap_pct)).map(r => +r.snap_pct))), 'of team defensive snaps')}
      ${mini('Tackles / G', f(tk / gp, 2), `${f(sum('solo'), 0)} solo · ${f(sum('ast'), 0)} ast`)}
      ${mini('TCK / snap', sn ? f(tk / sn, 4) : '–', 'raw, this season')}
      ${mini('Missed-tackle %', mt.length && (mts + mtk) ? pct(mts / (mts + mtk), 1) : '–', 'PFR, ~1 week late')}
      ${mini('Run-play share', rs.length ? pct(avg(rs.map(r => +r.run_share))) : '–', 'of his PBP tackles')}</div>` : '<div class="pc-empty">No defensive snaps yet this season.</div>';
    const last = games(lg).slice(0, 17).reverse();
    const chart = barChart(last.map(r => ({ v: r.snaps || 0, top: ok(r.snap_pct) ? pct(r.snap_pct) : String(r.snaps ?? ''), l1: (r.home ? '' : '@') + (r.opp || ''), l2: wkl(r), color: 'var(--navy-ink,#14233A)', op: 0.85 })), { h: 200, ref: snaps, refLab: 'proj ' + f(snaps, 0), minW: 560 });
    const dep = `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Wk</th><th class="l">Opp</th><th>Snaps</th><th>Snap %</th><th>Depth</th><th class="l">Status</th><th>TCK</th><th>TCK / snap</th><th>Run share</th><th>Missed</th><th>Targets</th><th>Pressures</th></tr></thead><tbody>
      ${lg.slice(0, 17).map(r => `<tr class="${r.def_game ? '' : 'pc-dim'}"><td>${wkl(r)}</td><td class="l">${r.home ? 'vs' : '@'} ${esc(r.opp)}</td>
        <td class="b">${f(r.snaps, 0)}</td><td>${pct(r.snap_pct)}</td><td>${ok(r.dc_rank) ? '#' + f(r.dc_rank, 0) : '–'}</td><td class="l pc-muted">${esc(r.status || '')}${r.def_game ? '' : ' · ST only'}</td>
        <td class="b">${f(r.tck, 0)}</td><td>${r.snaps ? f(r.tck / r.snaps, 3) : '–'}</td><td>${pct(r.run_share)}</td><td>${f(r.missed, 0)}</td><td>${f(r.targets, 0)}</td><td>${f(r.pressures, 0)}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="pc-grid2">${sec('This week', 'What the model expects him to play.', tonight)}${sec('This season', '', season)}</div>`
      + sec('Defensive snaps', `Last ${last.length} games — bar = snaps, label = snap %; dashed line is this week's projected snaps.`, `<div class="pc-tw">${chart}</div>`)
      + sec('Deployment log', 'Depth = the week\'s chart rank; missed tackles, targets and pressures are PFR (published about a week late).', dep);
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  function tabForm() {
    const L = S.line, lg = logRows();
    if (!lg.length) return lineChips(true) + '<div class="pc-empty">No games logged for him yet.</div>';
    const both = games(scoped('both'));
    const m = (lab, rr) => mini(lab, rr ? pct(rr.pct) : '–', rr ? `${rr.over}/${rr.n} over · avg ${f(rr.avg, 1)}` : 'no games');
    const minis = `<div class="pc-minis">${m('Last 5', rate(both.slice(0, 5), L))}${m('Last 10', rate(both.slice(0, 10), L))}${m('Last 17', rate(both.slice(0, 17), L))}${m('This season', rate(scoped('cur'), L))}${m('Last season', rate(scoped('prev'), L))}</div>`;
    const last = both.slice(0, 17).reverse();
    const chart = barChart(last.map(r => ({
      v: r.tck || 0, top: String(r.tck ?? '–'), l1: (r.home ? '' : '@') + (r.opp || ''), l2: wkl(r),
      color: r.tck > L ? 'var(--green,#1C7444)' : 'var(--red,#AE3328)', op: r.tck > L ? 0.9 : 0.55, mark: r.proj
    })), { h: 220, ref: L, refLab: 'line ' + f(L, 1), minW: 560 });
    const opp = S.p.opp;
    const split = [
      ['Home', both.filter(r => r.home)], ['Away', both.filter(r => !r.home)],
      [`vs ${esc(opp || '—')}`, both.filter(r => r.opp === opp)],
      ['Team favoured', both.filter(r => r.fav === true)], ['Team underdog', both.filter(r => r.fav === false)],
      ['Snap % ≥ 85', both.filter(r => (r.snap_pct || 0) >= 0.85)], ['Snap % < 85', both.filter(r => ok(r.snap_pct) && r.snap_pct < 0.85)],
      ['Outdoors', both.filter(r => r.outdoor === true)], ['Dome / closed', both.filter(r => r.outdoor === false)],
      ['Short rest (< 7 days)', both.filter(r => ok(r.rest) && r.rest < 7)],
    ].map(([lab, rr]) => { const x = rate(rr, L); return `<tr><td>${lab}</td><td>${x ? x.n : 0}</td><td class="b">${x ? f(x.avg, 2) : '–'}</td><td>${x ? pct(x.pct) : '–'}</td><td>${x && ok(x.snaps) ? f(x.snaps, 0) : '–'}</td></tr>`; }).join('');
    return lineChips(true) + minis
      + sec(`Last ${last.length} games vs ${f(L, 1)}`, 'Green = over, red = under; ◆ = what the model projected that week. Games without a defensive snap are left out.', `<div class="pc-tw">${chart}</div>`)
      + sec('Splits', 'This season and last, against the selected line. Small cells are noise — read the n.', `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Split</th><th>GP</th><th>Avg TCK</th><th>Over ${f(L, 1)}</th><th>Snaps</th></tr></thead><tbody>${split}</tbody></table></div>`);
  }

  // ── Log ───────────────────────────────────────────────────────────────────
  function tabLog() {
    const L = S.line;
    const chips = `<div class="pc-chiprow"><span class="lbl">Season</span>${[['cur', 'This season'], ['prev', 'Last season'], ['both', 'Both']].map(([k, l]) => `<button type="button" class="pc-chip" data-a="scope" data-v="${k}" aria-pressed="${S.scope === k}">${l}</button>`).join('')}</div>`;
    const rows = scoped(S.scope);
    if (!rows.length) return chips + lineChips(false) + '<div class="pc-empty">No games logged for this span.</div>';
    let lastSeason = null;
    const body = rows.map(r => {
      let div = '';
      if (S.scope === 'both' && r.season !== lastSeason) { lastSeason = r.season; div = `<tr class="pc-div"><td colspan="15">${r.season}${r.scope === 'cur' ? ' · this season' : ''}</td></tr>`; }
      const res = r.def_game && ok(r.tck) ? (r.tck > L ? '<span class="pc-hit">O</span>' : r.tck === L ? '<span class="pc-muted">P</span>' : '<span class="pc-miss">U</span>') : '<span class="pc-muted">—</span>';
      return div + `<tr class="${r.def_game ? '' : 'pc-dim'}"><td>${wkl(r)}</td><td>${esc((r.date || '').slice(5).replace('-', '/'))}</td><td class="l">${r.home ? 'vs' : '@'} ${esc(r.opp)}</td>
        <td>${f(r.snaps, 0)}</td><td>${pct(r.snap_pct)}</td><td>${f(r.solo, 0)}</td><td>${f(r.ast, 0)}</td><td class="b">${f(r.tck, 0)}${r.zero_row && r.def_game ? '<span class="pc-muted" title="no stat row — played, recorded nothing"> ·</span>' : ''}</td>
        <td>${f(r.sacks, 1)}</td><td>${f(r.qbh, 0)}</td><td>${f(r.pd, 0)}</td><td>${f(r.missed, 0)}</td><td>${ok(r.dc_rank) ? '#' + f(r.dc_rank, 0) : '–'}</td>
        <td>${f(r.proj, 2)}</td><td>${res}</td></tr>`;
    }).join('');
    return chips + lineChips(false) + sec('Game log', `Every stored game, newest first (P = playoffs; faded = special teams only). O/U is against ${f(L, 1)}; Proj is what the model said that week.`,
      `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Wk</th><th>Date</th><th class="l">Opp</th><th>Snaps</th><th>Snap %</th><th>Solo</th><th>Ast</th><th>TCK</th><th>Sacks</th><th>QB hits</th><th>PD</th><th>Missed</th><th>Depth</th><th>Proj</th><th>${f(L, 1)}</th></tr></thead><tbody>${body}</tbody></table></div>`);
  }

  // ── History ───────────────────────────────────────────────────────────────
  function playsTable(plays, pending) {
    return `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Wk</th><th class="l">Play</th><th>Price</th><th>EV</th><th>Kelly</th><th>Proj</th><th>TCK</th><th>${pending ? 'Status' : 'Result'}</th>${pending ? '<th>Now</th>' : '<th>Units</th><th>CLV</th>'}</tr></thead><tbody>
      ${plays.map(r => `<tr><td>${esc(r.season)} W${esc(r.week)}</td><td class="l b">${String(r.side).toLowerCase() === 'over' ? 'Over' : 'Under'} ${f(r.line, 1)}${r.overridden ? ' <span class="pc-pill v">✎</span>' : ''}</td>
        <td>${odds(r.odds)} <span class="pc-muted">${esc(r.book || '')}</span></td><td class="pc-pos-ev">${sg(r.ev_pct, 1)}%</td><td>${ok(r.kelly_pct) ? f(r.kelly_pct, 2) + '%' : '–'}</td>
        <td>${f(r.proj, 2)}</td><td class="b">${r.actual ?? '–'}</td>
        ${pending ? `<td>${stateChip(r)}${r.would ? ` <span class="${r.would === 'win' ? 'pc-hit' : r.would === 'loss' ? 'pc-miss' : 'pc-muted'}">${r.would[0].toUpperCase()}</span>` : ''}</td>
          <td>${r.now && ok(r.now.odds) ? `${odds(r.now.odds)} <span class="pc-muted">${r.now.line !== r.line ? 'at ' + f(r.now.line, 1) : esc(r.now.book || '')}</span>` : '–'}</td>`
        : `<td>${r.result === 'win' ? '<span class="pc-pill g">W</span>' : r.result === 'loss' ? '<span class="pc-pill r">L</span>' : '<span class="pc-pill">P</span>'}</td>
          <td class="${(r.units || 0) >= 0 ? 'pc-pos-ev' : 'pc-red'}"><b>${sg(r.units, 2)}</b></td><td class="${evCls(r.clv)}">${ok(r.clv) ? sg(r.clv, 1) : '–'}</td>`}</tr>`).join('')}</tbody></table></div>`;
  }
  function tabHistory() {
    const d = S.data || {}, a = d.accuracy, ps = d.plays_summary, o = d.oos;
    const model = `<div class="pc-minis">
      ${mini('Weeks graded', a ? a.n : '0', 'projection files, this season + last')}
      ${mini('MAE', a ? f(a.mae, 2) : '–', 'tackles per game')}
      ${mini('Bias', a ? sg(a.bias, 2) : '–', a ? (a.bias > 0 ? 'we run high on him' : 'we run low on him') : '')}
      ${mini('Avg proj / actual', a ? `${f(a.proj_mean, 2)} / ${f(a.actual_mean, 2)}` : '–', '')}
      ${mini('Out-of-sample CV', o ? `${sg(o.bias, 2)}` : '–', o ? `bias on ${o.n} games · z ${f(o.z, 1)}${Math.abs(o.z || 0) >= 2 && o.n >= 16 ? ' ⚑' : ''}` : 'no CV rows')}
      ${mini('EV plays', ps ? `${ps.w}-${ps.l}${ps.p ? '-' + ps.p : ''}` : '0', 'settled, one per player/side/week')}
      ${mini('Units', ps ? sg(ps.units, 2) + 'u' : '–', ps && ok(ps.roi) ? `ROI ${sg(ps.roi * 100, 1)}% (flat 1u)` : 'flat 1u', ps ? (ps.units >= 0 ? 'pc-pos-ev' : 'pc-red') : '')}
      ${mini('CLV', ps && ok(ps.clv) ? sg(ps.clv, 2) : '–', 'pts vs the close')}</div>`;
    const acc = games(logRows()).filter(r => ok(r.proj)).slice(0, 17).reverse();
    const accChart = acc.length ? barChart(acc.map(r => ({ v: r.tck, top: String(r.tck), l1: (r.home ? '' : '@') + (r.opp || ''), l2: wkl(r), color: 'var(--border2,#CDC4B0)', op: 1, mark: r.proj })), { h: 200, minW: 520 }) : '<div class="pc-empty">No projection files cover his recent games yet.</div>';
    const plays = d.plays || [], pend = d.pending || [];
    const car = d.career || [];
    const ctbl = car.length ? `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Season</th><th class="l">Team</th><th>GP</th><th>TCK</th><th>Solo</th><th>TCK/G</th><th>Snaps/G</th><th>Snap %</th><th>TCK/snap</th><th>Sacks</th><th>PD</th><th>Missed %</th></tr></thead><tbody>
      ${car.map(s => `<tr><td>${esc(s.season)}</td><td class="l">${esc(s.team)}</td><td>${s.gp}</td><td class="b">${s.tck}</td><td>${s.solo}</td><td class="b">${f(s.tck_pg, 2)}</td><td>${f(s.snaps_pg, 1)}</td><td>${pct(s.snap_pct)}</td><td>${f(s.tps, 3)}</td><td>${f(s.sacks, 1)}</td><td>${f(s.pd, 0)}</td><td>${pct(s.miss_rate, 1)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="pc-empty">No regular-season games on record.</div>';
    return sec('Our model on him', 'Weekly projections vs what he did, the expanding-season CV rows the model never trained on, and every settled EV play (flat 1u).', model)
      + sec('Projected vs actual', 'Bars = actual tackles, ◆ = the model\'s projection that week.', `<div class="pc-tw">${accChart}</div>`)
      + (pend.length ? sec(`Pending plays <span class="pc-muted" style="letter-spacing:0">(${pend.length})</span>`, 'Logged, not graded yet — they move to Results when the grader settles them.', playsTable(pend, true)) : '')
      + sec(`Graded EV plays <span class="pc-muted" style="letter-spacing:0">(${plays.length})</span>`, '', plays.length ? playsTable(plays, false) : '<div class="pc-empty">No settled EV plays on him yet.</div>')
      + sec('Career — regular season (2016+, from the model panel)', 'GP counts games with a defensive snap.', ctbl);
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  function tabSchedule() {
    const s = (S.data && S.data.schedule) || [];
    if (!s.length) return sec('Upcoming', '', '<div class="pc-empty">No upcoming games in schedule.parquet for his team.</div>');
    const both = games(scoped('both')), L = S.line, pg = (S.data && S.data.pos_group) || S.p.pos_group || '';
    const rows = s.map(g => {
      const x = rate(both.filter(r => r.opp === g.opp), L);
      const d = g.kickoff ? new Date(g.kickoff) : null;
      const ar = g.allow_ratio;
      return `<tr><td>W${g.week}</td><td>${d ? d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) : '–'}</td><td>${d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–'}</td>
        <td class="l b">${g.home ? 'vs' : '@'} ${esc(g.opp)}</td><td>${esc(spreadTxt(g.spread))}</td><td>${f(g.total, 1)}</td>
        <td>${f(g.opp_plays_pg, 1)}</td><td>${pct(g.opp_run_rate)}</td>
        <td class="${ok(ar) ? (ar >= 1.05 ? 'pc-pos-ev' : ar <= 0.95 ? 'pc-red' : '') : ''}">${ok(g.allow_pg) ? `${f(g.allow_pg, 1)} <span class="pc-muted">(${sg((ar - 1) * 100, 0)}%)</span>` : '–'}</td>
        <td>${x ? x.n : 0}</td><td>${x ? f(x.avg, 2) : '–'}</td><td>${x ? `${x.over}/${x.n}` : '–'}</td></tr>`;
    }).join('');
    return sec('Upcoming', `Opponent offence volume this season (plays / game, run rate) and how many tackles ${esc(pg)}s make against it per game vs the league average — more plays and more runs mean more tackles to share. Right columns: his own games vs that team (this season + last), against ${f(L, 1)}.`,
      `<div class="pc-tw"><table class="pc-t"><thead><tr><th>Wk</th><th>Date</th><th>Time</th><th class="l">Opponent</th><th>Line</th><th>Total</th><th>Opp plays/G</th><th>Opp run %</th><th>${esc(pg)} TCK allowed/G</th><th>Met</th><th>Avg TCK</th><th>Over ${f(L, 1)}</th></tr></thead><tbody>${rows}</tbody></table></div>`)
      + '<div class="pc-note" style="margin-top:-6px">Line: fav / dog from his team\'s side (nflverse lines until the board pulls the week\'s own). Allowed-per-game is display only — the model reads its own lagged version.</div>';
  }

  // ── tiny SVG charts ───────────────────────────────────────────────────────
  function frame(n, o) {
    const padR = ok(o.ref) ? 78 : 10, W = Math.max(o.minW || 480, n * 50 + 40 + padR), H = o.h || 200, padL = 30, padT = 18, padB = 36;
    return { W, H, padL, padR, padT, padB, iw: W - padL - padR, ih: H - padT - padB };
  }
  function axis(F, max, fmt) {
    const ticks = []; const stepV = max <= 5 ? 1 : max <= 12 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : Math.ceil(max / 5 / 10) * 10;
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
      if (ok(b.mark)) { s += `<path d="M${cx} ${myy - 5}L${cx + 5} ${myy}L${cx} ${myy + 5}L${cx - 5} ${myy}Z" style="fill:var(--brass,#A8843F);stroke:var(--card,#fff)" stroke-width="1.5"><title>projected ${f(b.mark, 2)}</title></path>`; }
      if (b.l1) s += `<text x="${cx}" y="${F.H - 20}" text-anchor="middle" font-size="10" font-weight="600">${esc(b.l1)}</text>`;
      if (b.l2) s += `<text x="${cx}" y="${F.H - 7}" text-anchor="middle" font-size="9">${esc(b.l2)}</text>`;
    });
    if (ok(o.ref)) { const ry = y(Number(o.ref)); s += `<line x1="${F.padL}" x2="${F.W - F.padR}" y1="${ry}" y2="${ry}" style="stroke:var(--bright,#101C2E)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${F.W - F.padR + 6}" y="${ry + 3.5}" text-anchor="start" font-size="10" font-weight="600" style="fill:var(--bright,#101C2E)">${esc(o.refLab || '')}</text>`; }
    return `<svg class="pc-chart" viewBox="0 0 ${F.W} ${F.H}" style="min-width:${Math.min(F.W, o.minW || 480)}px;max-width:${F.W}px;margin:0 auto" role="img">${s}</svg>`;
  }

  // ── hook into the board ───────────────────────────────────────────────────
  const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>';
  function addButton() {
    const ds = document.querySelector('#d-content .ds');
    if (!ds || ds.querySelector('.pc-open-btn')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pc-open-btn'; b.title = 'Open the full player card (F, or double-click the row)';
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
          if (S.open && S.fromBoard) open(p);
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

  window.pcard = { open: (p, opts) => open(p || S.last, opts), close: () => close(), version: '1.0.0', playsTable: (rows, pending) => playsTable(rows, pending) };
})();
