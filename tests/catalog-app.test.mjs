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
  const databasePath = join(directory, 'inventory.sqlite');
  let server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let url = `http://127.0.0.1:${server.address().port}`;
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
  const restart = async () => {
    await new Promise((resolve) => server.close(resolve));
    server = createInventoryServer({ databasePath });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  };
  return { url, get, post, token, csrfToken, signIn, restart, databasePath, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
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

test('Inventario searches by P/N or name and ignores the retired filters', async (t) => {
  const a = await app(t);
  await seed(a);

  const byName = await (await a.get('/inventory?q=culata')).text();
  assert.match(byName, /JUNTA/);
  assert.doesNotMatch(byName, /ANODO|KIT-BOMBA|FILTRO/);

  const byPartNumber = await (await a.get('/inventory?q=kit-bomba')).text();
  assert.match(byPartNumber, /KIT-BOMBA/);
  assert.doesNotMatch(byPartNumber, /JUNTA|ANODO|FILTRO/);

  // Presentation, category, brand and stock level no longer filter Inventory.
  const ignored = await (await a.get('/inventory?presentation=SET&category=999&brand=Nope&outOfStock=on&lowStock=on')).text();
  for (const partNumber of ['JUNTA', 'ANODO', 'KIT-BOMBA', 'FILTRO']) {
    assert.match(ignored, new RegExp(partNumber));
  }
});

test('Inventario colours the editable Disponible number green or red like Productos', async (t) => {
  const a = await app(t);
  await seed(a);
  // JUNTA min 2 qty 0, KIT-BOMBA min 4 qty 2 and ANODO (no minimum, fallback 10) qty 3 are red;
  // FILTRO meets its minimum of 1 and is green.
  const page = await (await a.get('/inventory')).text();
  const cell = (level, value) => new RegExp(`class="quantity-cell inventory-${level}"[^>]*>\\s*<a class="stock-value"[^>]*>${value}</a>`);
  assert.match(page, cell('low', 0));
  assert.match(page, cell('low', 2));
  assert.match(page, cell('low', 3));
  assert.match(page, cell('ok', 1));
  // The figures are not badges and never say `N existencias`.
  assert.doesNotMatch(page, /badge-out|badge-low|\d+ existencias/);

  // Reaching the minimum flips the level to green.
  await setStock(a, 3, 4);
  assert.match(await (await a.get('/inventory')).text(), cell('ok', 4));
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
  assert.doesNotMatch(archivedFallback, /ANODO/);

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
  assert.doesNotMatch(viewerPage, /Archivar|Desarchivar|Ajustar inventario/);
  const viewerActive = await (await a.get('/inventory')).text();
  assert.doesNotMatch(viewerActive, /Archivar|Desarchivar|Ajustar inventario/);
  assert.match(viewerActive, /JUNTA/);
});

test('Inventario shows only Producto, P/N and Disponible with an instant search', async (t) => {
  const a = await app(t);
  await seed(a);

  const page = await (await a.get('/inventory')).text();
  assert.match(page, /<th scope="col" class="align-left">Producto<\/th>\s*<th scope="col">P\/N<\/th>\s*<th scope="col" class="align-right">Disponible<\/th>\s*<th scope="col">Historial<\/th>/);
  assert.doesNotMatch(page, /<th[^>]*>Acciones<\/th>|<th[^>]*>Existencias<\/th>|<th[^>]*>Ubicación<\/th>|<th[^>]*>Mínimo de stock<\/th>/);
  assert.doesNotMatch(page, /name="presentation"|name="category"|name="brand"|name="outOfStock"|name="lowStock"|name="pageSize"|data-column|data-column-toggle/);
  assert.doesNotMatch(page, /class="filter-bar"/);

  // Instant search, the inline stock editor and Importar/Exportar remain; bulk selection is gone.
  assert.match(page, /class="catalog-toolbar"[^>]*data-instant-search/);
  assert.match(page, /placeholder="Buscar por P\/N o nombre"/);
  assert.match(page, /data-catalog-results/);
  assert.doesNotMatch(page, /formaction="\/purchase-orders\/add-selection"|type="checkbox" name="id"/);
  assert.match(page, /action="\/products\/1\/stock\/apply"/);
  assert.match(page, /<option value="set">Fijar en<\/option>/);
  assert.match(page, /<option value="adjust">Ajustar<\/option>/);
  assert.match(page, /href="\/products\/1\/history">Historial/);
  assert.match(page, /href="\/imports\?view=inventory">Importar<\/a>/);
  assert.match(page, /href="\/exports\?[^"]*">Exportar<\/a>/);
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
  assert.ok(columns.includes('category_id'), 'category column added');
  for (const column of ['long_description', 'price_cents', 'cost_cents', 'product_type_id', 'supplier_id']) {
    assert.ok(columns.includes(column), `${column} column added`);
  }
  const legacyFields = upgraded.prepare("SELECT category_id, long_description, price_cents, cost_cents, product_type_id, supplier_id FROM products WHERE part_number = 'LEGACY-1'").get();
  for (const field of ['category_id', 'long_description', 'price_cents', 'cost_cents', 'product_type_id', 'supplier_id']) {
    assert.equal(legacyFields[field], null, `${field} defaults to null`);
  }
  const lists = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('product_types', 'suppliers') ORDER BY name").all();
  assert.deepEqual(lists.map((table) => table.name), ['product_types', 'suppliers']);
  const product = upgraded.prepare("SELECT part_number, archived FROM products WHERE part_number = 'LEGACY-1'").get();
  assert.equal(product.archived, 0);
  // Reopening an already-migrated file must stay a no-op.
  const again = openDatabase(databasePath);
  assert.equal(again.prepare("SELECT part_number FROM products WHERE id = 1").get().part_number, 'LEGACY-1');
  again.close();
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
      assert.equal([...sidebar.matchAll(/<a /g)].length, role === 'admin' ? 5 : 3);
      assert.equal(sidebar.includes('>Cuentas y permisos</a>'), role === 'admin');
      assert.equal(sidebar.includes('>Copias de seguridad</a>'), role === 'admin');
      assert.match(html, /Cerrar sesión/);
      assert.equal(html.includes('href="/users"'), role === 'admin');
      assert.equal(html.includes('href="/backups"'), role === 'admin');
    }
    const products = await (await a.get('/products')).text();
    assert.match(products, /Sin categoría/);
    assert.match(products, /href="\/products\/1">Junta de culata/);
    assert.match(products, />Exportar<\/a>/);
    assert.equal(products.includes('Agregar producto'), role !== 'viewer');
    assert.equal(products.includes('>Importar</a>'), role !== 'viewer');
    const inventory = await (await a.get('/inventory')).text();
    assert.doesNotMatch(inventory, /name="archived"|name="state"|name="presentation"|name="pageSize"/);
    assert.match(inventory, /<th scope="col" class="align-left">Producto<\/th>\s*<th scope="col">P\/N<\/th>\s*<th scope="col" class="align-right">Disponible<\/th>\s*<th scope="col">Historial<\/th>/);
    assert.match(inventory, /class="catalog-toolbar"[^>]*data-instant-search/);
    const detail = await a.get('/products/1');
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /Existencias<\/dt><dd>0/);
    assert.match(html, /href="\/products\/1\/history"/);
    assert.equal(html.includes('Editar producto'), role !== 'viewer');
    assert.equal(html.includes('Ajustar inventario'), role !== 'viewer');
    assert.equal(html.includes('>Archivar</button>'), role !== 'viewer');
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

const rowIds = (html) => [...html.matchAll(/class="product-description" href="\/products\/(\d+)"/g)].map((match) => Number(match[1]));

test('Productos shows the agreed columns and header without the retired filters', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'MOTOR-1', description: 'Bomba de achique', presentation: 'KIT',
    newCategory: 'Motores', newProductType: 'Motor eléctrico', newSupplier: 'ACME',
  })).status, 303);

  const page = await (await a.get('/products')).text();
  assert.match(page, /<th scope="col" class="align-left">Producto<\/th>\s*<th scope="col" class="align-left">P\/N<\/th>\s*<th scope="col">Estado<\/th>\s*<th scope="col" class="align-right">Inventario<\/th>\s*<th scope="col">Categoría<\/th>\s*<th scope="col">Tipo de producto<\/th>\s*<th scope="col">Proveedor<\/th>/);
  assert.doesNotMatch(page, /<th[^>]*>Acciones<\/th>/);
  assert.match(page, /Motores/);
  assert.match(page, /Motor eléctrico/);
  assert.match(page, /ACME/);

  // Instant search and the state selector replace the filter bar; no size selector or stats.
  assert.match(page, /class="catalog-toolbar"[^>]*data-instant-search/);
  assert.match(page, /data-catalog-results/);
  assert.doesNotMatch(page, /formaction="\/purchase-orders\/add-selection"|type="checkbox" name="id"/);
  assert.match(page, /name="q"/);
  assert.match(page, /name="state"/);
  assert.doesNotMatch(page, /class="filter-bar"/);
  assert.doesNotMatch(page, /name="presentation"|name="category"|name="brand"|name="outOfStock"|name="lowStock"|name="pageSize"/);
  assert.doesNotMatch(page, /<th[^>]*>Presentación<\/th>|<th[^>]*>Marca<\/th>/);
  assert.doesNotMatch(page, /Canales|Catálogos|Más acciones/);

  // The header keeps only Importar, Exportar and Agregar producto, in that order.
  const importAt = page.indexOf('>Importar</a>');
  const exportAt = page.indexOf('>Exportar</a>');
  const addAt = page.indexOf('>Agregar producto</a>');
  assert.ok(importAt > -1 && importAt < exportAt && exportAt < addAt, 'header order is Importar, Exportar, Agregar producto');
});

