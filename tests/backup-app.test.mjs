import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function app(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-backup-'));
  const backupDirectory = join(directory, 'backups');
  const server = createInventoryServer({
    databasePath: join(directory, 'inventory.sqlite'),
    backupDirectory,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: fields instanceof FormData ? fields : new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = token(await (await get('/inventory')).text());
  const signIn = async (username, password) => {
    const session = await post('/login', { username, password });
    cookie = session.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, signIn, backupDirectory, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

async function seedArticle(a, { partNumber = '001-A', description = 'Junta marina', quantity = '5' } = {}) {
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber, description, presentation: 'KIT', minimumStock: '1',
  })).status, 303);
  const preview = await a.post('/products/1/stock', {
    csrfToken: a.csrfToken, operation: 'set', quantity, reason: 'Recuento inicial',
  });
  assert.equal((await a.post('/products/1/stock/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken'),
  })).status, 303);
}

test('backups are created automatically and listed with verifiable contents', async (t) => {
  const a = await app(t, { backupIntervalMs: 25 });
  await seedArticle(a);
  await delay(80);
  const page = await a.get('/backups');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Copias de seguridad/);
  assert.match(html, /Crear copia ahora/);
  assert.match(html, /Correcta/);
  assert.match(html, /\b1 artículo\b/);
  assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}T/);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /href="\/backups"/);
});

test('the administrator can create a backup on demand and export a verified restore point', async (t) => {
  const a = await app(t);
  await seedArticle(a);
  const created = await a.post('/backups', { csrfToken: a.csrfToken });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/backups?created=1');
  const html = await (await a.get('/backups?created=1')).text();
  assert.match(html, /Copia creada/);
  const file = html.match(/href="\/backups\/restore\?file=([^"]+)"/)?.[1];
  assert.ok(file, html);
  const restore = await a.get(`/backups/restore?file=${file}`);
  assert.equal(restore.status, 200);
  const restoreHtml = await restore.text();
  assert.match(restoreHtml, /Restaurar copia/);
  assert.match(restoreHtml, /integridad/i);
});

test('only the administrator can see, create or restore backups', async (t) => {
  const a = await app(t);
  await seedArticle(a);
  for (const role of ['viewer', 'manager']) {
    assert.equal((await a.post('/users', {
      csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role,
    })).status, 303);
  }
  for (const role of ['viewer', 'manager']) {
    await a.signIn(role, 'equipo-seguro-123');
    const page = await a.get('/backups');
    assert.equal(page.status, 403, role);
    const inventory = await (await a.get('/inventory')).text();
    assert.doesNotMatch(inventory, /href="\/backups"/);
    assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 403, role);
    assert.equal((await a.post('/backups/restore', { csrfToken: a.csrfToken, file: 'inventario-x.sqlite' })).status, 403, role);
  }
});

test('restoring a backup recovers articles, stock and movement history', async (t) => {
  const a = await app(t);
  await seedArticle(a, { partNumber: 'ANTES', description: 'Estado anterior', quantity: '5' });
  const created = await a.post('/backups', { csrfToken: a.csrfToken });
  assert.equal(created.status, 303);
  const listing = await (await a.get('/backups')).text();
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  // Diverge from the backup: add an article and change the original stock.
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'DESPUES', description: 'Estado posterior', presentation: 'SET',
  })).status, 303);
  const change = await a.post('/products/1/stock', { csrfToken: a.csrfToken, operation: 'set', quantity: '9' });
  assert.equal((await a.post('/products/1/stock/confirm', {
    csrfToken: a.csrfToken, confirmationToken: a.token(await change.text(), 'confirmationToken'),
  })).status, 303);

  const confirmation = await a.get(`/backups/restore?file=${file}`);
  const restoreHtml = await confirmation.text();
  const restored = await a.post('/backups/restore', {
    csrfToken: a.csrfToken, file,
    confirmationToken: a.token(restoreHtml, 'confirmationToken'),
  });
  assert.equal(restored.status, 303);
  assert.equal(restored.headers.get('location'), '/backups?restored=1');

  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /ANTES/);
  assert.doesNotMatch(inventory, /DESPUES/);
  assert.match(inventory, /<td class="quantity-cell inventory-(?:ok|low)">5<\/td>/);
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /Recuento inicial/);
  assert.match(history, /<td>0<\/td><td>5<\/td>/);
  assert.doesNotMatch(history, /<td>5<\/td><td>9<\/td>/);

  const verified = await (await a.get('/backups?restored=1')).text();
  assert.match(verified, /Restauración completada y verificada/);
  assert.match(verified, /integridad correcta/i);
  assert.match(verified, /Copia de seguridad del estado anterior/);
});

test('a restore cannot proceed without a valid confirmation and never touches a missing backup', async (t) => {
  const a = await app(t);
  await seedArticle(a);
  const listing = await (await a.get('/backups')).text();
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  assert.equal((await a.post('/backups/restore', { csrfToken: '', file })).status, 403);
  assert.equal((await a.post('/backups/restore', { csrfToken: a.csrfToken, file, confirmationToken: 'forged' })).status, 409);
  assert.equal((await a.get('/backups/restore?file=../../inventory.sqlite')).status, 404);
  assert.equal((await a.get('/backups/restore?file=missing.sqlite')).status, 404);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /001-A/);
});

test('a tampered backup is reported as not verifiable and cannot be restored', async (t) => {
  const a = await app(t);
  await seedArticle(a);
  await a.post('/backups', { csrfToken: a.csrfToken });
  const listing = await (await a.get('/backups')).text();
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(a.backupDirectory, file), 'esto no es una base de datos');

  const page = await (await a.get('/backups')).text();
  assert.match(page, /No verificable/);
  assert.equal((await a.get(`/backups/restore?file=${file}`)).status, 422);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /001-A/);
});

test('a retained backup can be restored even when the safety copy would prune it', async (t) => {
  const a = await app(t, { automaticBackups: false, backupRetention: 2 });
  await seedArticle(a, { partNumber: 'ANTES', description: 'Estado anterior', quantity: '5' });
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  await delay(10);
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'DESPUES', description: 'Estado posterior', presentation: 'SET',
  })).status, 303);
  const listing = await (await a.get('/backups')).text();
  const files = [...listing.matchAll(/href="\/backups\/restore\?file=([^"]+)"/g)].map((match) => match[1]);
  assert.equal(files.length, 2);
  const oldest = files[files.length - 1];
  const page = await (await a.get(`/backups/restore?file=${oldest}`)).text();
  const restored = await a.post('/backups/restore', {
    csrfToken: a.csrfToken, file: oldest, confirmationToken: a.token(page, 'confirmationToken'),
  });
  assert.equal(restored.status, 303);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /ANTES/);
  assert.doesNotMatch(inventory, /DESPUES/);
});

test('old automatic backups are pruned while the newest survive', async (t) => {
  const a = await app(t, { backupRetention: 3, automaticBackups: false });
  await seedArticle(a);
  for (let index = 0; index < 4; index++) {
    const response = await a.post('/backups', { csrfToken: a.csrfToken });
    assert.equal(response.status, 303);
    await delay(5);
  }
  const html = await (await a.get('/backups')).text();
  const files = [...html.matchAll(/href="\/backups\/restore\?file=([^"]+)"/g)].map((match) => match[1]);
  assert.equal(files.length, 3);
  const onDisk = await import('node:fs/promises').then((fs) => fs.readdir(a.backupDirectory));
  assert.equal(onDisk.length, 3);
});
