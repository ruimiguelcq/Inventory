import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-purchase-'));
  const databasePath = join(directory, 'inventory.sqlite');
  let server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrfToken = '';
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual',
    body: new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrfToken = token(await (await get('/inventory')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/inventory')).text());
    return csrfToken;
  };
  const restart = async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createInventoryServer({ databasePath });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  };
  return {
    url, get, post, token, signIn, restart, databasePath,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

async function setStock(a, id, quantity) {
  const review = await a.post(`/products/${id}/stock`, { csrfToken: a.csrfToken, operation: 'set', quantity: String(quantity) });
  assert.equal(review.status, 200);
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post(`/products/${id}/stock/confirm`, { csrfToken: a.csrfToken, confirmationToken })).status, 303);
}

// Four articles: id 1 agotado, id 2 normal, ids 3 and 4 stock bajo.
async function seed(a) {
  const products = [
    { partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT', minimumStock: '2' },
    { partNumber: 'ANODO', description: 'Ánodo de sacrificio', presentation: 'unidad' },
    { partNumber: 'KIT-BOMBA', description: 'Kit bomba de achique', presentation: 'SET', minimumStock: '4' },
    { partNumber: 'FILTRO', description: 'Filtro de aceite', presentation: 'unidad', minimumStock: '1' },
  ];
  for (const product of products) {
    assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  }
  await setStock(a, 1, 0);
  await setStock(a, 2, 3);
  await setStock(a, 3, 2);
  await setStock(a, 4, 1);
}

async function createOrder(a, token = a.csrfToken) {
  const response = await a.post('/purchase-orders', { csrfToken: token });
  assert.equal(response.status, 303);
  return { response, id: Number(response.headers.get('location').match(/\/purchase-orders\/(\d+)/)[1]) };
}

async function addLine(a, id, productId, token = a.csrfToken) {
  return a.post(`/purchase-orders/${id}/lines`, { csrfToken: token, productId: String(productId) });
}

const lineIdFrom = (html) => Number(html.match(/name="line-(\d+)"/)[1]);
const optionIdsFrom = (html) => [...html.matchAll(/<option value="(\d+)"/g)].map((match) => Number(match[1]));

test('creates a numbered, dated draft and recovers it after restart', async (t) => {
  const a = await app(t);
  assert.match(await (await a.get('/purchase-orders')).text(), /Todavía no hay listas de compra/);

  const { id } = await createOrder(a);
  const listing = await (await a.get('/purchase-orders')).text();
  assert.match(listing, new RegExp(`Compra #${id}`));
  assert.match(listing, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  assert.match(listing, /Borrador/);

  const detail = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(detail, new RegExp(`Compra #${id}`));
  assert.match(detail, /Creada el \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);

  await a.restart();
  a.csrfToken = await a.signIn('admin', 'marina-segura-123');
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`Compra #${id}`));
});

test('the selector prioritizes agotados and stock bajo and only offers active articles', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);

  const page = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.deepEqual(optionIdsFrom(page), [1, 4, 3, 2]);
  assert.match(page, /JUNTA — Junta de culata · 0 · Agotado/);
  assert.match(page, /FILTRO — Filtro de aceite · 1 · Stock bajo/);
  assert.match(page, /ANODO — Ánodo de sacrificio · 3</);

  assert.equal((await addLine(a, id, 1)).status, 303);
  const withLine = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(withLine, /JUNTA/);
  assert.deepEqual(optionIdsFrom(withLine), [4, 3, 2]);

  // An archived article is never offered nor accepted for a new line.
  assert.equal((await a.post('/products/2/archive', { csrfToken: a.csrfToken })).status, 303);
  assert.equal((await addLine(a, id, 2)).status, 400);
  const afterArchive = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.doesNotMatch(afterArchive, /<option value="2"/);
});

