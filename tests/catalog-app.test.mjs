import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-catalog-'));
  const server = createInventoryServer({ databasePath: join(directory, 'inventory.sqlite') });
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
    body: new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = token(await (await get('/inventory')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, signIn, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

async function setStock(a, id, quantity) {
  const review = await a.post(`/products/${id}/stock`, { csrfToken: a.csrfToken, operation: 'set', quantity: String(quantity) });
  assert.equal(review.status, 200);
  const confirmationToken = a.token(await review.text(), 'confirmationToken');
  assert.equal((await a.post(`/products/${id}/stock/confirm`, { csrfToken: a.csrfToken, confirmationToken })).status, 303);
}

// Creates four articles with id 1..4: agotado, normal, stock bajo, stock bajo.
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

test('search finds articles by P/N or description and filters by presentation', async (t) => {
  const a = await app(t);
  await seed(a);

  const byDescription = await (await a.get('/inventory?q=culata')).text();
  assert.match(byDescription, /JUNTA/);
  assert.doesNotMatch(byDescription, /ANODO|KIT-BOMBA|FILTRO/);

  const byPartNumber = await (await a.get('/inventory?q=kit-bomba')).text();
  assert.match(byPartNumber, /KIT-BOMBA/);
  assert.doesNotMatch(byPartNumber, /JUNTA|ANODO|FILTRO/);

  const onlySets = await (await a.get('/inventory?presentation=SET')).text();
  assert.match(onlySets, /KIT-BOMBA/);
  assert.doesNotMatch(onlySets, /JUNTA|ANODO|FILTRO/);

  const onlyUnits = await (await a.get('/inventory?presentation=unidad')).text();
  assert.match(onlyUnits, /ANODO/);
  assert.match(onlyUnits, /FILTRO/);
  assert.doesNotMatch(onlyUnits, /JUNTA|KIT-BOMBA/);
});

test('the table flags agotado and stock bajo and filters each state', async (t) => {
  const a = await app(t);
  await seed(a);

  const full = await (await a.get('/inventory')).text();
  assert.equal([...full.matchAll(/badge-out/g)].length, 1);
  assert.equal([...full.matchAll(/badge-low/g)].length, 2);

  const out = await (await a.get('/inventory?outOfStock=on')).text();
  assert.match(out, /JUNTA/);
  assert.doesNotMatch(out, /ANODO|KIT-BOMBA|FILTRO/);

  const low = await (await a.get('/inventory?lowStock=on')).text();
  assert.match(low, /KIT-BOMBA/);
  assert.match(low, /FILTRO/);
  assert.doesNotMatch(low, /JUNTA|ANODO/);
});

test('archiving retires an article from the active list, preserves its history and restores it', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.match(await (await a.get('/products?archived=on')).text(), /No hay repuestos archivados/);

  const archive = await a.post('/products/1/archive', { csrfToken: a.csrfToken });
  assert.equal(archive.status, 303);
  assert.equal(archive.headers.get('location'), '/products?msg=archived');

  const active = await (await a.get('/inventory')).text();
  assert.doesNotMatch(active, /JUNTA/);
  assert.match(active, /ANODO|KIT-BOMBA|FILTRO/);

  const legacy = await a.get('/inventory?archived=on');
  assert.equal(legacy.status, 303);
  assert.equal(legacy.headers.get('location'), '/products?archived=on');
  const archived = await (await a.get('/products?archived=on')).text();
  assert.match(archived, /JUNTA/);
  assert.match(archived, /Desarchivar/);
  assert.doesNotMatch(archived, /Ajustar existencias/);
  assert.doesNotMatch(archived, /ANODO|KIT-BOMBA|FILTRO/);

  // Archiving keeps the movement history untouched.
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /Establecer en/);

  // A filter with no matches wins over the archived empty state.
  assert.match(await (await a.get('/products?archived=on&q=zzz')).text(), /Sin resultados/);

  // The generic error fallback never shows archived articles as active.
  const oversized = await fetch(`${a.url}/products`, {
    method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(17000),
  });
  assert.equal(oversized.status, 400);
  const fallback = await oversized.text();
  assert.doesNotMatch(fallback, /JUNTA/);
  assert.match(fallback, /ANODO/);

  const archivedError = await fetch(`${a.url}/products?archived=on`, {
    method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(17000),
  });
  assert.equal(archivedError.status, 400);
  const archivedFallback = await archivedError.text();
  assert.match(archivedFallback, /JUNTA/);
  assert.match(archivedFallback, /Desarchivar/);
  assert.doesNotMatch(archivedFallback, /Ajustar existencias|ANODO/);

  const restore = await a.post('/products/1/restore', { csrfToken: a.csrfToken });
  assert.equal(restore.status, 303);
  assert.match(await (await a.get('/inventory')).text(), /JUNTA/);
});