test('Productos searches by P/N or name and defaults to active articles', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await a.post('/products/2/archive', { csrfToken: a.csrfToken })).status, 303);

  const byName = await (await a.get('/products?q=culata')).text();
  assert.match(byName, /JUNTA/);
  assert.doesNotMatch(byName, /ANODO|KIT-BOMBA|FILTRO/);

  const byPart = await (await a.get('/products?q=kit-bomba')).text();
  assert.match(byPart, /KIT-BOMBA/);
  assert.doesNotMatch(byPart, /JUNTA|ANODO|FILTRO/);

  // Active is the default and archived articles are reachable through the selector.
  assert.doesNotMatch(await (await a.get('/products')).text(), /ANODO/);
  const archived = await (await a.get('/products?state=archived')).text();
  assert.match(archived, /ANODO/);
  const all = await (await a.get('/products?state=all')).text();
  assert.match(all, /JUNTA/);
  assert.match(all, /ANODO/);
});

test('the Inventario cell colours N existencias against the per-product minimum, ten by default', async (t) => {
  const a = await app(t);
  await seed(a);
  // JUNTA min 2 qty 0, KIT-BOMBA min 4 qty 2 and FILTRO min 1 qty 1, ANODO has no minimum and qty 3.
  const page = await (await a.get('/products')).text();
  assert.match(page, /class="quantity-cell inventory-low">0 existencias/);
  assert.match(page, /class="quantity-cell inventory-low">2 existencias/);
  assert.match(page, /class="quantity-cell inventory-low">3 existencias/);
  assert.match(page, /class="quantity-cell inventory-ok">1 existencias/);

  // Without a minimum the fallback is ten.
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'DIEZ', description: 'Sin mínimo', presentation: 'unidad' })).status, 303);
  await setStock(a, 5, 10);
  assert.match(await (await a.get('/products')).text(), /class="quantity-cell inventory-ok">10 existencias/);
});

