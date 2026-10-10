// Real UI acceptance on the built app, using an already installed Playwright.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/usr/sbin/chromium' });
const base = process.env.VOTE_TEST_URL ?? 'http://127.0.0.1:3193';
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await context.addInitScript(() => {
    const Native = window.WebSocket; window.__sockets = [];
    window.WebSocket = class extends Native { constructor(...args) { super(...args); window.__sockets.push(this); } };
  });
  const host = await context.newPage();
  host.on('pageerror', e => errors.push(e.message));
  await host.goto(base);
  await host.getByRole('button', { name: 'Create a room', exact: true }).click();
  await host.locator('.room-code').waitFor();
  const code = await host.locator('.room-code').textContent();
  const join = async (name, table = false) => {
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?code=${code}`);
    await page.getByRole('textbox', { name: 'Your name' }).fill(name);
    if (table) await page.getByRole('button', { name: 'I’m judging', exact: true }).click();
    await page.getByRole('button', { name: 'Sit down', exact: true }).click();
    await page.locator('.player-list__name').filter({ hasText: name }).waitFor();
    return page;
  };
  const guest = await join('ChefWithTwentyFourChars!');
  const first = await join('Diner A', true); const second = await join('Diner B', true);
  await host.locator('#draft-vegetarian').check();
  await host.getByRole('button', { name: 'Start draft', exact: true }).click();
  const raw = (page, event, payload) => page.evaluate(({event,payload}) => window.__sockets.find(ws => ws.readyState === 1).send(`42${JSON.stringify([event,payload])}`), {event,payload});
  for (let i = 0; i < 10; i++) {
    await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
    await host.waitForFunction(n => {
      const list = [...document.querySelectorAll('.dish__items li')];
      return document.querySelector('.shot-clock') || list.length >= n;
    }, i + 1);
    if (await host.locator('.shot-clock').count()) await raw(host, 'draft:take-it', { code, chef: 'chefOne' });
    await host.waitForFunction(n => document.querySelectorAll('.dish__items li').length === n, i + 1);
  }
  for (const page of [host, guest, first, second]) await page.getByText('Waiting for the vote to open', { exact: true }).waitFor();
  assert.equal(await first.locator('.vegetarian-badge').count(), 2);
  assert.equal(await first.locator('.vote-dish .dish__items li').count(), 10);
  assert.equal(await guest.getByRole('button', { name: 'Open voting', exact: true }).count(), 0);
  assert.equal(await first.locator('[data-vote]:enabled').count(), 0);
  await host.getByRole('button', { name: 'Open voting', exact: true }).click();
  await first.locator('[data-vote="chefOne"]:enabled').waitFor();
  assert.equal(await host.locator('[data-vote]:enabled').count(), 0); // Table exists: chefs watch.
  await first.locator('[data-vote="chefOne"]').click();
  await first.getByText('Vote locked in — anonymous', { exact: true }).waitFor();
  assert.equal(await first.locator('[data-vote]:enabled').count(), 0);
  assert.equal(await second.locator('.vote-count').count(), 0); // No intermediate tally signal.
  await second.locator('[data-vote="chefOne"]:enabled').click();
  for (const page of [host, guest, first, second]) await page.getByRole('heading', { name: 'The table picks Host’s dish' }).waitFor();
  assert.deepEqual(await first.locator('.vote-count').allTextContents(), ['2 votes', '0 votes']);
  const measurements = [];
  for (const width of [320, 360, 390, 414, 768, 1280]) {
    await first.setViewportSize({ width, height: 800 });
    const result = await first.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      smallTargets: [...document.querySelectorAll('button,input,select')].filter(n => { const r = n.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(n => n.textContent),
      clipped: [...document.querySelectorAll('.vote-screen *')].filter(n => { const r = n.getBoundingClientRect(); return r.width && (r.right > innerWidth + .5 || r.left < -.5); }).map(n => n.className),
    }));
    assert.equal(result.overflow, 0); assert.deepEqual(result.smallTargets, []); assert.deepEqual(result.clipped, []);
    measurements.push(result);
  }
  await first.setViewportSize({ width: 360, height: 800 });
  // Prove the overflow detector fires before trusting the clean measurements.
  assert.equal(await first.evaluate(() => { const probe = document.createElement('div'); probe.id = 'overflow-probe'; probe.style.cssText = `width: ${innerWidth + 5}px; height: 1px`; document.body.append(probe); return document.documentElement.scrollWidth - innerWidth; }), 5);
  await first.evaluate(() => document.querySelector('#overflow-probe').remove());
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  // Exercise a real two-chef tie in a second room.
  const tieHost = await context.newPage(); await tieHost.goto(base);
  await tieHost.getByRole('button', { name: 'Create a room', exact: true }).click();
  await tieHost.locator('.room-code').waitFor();
  const tieCode = await tieHost.locator('.room-code').textContent();
  const tieGuest = await context.newPage(); await tieGuest.goto(`${base}/?code=${tieCode}`);
  await tieGuest.getByRole('textbox', { name: 'Your name' }).fill('Second Chef');
  await tieGuest.getByRole('button', { name: 'Sit down', exact: true }).click();
  await tieHost.getByRole('button', { name: 'Start draft', exact: true }).click();
  for (let i = 0; i < 10; i++) {
    await tieHost.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
    await tieHost.waitForFunction(n => document.querySelector('.shot-clock') || document.querySelectorAll('.dish__items li').length >= n, i + 1);
    if (await tieHost.locator('.shot-clock').count()) await raw(tieHost, 'draft:take-it', { code: tieCode, chef: 'chefOne' });
    await tieHost.waitForFunction(n => document.querySelectorAll('.dish__items li').length === n, i + 1);
  }
  await tieHost.getByRole('button', { name: 'Open voting', exact: true }).click();
  await tieHost.locator('[data-vote="chefOne"]:enabled').click();
  await tieHost.getByText('Vote locked in — anonymous', { exact: true }).waitFor();
  await tieGuest.locator('[data-vote="chefTwo"]:enabled').click();
  await tieHost.getByRole('heading', { name: 'It’s a tie. Both dishes win the table.' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS real vote UI: waiting/open/locked/winner/tie, table-only voting and two-chef self-votes, vegetarian badges, batched tally, no browser errors');
  console.log('PASS mobile measurements:', JSON.stringify(measurements));
} finally { await browser.close(); }