test('saves incomplete drafts and only accepts positive integer quantities', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);

  // A line starts with an empty requested quantity; it is never derived from the minimum stock.
  const initial = await (await a.get(`/purchase-orders/${id}`)).text();
  const lineId = lineIdFrom(initial);
  assert.match(initial, new RegExp(`name="line-${lineId}" value=""`));

  // The draft can be stored incomplete.
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '' })).status, 303);

  const saved = await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '5' });
  assert.equal(saved.status, 303);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`name="line-${lineId}" value="5"`));

  for (const quantity of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    const rejected = await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: quantity });
    assert.equal(rejected.status, 400, quantity);
    assert.match(await rejected.text(), /enteros mayores que cero/);
    // The rejected value is never persisted.
    assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`name="line-${lineId}" value="5"`));
  }

  // Clearing a quantity returns the draft to an incomplete state.
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '' })).status, 303);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), new RegExp(`name="line-${lineId}" value=""`));
});

test('each article appears once per list and lines can be removed', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);

  const first = await addLine(a, id, 1);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), `/purchase-orders/${id}?added=1`);
  const duplicate = await addLine(a, id, 1);
  assert.equal(duplicate.status, 303);
  assert.equal(duplicate.headers.get('location'), `/purchase-orders/${id}?duplicate=1`);

  const page = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.equal([...page.matchAll(/name="line-\d+"/g)].length, 1);
  assert.match(await (await a.get(`/purchase-orders/${id}?duplicate=1`)).text(), /ya formaba parte de la lista/);

  const lineId = lineIdFrom(page);
  const removed = await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken });
  assert.equal(removed.status, 303);
  assert.equal(removed.headers.get('location'), `/purchase-orders/${id}?removed=1`);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), /Todavía no hay artículos/);

  // Removing a line that no longer belongs to the list is a safe failure.
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 404);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/0/remove`, { csrfToken: a.csrfToken })).status, 400);
});

test('consulta can view drafts while gestión and administración create and edit', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }

  a.cookie = '';
  assert.equal((await a.get('/purchase-orders')).headers.get('location'), '/login');
  assert.equal((await a.get(`/purchase-orders/${id}`)).headers.get('location'), '/login');

  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  const listing = await (await a.get('/purchase-orders')).text();
  assert.match(listing, /Compra #/);
  assert.doesNotMatch(listing, /Nueva lista de compra/);
  const detail = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(detail, /JUNTA/);
  assert.doesNotMatch(detail, /Guardar borrador|Añadir artículo|Retirar|name="line-/);
  assert.equal((await a.post('/purchase-orders', { csrfToken: viewerToken })).status, 403);
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: viewerToken })).status, 403);
  assert.equal((await addLine(a, id, 2, viewerToken)).status, 403);

  const managerToken = await a.signIn('manager', 'equipo-seguro-123');
  assert.equal((await createOrder(a, managerToken)).response.status, 303);
  assert.equal((await addLine(a, id, 2, managerToken)).status, 303);

  // CSRF is required for every mutation.
  assert.equal((await a.post('/purchase-orders', {})).status, 403);
  assert.equal((await a.post(`/purchase-orders/${id}`, {})).status, 403);
  assert.equal((await a.post(`/purchase-orders/${id}/lines`, { productId: '3' })).status, 403);

  assert.equal((await a.get('/purchase-orders/9999')).status, 404);
  assert.equal((await a.post('/purchase-orders/9999/lines', { csrfToken: a.csrfToken, productId: '3' })).status, 404);
});

test('preparing a purchase never changes stock or movement history', async (t) => {
  const a = await app(t);
  await seed(a);
  const historyBefore = await (await a.get('/products/1/history')).text();
  const detailBefore = await (await a.get('/products/1')).text();

  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  const lineId = lineIdFrom(await (await a.get(`/purchase-orders/${id}`)).text());
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '9' })).status, 303);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 303);

  assert.equal(await (await a.get('/products/1/history')).text(), historyBefore);
  assert.equal(await (await a.get('/products/1')).text(), detailBefore);
});

test('archiving an article later keeps its line, allows removal and hides it from new additions', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  assert.equal((await a.post('/products/1/archive', { csrfToken: a.csrfToken })).status, 303);

  const page = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(page, /JUNTA/);
  assert.match(page, /Archivado/);
  assert.doesNotMatch(page, /<option value="1"/);

  // Re-adding the archived article is rejected, even though it is already in the list.
  assert.equal((await addLine(a, id, 1)).status, 400);
  const lineId = lineIdFrom(page);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 303);
  assert.match(await (await a.get(`/purchase-orders/${id}`)).text(), /Todavía no hay artículos/);
});

test('an existing database gains the purchase tables without losing its data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-purchase-migration-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      part_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL,
      presentation TEXT NOT NULL CHECK (presentation IN ('SET', 'KIT', 'unidad')),
      brand TEXT,
      location TEXT,
      minimum_stock INTEGER CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
      quantity INTEGER NOT NULL DEFAULT 0,
      stock_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (part_number, description, presentation) VALUES ('LEGACY-1', 'Repuesto existente', 'KIT');
  `);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  t.after(async () => {
    upgraded.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes('purchase_orders'), 'purchase_orders table added');
  assert.ok(tables.includes('purchase_order_lines'), 'purchase_order_lines table added');
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM purchase_orders').get().count, 0);
  assert.equal(upgraded.prepare('SELECT part_number FROM products').get().part_number, 'LEGACY-1');
});