test('Productos pages at a fixed 50 rows without a size selector', async (t) => {
  const a = await app(t);
  for (let index = 1; index <= 55; index++) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber: `P-${String(index).padStart(3, '0')}`, description: 'Bomba marina', presentation: 'KIT',
    })).status, 303);
  }
  const first = await (await a.get('/products')).text();
  assert.equal(rowIds(first).length, 50);
  assert.match(first, /55 artículos · Página 1 de 2/);
  assert.doesNotMatch(first, /name="pageSize"/);
  // A hand-crafted size is ignored: Products always shows 50 per page.
  assert.equal(rowIds(await (await a.get('/products?pageSize=25')).text()).length, 50);
  assert.equal(rowIds(await (await a.get('/products?page=2')).text()).length, 5);
});

test('categories are optional, assigned or created atomically, and editable only by management', async (t) => {
  const a = await app(t);
  await seed(a);
  const product = { csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT', minimumStock: '2' };
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Sin categoría/);
  assert.equal((await a.post('/products/1', { ...product, newCategory: ' Motor & agua ' })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Motor &amp; agua/);
  const edit = await (await a.get('/products/1/edit')).text();
  const categoryId = edit.match(/value="(\d+)" selected>Motor &amp; agua/)[1];
  assert.ok(categoryId, 'the created category keeps its selected option');
  assert.equal((await a.post('/products', { ...product, partNumber: 'NUEVO', categoryId })).status, 303);
  assert.equal((await a.post('/products', { ...product, partNumber: 'OTRO', newCategory: 'motor & agua' })).status, 303);
  assert.match(edit, new RegExp(`value="${categoryId}" selected>Motor &amp; agua`));
  assert.equal([...edit.matchAll(/>Motor &amp; agua<\/option>/g)].length, 1);
  for (const invalidId of ['9999', '-1', '1.5', '1x', '9007199254740992']) {
    assert.equal((await a.post('/products/1', { ...product, categoryId: invalidId })).status, 400);
  }
  assert.equal((await a.post('/products/1', { ...product, categoryId, newCategory: 'Ambigua' })).status, 400);
  assert.equal((await a.post('/products/1', { ...product, categoryId: '', newCategory: 'x'.repeat(101) })).status, 400);
  assert.equal((await a.post('/products', { ...product, newCategory: 'No debe guardarse' })).status, 409);
  assert.doesNotMatch(await (await a.get('/products/new')).text(), /No debe guardarse|Ambigua/);
  assert.equal((await a.post('/products/1', { ...product, categoryId: '' })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Sin categoría/);
  // The starter categories ship with the app; a manager can assign one, but only an admin adds more.
  assert.match(await (await a.get('/products/new')).text(), /Motor base y componentes internos/);
  for (const role of ['manager', 'viewer']) {
    assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: role, password: 'equipo-seguro-123', role })).status, 303);
  }
  const managerToken = await a.signIn('manager', 'equipo-seguro-123');
  assert.equal((await a.post('/products/1', { ...product, csrfToken: managerToken, categoryId })).status, 303);
  assert.equal((await a.post('/products/1', { ...product, csrfToken: managerToken, categoryId: '', newCategory: 'Solo admin' })).status, 403);
  const viewerToken = await a.signIn('viewer', 'equipo-seguro-123');
  assert.equal((await a.post('/products/1', { ...product, csrfToken: viewerToken, newCategory: 'Prohibida' })).status, 403);
  assert.equal((await a.post('/products', { ...product, csrfToken: viewerToken, newCategory: 'Prohibida' })).status, 403);
  assert.equal((await a.get('/products/1/edit')).status, 403);
  assert.match(await (await a.get('/products/1')).text(), /Motor &amp; agua/);
});

