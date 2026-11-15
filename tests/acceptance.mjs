// Runs the nine acceptance checks from the builder prompt (plus an offline
// check) against a local Supabase (`supabase start`) and the web/ folder.
// Two separate browser contexts stand in for two devices.
//   cd tests && npm i && node acceptance.mjs
import { chromium } from 'playwright';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

const env = JSON.parse(execSync('supabase status -o json', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
const API = env.API_URL;
const SERVICE = env.SERVICE_ROLE_KEY;
console.log('Resetting the local database…');
execSync('supabase db reset', { cwd: root, stdio: 'ignore' });
// Give the live-updates service a moment to come back after the reset.
for (let i = 0; i < 30; i++) {
  const r = await fetch(`${env.API_URL}/realtime/v1/api/ping`).catch(() => null);
  if (r && r.status < 500) break;
  await new Promise((res) => setTimeout(res, 1000));
}
await new Promise((res) => setTimeout(res, 12000));

const PORT = Number(process.env.CC_PORT || 8791);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: path.join(root, 'web'), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const URL_ = `http://127.0.0.1:${PORT}/`;

const EMAIL = 'family@example.com';
const PASSWORD = 'family-test-pass';
const PIN = '2468';
const results = [];
const pass = (n, what) => { results.push([n, true, what]); console.log(`PASS ${n}: ${what}`); };
const fail = (n, what) => { results.push([n, false, what]); console.log(`FAIL ${n}: ${what}`); };
const check = (n, ok, what) => (ok ? pass(n, what) : fail(n, what));

async function rest(pathq) {
  const r = await fetch(`${API}/rest/v1/${pathq}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return r.json();
}

const browser = await chromium.launch({ channel: 'chrome' });
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const computer = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const A = await phone.newPage();
const B = await computer.newPage();
for (const p of [A, B]) {
  p.on('dialog', (d) => d.accept());
  p.on('pageerror', (e) => console.log('page error:', e.message));
}
const T = 12000;
const shot = (p, name) => p.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
const box = (p, name) => p.getByRole('checkbox', { name, exact: true }).first();
const toPick = async (p) => { if (await p.locator('.back').count()) await p.locator('.back').click(); await p.getByRole('button', { name: 'Family meeting' }).waitFor({ timeout: T }); };
const openKid = async (p, name) => { await toPick(p); await p.locator('.person', { hasText: name }).click(); await p.getByRole('tab', { name: 'My list' }).waitFor(); };
async function openMom(p, tab) {
  await toPick(p);
  await p.locator('.person.mom').click();
  await p.locator('.pin-pad').waitFor();
  const type = async () => { for (const k of PIN) await p.locator(`.keys button[data-k="${k}"]`).click(); await p.getByRole('button', { name: 'OK' }).click(); };
  await type();
  if (await p.getByText('Type it once more').isVisible().catch(() => false)) await type();
  await p.getByRole('tab', { name: 'Requests' }).waitFor({ timeout: T });
  if (tab) await p.getByRole('tab', { name: tab }).click();
}
async function setTestClock(p, isoLocal) {
  await openMom(p, 'Settings');
  await p.locator('details summary', { hasText: 'Testing tools' }).click();
  await p.locator('#tc-when').fill(isoLocal);
  await p.getByRole('button', { name: 'Use this time' }).click();
  await p.locator('.test-bar').waitFor();
}
const familyDay = (offsetDays = 0) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(Date.now() + offsetDays * 864e5));
};

try {
  // ---- setup: Mom makes the family account on the phone, the computer signs in ----
  await A.goto(URL_);
  await A.getByRole('button', { name: 'First time? Make the family account' }).click();
  await A.fill('#em', EMAIL); await A.fill('#pw', PASSWORD);
  await A.getByRole('button', { name: 'Make the account' }).click();
  // First run: Mom types the kids' names (they live only in the database).
  await A.locator('#su-1').fill('Avery');
  await A.locator('#su-2').fill('Sam');
  await A.getByRole('button', { name: 'Start' }).click();
  await A.locator('.person', { hasText: 'Avery' }).waitFor({ timeout: T });
  await B.goto(URL_);
  await B.fill('#em', EMAIL); await B.fill('#pw', PASSWORD);
  await B.getByRole('button', { name: 'Sign in' }).click();
  await B.locator('.person', { hasText: 'Avery' }).waitFor({ timeout: T });
  await A.waitForTimeout(5000); // let both devices' live connections settle
  await shot(A, '01-phone-names');

  // ---- 1. check on one device, see it on the other (both directions) ----
  await openKid(A, 'Avery');
  await openKid(B, 'Avery');
  await box(A, 'Do the dishes').click();
  const thanks = await A.locator('.sheet').innerText();
  await shot(A, '02-phone-kid-thanks');
  await B.waitForFunction(() => document.querySelector('[aria-label="Do the dishes"]')?.getAttribute('aria-checked') === 'true', null, { timeout: T }).catch(() => {});
  const seenOnB = await box(B, 'Do the dishes').getAttribute('aria-checked');
  await box(B, 'Tidy your room').click();
  await A.waitForFunction(() => document.querySelector('[aria-label="Tidy your room"]')?.getAttribute('aria-checked') === 'true', null, { timeout: T }).catch(() => {});
  const seenOnA = await box(A, 'Tidy your room').getAttribute('aria-checked');
  check(1, seenOnB === 'true' && seenOnA === 'true', `phone check showed on computer (${seenOnB}); computer check showed on phone (${seenOnA})`);
  check('1b', thanks.includes('The dishes are done. Now we have room to cook dinner.'), `stored thank-you line shown: "${thanks.trim()}"`);
  await shot(B, '03-computer-kid');

  // ---- 4. un-check in the same period leaves no trace ----
  await box(A, 'Tidy your room').click();
  await A.waitForFunction(() => document.querySelector('[aria-label="Tidy your room"]')?.getAttribute('aria-checked') === 'false');
  await A.waitForTimeout(1500);
  const tidy = (await rest('contributions?person_id=eq.kid1&name=eq.Tidy%20your%20room&select=id'))[0];
  const tidyRows = await rest(`checkoffs?contribution_id=eq.${tidy.id}&select=id`);
  await B.waitForFunction(() => document.querySelector('[aria-label="Tidy your room"]')?.getAttribute('aria-checked') === 'false', null, { timeout: T }).catch(() => {});
  const tidyB = await box(B, 'Tidy your room').getAttribute('aria-checked');
  check(4, tidyRows.length === 0 && tidyB === 'false', `after un-check: ${tidyRows.length} history rows in the database, computer shows checked=${tidyB}`);

  // ---- offline: check while offline, note shows, syncs when back ----
  await computer.setOffline(true);
  await box(B, 'General tidy').click();
  const note = await B.locator('.note-bar').innerText().catch(() => '');
  await B.waitForTimeout(1200);
  const whileOff = await box(A, 'General tidy').getAttribute('aria-checked');
  await computer.setOffline(false);
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await A.waitForFunction(() => document.querySelector('[aria-label="General tidy"]')?.getAttribute('aria-checked') === 'true', null, { timeout: T }).catch(() => {});
  const afterOn = await box(A, 'General tidy').getAttribute('aria-checked');
  check('offline', note.includes("Will sync when you're back online.") && whileOff === 'false' && afterOn === 'true',
    `offline note "${note.trim()}"; phone saw it while offline=${whileOff}; after reconnect=${afterOn}`);

  // ---- 5. "This one feels hard" goes to Mom only ----
  const listBefore = await A.locator('.list').first().innerHTML();
  await A.locator('.item', { hasText: 'Clean the porch' }).getByRole('button', { name: 'This one feels hard' }).click();
  const ack = await A.locator('.sheet').innerText();
  const listAfter = await A.locator('.list').first().innerHTML();
  await A.waitForTimeout(1000);
  const cacheHasFlags = await A.evaluate(() => JSON.stringify(window.__cc.db).includes('hard_flag'));
  // The family account itself cannot read the flags table directly.
  const direct = await A.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('cc.auth'));
    const r = await fetch(`${window.CC_CONFIG.supabaseUrl}/rest/v1/hard_flags?select=*`, { headers: { apikey: window.CC_CONFIG.supabaseKey, Authorization: `Bearer ${s.access_token}` } });
    return { status: r.status, body: await r.text() };
  });
  const boysText = [];
  for (const kid of ['Avery', 'Sam']) {
    await openKid(B, kid);
    for (const tab of await B.getByRole('tab').allInnerTexts()) { await B.getByRole('tab', { name: tab.trim() }).click(); boysText.push(await B.locator('#app').innerText()); }
  }
  await toPick(B); await B.getByRole('button', { name: 'Family meeting' }).click();
  const meetingText = await B.locator('#app').innerText();
  await openMom(A, 'Feels hard');
  await A.locator('.history li', { hasText: 'Clean the porch' }).waitFor({ timeout: T });
  const momFlags = await A.locator('#app').innerText();
  const leaks = [...boysText, meetingText].some((t) => /feels hard\b(?!\n)/i.test(t.replace(/This one feels hard/g, '')) || /Thanks for saying so/.test(t));
  check(5, ack.includes('Thanks for saying so.') && listBefore === listAfter && !cacheHasFlags && !leaks && /Avery[\s\S]*Clean the porch/.test(momFlags) && (direct.status >= 400 || direct.body === '[]'),
    `ack="${ack.trim()}", boy's list unchanged=${listBefore === listAfter}, shows in Mom mode=${/Clean the porch/.test(momFlags)}, in boys/meeting screens=${leaks}, direct read by family account → ${direct.status} ${direct.body.slice(0, 60)}`);
  await shot(A, '04-phone-mom-feels-hard');

  // ---- 7. edit a why line, reload + re-run seeding: edit survives ----
  await A.getByRole('tab', { name: 'Lists' }).click();
  await A.locator('.item', { hasText: 'Do the dishes' }).getByRole('button', { name: 'Edit' }).click();
  const newWhy = 'So we have clean dishes and room to cook together.';
  await A.locator('form[data-action="save-edit"] input[name="why"]').fill(newWhy);
  await A.locator('form[data-action="save-edit"]').getByRole('button', { name: 'Save' }).click();
  await A.waitForTimeout(1200);
  const reseed = await A.evaluate(async () => {
    const payload = await (await fetch('seed/seed.json')).json();
    const s = JSON.parse(localStorage.getItem('cc.auth'));
    const r = await fetch(`${window.CC_CONFIG.supabaseUrl}/rest/v1/rpc/seed_family`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: window.CC_CONFIG.supabaseKey, Authorization: `Bearer ${s.access_token}` }, body: JSON.stringify({ payload }) });
    return r.text();
  });
  await A.reload();
  await openKid(A, 'Avery');
  const whyShown = await A.locator('.item', { hasText: 'Do the dishes' }).locator('.why').innerText();
  const whyDb = (await rest('contributions?person_id=eq.kid1&name=eq.Do%20the%20dishes&select=why'))[0].why;
  const dishCount = (await rest('contributions?person_id=eq.kid1&name=eq.Do%20the%20dishes&select=id')).length;
  check(7, whyShown === newWhy && whyDb === newWhy && reseed === 'false' && dishCount === 1, `after reload + second seed run (returned ${reseed}): page shows "${whyShown}", database has "${whyDb}", no duplicate rows (${dishCount})`);

  // ---- 8. requests: suggestion, idea, trade ----
  await A.getByRole('tab', { name: 'Ask' }).click();
  await A.fill('#sg-name', 'Sweep the front steps');
  await A.fill('#sg-why', 'So nobody slips.');
  await A.getByRole('button', { name: 'Send to Mom' }).click();
  await A.getByRole('tab', { name: 'Ideas' }).click();
  await A.locator('.item', { hasText: 'Bring in the mail' }).getByRole('button', { name: 'Ask' }).click();
  await A.getByRole('tab', { name: 'Ask' }).click();
  const porch = (await rest('contributions?person_id=eq.kid1&name=eq.Clean%20the%20porch&select=id'))[0].id;
  const sheets = (await rest('contributions?person_id=eq.kid2&name=eq.Wash%20your%20sheets&select=id'))[0].id;
  await A.selectOption('#tr-give', porch);
  await A.selectOption('#tr-take', sheets);
  await A.locator('form[data-action="trade"]').getByRole('button', { name: 'Ask' }).click();
  // a second trade Sam will turn down, and a request Avery takes back
  await A.selectOption('#tr-give', (await rest('contributions?person_id=eq.kid1&name=eq.Wash%20your%20clothes&select=id'))[0].id);
  await A.selectOption('#tr-take', (await rest('contributions?person_id=eq.kid2&name=eq.Clean%20the%20living%20room&select=id'))[0].id);
  await A.locator('form[data-action="trade"]').getByRole('button', { name: 'Ask' }).click();
  await A.fill('#sg-name', 'Wash the car');
  await A.getByRole('button', { name: 'Send to Mom' }).click();
  await A.waitForTimeout(1500);
  await shot(A, '05-phone-kid-ask');
  await A.locator('.card', { hasText: 'Wash the car' }).getByRole('button', { name: 'Take it back' }).click();
  await A.waitForTimeout(1200);
  const pendingDb = await rest('requests?status=eq.pending&select=kind,name,partner');
  await openMom(A, 'Requests');
  const momReq = await A.locator('#app').innerText();
  const yesDisabled = await A.locator('.card', { hasText: 'Clean the porch' }).getByRole('button', { name: 'Yes' }).isDisabled();
  check('8a', pendingDb.length === 4 && /Sweep the front steps/.test(momReq) && /Bring in the mail/.test(momReq) && /Trade/.test(momReq) && !/Wash the car/.test(momReq),
    `pending in Mom mode: ${pendingDb.map((r) => r.kind + (r.name ? ':' + r.name : '')).join(', ')}; withdrawn one gone`);
  check('8b', yesDisabled, 'Mom cannot approve the trade before Sam agrees');

  await openKid(B, 'Sam');
  await B.getByRole('tab', { name: /Ask/ }).click();
  await B.locator('.card', { hasText: 'Wash your clothes' }).getByRole('button', { name: 'No thanks' }).click();
  await B.locator('.card', { hasText: 'Clean the porch' }).getByRole('button', { name: "Yes, I'd trade" }).click();
  await B.waitForTimeout(1500);
  const beforeApprove = (await rest(`contributions?id=eq.${porch}&select=person_id`))[0].person_id;
  await A.waitForFunction(() => { const c = [...document.querySelectorAll('.card')].find((x) => x.innerText.includes('Clean the porch')); return c && !c.querySelector('[data-yes="1"]').disabled; }, null, { timeout: T });
  await shot(A, '06-phone-mom-requests');
  await A.locator('.card', { hasText: 'Clean the porch' }).getByRole('button', { name: 'Yes' }).click();
  await A.waitForTimeout(1500);
  const afterPorch = (await rest(`contributions?id=eq.${porch}&select=person_id`))[0].person_id;
  const afterSheets = (await rest(`contributions?id=eq.${sheets}&select=person_id`))[0].person_id;
  const declined = await rest('requests?partner=eq.declined&select=status');
  const clothesOwner = (await rest('contributions?name=eq.Wash%20your%20clothes&select=person_id&order=person_id')).map((r) => r.person_id).join(',');
  check('8c', beforeApprove === 'kid1' && afterPorch === 'kid2' && afterSheets === 'kid1',
    `trade: before Mom's yes porch belonged to ${beforeApprove}; after: porch → ${afterPorch}, sheets → ${afterSheets}`);
  check('8d', declined.length === 1 && declined[0].status === 'not_this_time' && clothesOwner === 'kid1,kid2', `trade Sam declined: status ${declined[0]?.status}, nothing moved (${clothesOwner})`);
  // Mom says yes to the suggestion and the idea
  for (const t of ['Sweep the front steps', 'Bring in the mail']) {
    await A.locator('.card', { hasText: t }).getByRole('button', { name: 'Yes' }).click();
    await A.waitForTimeout(800);
  }
  const firstKidNames = (await rest('contributions?person_id=eq.kid1&select=name')).map((r) => r.name);
  check('8e', firstKidNames.includes('Sweep the front steps') && firstKidNames.includes('Bring in the mail'), 'approved suggestion and idea now on Avery\'s list');

  // ---- 3. one-time contribution ----
  await A.getByRole('tab', { name: 'Lists' }).click();
  await A.getByRole('button', { name: /Add a contribution for Avery/ }).click();
  const f = A.locator('form[data-action="save-edit"]');
  await f.locator('input[name="name"]').fill('Carry in firewood');
  await f.locator('input[name="why"]').fill('So the house stays warm tonight.');
  await f.locator('input[name="thanks"]').fill('The firewood is in. The house will stay warm tonight.');
  await f.locator('select[name="kind"]').selectOption('once');
  await f.getByRole('button', { name: 'Save' }).click();
  await A.waitForTimeout(800);
  await openKid(A, 'Avery');
  const inActiveBefore = await A.locator('h2:has-text("Just this once") + .list').innerText().catch(() => '');
  await box(A, 'Carry in firewood').click();
  await A.waitForTimeout(1000);
  const activeAfter = await A.locator('h2:has-text("Just this once") + .list').innerText().catch(() => '');
  const doneList = await A.locator('h2:has-text("Done this week") + .list').innerText().catch(() => '');
  await toPick(A); await A.getByRole('button', { name: 'Family meeting' }).click();
  const meetOnce = await A.locator('#app').innerText();
  check(3, inActiveBefore.includes('Carry in firewood') && !activeAfter.includes('Carry in firewood') && doneList.includes('Carry in firewood') && /Carry in firewood/.test(meetOnce),
    `one-time: was in active list, left it after check, in "Done this week", in this week's family meeting history`);

  // ---- 9. test clock can't be seen or reached from a boy's view ----
  const boyScreens = [];
  for (const kid of ['Avery', 'Sam']) {
    await openKid(A, kid);
    for (const tab of await A.getByRole('tab').allInnerTexts()) { await A.getByRole('tab', { name: tab.trim() }).click(); boyScreens.push(await A.locator('body').innerHTML()); }
  }
  const tcInBoys = boyScreens.some((h) => /Testing tools|tc-when|test-bar|Pretend it is/.test(h));

  // ---- 2. daily reset with the test clock; yesterday stays in history ----
  const today = familyDay(0);
  const tomorrow = familyDay(1);
  await setTestClock(A, `${tomorrow}T06:30`);
  await openKid(A, 'Avery');
  const testBarInBoy = await A.locator('.test-bar').count();
  const dishesNow = await box(A, 'Do the dishes').getAttribute('aria-checked');
  await shot(A, '07-phone-kid-next-day');
  await toPick(A); await A.getByRole('button', { name: 'Family meeting' }).click();
  await A.getByRole('button', { name: 'Avery' }).click();
  let hist = await A.locator('#app').innerText();
  const todayLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!hist.includes(todayLabel)) { await A.getByRole('button', { name: 'week before' }).click(); hist = await A.locator('#app').innerText(); }
  const yesterdayListed = new RegExp(`${todayLabel}[\\s\\S]*Do the dishes`).test(hist);
  check(2, dishesNow === 'false' && yesterdayListed, `next day: "Do the dishes" checked=${dishesNow}; still listed under ${todayLabel} in family meeting=${yesterdayListed}`);
  check(9, !tcInBoys && testBarInBoy === 0, `test clock in any boy screen=${tcInBoys}; test banner in boy view while on=${testBarInBoy}`);

  // weekly reset: jump 8 days; weekly + one-time cleared, past week still in history
  await setTestClock(A, `${familyDay(8)}T07:00`);
  await openKid(A, 'Avery');
  const gt = await box(A, 'General tidy').getAttribute('aria-checked');
  const firewoodGone = !(await A.locator('#app').innerText()).includes('Carry in firewood');
  await toPick(A); await A.getByRole('button', { name: 'Family meeting' }).click();
  await A.getByRole('button', { name: 'Avery' }).click();
  let weeks = 0; let pastWeek = '';
  while (weeks < 3 && !/Carry in firewood/.test(pastWeek)) { await A.getByRole('button', { name: 'week before' }).click(); pastWeek = await A.locator('#app').innerText(); weeks++; }
  check('2b', gt === 'false' && firewoodGone && /Carry in firewood/.test(pastWeek) && /Do the dishes/.test(pastWeek), 'a week later: lists cleared, one-time gone for good, last week still in family meeting');

  // ---- 6. no scores, praise, or "chores" anywhere ----
  const texts = [];
  const grab = async (p) => texts.push(await p.locator('body').innerText());
  await toPick(A); await grab(A);
  await A.getByRole('button', { name: 'Family meeting' }).click(); await grab(A);
  for (const kid of ['Avery', 'Sam']) {
    await openKid(A, kid);
    for (const tab of await A.getByRole('tab').allInnerTexts()) { await A.getByRole('tab', { name: tab.trim() }).click(); await grab(A); }
  }
  await toPick(B); await B.getByRole('button', { name: 'Family meeting' }).click(); await grab(B); await shot(B, '08-computer-meeting');
  await openMom(A);
  for (const tab of ['Requests', 'Lists', 'Ideas', 'Feels hard', 'Settings']) {
    await A.getByRole('tab', { name: tab }).click(); await A.waitForTimeout(300);
    if (tab === 'Settings') await A.locator('details summary').click();
    await grab(A);
  }
  await A.getByRole('tab', { name: 'Lists' }).click();
  await A.locator('.item').first().getByRole('button', { name: 'Edit' }).click(); await grab(A);
  const banned = /\bpoints?\b|\bstreaks?\b|\bbadges?\b|good job|great job|well done|awesome|super ?star|\bchores?\b|\bleaderboard|\bscores?\b|\bprize|\bsticker|\breward|\bpercent|%|\b\d+\s*(of|\/|out of)\s*\d+\b|progress|\btotal|\bdone:\s*\d|\bcompleted\s*\d/i;
  const hits = texts.flatMap((t) => t.split('\n').filter((l) => banned.test(l)));
  const srcFiles = ['web/index.html', 'web/app.js', 'web/seed/seed.json', 'web/manifest.webmanifest'].map((f) => readFileSync(path.join(root, f), 'utf8'));
  const srcChores = srcFiles.some((s) => /chores?\b/i.test(s));
  const progressEls = await A.locator('progress, meter, [role="progressbar"]').count();
  check(6, hits.length === 0 && !srcChores && progressEls === 0, `screens scanned: ${texts.length}; lines flagged: ${hits.length ? JSON.stringify(hits.slice(0, 5)) : 'none'}; "chores" in source: ${srcChores}; progress elements: ${progressEls}`);

  await A.locator('[data-action="test-clear"]').first().click().catch(() => {});
} catch (e) {
  console.log('STOPPED:', e.message);
  results.push(['run', false, e.message]);
  await shot(A, 'zz-error-phone').catch(() => {});
  await shot(B, 'zz-error-computer').catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