test('backups and restores preserve purchase orders and their lines', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303);
  const lineId = lineIdFrom(await (await a.get(`/purchase-orders/${id}`)).text());
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${lineId}`]: '7' })).status, 303);

  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const listing = await (await a.get('/backups')).text();
  assert.match(listing, /1 lista de compra/);
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  // Diverge from the snapshot: a new draft appears and the first line is removed.
  assert.equal((await createOrder(a)).response.status, 303);
  assert.equal((await a.post(`/purchase-orders/${id}/lines/${lineId}/remove`, { csrfToken: a.csrfToken })).status, 303);

  const confirmation = await (await a.get(`/backups/restore?file=${file}`)).text();
  assert.equal((await a.post('/backups/restore', {
    csrfToken: a.csrfToken, file, confirmationToken: a.token(confirmation, 'confirmationToken'),
  })).status, 303);

  const restored = await (await a.get(`/purchase-orders/${id}`)).text();
  assert.match(restored, /JUNTA/);
  assert.match(restored, new RegExp(`name="line-${lineId}" value="7"`));
  assert.doesNotMatch(await (await a.get('/purchase-orders')).text(), /Compra #2/);
});

test('adding and removing a line never depend on the other rows being valid', async (t) => {
  const a = await app(t);
  await seed(a);
  const { id } = await createOrder(a);
  assert.equal((await addLine(a, id, 1)).status, 303); // JUNTA
  assert.equal((await addLine(a, id, 2)).status, 303); // ANODO

  const page = await (await a.get(`/purchase-orders/${id}`)).text();
  // The table is ordered by P/N, so the first input is ANODO and the second one JUNTA.
  const [firstLine, secondLine] = [...page.matchAll(/name="line-(\d+)"/g)].map((match) => match[1]);

  // An invalid quantity in one row never blocks adding another article.
  const added = await a.post(`/purchase-orders/${id}/lines`, {
    csrfToken: a.csrfToken, productId: '3', [`line-${firstLine}`]: '0',
  });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get('location'), `/purchase-orders/${id}?added=1`);

  // Nor does it block removing a different line.
  const removed = await a.post(`/purchase-orders/${id}/lines/${secondLine}/remove`, {
    csrfToken: a.csrfToken, [`line-${firstLine}`]: 'abc',
  });
  assert.equal(removed.status, 303);
  assert.equal(removed.headers.get('location'), `/purchase-orders/${id}?removed=1`);

  const after = await (await a.get(`/purchase-orders/${id}`)).text();
  const remaining = [...after.matchAll(/name="line-(\d+)"/g)].map((match) => match[1]);
  assert.ok(remaining.includes(firstLine));
  assert.ok(!remaining.includes(secondLine));
  assert.match(after, /KIT-BOMBA/);
  // The invalid values were neither saved nor did they become a quantity.
  assert.match(after, new RegExp(`name="line-${firstLine}" value=""`));
  assert.equal((await a.post(`/purchase-orders/${id}`, { csrfToken: a.csrfToken, [`line-${firstLine}`]: '0' })).status, 400);
});