test('Inventario paginates a fixed 50 rows and stays active-only whatever the query', async (t) => {
  const a = await app(t);
  for (let index = 1; index <= 55; index++) {
    assert.equal((await a.post('/products', {
      csrfToken: a.csrfToken, partNumber: `P-${String(index).padStart(3, '0')}`, description: 'Bomba marina', presentation: 'KIT',
    })).status, 303);
  }
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'OTRO', description: 'Ánodo de sacrificio', presentation: 'unidad' })).status, 303);
  assert.equal((await a.post('/products/56/archive', { csrfToken: a.csrfToken })).status, 303);

  const first = await (await a.get('/inventory?q=bomba')).text();
  assert.equal(rowIds(first).length, 50);
  assert.match(first, /55 artículos · Página 1 de 2/);
  assert.doesNotMatch(first, /name="pageSize"/);
  const next = first.match(/href="([^"]+)">Siguiente/)[1].replaceAll('&amp;', '&');
  assert.equal(rowIds(await (await a.get(next)).text()).length, 5);
  // A hand-crafted size is ignored: Inventario always shows 50 per page.
  assert.equal(rowIds(await (await a.get('/inventory?q=bomba&pageSize=25')).text()).length, 50);
  assert.equal(rowIds(await (await a.get('/inventory?q=bomba&page=999')).text()).length, 5);

  // The retired filters are ignored rather than applied.
  assert.equal(rowIds(await (await a.get('/inventory?q=bomba&category=1&brand=x&presentation=SET&outOfStock=on')).text()).length, 50);

  // Archived articles never appear in Inventario, even through a forged state.
  for (const query of ['q=OTRO', 'state=all&q=OTRO', 'state=archived&q=OTRO']) {
    assert.deepEqual(rowIds(await (await a.get(`/inventory?${query}`)).text()), []);
  }
  assert.deepEqual(rowIds(await (await a.get('/products?state=archived')).text()), [56]);
});

