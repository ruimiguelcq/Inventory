import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-order-'));
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
  const encode = (fields) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item);
      else params.append(key, value);
    }
    return params;
  };
  const get = (path) => fetch(url + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path, fields) => fetch(url + path, {
    method: 'POST', headers: { cookie }, redirect: 'manual', body: encode(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrfToken = token(await (await get('/products')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/products')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn, databasePath,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

// One customer (id 1) and two priced articles: JUNTA (5 in stock, $10.00) and ANODO (3, $2.50).
async function seed(a) {
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
    email: 'ana@example.com', phone: '+58 412 000 0000',
  })).status, 303);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT',
    price: '10.00', initialQuantity: '5',
  })).status, 303);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'ANODO', description: 'Ánodo de sacrificio', presentation: 'unidad',
    price: '2.50', initialQuantity: '3',
  })).status, 303);
}

const orderFields = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, customerId: '1', channelId: '1', discount: '10', notes: 'Urgente',
  productId: ['1', '2'], quantity: ['2', '1'], ...overrides,
});

const createOrder = (a, overrides = {}) => a.post('/orders', orderFields(a, overrides));

test('creates a numbered order, discounts inventory and records an order movement per line', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.match(await (await a.get('/orders')).text(), /Todavía no hay pedidos/);

  const created = await createOrder(a);
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/orders/1001');

  // The detail shows number, date, client, channel, lines, discount, total and notes.
  const detail = await (await a.get('/orders/1001')).text();
  assert.match(detail, /<h1>Pedido #1001<\/h1>/);
  assert.match(detail, /Creado el \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  assert.match(detail, /Cliente<\/dt><dd>Ana Pérez/);
  assert.match(detail, /Canal<\/dt><dd>Online/);
  assert.match(detail, /JUNTA/);
  assert.match(detail, /ANODO/);
  assert.match(detail, /Descuento<\/dt><dd>10 %<\/dd>/);
  assert.match(detail, /Subtotal<\/dt><dd>\$22\.50<\/dd>/);
  assert.match(detail, /Total<\/dt><dd>\$20\.25<\/dd>/);
  assert.match(detail, /Notas<\/dt><dd class="long-description">Urgente<\/dd>/);

  // Inventory is discounted and the movement carries the order origin in the product history.
  assert.match(await (await a.get('/products/1')).text(), /Inventario<\/dt><dd>3/);
  assert.match(await (await a.get('/products/2')).text(), /Inventario<\/dt><dd>2/);
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /Pedido/);
  assert.match(history, /Pedido #1001/);
  assert.match(history, /<td>-2<\/td><td>5<\/td><td>3<\/td>/);

  // Numbers advance and are never reused.
  assert.equal((await createOrder(a, { productId: ['1'], quantity: ['1'] })).headers.get('location'), '/orders/1002');
  const list = await (await a.get('/orders')).text();
  assert.match(list, /#1001/);
  assert.match(list, /#1002/);
  assert.match(list, /Ana Pérez/);
  assert.match(list, /Online/);
  assert.match(list, /\$20\.25/);
});

test('rejects a quantity beyond the available stock without changing inventory or creating an order', async (t) => {
  const a = await app(t);
  await seed(a);
  const before = await (await a.get('/products/1/history')).text();

  const rejected = await createOrder(a, { productId: ['1'], quantity: ['6'] });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /No hay existencias suficientes de JUNTA: disponible 5, pedido 6/);

  assert.match(await (await a.get('/products/1')).text(), /Inventario<\/dt><dd>5/);
  assert.equal(await (await a.get('/products/1/history')).text(), before);
  assert.match(await (await a.get('/orders')).text(), /Todavía no hay pedidos/);
});

test('the total is the subtotal minus the discount in USD with two decimals', async (t) => {
  const a = await app(t);
  await seed(a);
  // 2 × $10.00 = $20.00, −12.5 % → $17.50.
  const created = await createOrder(a, { discount: '12.5', productId: ['1'], quantity: ['2'] });
  assert.equal(created.headers.get('location'), '/orders/1001');
  const detail = await (await a.get('/orders/1001')).text();
  assert.match(detail, /Subtotal<\/dt><dd>\$20\.00<\/dd>/);
  assert.match(detail, /Descuento<\/dt><dd>12\.5 %<\/dd>/);
  assert.match(detail, /Total<\/dt><dd>\$17\.50<\/dd>/);

  for (const discount of ['101', '-1', 'abc', '1.234']) {
    assert.equal((await createOrder(a, { discount, productId: ['1'], quantity: ['1'] })).status, 400, discount);
  }
});

test('validates customer, channel, lines and quantities on the server', async (t) => {
  const a = await app(t);
  await seed(a);
  const cases = [
    [{ customerId: '' }, /cliente registrado/],
    [{ customerId: '999' }, /cliente seleccionado/],
    [{ channelId: '', newChannel: '' }, /canal/],
    [{ channelId: '1', newChannel: 'Online' }, /no ambos/],
    [{ productId: [''], quantity: [''] }, /al menos un artículo/],
    [{ productId: ['999'], quantity: ['1'] }, /ya no existe/],
    [{ productId: ['1'], quantity: ['0'] }, /cantidad entera mayor que cero/],
    [{ productId: ['1'], quantity: ['-1'] }, /cantidad entera mayor que cero/],
    [{ productId: ['1'], quantity: ['1.5'] }, /cantidad entera mayor que cero/],
    [{ productId: ['1'], quantity: ['abc'] }, /cantidad entera mayor que cero/],
    [{ productId: ['1', '1'], quantity: ['1', '1'] }, /aparece más de una vez/],
  ];
  for (const [overrides, message] of cases) {
    const response = await createOrder(a, overrides);
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.match(await response.text(), message);
  }
  assert.match(await (await a.get('/orders')).text(), /Todavía no hay pedidos/);

  // Without CSRF the mutation is refused.
  assert.equal((await a.post('/orders', { customerId: '1', channelId: '1', productId: ['1'], quantity: ['1'] })).status, 403);
});

test('only active articles are offered and archived articles cannot be ordered', async (t) => {
  const a = await app(t);
  await seed(a);
  const form = await (await a.get('/orders/new')).text();
  assert.match(form, /JUNTA — Junta de culata · 5/);
  assert.match(form, /ANODO — Ánodo de sacrificio · 3/);
  assert.match(form, /data-available="5"/);

  assert.equal((await a.post('/products/1/archive', { csrfToken: a.csrfToken })).status, 303);
  assert.doesNotMatch(await (await a.get('/orders/new')).text(), /<option value="1" data-price/);
  const rejected = await createOrder(a, { productId: ['1'], quantity: ['1'] });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /archivado/);
});

test('an order may create a channel and the list is editable', async (t) => {
  const a = await app(t);
  await seed(a);
  const form = await (await a.get('/orders/new')).text();
  for (const name of ['Online', 'Tienda', 'Correo']) assert.match(form, new RegExp(`>${name}</option>`));

  const created = await createOrder(a, { channelId: '', newChannel: 'Instagram' });
  assert.equal(created.headers.get('location'), '/orders/1001');
  assert.match(await (await a.get('/orders/1001')).text(), /Canal<\/dt><dd>Instagram/);
  assert.match(await (await a.get('/orders/new')).text(), />Instagram<\/option>/);

  // A second order reusing the equivalent name does not duplicate the channel.
  assert.equal((await createOrder(a, { channelId: '', newChannel: 'instagram' })).status, 303);
  const page = await (await a.get('/orders/new')).text();
  assert.equal([...page.matchAll(/>Instagram<\/option>/g)].length, 1);
  assert.equal((await createOrder(a, { channelId: '', newChannel: 'x'.repeat(101) })).status, 400);
});

test('consulta views and exports nothing while gestión and administración create orders', async (t) => {
  const a = await app(t);
  await seed(a);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }
  assert.equal((await createOrder(a)).status, 303);

  a.cookie = '';
  assert.equal((await a.get('/orders')).headers.get('location'), '/login');

  await a.signIn('viewer', 'equipo-seguro-123');
  assert.equal((await a.get('/orders')).status, 200);
  assert.equal((await a.get('/orders/1001')).status, 200);
  assert.doesNotMatch(await (await a.get('/orders')).text(), /Crear pedido/);
  assert.equal((await a.get('/orders/new')).status, 403);
  assert.equal((await createOrder(a)).status, 403);

  await a.signIn('manager', 'equipo-seguro-123');
  assert.equal((await a.get('/orders/new')).status, 200);
  assert.equal((await createOrder(a, { productId: ['1'], quantity: ['1'] })).status, 303);
});

