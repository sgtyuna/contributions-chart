/* Family Contributions Chart.
 * All words the family sees about contributions come from the database
 * (seeded once from seed/seed.json). This file holds only the app's
 * plumbing and its button labels. */
(() => {
  'use strict';

  const cfg = window.CC_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cc.auth' }
  });

  // ---------- small helpers ----------
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-host');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } }
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const KIND_LABEL = { daily: 'Every day', weekly: 'Once a week', once: 'Just this once' };
  const EMOJI = ['🛏️', '🍽️', '🛋️', '🏠', '👕', '🛌', '🧺', '👖', '🧹', '🪴', '🧽', '🍴', '🥕', '🛒', '🗑️', '🥬', '🪞', '🚽', '🧻', '🪣', '💧', '🌱', '📬', '🍂', '🐾', '🦴', '🤝', '📦', '🐔', '🐕', '🐈', '🚗', '🪵', '🔥', '📚', '🎒', '🌻', '🍞'];

  // ---------- state ----------
  const TABLES = ['people', 'settings', 'texts', 'contributions', 'checkoffs', 'ideas', 'requests', 'weekly_notes'];
  const empty = () => Object.fromEntries(TABLES.map((t) => [t, []]));
  let db = store.get('cc.cache', null) || empty();
  let outbox = store.get('cc.outbox', []);
  let session = null;
  let offline = false;
  let flushing = false;
  let channel = null;

  const ui = {
    screen: 'loading',
    who: null,          // a kid's id while in that kid's view
    tab: 'list',
    momTab: 'requests',
    momPerson: null,
    momPin: null,       // kept in memory only while Mom mode is open
    pin: '', pinNext: null, pinMode: 'enter', pinMsg: '', pinOld: null,
    meetingWeek: null, meetingPerson: null, meetingSide: true, noteEditing: false,
    editing: null,      // { table, id } or { table, id: 'new', person }
    forms: {},          // draft text typed into forms, so a live refresh never loses it
    signinMode: 'in', signinMsg: '',
    hardFlags: null, msg: ''
  };

  // ---------- time (family timezone + hidden test clock) ----------
  const testOffset = () => store.get('cc.testOffset', 0);
  const now = () => Date.now() + testOffset();
  const settings = () => db.settings[0] || { timezone: 'America/New_York', reset_day: 1 };
  const tz = () => settings().timezone || 'America/New_York';
  const resetDay = () => (Number.isInteger(settings().reset_day) ? settings().reset_day : 1);
  function partsIn(ms, zone) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute };
  }
  const dayStr = (ms = now()) => { const p = partsIn(ms, tz()); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = (ds) => new Date(ds + 'T00:00:00Z').getUTCDay();
  const weekOf = (ds) => addDays(ds, -((dow(ds) - resetDay() + 7) % 7));
  const fmtDay = (ds, opts = { weekday: 'long', month: 'short', day: 'numeric' }) => new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  function zonedToMs(y, m, d, h, mi) {
    const want = Date.UTC(y, m - 1, d, h, mi);
    let guess = want;
    for (let i = 0; i < 3; i++) {
      const p = partsIn(guess, tz());
      guess += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    }
    return guess;
  }
  const periodFor = (c, today = dayStr()) => (c.kind === 'daily' ? today : weekOf(today));

  // ---------- reading the data ----------
  const text = (k) => (db.texts.find((t) => t.key === k) || {}).value || '';
  const person = (id) => db.people.find((p) => p.id === id) || { id, name: id };
  const kids = () => db.people.filter((p) => p.role === 'kid').sort((a, b) => a.sort - b.sort);
  const brotherOf = (id) => kids().find((k) => k.id !== id);
  const listOf = (pid) => db.contributions.filter((c) => c.person_id === pid).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const currentCheck = (c) => db.checkoffs.find((k) => k.contribution_id === c.id && k.period === periodFor(c));
  const everChecked = (c) => db.checkoffs.some((k) => k.contribution_id === c.id);
  const isLastDayOfWeek = (ds = dayStr()) => dow(ds) === (resetDay() + 6) % 7;

  // ---------- saving: local first, then the database; queued while offline ----------
  function applyLocal(op) {
    const rows = db[op.table];
    if (!rows) return;
    const key = op.key || 'id';
    if (op.type === 'insert' || op.type === 'upsert') {
      const i = rows.findIndex((r) => r[key] === op.row[key]);
      if (i >= 0) rows[i] = { ...rows[i], ...op.row }; else rows.push({ ...op.row });
    } else if (op.type === 'update') {
      const r = rows.find((x) => x[key] === op.id);
      if (r) Object.assign(r, op.patch);
    } else if (op.type === 'delete') {
      db[op.table] = rows.filter((r) => r[key] !== op.id);
    }
  }
  const saveCache = () => store.set('cc.cache', db);
  const saveOutbox = () => store.set('cc.outbox', outbox);
  function queue(op) {
    applyLocal(op);
    outbox.push(op);
    saveOutbox();
    saveCache();
    render();
    flush();
  }
  const isNetError = (e) => !navigator.onLine || /fetch|network|load failed|timed? ?out|connection/i.test((e && (e.message || e.details)) || '');
  async function send(op) {
    try {
      let res;
      const key = op.key || 'id';
      if (op.type === 'insert') res = await sb.from(op.table).insert(op.row);
      else if (op.type === 'upsert') res = await sb.from(op.table).upsert(op.row, { onConflict: key });
      else if (op.type === 'update') res = await sb.from(op.table).update(op.patch).eq(key, op.id);
      else if (op.type === 'delete') res = await sb.from(op.table).delete().eq(key, op.id);
      else if (op.type === 'rpc') res = await sb.rpc(op.fn, op.args);
      if (res.error) return isNetError(res.error) ? 'net' : 'err';
      return 'ok';
    } catch (e) {
      return isNetError(e) ? 'net' : 'err';
    }
  }
  async function flush() {
    if (flushing || !session) return;
    flushing = true;
    let hadError = false;
    while (outbox.length) {
      const r = await send(outbox[0]);
      if (r === 'net') { setOffline(true); break; }
      outbox.shift();
      saveOutbox();
      if (r === 'err') hadError = true;
    }
    flushing = false;
    if (!outbox.length) { setOffline(false); if (hadError) refresh(); }
  }
  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    render();
  }

  let refreshSeq = 0;
  let rtEvents = 0;
  async function refresh() {
    if (!session) return;
    const mySeq = ++refreshSeq;
    try {
      const since = addDays(dayStr(Date.now()), -400);
      const results = await Promise.all(TABLES.map((t) => {
        let q = sb.from(t).select('*');
        if (t === 'checkoffs') q = q.gte('day', since);
        return q;
      }));
      if (mySeq !== refreshSeq) return; // a newer refresh is on its way
      const bad = results.find((r) => r.error);
      if (bad) { if (isNetError(bad.error)) setOffline(true); return; }
      const next = empty();
      TABLES.forEach((t, i) => { next[t] = results[i].data || []; });
      db = next;
      for (const op of outbox) applyLocal(op); // keep showing what hasn't synced yet
      saveCache();
      if (!outbox.length) setOffline(false);
      render();
    } catch (e) {
      if (isNetError(e)) setOffline(true);
    }
  }
  let refreshTimer = null;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); };

  async function listen() {
    if (channel) await sb.removeChannel(channel);
    // Live updates obey the same privacy rules, so they need the family sign-in.
    if (session && session.access_token) await sb.realtime.setAuth(session.access_token);
    channel = sb.channel('family')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => { rtEvents++; refreshSoon(); })
      .subscribe((status) => {
        // Re-read now and once more a few seconds later: the server takes a
        // moment to start sending changes after a device connects.
        if (status === 'SUBSCRIBED') { refreshSoon(); setTimeout(refresh, 4000); }
      });
  }

  // First run: Mom types the kids' names, then the starter content goes in.
  // The names are saved only in the database, never in the app's files.
  function seedIfNeeded() {
    if (db.settings.length && !db.settings[0].seeded && ui.screen !== 'setup') go({ screen: 'setup' });
  }
  async function runSetup(names) {
    try {
      const payload = await (await fetch('seed/seed.json', { cache: 'no-store' })).json();
      const kidsIn = names.map((name, i) => ({ id: `kid${i + 1}`, name, role: 'kid' }));
      payload.people = [...kidsIn, ...payload.people];
      const { error } = await sb.rpc('seed_family', { payload });
      if (error) return isNetError(error) ? 'net' : 'err';
      await refresh();
      return 'ok';
    } catch (e) {
      return isNetError(e) ? 'net' : 'err';
    }
  }

  // Online-only calls (Mom's PIN checks and answers).
  async function rpc(fn, args) {
    try {
      const { data, error } = await sb.rpc(fn, args);
      if (error) return { error: isNetError(error) ? 'net' : (error.message || 'error') };
      return { data };
    } catch (e) {
      return { error: 'net' };
    }
  }

  // ---------- actions ----------
  function toggle(c) {
    const k = currentCheck(c);
    if (k) {
      // Un-check: no trace kept. If the check-off hasn't synced yet, just drop it
      // (unless it's being sent right now; then queue a delete after it).
      const i = outbox.findIndex((op) => op.type === 'insert' && op.table === 'checkoffs' && op.row.id === k.id);
      if (i >= 0 && !(flushing && i === 0)) {
        outbox.splice(i, 1);
        saveOutbox();
        db.checkoffs = db.checkoffs.filter((r) => r.id !== k.id);
        saveCache();
        render();
      } else {
        queue({ type: 'delete', table: 'checkoffs', id: k.id });
      }
      return;
    }
    const today = dayStr();
    queue({
      type: 'insert', table: 'checkoffs', row: {
        id: uuid(), contribution_id: c.id, person_id: c.person_id, kind: c.kind,
        period: periodFor(c, today), day: today, week_start: weekOf(today),
        name: c.name, icon: c.icon || '', checked_at: new Date(now()).toISOString()
      }
    });
    showSheet(c.icon, c.thanks || c.name);
  }

  function flagHard(c) {
    queue({ type: 'rpc', fn: 'flag_hard', args: { contribution: c.id } });
    showSheet('', text('hard_ack'));
  }

  let sheetTimer = null;
  function showSheet(icon, words) {
    clearTimeout(sheetTimer);
    $sheet.innerHTML = `<div class="sheet" role="status" data-action="close-sheet">${icon ? `<span class="icon" aria-hidden="true">${esc(icon)}</span>` : ''}<p>${esc(words)}</p></div>`;
    sheetTimer = setTimeout(() => { $sheet.innerHTML = ''; }, 7000);
  }

  // ---------- forms keep their drafts ----------
  const draft = (form, name, fallback = '') => {
    const f = ui.forms[form];
    return f && name in f ? f[name] : fallback;
  };
  const clearForm = (form) => { delete ui.forms[form]; };

  // ---------- rendering ----------
  let renderWaiting = false;
  function render(force) {
    const a = document.activeElement;
    if (!force && a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
      renderWaiting = true;   // don't redraw under someone's typing
      return;
    }
    renderWaiting = false;
    const scroll = window.scrollY;
    $app.innerHTML = view();
    if (ui._keepScroll) window.scrollTo(0, scroll);
    ui._keepScroll = true;
  }
  const go = (patch) => { Object.assign(ui, patch); ui._keepScroll = false; ui.msg = ''; render(true); window.scrollTo(0, 0); };

  function view() {
    switch (ui.screen) {
      case 'loading': return `<div class="welcome"><p>Opening…</p></div>`;
      case 'signin': return viewSignin();
      case 'setup': if (settings().seeded) { ui.screen = 'pick'; return viewPick(); } return viewSetup();
      case 'pick': return viewPick();
      case 'kid': return viewKid();
      case 'pin': return viewPin();
      case 'mom': return viewMom();
      case 'meeting': return viewMeeting();
      default: return '';
    }
  }

  const syncNote = () => (offline || (!navigator.onLine && outbox.length))
    ? `<div class="note-bar" role="status">${esc(text('offline_note') || 'Will sync when you\'re back online.')}</div>` : '';
  const top = (title, back = 'pick') => `
    <div class="top">
      <button class="back" data-action="back" data-to="${back}">← ${back === 'pick' ? 'Switch' : 'Back'}</button>
      <h1>${esc(title)}</h1>
      <span class="date">${esc(fmtDay(dayStr(), { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
    </div>${syncNote()}`;

  function viewSignin() {
    const making = ui.signinMode === 'make';
    return `
      <div class="welcome"><h1>Contributions</h1><p>${making ? 'Make the family account. Mom does this once.' : 'Sign in with the family account.'}</p></div>
      <form class="card" data-form="signin" data-action="signin" style="max-width:460px;margin:20px auto">
        <label for="em">Family email</label>
        <input id="em" name="email" type="email" autocomplete="username" required value="${esc(draft('signin', 'email'))}">
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" autocomplete="${making ? 'new-password' : 'current-password'}" minlength="8" required>
        ${ui.signinMsg ? `<p class="muted">${esc(ui.signinMsg)}</p>` : ''}
        <div class="row end" style="margin-top:16px"><button class="btn" type="submit">${making ? 'Make the account' : 'Sign in'}</button></div>
      </form>
      <button class="quiet-link" data-action="signin-mode">${making ? 'I already have the family account' : 'First time? Make the family account'}</button>`;
  }

  function viewSetup() {
    return `
      <div class="welcome"><h1>Welcome</h1><p>First, who's in the family? These names are saved only in your family's private database, not in the app.</p></div>
      <form class="card" data-form="setup" data-action="setup" style="max-width:460px;margin:20px auto">
        <label for="su-1">First child's name</label>
        <input id="su-1" name="kid1" required maxlength="30" autocomplete="off" value="${esc(draft('setup', 'kid1'))}">
        <label for="su-2">Second child's name</label>
        <input id="su-2" name="kid2" maxlength="30" autocomplete="off" value="${esc(draft('setup', 'kid2'))}">
        ${ui.msg ? `<p class="muted">${esc(ui.msg)}</p>` : ''}
        <div class="row end" style="margin-top:16px"><button class="btn" type="submit">Start</button></div>
      </form>`;
  }

  function viewPick() {
    return `
      <div class="welcome"><h1>${esc(text('pick') || 'Contributions')}</h1>${text('welcome') ? `<p>${esc(text('welcome'))}</p>` : ''}</div>
      ${syncNote()}
      <div class="people">
        ${kids().map((k) => `<button class="person" data-action="open-kid" data-id="${esc(k.id)}">${esc(k.name)}${incomingTrades(k.id).length ? '<span class="dot" aria-label="something new"></span>' : ''}</button>`).join('')}
        ${db.people.filter((p) => p.role === 'mom').map((p) => `<button class="person mom" data-action="open-mom">${esc(p.name)}</button>`).join('')}
      </div>
      <button class="quiet-link" data-action="open-meeting">Family meeting</button>
      ${!kids().length ? `<p class="empty" style="text-align:center">Getting your lists ready…</p>` : ''}`;
  }

  // ----- a boy's view -----
  const incomingTrades = (pid) => db.requests.filter((r) => r.kind === 'trade' && r.to_person === pid && r.status === 'pending' && r.partner === 'waiting');

  function itemCard(c, { canCheck, showHard, gentle }) {
    const k = currentCheck(c);
    const done = !!k;
    const tag = c.kind === 'weekly' && c.weekday != null ? `<span class="tag">${DAYS[c.weekday]}</span>` : '';
    return `
      <div class="item ${done ? 'done' : ''}">
        <div class="icon" aria-hidden="true">${esc(c.icon)}</div>
        <div>
          <div class="name">${esc(c.name)}</div>
          ${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}
          ${tag}
          ${gentle && !done ? `<div class="gentle">${esc(text('unfinished_note'))}</div>` : ''}
          ${showHard ? `<button class="hard" data-action="hard" data-id="${c.id}">This one feels hard</button>` : ''}
        </div>
        <button class="check" role="checkbox" aria-checked="${done}" aria-label="${esc(c.name)}" data-action="toggle" data-id="${c.id}" ${canCheck ? '' : 'disabled'}>${done ? '✓' : ''}</button>
      </div>`;
  }

  function listSections(pid, mine) {
    const all = listOf(pid);
    const today = dayStr();
    const week = weekOf(today);
    const lastDay = isLastDayOfWeek(today);
    const opts = { canCheck: mine, showHard: mine };
    const daily = all.filter((c) => c.kind === 'daily');
    const weekly = all.filter((c) => c.kind === 'weekly');
    const once = all.filter((c) => c.kind === 'once' && !everChecked(c));
    const onceDone = all.filter((c) => c.kind === 'once' && db.checkoffs.some((k) => k.contribution_id === c.id && k.week_start === week));
    const sec = (title, items, o) => items.length ? `<h2>${title}</h2><div class="list">${items.map((c) => itemCard(c, o)).join('')}</div>` : '';
    const body = sec('Today', daily, opts)
      + sec('This week', weekly, { ...opts, gentle: lastDay })
      + sec('Just this once', once, { ...opts, gentle: lastDay })
      + sec('Done this week', onceDone, { ...opts, showHard: false });
    return body || `<p class="empty">${esc(text('nothing_yet'))}</p>`;
  }

  function viewKid() {
    const me = person(ui.who);
    const bro = brotherOf(ui.who);
    const tabs = [['list', 'My list'], ['brother', bro ? `${bro.name}'s list` : ''], ['ideas', 'Ideas'], ['ask', 'Ask']].filter((t) => t[1]);
    const newTrade = incomingTrades(ui.who).length > 0;
    let body = '';
    if (ui.tab === 'list') {
      body = (newTrade ? `<div class="note-bar">${esc(bro ? bro.name : '')} asked about a trade. <button class="btn soft" data-action="tab" data-tab="ask" style="margin-left:8px;min-height:40px;padding:6px 14px">See it</button></div>` : '')
        + listSections(ui.who, true);
    } else if (ui.tab === 'brother' && bro) {
      body = `<p class="muted small">${esc(bro.name)}'s list, just to look at.</p>` + listSections(bro.id, false);
    } else if (ui.tab === 'ideas') {
      body = viewIdeasForKid();
    } else if (ui.tab === 'ask') {
      body = viewAsk();
    }
    return `${top(me.name)}
      <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${ui.tab === id}" data-action="tab" data-tab="${id}">${esc(label)}${id === 'ask' && newTrade ? '<span class="dot" aria-label="something new"></span>' : ''}</button>`).join('')}</div>
      ${body}`;
  }

  function groupIdeas() {
    const groups = new Map();
    for (const i of [...db.ideas].sort((a, b) => a.sort - b.sort)) {
      if (!groups.has(i.category)) groups.set(i.category, []);
      groups.get(i.category).push(i);
    }
    return groups;
  }

  function viewIdeasForKid() {
    const mineAsked = (id) => db.requests.some((r) => r.kind === 'idea' && r.idea_id === id && r.from_person === ui.who && r.status === 'pending');
    let out = `<p class="muted small">Ideas for other ways to help. Ask to take one on, and Mom will answer.</p>`;
    for (const [cat, items] of groupIdeas()) {
      out += `<h2>${esc(cat || 'Other')}</h2><div class="list">${items.map((i) => `
        <div class="item">
          <div class="icon" aria-hidden="true">${esc(i.icon)}</div>
          <div><div class="name">${esc(i.name)}</div>${i.why ? `<div class="why">${esc(i.why)}</div>` : ''}<span class="tag">${KIND_LABEL[i.kind]}</span></div>
          ${mineAsked(i.id) ? `<span class="muted small">Asked</span>` : `<button class="btn soft" data-action="ask-idea" data-id="${i.id}">Ask</button>`}
        </div>`).join('')}</div>`;
    }
    return out;
  }

  function requestLine(r) {
    if (r.kind === 'suggest') return `New: ${esc(r.name)}`;
    if (r.kind === 'idea') { const i = db.ideas.find((x) => x.id === r.idea_id); return `From the ideas: ${esc(i ? i.name : 'an idea')}`; }
    const give = db.contributions.find((c) => c.id === r.give_id);
    const take = db.contributions.find((c) => c.id === r.take_id);
    return `Trade: ${esc(person(r.from_person).name)}'s “${esc(give ? give.name : '…')}” for ${esc(person(r.to_person).name)}'s “${esc(take ? take.name : '…')}”`;
  }
  function requestStatus(r) {
    if (r.status === 'approved') return 'Yes';
    if (r.status === 'not_this_time') return 'Not this time';
    if (r.kind === 'trade' && r.partner === 'waiting') return `Waiting for ${esc(person(r.to_person).name)}`;
    return 'Waiting for Mom';
  }

  function viewAsk() {
    const bro = brotherOf(ui.who);
    const recent = Date.now() - 14 * 864e5;
    const mine = db.requests.filter((r) => r.from_person === ui.who && (r.status === 'pending' || new Date(r.answered_at || r.created_at).getTime() > recent))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const incoming = incomingTrades(ui.who);
    const myItems = listOf(ui.who).filter((c) => !(c.kind === 'once' && everChecked(c)));
    const broItems = bro ? listOf(bro.id).filter((c) => !(c.kind === 'once' && everChecked(c))) : [];
    const opt = (c, sel) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`;
    return `
      ${incoming.length ? `<h2>${esc(bro.name)} asked</h2>${incoming.map((r) => `
        <div class="card">
          <p style="margin-top:0">${requestLine(r)}</p>
          <div class="row"><button class="btn" data-action="trade-yes" data-id="${r.id}">Yes, I'd trade</button><button class="btn plain" data-action="trade-no" data-id="${r.id}">No thanks</button></div>
        </div>`).join('')}` : ''}

      <h2>Suggest a new contribution</h2>
      <form class="card" data-form="suggest" data-action="suggest">
        <label for="sg-name">What would you like to do?</label>
        <input id="sg-name" name="name" required maxlength="80" value="${esc(draft('suggest', 'name'))}">
        <label for="sg-why">Why it matters (if you like)</label>
        <input id="sg-why" name="why" maxlength="160" value="${esc(draft('suggest', 'why'))}">
        <label for="sg-kind">How often</label>
        <select id="sg-kind" name="kind">${['daily', 'weekly', 'once'].map((k) => `<option value="${k}" ${draft('suggest', 'kind', 'weekly') === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
        <div class="row end" style="margin-top:14px"><button class="btn" type="submit">Send to Mom</button></div>
      </form>

      ${bro ? `<h2>Ask ${esc(bro.name)} to trade</h2>
      <form class="card" data-form="trade" data-action="trade">
        <label for="tr-give">One of mine</label>
        <select id="tr-give" name="give" required><option value="">Choose…</option>${myItems.map((c) => opt(c, draft('trade', 'give'))).join('')}</select>
        <label for="tr-take">For one of ${esc(bro.name)}'s</label>
        <select id="tr-take" name="take" required><option value="">Choose…</option>${broItems.map((c) => opt(c, draft('trade', 'take'))).join('')}</select>
        <p class="muted small">${esc(bro.name)} and Mom both say yes before anything changes.</p>
        <div class="row end"><button class="btn" type="submit">Ask</button></div>
      </form>` : ''}

      <h2>What I asked</h2>
      ${mine.length ? `<div class="list">${mine.map((r) => `
        <div class="card spread" style="margin:0">
          <div><div>${requestLine(r)}</div><div class="muted small">${requestStatus(r)}</div></div>
          ${r.status === 'pending' ? `<button class="btn plain" data-action="withdraw" data-id="${r.id}">Take it back</button>` : ''}
        </div>`).join('')}</div>` : `<p class="empty">${esc(text('nothing_yet'))}</p>`}`;
  }

  // ----- PIN -----
  function viewPin() {
    const setting = ui.pinMode === 'set' || ui.pinMode === 'confirm';
    const title = ui.pinMode === 'set' ? 'Choose a Mom PIN' : ui.pinMode === 'confirm' ? 'Type it once more' : 'Mom PIN';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    return `${top('Mom')}
      <div class="pin-pad">
        <h2 style="color:var(--ink)">${title}</h2>
        ${setting ? '<p class="muted small">4 to 8 numbers. Only for Mom.</p>' : ''}
        <div class="pin-dots" aria-label="${ui.pin.length} numbers typed">${'•'.repeat(ui.pin.length) || '&nbsp;'}</div>
        ${ui.pinMsg ? `<p class="muted">${esc(ui.pinMsg)}</p>` : ''}
        <div class="keys">${keys.map((k) => k ? `<button data-action="pin-key" data-k="${k}" aria-label="${k === '⌫' ? 'delete' : k}">${k}</button>` : '<span></span>').join('')}</div>
        <button class="btn" style="width:100%;margin-top:14px" data-action="pin-go" ${ui.pin.length >= 4 ? '' : 'disabled'}>OK</button>
      </div>`;
  }

  async function openMomGate(next) {
    if (ui.momPin) { go(next); return; }
    go({ screen: 'pin', pin: '', pinMsg: '', pinNext: next, pinMode: 'enter' });
    const r = await rpc('pin_is_set', {});
    if (r.error) { ui.pinMsg = 'Mom mode needs the internet for a moment.'; render(true); return; }
    if (!r.data) { ui.pinMode = 'set'; render(true); }
  }

  async function pinGo() {
    const pin = ui.pin;
    if (ui.pinMode === 'enter') {
      const r = await rpc('check_pin', { pin });
      if (r.error) { ui.pin = ''; ui.pinMsg = r.error === 'net' ? 'Mom mode needs the internet for a moment.' : 'That didn\'t work.'; return render(true); }
      if (!r.data) { ui.pin = ''; ui.pinMsg = 'That PIN didn\'t match.'; return render(true); }
      ui.momPin = pin;
      go(ui.pinNext || { screen: 'mom' });
    } else if (ui.pinMode === 'set') {
      ui.pinOld = pin; ui.pin = ''; ui.pinMode = 'confirm'; ui.pinMsg = ''; render(true);
    } else if (ui.pinMode === 'confirm') {
      if (pin !== ui.pinOld) { ui.pin = ''; ui.pinMode = 'set'; ui.pinMsg = 'Those were different. Try again.'; return render(true); }
      const r = await rpc('set_pin', { old_pin: '', new_pin: pin });
      if (r.error || !r.data) { ui.pin = ''; ui.pinMode = 'set'; ui.pinMsg = r.error === 'net' ? 'Needs the internet for a moment.' : 'That didn\'t save. Try again.'; return render(true); }
      ui.momPin = pin;
      go(ui.pinNext || { screen: 'mom' });
    }
  }

  // ----- Mom mode -----
  function viewMom() {
    const tabs = [['requests', 'Requests'], ['lists', 'Lists'], ['ideas', 'Ideas'], ['hard', 'Feels hard'], ['settings', 'Settings']];
    const waiting = db.requests.some((r) => r.status === 'pending');
    let body = '';
    if (ui.momTab === 'requests') body = viewMomRequests();
    if (ui.momTab === 'lists') body = viewMomLists();
    if (ui.momTab === 'ideas') body = viewMomIdeas();
    if (ui.momTab === 'hard') body = viewMomHard();
    if (ui.momTab === 'settings') body = viewMomSettings();
    return `${top('Mom')}
      ${testOffset() ? `<div class="test-bar">Test date is on: ${esc(fmtDay(dayStr()))}, ${esc(new Date(now()).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }))}. <button class="btn warm" style="min-height:40px;padding:6px 14px;margin-left:6px" data-action="test-clear">Back to real time</button></div>` : ''}
      <div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" aria-selected="${ui.momTab === id}" data-action="mom-tab" data-tab="${id}">${label}${id === 'requests' && waiting ? '<span class="dot" aria-label="waiting for you"></span>' : ''}</button>`).join('')}</div>
      ${ui.msg ? `<div class="note-bar" role="status">${esc(ui.msg)}</div>` : ''}
      ${body}`;
  }

  function viewMomRequests() {
    const pending = db.requests.filter((r) => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const done = db.requests.filter((r) => r.status !== 'pending').sort((a, b) => (b.answered_at || '').localeCompare(a.answered_at || '')).slice(0, 12);
    const card = (r) => {
      const waitingBro = r.kind === 'trade' && r.partner === 'waiting';
      const extra = r.kind === 'suggest' && r.why ? `<div class="muted small">${esc(r.why)} · ${KIND_LABEL[r.contribution_kind] || ''}</div>` : '';
      return `<div class="card">
        <div class="muted small">${esc(person(r.from_person).name)}</div>
        <div style="margin:4px 0 8px">${requestLine(r)}</div>${extra}
        ${waitingBro ? `<p class="muted small">Waiting for ${esc(person(r.to_person).name)} to agree first.</p>` : ''}
        <div class="row" style="margin-top:8px">
          <button class="btn" data-action="answer" data-id="${r.id}" data-yes="1" ${waitingBro ? 'disabled' : ''}>Yes</button>
          <button class="btn plain" data-action="answer" data-id="${r.id}" data-yes="0">Not this time</button>
        </div></div>`;
    };
    return `<h2>Waiting for you</h2>${pending.length ? pending.map(card).join('') : `<p class="empty">${esc(text('nothing_yet'))}</p>`}
      ${done.length ? `<h2>Answered</h2><ul class="history">${done.map((r) => `<li><span>${esc(person(r.from_person).name)}: ${requestLine(r)}</span><span class="muted small" style="margin-left:auto">${requestStatus(r)}</span></li>`).join('')}</ul>` : ''}`;
  }

  function editForm(table, row, extra = {}) {
    const f = `edit-${table}-${row.id || 'new'}`;
    const v = (n, d) => esc(draft(f, n, d ?? row[n] ?? ''));
    const kind = draft(f, 'kind', row.kind || 'daily');
    return `<form class="card" data-form="${f}" data-action="save-edit" data-table="${table}" data-id="${row.id || 'new'}" ${extra.person ? `data-person="${esc(extra.person)}"` : ''}>
      <label for="${f}-icon">Picture</label>
      <input id="${f}-icon" class="emoji-input" name="icon" maxlength="8" value="${v('icon')}">
      <div class="emoji-picks">${EMOJI.map((e) => `<button type="button" data-action="pick-emoji" data-form="${f}" data-e="${e}" aria-label="use ${e}">${e}</button>`).join('')}</div>
      <label for="${f}-name">Name</label>
      <input id="${f}-name" name="name" required maxlength="80" value="${v('name')}">
      <label for="${f}-why">Why it matters</label>
      <input id="${f}-why" name="why" maxlength="200" value="${v('why')}">
      <label for="${f}-thanks">Thank-you line (shows when it's checked off)</label>
      <input id="${f}-thanks" name="thanks" maxlength="200" value="${v('thanks')}">
      ${table === 'ideas' ? `<label for="${f}-cat">Group</label><input id="${f}-cat" name="category" maxlength="40" value="${v('category')}">` : ''}
      <label for="${f}-kind">How often</label>
      <select id="${f}-kind" name="kind">${['daily', 'weekly', 'once'].map((k) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
      ${table === 'contributions' ? `<label for="${f}-day">For a weekly one, a set day?</label>
      <select id="${f}-day" name="weekday"><option value="">Any day that week</option>${DAYS.map((d, i) => `<option value="${i}" ${String(draft(f, 'weekday', row.weekday ?? '')) === String(i) ? 'selected' : ''}>${d}</option>`).join('')}</select>` : ''}
      <div class="row end" style="margin-top:16px">
        ${row.id ? `<button type="button" class="btn plain" data-action="remove" data-table="${table}" data-id="${row.id}">Remove</button>` : ''}
        <button type="button" class="btn soft" data-action="cancel-edit">Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div></form>`;
  }

  function momRow(c, table) {
    const editingThis = ui.editing && ui.editing.table === table && ui.editing.id === c.id;
    if (editingThis) return editForm(table, c);
    const k = table === 'contributions' ? currentCheck(c) : null;
    const done = table === 'contributions' && c.kind === 'once' && everChecked(c) && !k;
    return `<div class="item ${k || done ? 'done' : ''}">
      <div class="icon" aria-hidden="true">${esc(c.icon)}</div>
      <div><div class="name">${esc(c.name)}${k ? ' <span class="muted small">✓ checked</span>' : ''}${done ? ' <span class="muted small">done earlier</span>' : ''}</div>
        ${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}
        ${c.thanks ? `<div class="why">“${esc(c.thanks)}”</div>` : `<div class="gentle small">Needs a thank-you line</div>`}
        <span class="tag">${KIND_LABEL[c.kind]}${c.weekday != null && c.kind === 'weekly' ? ' · ' + DAYS[c.weekday] : ''}</span>
        ${table === 'ideas' ? `<div class="row" style="margin-top:8px">${kids().map((p) => `<button class="btn soft" style="min-height:42px;padding:8px 14px" data-action="idea-to" data-id="${c.id}" data-person="${p.id}">Add to ${esc(p.name)}</button>`).join('')}</div>` : ''}
      </div>
      <button class="btn plain" data-action="edit" data-table="${table}" data-id="${c.id}">Edit</button>
    </div>`;
  }

  function viewMomLists() {
    const pid = ui.momPerson || (kids()[0] || {}).id;
    const list = listOf(pid);
    const adding = ui.editing && ui.editing.table === 'contributions' && ui.editing.id === 'new';
    return `<div class="tabs">${kids().map((k) => `<button aria-selected="${k.id === pid}" data-action="mom-person" data-id="${k.id}">${esc(k.name)}</button>`).join('')}</div>
      ${['daily', 'weekly', 'once'].map((kind) => {
        const items = list.filter((c) => c.kind === kind);
        return items.length ? `<h2>${KIND_LABEL[kind]}</h2><div class="list">${items.map((c) => momRow(c, 'contributions')).join('')}</div>` : '';
      }).join('')}
      <h2>Add one</h2>
      ${adding ? editForm('contributions', { kind: 'daily' }, { person: pid }) : `<button class="btn soft" data-action="add" data-table="contributions">Add a contribution for ${esc(person(pid).name)}</button>`}`;
  }

  function viewMomIdeas() {
    const adding = ui.editing && ui.editing.table === 'ideas' && ui.editing.id === 'new';
    let out = `<p class="muted small">Tap “Add to” to put an idea on a list. The idea stays here too.</p>`;
    for (const [cat, items] of groupIdeas()) {
      out += `<h2>${esc(cat || 'Other')}</h2><div class="list">${items.map((i) => momRow(i, 'ideas')).join('')}</div>`;
    }
    return out + `<h2>Add an idea</h2>${adding ? editForm('ideas', { kind: 'weekly' }) : `<button class="btn soft" data-action="add" data-table="ideas">Add an idea</button>`}`;
  }

  function viewMomHard() {
    if (ui.hardFlags === null) { loadHardFlags(); return `<p class="empty">Opening…</p>`; }
    if (ui.hardFlags === 'net') return `<p class="empty">This needs the internet for a moment.</p>`;
    return `<p class="muted small">Only you see this. The boys never see it, and it isn't in family meeting.</p>
      ${kids().map((k) => {
        const flags = ui.hardFlags.filter((f) => f.person_id === k.id);
        return `<h2>${esc(k.name)}</h2>${flags.length ? `<ul class="history">${flags.map((f) => `<li><span>${esc(f.name)}</span><button class="btn plain" style="margin-left:auto;min-height:40px;padding:6px 14px" data-action="clear-flag" data-id="${f.id}">Clear</button></li>`).join('')}</ul>` : `<p class="empty">Nothing here.</p>`}`;
      }).join('')}`;
  }
  async function loadHardFlags() {
    const r = await rpc('mom_hard_flags', { pin: ui.momPin });
    ui.hardFlags = r.error ? 'net' : r.data;
    render(true);
  }

  function viewMomSettings() {
    const s = settings();
    let zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
    try { zones = [...new Set([...zones, ...Intl.supportedValuesOf('timeZone')])]; } catch { /* older browsers */ }
    if (!zones.includes(s.timezone)) zones.unshift(s.timezone);
    const wordKeys = [['welcome', 'Welcome line'], ['pick', 'Name screen heading'], ['unfinished_note', 'Gentle note on an unfinished one'], ['hard_ack', 'Answer to “This one feels hard”'], ['meeting_intro', 'Family meeting line'], ['offline_note', 'Offline note'], ['nothing_yet', 'Empty list words']];
    const testVal = (() => { const p = partsIn(now(), tz()); return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; })();
    return `
      <form class="card" data-form="settings" data-action="save-settings">
        <label for="st-tz">Family timezone</label>
        <select id="st-tz" name="timezone">${zones.map((z) => `<option ${draft('settings', 'timezone', s.timezone) === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
        <label for="st-day">New week starts on</label>
        <select id="st-day" name="reset_day">${DAYS.map((d, i) => `<option value="${i}" ${String(draft('settings', 'reset_day', s.reset_day)) === String(i) ? 'selected' : ''}>${d}</option>`).join('')}</select>
        <div class="row end" style="margin-top:14px"><button class="btn" type="submit">Save</button></div>
      </form>

      <h2>Words</h2>
      <form class="card" data-form="words" data-action="save-words">
        ${wordKeys.map(([k, label]) => `<label for="w-${k}">${label}</label><input id="w-${k}" name="${k}" maxlength="240" value="${esc(draft('words', k, text(k)))}">`).join('')}
        <div class="row end" style="margin-top:14px"><button class="btn" type="submit">Save words</button></div>
      </form>

      <h2>Change Mom PIN</h2>
      <form class="card" data-form="pin" data-action="change-pin">
        <label for="pn-old">Current PIN</label><input id="pn-old" name="old" type="password" inputmode="numeric" autocomplete="off" required>
        <label for="pn-new">New PIN (4 to 8 numbers)</label><input id="pn-new" name="new" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" required>
        <div class="row end" style="margin-top:14px"><button class="btn" type="submit">Change PIN</button></div>
      </form>

      <h2>This device</h2>
      <div class="card"><p style="margin-top:0" class="muted small">Signing out means typing the family email and password again on this device.</p>
        <button class="btn plain" data-action="sign-out">Sign out this device</button></div>

      <details class="card">
        <summary>Testing tools</summary>
        <p class="muted small">Pretend it's another day or time on this device only, to check the morning and weekly clearing. The real dates in the database aren't changed, and the boys never see this.</p>
        <form data-form="testclock" data-action="test-set">
          <label for="tc-when">Pretend it is</label>
          <input id="tc-when" name="when" type="datetime-local" value="${esc(draft('testclock', 'when', testVal))}">
          <div class="row end" style="margin-top:12px">
            <button type="button" class="btn soft" data-action="test-clear">Real time</button>
            <button type="submit" class="btn">Use this time</button>
          </div>
        </form>
      </details>`;
  }

  // ----- family meeting -----
  function viewMeeting() {
    const thisWeek = weekOf(dayStr());
    const week = ui.meetingWeek || thisWeek;
    const end = addDays(week, 6);
    const note = db.weekly_notes.find((n) => n.week_start === week);
    const people = kids();
    const one = ui.meetingPerson || (people[0] || {}).id;
    const shown = ui.meetingSide ? people : people.filter((p) => p.id === one);
    const col = (p) => {
      const done = db.checkoffs.filter((k) => k.person_id === p.id && k.week_start === week)
        .sort((a, b) => a.day.localeCompare(b.day) || a.checked_at.localeCompare(b.checked_at));
      const byDay = new Map();
      for (const k of done) { if (!byDay.has(k.day)) byDay.set(k.day, []); byDay.get(k.day).push(k); }
      const isPastOrLast = week < thisWeek || isLastDayOfWeek();
      const unfinished = isPastOrLast ? listOf(p.id).filter((c) => {
        if (c.kind === 'daily') return false;
        if (c.created_at && c.created_at.slice(0, 10) > end) return false;
        if (c.kind === 'once') return !db.checkoffs.some((k) => k.contribution_id === c.id && k.week_start <= week);
        return !db.checkoffs.some((k) => k.contribution_id === c.id && k.week_start === week);
      }) : [];
      return `<section>
        <h2 style="color:var(--ink);font-size:1.35rem">${esc(p.name)}</h2>
        <h3>Got done this week</h3>
        ${byDay.size ? [...byDay.entries()].map(([d, ks]) => `<p class="muted small" style="margin:12px 0 6px">${esc(fmtDay(d))}</p><ul class="history">${ks.map((k) => `<li><span class="icon" aria-hidden="true">${esc(k.icon)}</span><span>${esc(k.name)}</span></li>`).join('')}</ul>`).join('') : `<p class="empty">${esc(text('nothing_yet'))}</p>`}
        ${unfinished.length ? `<h3>Still on the list</h3><ul class="history">${unfinished.map((c) => `<li><span class="icon" aria-hidden="true">${esc(c.icon)}</span><span>${esc(c.name)}<br><span class="gentle">${esc(text('unfinished_note'))}</span></span></li>`).join('')}</ul>` : ''}
      </section>`;
    };
    return `${top('Family meeting')}
      ${text('meeting_intro') ? `<p class="muted">${esc(text('meeting_intro'))}</p>` : ''}
      <div class="spread" style="margin:8px 0">
        <div class="row">
          <button class="btn plain" data-action="week" data-d="-7" aria-label="week before">‹</button>
          <strong>${esc(fmtDay(week, { month: 'short', day: 'numeric' }))} – ${esc(fmtDay(end, { month: 'short', day: 'numeric' }))}</strong>
          <button class="btn plain" data-action="week" data-d="7" aria-label="week after" ${week >= thisWeek ? 'disabled' : ''}>›</button>
        </div>
        <button class="btn soft only-wide" data-action="meeting-side">${ui.meetingSide ? 'One at a time' : 'Side by side'}</button>
      </div>
      <div class="tabs meeting-people" ${ui.meetingSide ? 'data-side="1"' : ''}>${people.map((p) => `<button aria-selected="${!ui.meetingSide && p.id === one}" data-action="meeting-person" data-id="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      <div class="side ${shown.length > 1 ? 'two' : ''}">${shown.map(col).join('')}</div>

      <h2>This week's note</h2>
      ${ui.noteEditing && ui.momPin ? `<form class="card" data-form="note-${week}" data-action="save-note" data-week="${week}">
          <label for="nt" class="sr">Weekly note</label>
          <textarea id="nt" name="note">${esc(draft('note-' + week, 'note', note ? note.note : ''))}</textarea>
          <div class="row end" style="margin-top:12px"><button type="button" class="btn soft" data-action="note-cancel">Cancel</button><button class="btn" type="submit">Save note</button></div>
        </form>`
        : `<div class="card">${note && note.note ? `<p style="margin-top:0;white-space:pre-wrap">${esc(note.note)}</p>` : `<p class="muted" style="margin-top:0">No note yet.</p>`}
          <button class="btn plain" data-action="note-edit">Write the note (Mom)</button></div>`}
      <div class="card"><p style="margin-top:0" class="muted small">Want to change a list together? That happens in Mom mode.</p>
        <button class="btn soft" data-action="meeting-lists">Change our lists</button></div>`;
  }

  // ---------- events ----------
  // Phones: on narrow screens the meeting shows one boy at a time.
  const narrow = () => window.matchMedia('(max-width: 899px)').matches;

  document.addEventListener('input', (e) => {
    const form = e.target.closest && e.target.closest('form[data-form]');
    if (form && e.target.name) {
      const f = form.dataset.form;
      (ui.forms[f] = ui.forms[f] || {})[e.target.name] = e.target.value;
    }
  });
  document.addEventListener('change', (e) => {
    const form = e.target.closest && e.target.closest('form[data-form]');
    if (form && e.target.name) (ui.forms[form.dataset.form] = ui.forms[form.dataset.form] || {})[e.target.name] = e.target.value;
  });
  document.addEventListener('focusout', () => { setTimeout(() => { if (renderWaiting) render(); }, 0); });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-action]');
    if (!form) return;
    e.preventDefault();
    const act = form.dataset.action;
    const d = Object.fromEntries(new FormData(form).entries());
    document.activeElement && document.activeElement.blur();

    if (act === 'signin') {
      ui.signinMsg = '';
      const making = ui.signinMode === 'make';
      const res = making
        ? await sb.auth.signUp({ email: d.email.trim(), password: d.password, options: { emailRedirectTo: location.href.split('#')[0] } })
        : await sb.auth.signInWithPassword({ email: d.email.trim(), password: d.password });
      if (res.error) { ui.signinMsg = isNetError(res.error) ? 'This needs the internet the first time.' : res.error.message; return render(true); }
      if (making && !res.data.session) { ui.signinMsg = 'Check that email for a link to confirm the account, then sign in here.'; ui.signinMode = 'in'; return render(true); }
      clearForm('signin');
      return;
    }
    if (act === 'setup') {
      const names = [d.kid1, d.kid2].map((n) => (n || '').trim()).filter(Boolean);
      if (!names.length) return;
      const r = await runSetup(names);
      if (r === 'ok') { clearForm('setup'); return go({ screen: 'pick' }); }
      ui.msg = r === 'net' ? 'Setting up needs the internet for a moment.' : 'That didn\'t go through. Try again.';
      return render(true);
    }
    if (act === 'suggest') {
      if (!d.name.trim()) return;
      queue({ type: 'insert', table: 'requests', row: { id: uuid(), kind: 'suggest', from_person: ui.who, status: 'pending', name: d.name.trim(), why: d.why.trim(), contribution_kind: d.kind, created_at: new Date().toISOString() } });
      clearForm('suggest');
      showSheet('', 'Sent to Mom.');
      return render(true);
    }
    if (act === 'trade') {
      const bro = brotherOf(ui.who);
      if (!d.give || !d.take || !bro) return;
      queue({ type: 'insert', table: 'requests', row: { id: uuid(), kind: 'trade', from_person: ui.who, to_person: bro.id, give_id: d.give, take_id: d.take, partner: 'waiting', status: 'pending', created_at: new Date().toISOString() } });
      clearForm('trade');
      showSheet('', `Asked ${bro.name}.`);
      return render(true);
    }
    if (act === 'save-edit') {
      const table = form.dataset.table;
      const id = form.dataset.id;
      const row = { name: d.name.trim(), why: d.why.trim(), thanks: d.thanks.trim(), icon: d.icon.trim(), kind: d.kind };
      if (!row.name) return;
      if (table === 'contributions') row.weekday = d.kind === 'weekly' && d.weekday !== '' ? Number(d.weekday) : null;
      if (table === 'ideas') row.category = (d.category || '').trim();
      if (id === 'new') {
        row.id = uuid();
        if (table === 'contributions') { row.person_id = form.dataset.person; row.sort = listOf(row.person_id).length + 1; row.created_at = new Date().toISOString(); }
        else row.sort = db.ideas.length + 1;
        queue({ type: 'insert', table, row });
      } else {
        queue({ type: 'update', table, id, patch: row });
      }
      clearForm(form.dataset.form);
      ui.editing = null;
      return render(true);
    }
    if (act === 'save-settings') {
      queue({ type: 'update', table: 'settings', id: 1, patch: { timezone: d.timezone, reset_day: Number(d.reset_day), updated_at: new Date().toISOString() } });
      clearForm('settings');
      ui.msg = 'Saved.';
      return render(true);
    }
    if (act === 'save-words') {
      for (const [key, value] of Object.entries(d)) {
        if (value !== text(key)) queue({ type: 'upsert', table: 'texts', key: 'key', row: { key, value } });
      }
      clearForm('words');
      ui.msg = 'Saved.';
      return render(true);
    }
    if (act === 'change-pin') {
      const r = await rpc('set_pin', { old_pin: d.old, new_pin: d.new });
      ui.msg = r.error ? (r.error === 'net' ? 'Needs the internet for a moment.' : 'That PIN needs 4 to 8 numbers.') : r.data ? 'PIN changed.' : 'The current PIN didn\'t match.';
      if (r.data) ui.momPin = d.new;
      return render(true);
    }
    if (act === 'test-set') {
      const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(d.when || '');
      if (!m) return;
      store.set('cc.testOffset', zonedToMs(+m[1], +m[2], +m[3], +m[4], +m[5]) - Date.now());
      clearForm('testclock');
      return render(true);
    }
    if (act === 'save-note') {
      queue({ type: 'upsert', table: 'weekly_notes', key: 'week_start', row: { week_start: form.dataset.week, note: d.note, updated_at: new Date().toISOString() } });
      clearForm(form.dataset.form);
      ui.noteEditing = false;
      return render(true);
    }
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'FORM') return;
    const act = el.dataset.action;
    const id = el.dataset.id;
    const find = (table) => db[table].find((r) => r.id === id);

    switch (act) {
      case 'close-sheet': clearTimeout(sheetTimer); $sheet.innerHTML = ''; return;
      case 'back': {
        if (ui.screen === 'mom' || ui.screen === 'pin') { ui.momPin = null; ui.hardFlags = null; ui.editing = null; }
        return go({ screen: 'pick', who: null });
      }
      case 'signin-mode': ui.signinMode = ui.signinMode === 'make' ? 'in' : 'make'; ui.signinMsg = ''; return render(true);
      case 'open-kid': return go({ screen: 'kid', who: id, tab: 'list' });
      case 'open-mom': return openMomGate({ screen: 'mom', momTab: 'requests' });
      case 'open-meeting': return go({ screen: 'meeting', meetingWeek: null, meetingSide: !narrow(), noteEditing: false });
      case 'tab': return go({ tab: el.dataset.tab });
      case 'toggle': { const c = find('contributions'); if (c && c.person_id === ui.who) toggle(c); return; }
      case 'hard': { const c = find('contributions'); if (c && c.person_id === ui.who) flagHard(c); return; }
      case 'ask-idea':
        queue({ type: 'insert', table: 'requests', row: { id: uuid(), kind: 'idea', from_person: ui.who, idea_id: id, status: 'pending', created_at: new Date().toISOString() } });
        showSheet('', 'Sent to Mom.');
        return;
      case 'withdraw': { const r = find('requests'); if (r && r.from_person === ui.who && r.status === 'pending') queue({ type: 'delete', table: 'requests', id }); return; }
      case 'trade-yes': { const r = find('requests'); if (r && r.to_person === ui.who) queue({ type: 'update', table: 'requests', id, patch: { partner: 'agreed' } }); return; }
      case 'trade-no': { const r = find('requests'); if (r && r.to_person === ui.who) queue({ type: 'update', table: 'requests', id, patch: { partner: 'declined', status: 'not_this_time', answered_at: new Date().toISOString() } }); return; }

      case 'pin-key':
        if (el.dataset.k === '⌫') ui.pin = ui.pin.slice(0, -1);
        else if (ui.pin.length < 8) ui.pin += el.dataset.k;
        return render(true);
      case 'pin-go': return pinGo();

      case 'mom-tab': if (el.dataset.tab === 'hard') ui.hardFlags = null; return go({ momTab: el.dataset.tab, editing: null });
      case 'mom-person': return go({ momPerson: id, editing: null });
      case 'edit': return go({ editing: { table: el.dataset.table, id } });
      case 'add': return go({ editing: { table: el.dataset.table, id: 'new' } });
      case 'cancel-edit': ui.editing = null; ui.forms = Object.fromEntries(Object.entries(ui.forms).filter(([k]) => !k.startsWith('edit-'))); return render(true);
      case 'remove': {
        const table = el.dataset.table;
        const row = find(table);
        if (row && confirm(`Remove “${row.name}”? Past check-offs stay in the family meeting history.`)) {
          queue({ type: 'delete', table, id });
          ui.editing = null;
          render(true);
        }
        return;
      }
      case 'pick-emoji': {
        const f = el.dataset.form;
        (ui.forms[f] = ui.forms[f] || {}).icon = el.dataset.e;
        const input = $app.querySelector(`form[data-form="${f}"] input[name="icon"]`);
        if (input) input.value = el.dataset.e;
        return;
      }
      case 'idea-to': {
        const i = find('ideas');
        const pid = el.dataset.person;
        if (!i) return;
        queue({ type: 'insert', table: 'contributions', row: { id: uuid(), person_id: pid, name: i.name, why: i.why, thanks: i.thanks, icon: i.icon, kind: i.kind, weekday: null, sort: listOf(pid).length + 1, created_at: new Date().toISOString() } });
        ui.msg = `Added “${i.name}” to ${person(pid).name}'s list.`;
        return render(true);
      }
      case 'answer': {
        el.disabled = true;
        const r = await rpc('answer_request', { pin: ui.momPin, request_id: id, yes: el.dataset.yes === '1' });
        ui.msg = r.error ? (r.error === 'net' ? 'Answering needs the internet for a moment.' : 'That didn\'t go through. Try again.') : '';
        await refresh();
        return render(true);
      }
      case 'clear-flag': {
        const r = await rpc('clear_hard_flag', { pin: ui.momPin, flag_id: id });
        if (!r.error) ui.hardFlags = ui.hardFlags.filter((f) => f.id !== id);
        return render(true);
      }
      case 'sign-out':
        if (!confirm('Sign this device out of the family account?')) return;
        await sb.auth.signOut();
        store.del('cc.cache'); store.del('cc.outbox'); outbox = []; db = empty();
        return go({ screen: 'signin', momPin: null });
      case 'test-clear': store.del('cc.testOffset'); clearForm('testclock'); return render(true);

      case 'week': {
        const base = ui.meetingWeek || weekOf(dayStr());
        return go({ meetingWeek: addDays(base, Number(el.dataset.d)), noteEditing: false });
      }
      case 'meeting-side': return go({ meetingSide: !ui.meetingSide });
      case 'meeting-person': return go({ meetingPerson: id, meetingSide: false });
      case 'note-edit': return openMomGate({ screen: 'meeting', noteEditing: true });
      case 'note-cancel': return go({ noteEditing: false });
      case 'meeting-lists': return openMomGate({ screen: 'mom', momTab: 'lists' });
      default:
    }
  });

  // A new day or week starts on its own: redraw each minute.
  let lastDay = null;
  setInterval(() => {
    const d = dayStr();
    if (d !== lastDay) { lastDay = d; if (!renderWaiting) render(); }
  }, 30000);
  window.addEventListener('online', () => { flush(); refresh(); });
  window.addEventListener('offline', () => setOffline(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { flush(); refresh(); } });
  // Safety net if the live connection drops: catch up every 20 seconds while open.
  setInterval(() => { if (outbox.length) flush(); if (document.visibilityState === 'visible') refresh(); }, 20000);

  // ---------- start ----------
  async function onSession(s) {
    const had = !!session;
    session = s;
    if (!s) { if (ui.screen !== 'signin') go({ screen: 'signin' }); return; }
    if (!had) {
      if (ui.screen === 'loading' || ui.screen === 'signin') go({ screen: 'pick' });
      await listen();
      await flush();
      await refresh();
      await seedIfNeeded();
    }
  }

  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'TOKEN_REFRESHED' && s) { session = s; sb.realtime.setAuth(s.access_token); return; }
    setTimeout(() => onSession(s), 0);
  });
  sb.auth.getSession().then(({ data }) => {
    if (data.session) onSession(data.session);
    else if (store.get('cc.auth', null) && !navigator.onLine) { session = { offline: true }; go({ screen: 'pick' }); setOffline(true); }
    else go({ screen: 'signin' });
  });
  lastDay = dayStr();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  // Exposed for the automated checks only.
  window.__cc = { get db() { return db; }, get outbox() { return outbox; }, get rtEvents() { return rtEvents; }, ui };
})();