test('categories and assignments survive restart and a verified full-state backup restore', async (t) => {
  const a = await app(t);
  await seed(a);
  const product = { partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT', minimumStock: '2' };
  assert.equal((await a.post('/products/1', { ...product, csrfToken: a.csrfToken, newCategory: 'Motor' })).status, 303);
  await a.restart();
  a.csrfToken = await a.signIn('admin', 'marina-segura-123');
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Motor/);
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const listing = await (await a.get('/backups')).text();
  assert.match(listing, /8 categorías/);
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];
  assert.equal((await a.post('/products/1', { ...product, csrfToken: a.csrfToken, categoryId: '', newCategory: 'Posterior' })).status, 303);
  await setStock(a, 3, 9);
  const confirmation = await (await a.get(`/backups/restore?file=${file}`)).text();
  assert.equal((await a.post('/backups/restore', { csrfToken: a.csrfToken, file, confirmationToken: a.token(confirmation, 'confirmationToken') })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Categoría<\/dt><dd>Motor/);
  assert.doesNotMatch(await (await a.get('/products/new')).text(), /Posterior/);
  assert.match(await (await a.get('/products/3')).text(), /Existencias<\/dt><dd>2/);
  assert.doesNotMatch(await (await a.get('/products/3/history')).text(), /<td>2<\/td><td>9<\/td>/);
});

test('migrating and restoring a pre-category database preserves accounts, articles, stock and history', async (t) => {
  const a = await app(t);
  await seed(a);
  await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' });
  const legacy = new DatabaseSync(a.databasePath);
  legacy.exec('ALTER TABLE products DROP COLUMN category_id; DROP TABLE categories;');
  const originalProducts = legacy.prepare('SELECT * FROM products ORDER BY id').all();
  const originalUsers = legacy.prepare('SELECT * FROM users ORDER BY id').all();
  const originalMovements = legacy.prepare('SELECT * FROM stock_movements ORDER BY id').all();
  legacy.close();
  // The backup endpoint also accepts the old schema before the next startup migrates it.
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const file = (await (await a.get('/backups')).text()).match(/href="\/backups\/restore\?file=([^"]+)"/)[1];
  await a.restart();
  a.csrfToken = await a.signIn('admin', 'marina-segura-123');
  const checkState = () => {
    const db = new DatabaseSync(a.databasePath, { readOnly: true });
    try {
      const products = db.prepare('SELECT * FROM products ORDER BY id').all();
      assert.ok(products.every((product) => product.category_id === null));
      assert.deepEqual(products.map(({ category_id, ...product }) => product), originalProducts.map((product) => ({ ...product })));
      assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), originalUsers);
      assert.deepEqual(db.prepare('SELECT * FROM stock_movements ORDER BY id').all(), originalMovements);
    } finally { db.close(); }
  };
  checkState();
  await a.post('/products/1', { csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Modificado', presentation: 'KIT', newCategory: 'Posterior' });
  const confirmation = await (await a.get(`/backups/restore?file=${file}`)).text();
  assert.equal((await a.post('/backups/restore', { csrfToken: a.csrfToken, file, confirmationToken: a.token(confirmation, 'confirmationToken') })).status, 303);
  checkState();
  assert.doesNotMatch(await (await a.get('/products/new')).text(), /Posterior/);
  assert.ok(await a.signIn('viewer', 'equipo-seguro-123'));
});