test('an order saves the unit price snapshot so later price changes do not alter it', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a, { productId: ['1'], quantity: ['2'], discount: '0' })).status, 303);
  assert.equal((await a.post('/products/1', {
    csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT', price: '99.00',
  })).status, 303);

  const detail = await (await a.get('/orders/1001')).text();
  assert.match(detail, /Precio unitario<\/th>[\s\S]*\$10\.00/);
  assert.match(detail, /Total<\/dt><dd>\$20\.00<\/dd>/);
});

test('an existing database gains the order tables and the order movement source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-order-migration-'));
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
    if (upgraded.isOpen) upgraded.close();
    await rm(directory, { recursive: true, force: true });
  });
  const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['channels', 'orders', 'order_lines', 'order_sequences']) {
    assert.ok(tables.includes(table), `${table} table added`);
  }
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
  assert.equal(upgraded.prepare("SELECT name FROM channels ORDER BY id").all().map((row) => row.name).join(','), 'Online,Tienda,Correo');
  assert.equal(upgraded.prepare("SELECT next_number FROM order_sequences WHERE kind = 'order'").get().next_number, 1001);
  assert.equal(upgraded.prepare('SELECT part_number FROM products').get().part_number, 'LEGACY-1');

  // Reopening is a no-op and the new origin is accepted by the rebuilt movement table.
  upgraded.close();
  const again = openDatabase(databasePath);
  assert.equal(again.prepare('SELECT COUNT(*) AS count FROM channels').get().count, 3);
  again.prepare("INSERT INTO users (username, password_salt, password_hash, role) VALUES ('viejo', 's', 'h', 'admin')").run();
  again.prepare(`INSERT INTO stock_movements (product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source)
    VALUES (1, 1, 'adjust', -1, 5, 4, 'KIT', 'Pedido #1001', '2026-01-02T00:00:00Z', 'order')`).run();
  assert.equal(again.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE source = 'order'").get().count, 1);
  again.close();
});
