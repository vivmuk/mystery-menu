// Optional real-browser acceptance test; no application dependency is added.
// Run against npm start with PLAYWRIGHT_MODULE pointing to an installed Playwright.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.AUCTION_TEST_URL ?? 'http://127.0.0.1:3187';
const output = process.env.AUCTION_TEST_OUTPUT;
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await context.addInitScript(() => {
    const Native = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.__testSockets.push(this); }
    };
  });
  const host = await context.newPage();
  const guest = await context.newPage();
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message));
  await host.goto(base);
  await host.getByRole('button', { name: 'Create a room', exact: true }).click();
  await host.locator('.room-code').waitFor();
  const code = await host.locator('.room-code').textContent();
  await guest.goto(`${base}/?code=${code}`);
  await guest.getByRole('textbox', { name: 'Your name' }).fill('ChefWithTwentyFourChars!!');
  await guest.getByRole('button', { name: 'Sit down', exact: true }).click();
  await host.getByRole('button', { name: 'Start draft', exact: true }).waitFor();
  const spectator = await context.newPage();
  spectator.on('pageerror', error => errors.push(error.message));
  await spectator.goto(`${base}/?code=${code}`);
  await spectator.getByRole('textbox', { name: 'Your name' }).fill('Table voter');
  await spectator.getByRole('button', { name: 'Sit down', exact: true }).click();
  assert.equal(await guest.getByRole('button', { name: 'Start draft', exact: true }).count(), 0);
  await host.getByRole('button', { name: 'Start draft', exact: true }).click();
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Reveal next ingredient', exact: true }).count(), 0);
  assert.equal(await host.locator('.ingredient__name').textContent(), 'What’s on the menu?');
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
  await host.locator('[data-action="next-bid"]:enabled').waitFor();
  assert.equal(await guest.locator('[data-action="next-bid"]').isDisabled(), true);
  await spectator.locator('[data-action="next-bid"]').waitFor();
  assert.equal(await spectator.locator('[data-action="next-bid"]').isDisabled(), true);
  assert.equal(await spectator.locator('[data-action="take-it"]').isDisabled(), true);
  assert.equal(await spectator.getByRole('button', { name: 'Reveal next ingredient', exact: true }).count(), 0);
  // Exercise the actual sender-only draft:error protocol, bypassing the UI guard.
  await guest.evaluate(code => window.__testSockets.find(ws => ws.readyState === 1).send(`42${JSON.stringify(['draft:bid', { code, chef: 'chefTwo', amount: 1 }])}`), code);
  await guest.getByRole('alert').filter({ hasText: 'Wait for your turn.' }).waitFor();
  assert.equal(await host.locator('#draft-error').isVisible(), false);
  await host.locator('[data-action="next-bid"]').click();
  await guest.locator('[data-action="raise-5"]:enabled').waitFor();
  await guest.locator('[data-action="raise-5"]').click();
  await host.locator('[data-action="take-it"]:enabled').waitFor();
  assert.equal(await host.locator('.standing-bid strong').textContent(), '6 coins');
  await host.locator('[data-action="take-it"]').click();
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).waitFor();
  assert.equal(await guest.locator('.purse--chefTwo .purse__coins').textContent(), '4 coins');
  assert.equal(await host.locator('.dish--chefTwo .dish__items li').count(), 1);
  console.log('PASS two phones: host-only start/reveal, alternating bids, sender-only readable error, Take it, purse 10→4, awarded plate');
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
  await host.locator('[data-action="raise-5"]:enabled').waitFor();
  await host.locator('[data-action="raise-5"]').click(); // Opponent cannot afford 6; immediate award.
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).waitFor();
  assert.equal(await host.locator('.purse--chefOne .purse__coins').textContent(), '5 coins');
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
  await host.locator('[data-action="next-bid"]:enabled').waitFor();
  await host.locator('[data-action="next-bid"]').click();
  await guest.locator('[data-action="next-bid"]:enabled').waitFor();
  assert.equal(await guest.locator('[data-action="raise-5"]').isDisabled(), true);
  const measurements = [];
  for (const width of [320, 360, 390, 414, 768, 1280]) {
    await guest.setViewportSize({ width, height: 800 });
    const result = await guest.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      smallTargets: [...document.querySelectorAll('button,input,select')].filter(n => { const r = n.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map(n => n.textContent),
      takeBottom: document.querySelector('.take-it').getBoundingClientRect().bottom,
    }));
    assert.equal(result.overflow, 0, `overflow at ${width}`);
    if (width === 360) assert.ok(result.takeBottom <= 800, `Take it below the fold: ${result.takeBottom}`);
    assert.deepEqual(result.smallTargets, [], `small targets at ${width}`);
    measurements.push(result);
  }
  await guest.setViewportSize({ width: 360, height: 640 });
  assert.ok(await guest.locator('.take-it').evaluate(n => n.getBoundingClientRect().bottom <= innerHeight), 'Take it must stay in thumb reach at 360×640');
  await guest.setViewportSize({ width: 360, height: 800 });
  await guest.keyboard.press('Tab'); // Establish keyboard modality before moving focus.
  await guest.locator('[data-action="next-bid"]').focus();
  assert.equal(await guest.locator('[data-action="next-bid"]').evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
  await guest.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await guest.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
  if (output) { await mkdir(output, { recursive: true }); await guest.screenshot({ path: `${output}/auction-360.png`, fullPage: true }); }
  await guest.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await guest.locator('.shot-clock__fill').evaluate(n => getComputedStyle(n).transform), 'none');
  assert.equal(await guest.locator('.ingredient').evaluate(n => getComputedStyle(n).animationName), 'none');
  console.log('PASS legal-only raises and static reduced-motion bar:', JSON.stringify(measurements));
  await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).waitFor({ timeout: 13000 });
  assert.match(await host.locator('.ingredient__award').textContent(), /Time’s up!/);
  console.log('PASS server-owned timeout resolves the turn without a client timeout command');
  let twists = 0;
  for (let item = 3; item < 10; item++) {
    await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).click();
    await host.waitForFunction(expected => document.querySelector('.ingredient__count')?.textContent === `Ingredient ${expected} / 10`, item + 1);
    if (item >= 8) {
      await host.getByText('Cross-cuisine twist!', { exact: true }).waitFor();
      twists++;
      if (output && item === 8) {
        await host.locator('.ingredient').evaluate(n => Promise.all(n.getAnimations().map(a => a.finished)));
        await host.screenshot({ path: `${output}/twist-360.png`, fullPage: true });
      }
    } else assert.equal(await host.locator('.twist-badge').count(), 0);
    if (await host.locator('[data-action="take-it"]').count()) await host.locator('[data-action="take-it"]:enabled').click();
    await host.waitForFunction(() => !document.querySelector('.shot-clock'));
  }
  assert.equal(twists, 2);
  assert.equal(await host.locator('.dish--chefOne .dish__items li').count(), 5);
  assert.equal(await host.locator('.dish--chefTwo .dish__items li').count(), 5);
  assert.equal(await host.getByRole('button', { name: 'Reveal next ingredient', exact: true }).count(), 0);
  for (const width of [320, 360, 390, 414, 768, 1280]) {
    await host.setViewportSize({ width, height: 800 });
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `full plates overflow at ${width}`);
  }
  await host.locator('.dish--chefTwo .dish__items li').last().scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  console.log('PASS ten reveals, two public-state twist cues, forced awards, two five-item plates, no browser errors');
} finally { await browser.close(); }