test('extended product fields are saved, shown and validated through HTTP', async (t) => {
  const a = await app(t);
  const base = { csrfToken: a.csrfToken, partNumber: 'MOTOR-1', description: 'Bomba de achique', presentation: 'KIT' };
  const created = await a.post('/products', {
    ...base, longDescription: 'Detalle\nlargo del producto.', price: '12.5',
    newProductType: ' Motor eléctrico ', newSupplier: ' Proveedor & uno ', initialQuantity: '4',
  });
  assert.equal(created.status, 303);

  const detail = await (await a.get('/products/1')).text();
  assert.match(detail, /<dt>Precio<\/dt><dd>\$12\.50<\/dd>/);
  assert.match(detail, /<dt>Descripción<\/dt><dd class="long-description">Detalle\nlargo del producto\.<\/dd>/);
  assert.match(detail, /<dt>Tipo de producto<\/dt><dd>Motor eléctrico<\/dd>/);
  assert.match(detail, /<dt>Proveedor<\/dt><dd>Proveedor &amp; uno<\/dd>/);

  // The initial quantity is recorded once, as a creation movement.
  const history = await (await a.get('/products/1/history')).text();
  assert.match(history, /Alta/);
  assert.match(history, /<td>4<\/td><td>0<\/td><td>4<\/td>/);

  const edit = await (await a.get('/products/1/edit')).text();
  assert.match(edit, /name="price" inputmode="decimal" value="12\.50"/);
  assert.match(edit, /value="1" selected>Motor eléctrico/);
  assert.match(edit, /value="1" selected>Proveedor &amp; uno/);
  assert.match(edit, />Detalle\nlargo del producto\.<\/textarea>/);
  assert.doesNotMatch(edit, /name="initialQuantity"/);

  for (const price of ['1.234', 'abc', '-5', '1,2,3']) {
    assert.equal((await a.post('/products', { ...base, partNumber: `P-${price}`, price })).status, 400, `price ${price}`);
  }
  assert.equal((await a.post('/products', { ...base, partNumber: 'LARGO', longDescription: 'x'.repeat(2001) })).status, 400);
  for (const initialQuantity of ['-1', '1.5', 'muchos']) {
    assert.equal((await a.post('/products', { ...base, partNumber: `Q-${initialQuantity}`, initialQuantity })).status, 400, `quantity ${initialQuantity}`);
  }
});

test('clearing a field writes null while omitting it preserves the stored value', async (t) => {
  const a = await app(t);
  const base = { csrfToken: a.csrfToken, partNumber: 'P-1', description: 'Producto', presentation: 'KIT', price: '9.99', longDescription: 'Nota original' };
  assert.equal((await a.post('/products', base)).status, 303);

  // A request with neither field (nor representation of them) must not wipe what exists.
  assert.equal((await a.post('/products/1', { csrfToken: a.csrfToken, partNumber: 'P-1', description: 'Renombrado', presentation: 'KIT' })).status, 303);
  const kept = await (await a.get('/products/1')).text();
  assert.match(kept, /<dt>Precio<\/dt><dd>\$9\.99<\/dd>/);
  assert.match(kept, /Nota original/);

  // Explicit empty values clear them.
  assert.equal((await a.post('/products/1', { ...base, description: 'Renombrado', price: '', longDescription: '' })).status, 303);
  const cleared = await (await a.get('/products/1')).text();
  assert.match(cleared, /<dt>Precio<\/dt><dd>—<\/dd>/);
  assert.match(cleared, /<dt>Descripción<\/dt><dd class="long-description">—<\/dd>/);
});

test('prices are stored as integer cents and shown with two decimals', async (t) => {
  const a = await app(t);
  for (const [price, shown] of [['0.1', '0.10'], ['19.99', '19.99'], ['7', '7.00'], ['0', '0.00']]) {
    assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: `P-${shown}`, description: shown, presentation: 'unidad', price })).status, 303);
  }
  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT price_cents FROM products ORDER BY id').all().map((row) => row.price_cents), [10, 1999, 700, 0]);
  } finally { db.close(); }
  assert.match(await (await a.get('/products/1')).text(), /Precio<\/dt><dd>\$0\.10<\/dd>/);
  assert.match(await (await a.get('/products/3')).text(), /Precio<\/dt><dd>\$7\.00<\/dd>/);
});

