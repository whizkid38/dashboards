/* plays.js — WhizShap "Plays" tab (v1.0.0)
 *
 * Adds a third tab to the shared props board (Projections · Plays · Results) without touching deploy/wk:
 * every play in the bet log that the grader has NOT settled yet — this week's upcoming plays, games in progress,
 * finals waiting for the Tuesday grader, box scores not in yet. Once nfl_grade.py settles a play it leaves this tab
 * and shows up on Results (the adapter serves Results settled-only). Data: GET {API}/api/wk/plays (pcard_api.py).
 * Click a row for the full player card.
 */
(function () {
  'use strict';
  if (window.__plays) return;
  window.__plays = true;

  const API = location.pathname.replace(/\/[^\/]*$/, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = v => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));
  const f = (v, d = 1) => ok(v) ? Number(v).toFixed(d) : '—';
  const pct = (v, d = 0) => ok(v) ? (Number(v) * 100).toFixed(d) + '%' : '—';
  const odds = o => ok(o) ? (Number(o) > 0 ? '+' : '') + Math.round(Number(o)) : '—';
  const sg = (v, d = 1) => ok(v) ? (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d) : '—';
  const units = (v, d = 2) => ok(v) ? sg(v, d) + 'u' : '—';
  const dec = o => !ok(o) || +o === 0 ? null : (+o > 0 ? +o / 100 + 1 : 100 / Math.abs(+o) + 1);
  const ago = iso => { if (!iso) return ''; const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; };
  const until = iso => { if (!iso) return ''; const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (m <= 0) return ''; if (m < 60) return `in ${m}m`; const h = Math.floor(m / 60); if (h < 48) return `in ${h}h ${m % 60}m`; return `in ${Math.floor(h / 24)}d`; };
  const kickTxt = iso => { if (!iso) return 'kickoff —'; const d = new Date(iso); return d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

  let D = null, loading = false, stateF = '', lastLoad = 0;
  const STATE_ORDER = { upcoming: 0, live: 1, awaiting_stats: 2, final: 3, void: 4 };

  // ── tab + page ──────────────────────────────────────────────────────────
  function install() {
    const nav = document.querySelector('nav');
    const proj = nav && nav.querySelector('.tab[data-page="projections"]');
    if (!nav || !proj || document.getElementById('page-plays')) return !!document.getElementById('page-plays');
    const tab = document.createElement('div');
    tab.className = 'tab'; tab.dataset.page = 'plays';
    tab.innerHTML = 'Plays<span class="tab-n" id="plays-n"></span>';
    proj.after(tab);
    const page = document.createElement('div');
    page.className = 'page'; page.id = 'page-plays';
    page.innerHTML = '<div class="bt-page" id="plays-content"><div class="empty">LOADING PLAYS…</div></div>';
    const res = document.getElementById('page-results');
    (res ? res.parentNode : document.body).insertBefore(page, res || null);
    tab.addEventListener('click', () => {
      document.querySelectorAll('nav .tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      tab.classList.add('active'); page.classList.add('active');
      if (!D || Date.now() - lastLoad > 60000) load(); else render();
    });
    return true;
  }

  async function load(silent) {
    if (loading) return; loading = true;
    const el = document.getElementById('plays-content');
    if (!silent && el && !D) el.innerHTML = '<div class="empty">LOADING PLAYS…</div>';
    try {
      const r = await fetch(`${API}/api/wk/plays`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      D = d; lastLoad = Date.now();
      const n = document.getElementById('plays-n'); if (n) n.textContent = d.summary && d.summary.n ? d.summary.n : '';
      if (document.getElementById('page-plays')?.classList.contains('active')) render();
    } catch (e) {
      if (el && !silent) el.innerHTML = `<div class="empty err">ERROR LOADING PLAYS<br><br><span style="font-size:12px">${esc(e.message)} — is server.py running (and pcard_api.py installed)?</span></div>`;
    } finally { loading = false; }
  }

  // ── render ──────────────────────────────────────────────────────────────
  function stChip(x) {
    let extra = '';
    if (x.state === 'upcoming') extra = until(x.kickoff);
    return `<span class="pl-st ${esc(x.state)}">${esc(x.state_label)}</span>${extra ? `<div class="pmeta">${esc(extra)}</div>` : ''}`;
  }
  function nowCell(x) {
    const n = x.now;
    if (!n || !ok(n.odds)) return x.state === 'upcoming' ? '<span class="dimtxt">not on the board</span>' : '<span class="dimtxt">—</span>';
    const sameLine = Number(n.line) === Number(x.line);
    const better = sameLine && dec(x.odds) != null && dec(n.odds) != null ? dec(x.odds) - dec(n.odds) : null;   // +ve = we got a better price than now
    const mv = !sameLine ? `<div class="pl-move dimtxt">line moved → ${f(n.line, 1)}</div>`
      : better == null ? '' : Math.abs(better) < 1e-9 ? '<div class="pl-move dimtxt">same price</div>'
      : better > 0 ? '<div class="pl-move ppos">beat the current price</div>' : '<div class="pl-move pneg">price improved since</div>';
    return `${odds(n.odds)} <span class="dimtxt">${esc(n.book || '')}</span>${ok(n.ev_pct) ? ` · <span class="${n.ev_pct > 0 ? 'ppos' : 'pneg'}">${sg(n.ev_pct, 1)}%</span>` : ''}${mv}`;
  }
  function resultCell(x) {
    if (!ok(x.actual)) return '<span class="dimtxt">—</span>';
    const w = x.would, c = w === 'win' ? 'ppos' : w === 'loss' ? 'pneg' : 'pdim';
    return `<b style="color:var(--bright)">${f(x.actual, 0)}</b> <span class="${c}">${w ? w.toUpperCase() : ''}</span>`;
  }
  function render() {
    const el = document.getElementById('plays-content'); if (!el || !D) return;
    const s = D.summary || {}, all = D.plays || [];
    const rows = all.filter(x => !stateF || x.state === stateF);
    const bs = s.by_state || {};
    const states = Object.keys(bs).sort((a, b) => (STATE_ORDER[a] ?? 9) - (STATE_ORDER[b] ?? 9));
    const label = { upcoming: 'PENDING', live: 'IN PROGRESS', final: 'FINAL · GRADER NEXT', awaiting_stats: 'AWAITING BOX SCORE', void: 'VOID?' };
    const cards = `<div class="stat-grid">
      <div class="stat-card"><div class="stat-label">PLAYS WAITING</div><div class="stat-val">${s.n || 0}</div>
        <div class="stat-sub">${states.map(k => `${bs[k]} ${esc((label[k] || k).toLowerCase())}`).join(' · ') || '—'}<br>${s.n_games || 0} game${s.n_games === 1 ? '' : 's'} · ${esc((s.weeks || []).join(', '))}</div></div>
      <div class="stat-card"><div class="stat-label">KELLY STAKED</div><div class="stat-val">${f(s.kelly_pct, 2)}%</div>
        <div class="stat-sub">of bankroll · ${units(s.kelly_pct)} at 1% Kelly = 1u<br>the stake the board logged on each play</div></div>
      <div class="stat-card"><div class="stat-label">EXPECTED UNITS</div><div class="stat-val ${s.exp_units > 0 ? 'pos' : ''}">${units(s.exp_units)}</div>
        <div class="stat-sub">flat 1u per play · Kelly-sized ${units(s.exp_units_kelly)}<br>Σ EV at the price taken — not a forecast you can bank</div></div>
      <div class="stat-card"><div class="stat-label">MEAN EV</div><div class="stat-val">${ok(s.mean_ev) ? sg(s.mean_ev, 1) + '%' : '—'}</div>
        <div class="stat-sub">at the price taken<br>bar 8% (10% single-book)</div></div>
      <div class="stat-card"><div class="stat-label">PRICE CHECK</div><div class="stat-val">${s.price_checked ? `${s.price_beat}/${s.price_checked}` : '—'}</div>
        <div class="stat-sub">upcoming plays still at the same line where our price beats today's best<br>a rough early read of CLV — the grader scores the real close</div></div>
    </div>`;
    const filt = `<div class="pl-filters"><span class="cl">STATUS</span>
      <select id="plays-state"><option value="">ALL (${all.length})</option>${states.map(k => `<option value="${esc(k)}" ${stateF === k ? 'selected' : ''}>${esc(label[k] || k)} (${bs[k]})</option>`).join('')}</select>
      <span class="n-results" style="margin-left:auto">SHOWING <span>${rows.length}</span> / ${all.length}</span></div>`;
    let body = '';
    if (!rows.length) {
      body = `<div class="empty" style="padding:28px">${all.length ? 'NO PLAYS IN THIS STATUS' : 'NO PENDING PLAYS'}<br><br><span style="font-size:12px">${all.length ? '' : 'Every logged play has been graded — see Results. New plays land here the moment the board logs them.'}</span></div>`;
    } else {
      const games = new Map((D.games || []).map(g => [g.key, g]));
      const byGame = new Map();
      rows.forEach(x => { if (!byGame.has(x.game)) byGame.set(x.game, []); byGame.get(x.game).push(x); });
      const trs = [...byGame.entries()].map(([gk, xs]) => {
        const g = games.get(gk) || {}; const t = g.teams || [xs[0].team, xs[0].opp];
        const kel = xs.reduce((a, x) => a + (x.kelly_pct || 0), 0), eu = xs.reduce((a, x) => a + (x.ev_pct || 0) / 100, 0);
        const head = `<tr class="pl-game"><td colspan="12">${esc(t.join(' · '))} &nbsp;W${esc(xs[0].week)}<span>${esc(kickTxt(g.kickoff || xs[0].kickoff))} · ${xs.length} play${xs.length > 1 ? 's' : ''} · ${f(kel, 2)}% staked · ${units(eu)} expected</span></td></tr>`;
        return head + xs.map(x => {
          const i = all.indexOf(x);
          return `<tr class="pl-row" data-i="${i}">
            <td class="pl-player"><span style="color:var(--bright);font-weight:600">${esc(x.player)}</span>${x.overridden ? `<span class="ov-badge" title="${esc(x.note || 'override')}">✎</span>` : ''}<div class="pmeta">${esc(x.pos)} · ${esc(x.team)} ${x.opp ? 'vs ' + esc(x.opp) : ''}</div></td>
            <td><b style="color:var(--bright)">${x.side === 'over' ? 'O' : 'U'} ${f(x.line, 1)}</b></td>
            <td>${odds(x.odds)}<div class="pmeta">${esc(x.book)}${x.n_books > 1 ? ` (${Math.round(x.n_books)})` : ''}</div></td>
            <td><span class="evc evc-q">${sg(x.ev_pct, 1)}%</span></td>
            <td>${ok(x.kelly_pct) ? f(x.kelly_pct, 2) + '%' : '—'}</td>
            <td>${pct(x.p_bet, 0)}<div class="pmeta">mdl ${pct(x.p_model, 0)} · mkt ${pct(x.p_mkt, 0)}</div></td>
            <td>${f(x.proj, 2)}${x.overridden && ok(x.lambda_model) ? `<div class="pmeta">model ${f(x.lambda_model, 2)}</div>` : ''}</td>
            <td>${ok(x.to_win) ? units(x.to_win) : '—'}</td>
            <td>${nowCell(x)}</td>
            <td>${stChip(x)}</td>
            <td>${resultCell(x)}</td>
            <td class="pdim">${esc(ago(x.priced_at))}</td>
          </tr>`;
        }).join('');
      }).join('');
      body = `<div class="pl-wrap"><table class="bt-tbl pl-tbl"><thead><tr><th>PLAYER</th><th>BET</th><th>PRICE</th><th>EV</th><th>KELLY</th><th>P BET</th><th>PROJ</th><th>TO WIN</th><th>NOW</th><th>STATUS</th><th>TCK</th><th>LOGGED</th></tr></thead><tbody>${trs}</tbody></table></div>`;
    }
    el.innerHTML = `<div class="res-toolbar"><div><div class="res-title">PENDING PLAYS</div>
        <div class="res-sub">ev_plays_history.csv, the grader's own bet rules (re-bets collapsed, post-kickoff rows dropped) · last graded ${esc(D.graded_at ? new Date(D.graded_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never')} · updated ${esc(ago(D.generated_at) || 'just now')}</div></div>
      <div class="res-right"><button class="btn" id="plays-reload">↻ RELOAD</button></div></div>
      ${cards}
      <div class="note"><b>One row per bet</b> — the first line and book logged for that player and side this week (the board's first-seen lock), at the stake it logged. A play leaves this tab when <b>nfl_grade.py</b> settles it (Tuesday 05:20 cron or ▶ RUN GRADER on Results) and appears there with its units and CLV. <b>Final</b> = the box score is in and shows what it would grade as; <b>Void?</b> = his team's box score is in without him (a void prop — the grader confirms). Click a row for the full player card.</div>
      ${filt}${body}`;
    el.querySelector('#plays-reload').addEventListener('click', () => load());
    el.querySelector('#plays-state')?.addEventListener('change', e => { stateF = e.target.value; render(); });
    el.querySelectorAll('tr.pl-row').forEach(tr => tr.addEventListener('click', () => openCard(all[+tr.dataset.i])));
  }

  function openCard(x) {
    if (!x || !window.pcard) return;
    let p = null;
    try { p = (typeof allProjs !== 'undefined' ? allProjs : []).find(q => String(q.id) === String(x.player_id)); } catch (_) { p = null; }   // eslint-disable-line no-undef
    if (!p) p = { id: x.player_id || x.player, name: x.player, team: x.team, opp: x.opp, pos: x.pos, pos_group: x.pos, matchup: x.opp ? `vs ${x.opp}` : '',
                  proj: x.proj, lines: {}, _rows: [], x: {}, status: null, chips: [] };
    window.pcard.open(p, { fromBoard: false, line: x.line, tab: 'history' });
  }

  // ── Results: pending plays live here now, so the OPEN filter goes; "N open" points at this tab ──
  function patchResults() {
    const bt = document.getElementById('bt-content'); if (!bt) return;
    const sel = bt.querySelector('#res-result option[value="open"]'); if (sel) sel.remove();
    bt.querySelectorAll('.stat-card').forEach(c => {
      const l = c.querySelector('.stat-label'); if (!l || l.textContent.trim() !== 'PLAYS GRADED') return;
      const sub = c.querySelector('.stat-sub'); if (!sub || sub.dataset.pl) return;
      sub.dataset.pl = '1';
      sub.innerHTML = sub.innerHTML.replace(/(\d+) open/, (m, n) => `<a href="#" class="plays-link" style="color:var(--accent)">${n} pending → Plays</a>`);
      sub.querySelector('.plays-link')?.addEventListener('click', e => { e.preventDefault(); document.querySelector('nav .tab[data-page="plays"]')?.click(); });
    });
  }

  function init() {
    let tries = 0;
    (function retry() { if (!install() && ++tries < 50) setTimeout(retry, 200); else load(true); })();
    const bt = document.getElementById('bt-content');
    if (bt) new MutationObserver(() => patchResults()).observe(bt, { childList: true, subtree: true });
    setInterval(() => { if (document.getElementById('page-plays')?.classList.contains('active') && !document.hidden) load(true); }, 120000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