test('archiving requires gestión, a valid CSRF token and an existing article', async (t) => {
  const a = await app(t);
  await seed(a);

  for (const action of ['archive', 'restore']) {
    assert.equal((await a.post(`/products/1/${action}`, {})).status, 403, `${action} without CSRF`);
    assert.equal((await a.post(`/products/9999/${action}`, { csrfToken: a.csrfToken })).status, 404, `${action} unknown id`);
  }

  await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' });
  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  assert.equal((await a.post('/products/1/archive', { csrfToken: viewerToken })).status, 403);
  assert.equal((await a.post('/products/1/restore', { csrfToken: viewerToken })).status, 403);

  const viewerPage = await (await a.get('/products?archived=on')).text();
  assert.doesNotMatch(viewerPage, /Archivar|Desarchivar|Ajustar existencias/);
  const viewerActive = await (await a.get('/inventory')).text();
  assert.doesNotMatch(viewerActive, /Archivar|Desarchivar|Ajustar existencias/);
  assert.match(viewerActive, /JUNTA/);
});

test('status filters combine as a union and respect the minimum boundaries', async (t) => {
  const a = await app(t);
  await seed(a);

  const both = await (await a.get('/inventory?outOfStock=on&lowStock=on')).text();
  assert.match(both, /JUNTA/);
  assert.match(both, /KIT-BOMBA/);
  assert.match(both, /FILTRO/);
  assert.doesNotMatch(both, /ANODO/);

  // Minimum 0: quantity 0 is agotado, any positive quantity is not low stock.
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'MIN-CERO', description: 'Mínimo cero', presentation: 'unidad', minimumStock: '0' })).status, 303);
  const zero = await (await a.get('/inventory?outOfStock=on')).text();
  assert.match(zero, /MIN-CERO/);
  assert.doesNotMatch(await (await a.get('/inventory?lowStock=on')).text(), /MIN-CERO/);
  await setStock(a, 5, 3);
  const positive = await (await a.get('/inventory')).text();
  assert.match(positive, /MIN-CERO/);
  assert.equal([...positive.matchAll(/badge-low/g)].length, 2);
});

test('an existing database is upgraded with the archived column and keeps its articles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-migration-'));
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
  const columns = upgraded.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  assert.ok(columns.includes('archived'), 'archived column added');
  const product = upgraded.prepare("SELECT part_number, archived FROM products WHERE part_number = 'LEGACY-1'").get();
  assert.equal(product.archived, 0);
});

test('desktop sections, product details and management links respect every role through HTTP', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const role of ['viewer', 'manager']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }
  for (const role of ['admin', 'manager', 'viewer']) {
    if (role !== 'admin') await a.signIn(role, 'equipo-seguro-123');
    const landing = await a.get('/');
    assert.equal(landing.headers.get('location'), '/products');
    for (const [path, title] of [['/products', 'Productos'], ['/inventory', 'Inventario'], ['/purchase-orders', 'Órdenes de compra']]) {
      const response = await a.get(path);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(`href="${path}" aria-current="page">${title}`));
      const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)[0];
      assert.equal([...sidebar.matchAll(/<a /g)].length, 3);
      assert.doesNotMatch(sidebar, /Cuentas|Copias/);
      assert.match(html, /Cerrar sesión/);
      assert.equal(html.includes('href="/users"'), role === 'admin');
      assert.equal(html.includes('href="/backups"'), role === 'admin');
    }
    const products = await (await a.get('/products')).text();
    assert.match(products, /Sin categoría/);
    assert.match(products, /href="\/products\/1">Junta de culata/);
    assert.match(products, /Exportar productos/);
    assert.equal(products.includes('Agregar producto'), role !== 'viewer');
    assert.equal(products.includes('Importar productos'), role !== 'viewer');
    const inventory = await (await a.get('/inventory')).text();
    assert.doesNotMatch(inventory, /name="archived"|Sin categoría|<th[^>]*>Marca/);
    assert.match(inventory, /data-column="location" hidden/);
    assert.match(inventory, /data-column="minimum" hidden/);
    const detail = await a.get('/products/1');
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /Existencias<\/dt><dd>0/);
    assert.match(html, /href="\/products\/1\/history"/);
    assert.equal(html.includes('Editar producto'), role !== 'viewer');
    assert.equal(html.includes('Ajustar existencias'), role !== 'viewer');
    assert.equal((await a.get('/products/9999')).status, 404);
    for (const path of ['/users', '/backups', '/products/1/edit', '/products/1/stock', '/imports']) {
      assert.equal((await a.get(path)).status, path === '/users' || path === '/backups' ? (role === 'admin' ? 200 : 403) : (role === 'viewer' ? 403 : 200));
    }
  }
  const script = await a.get('/assets/catalog.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  a.cookie = '';
  for (const path of ['/products', '/inventory', '/purchase-orders', '/products/1']) {
    assert.equal((await a.get(path)).headers.get('location'), '/login');
  }
});