test('product types and suppliers are created or reused without duplicating equivalent values', async (t) => {
  const a = await app(t);
  const base = { csrfToken: a.csrfToken, presentation: 'unidad' };
  assert.equal((await a.post('/products', { ...base, partNumber: 'A', description: 'A', newProductType: ' Motor ', newSupplier: ' ACME ' })).status, 303);
  assert.equal((await a.post('/products', { ...base, partNumber: 'B', description: 'B', newProductType: 'motor', newSupplier: 'acme' })).status, 303);
  assert.equal((await a.post('/products', { ...base, partNumber: 'C', description: 'C', productTypeId: '1', supplierId: '1' })).status, 303);

  const edit = await (await a.get('/products/1/edit')).text();
  assert.equal([...edit.matchAll(/>Motor<\/option>/g)].length, 1);
  assert.equal([...edit.matchAll(/>ACME<\/option>/g)].length, 1);
  const detail = await (await a.get('/products/3')).text();
  assert.match(detail, /Tipo de producto<\/dt><dd>Motor<\/dd>/);
  assert.match(detail, /Proveedor<\/dt><dd>ACME<\/dd>/);

  for (const productTypeId of ['9999', '-1', '1.5', '1x', '9007199254740992']) {
    assert.equal((await a.post('/products/1', { ...base, partNumber: 'A', description: 'A', productTypeId })).status, 400, `type ${productTypeId}`);
  }
  for (const supplierId of ['9999', '-1', '1.5', '1x']) {
    assert.equal((await a.post('/products/1', { ...base, partNumber: 'A', description: 'A', supplierId })).status, 400, `supplier ${supplierId}`);
  }
  assert.equal((await a.post('/products/1', { ...base, partNumber: 'A', description: 'A', productTypeId: '1', newProductType: 'Ambigua' })).status, 400);
  assert.equal((await a.post('/products/1', { ...base, partNumber: 'A', description: 'A', supplierId: '1', newSupplier: 'Ambigua' })).status, 400);
  assert.equal((await a.post('/products/1', { ...base, partNumber: 'A', description: 'A', newSupplier: 'x'.repeat(101) })).status, 400);
});

test('consulta views extended fields but cannot change them', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'X', description: 'X', presentation: 'KIT', newProductType: 'Tipo', price: '1.00' })).status, 303);
  await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' });
  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  assert.match(await (await a.get('/products/1')).text(), /Tipo de producto<\/dt><dd>Tipo<\/dd>/);
  assert.equal((await a.post('/products/1', { csrfToken: viewerToken, partNumber: 'X', description: 'X', presentation: 'KIT', newProductType: 'Otro' })).status, 403);
  assert.equal((await a.post('/products', { csrfToken: viewerToken, partNumber: 'Y', description: 'Y', presentation: 'KIT', newSupplier: 'Proveedor' })).status, 403);
  assert.equal((await a.get('/products/1/edit')).status, 403);
  assert.equal((await a.get('/products/new')).status, 403);
});

test('a pre-v1.2 movements table is rebuilt to allow the creation origin without losing history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-source-'));
  const databasePath = join(directory, 'inventory.sqlite');
  openDatabase(databasePath).close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE stock_movements_old (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK (operation IN ('adjust', 'set')),
      quantity INTEGER NOT NULL,
      previous_quantity INTEGER NOT NULL CHECK (previous_quantity >= 0),
      new_quantity INTEGER NOT NULL CHECK (new_quantity >= 0),
      presentation TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import'))
    );
    DROP TABLE stock_movements;
    ALTER TABLE stock_movements_old RENAME TO stock_movements;
    CREATE INDEX stock_movements_product ON stock_movements(product_id, id);
    INSERT INTO users (username, password_salt, password_hash, role) VALUES ('viejo', 'salt', 'hash', 'admin');
    INSERT INTO products (part_number, description, presentation) VALUES ('LEGACY', 'Viejo', 'KIT');
    INSERT INTO stock_movements (product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source)
      VALUES (1, 1, 'set', 5, 0, 5, 'KIT', 'Inicial', '2026-01-01T00:00:00Z', 'import');
  `);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  t.after(async () => {
    upgraded.close();
    await rm(directory, { recursive: true, force: true });
  });
  const movement = upgraded.prepare('SELECT * FROM stock_movements WHERE id = 1').get();
  assert.equal(movement.source, 'import');
  assert.equal(movement.new_quantity, 5);
  upgraded.prepare(`INSERT INTO stock_movements (product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source)
    VALUES (1, 1, 'set', 2, 5, 7, 'KIT', NULL, '2026-01-02T00:00:00Z', 'creation')`).run();
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE source = 'creation'").get().count, 1);
  assert.equal(upgraded.prepare('PRAGMA foreign_key_check').all().length, 0);

  // Migrating again is a no-op that keeps every row.
  const again = openDatabase(databasePath);
  assert.equal(again.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count, 2);
  again.close();
});

