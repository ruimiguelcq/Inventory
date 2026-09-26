import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';
import { DEFAULT_CATEGORIES } from '../src/database.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-form-'));
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

test('the product form ships the two-column layout, Multimedia, Costo and the inventory card', async (t) => {
  const a = await app(t);
  const form = await (await a.get('/products/new')).text();
  // Shopify-style split: main column plus a sidebar for Organización del producto.
  assert.match(form, /class="product-layout"/);
  assert.match(form, /class="product-layout__main"/);
  assert.match(form, /class="product-layout__side"/);
  assert.match(form, /Organización del producto/);
  // Categoría is the first field of the sidebar.
  assert.ok(form.indexOf('Organización del producto') < form.indexOf('name="categoryId"'), 'categoría dentro de Organización');
  // Main card: P/N, Presentación, Producto, Descripción and the Multimedia box under it.
  const partNumber = form.indexOf('name="partNumber"');
  const description = form.indexOf('name="longDescription"');
  const multimedia = form.indexOf('form-subheading');
  const image = form.indexOf('name="image"');
  assert.ok(partNumber > -1 && description > partNumber && multimedia > description && image > multimedia, 'multimedia va tras la descripción');
  assert.match(form, /Multimedia/);
  assert.match(form, /name="image" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  // Precio card: Precio, then additional prices with the internal Precio de fábrica and Ganancia.
  assert.match(form, /<h2>Precio<\/h2>/);
  assert.match(form, /name="price"/);
  assert.match(form, /name="cost"/);
  assert.match(form, /Precios adicionales/);
  assert.match(form, /Precio de fábrica/);
  assert.match(form, /Ganancia/);
  assert.match(form, /currency-input__symbol/);
  assert.doesNotMatch(form, /Cobrar impuestos|Precio unitario|Precio de comparación/);
  assert.doesNotMatch(form, /name="minimumStock"/);
  assert.doesNotMatch(form, /Mínimo de stock|Cantidad inicial/);
  // Inventory card with an available quantity and the manual location.
  assert.match(form, /inventory-card/);
  assert.match(form, /name="initialQuantity"/);
  assert.match(form, /name="location"/);
  // Estado is no longer on the form.
  assert.doesNotMatch(form, /name="state"/);
  // Named lists render as a native select (no-JS fallback) plus a searchable combobox.
  assert.match(form, /data-combo-search/);
  assert.match(form, /placeholder="Buscar categorías"/);
  assert.match(form, /placeholder="Buscar o agregar tipo de producto"/);
  assert.match(form, /placeholder="Buscar o agregar proveedor"/);
  assert.match(form, /data-combo-add/);
});

test('Precio and Costo are saved and the detail shows the margin', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'C-1', description: 'Con coste', presentation: 'KIT', price: '10.00', cost: '6.50' })).status, 303);
  const detail = await (await a.get('/products/1')).text();
  assert.match(detail, /<dt>Precio<\/dt><dd>\$10\.00<\/dd>/);
  assert.match(detail, /<dt>Precio de fábrica<\/dt><dd>\$6\.50<\/dd>/);
  assert.match(detail, /<dt>Ganancia<\/dt><dd>\$3\.50<\/dd>/);
  // The form reloads both values and shows the additional prices.
  const form = await (await a.get('/products/1/edit')).text();
  assert.match(form, /name="price" inputmode="decimal" value="10\.00"/);
  assert.match(form, /name="cost" inputmode="decimal" value="6\.50"/);
  assert.match(form, /Precios adicionales/);
  assert.match(form, /Ganancia/);
  // An invalid factory price is rejected with a specific message and keeps the stored value.
  const invalid = await a.post('/products/1', { csrfToken: a.csrfToken, partNumber: 'C-1', description: 'Con coste', presentation: 'KIT', cost: 'abc' });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /El precio de fábrica/);
  assert.match(await (await a.get('/products/1')).text(), /<dt>Precio de fábrica<\/dt><dd>\$6\.50<\/dd>/);
});

test('the starter categories ship with the app and are seeded only once across restarts', async (t) => {
  const a = await app(t);
  const readCategories = () => {
    const db = new DatabaseSync(a.databasePath, { readOnly: true });
    try { return db.prepare('SELECT name FROM categories ORDER BY id').all().map((row) => row.name); }
    finally { db.close(); }
  };
  assert.deepEqual(readCategories(), DEFAULT_CATEGORIES);
  await a.restart();
  a.csrfToken = await a.signIn('admin', 'marina-segura-123');
  assert.deepEqual(readCategories(), DEFAULT_CATEGORIES);
  const form = await (await a.get('/products/new')).text();
  for (const name of DEFAULT_CATEGORIES) assert.ok(form.includes(name), `falta la categoría ${name}`);
});

test('only an admin creates categories; managers keep creating types and suppliers', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'gestion', password: 'equipo-seguro-123', role: 'manager' })).status, 303);
  const managerToken = await a.signIn('gestion', 'equipo-seguro-123');
  const managerForm = await (await a.get('/products/new')).text();
  // The category create field is admin-only; types and suppliers stay open to management.
  assert.doesNotMatch(managerForm, /name="newCategory"/);
  assert.match(managerForm, /name="newProductType"/);
  assert.match(managerForm, /name="newSupplier"/);
  const base = { csrfToken: managerToken, partNumber: 'M-1', description: 'Motor', presentation: 'KIT' };
  assert.equal((await a.post('/products', { ...base, newCategory: 'Categoría manager' })).status, 403);
  assert.equal((await a.post('/products', { ...base, newProductType: 'Tipo M', newSupplier: 'Prov M' })).status, 303);

  const adminToken = await a.signIn('admin', 'marina-segura-123');
  const adminForm = await (await a.get('/products/new')).text();
  assert.match(adminForm, /name="newCategory"/);
  assert.equal((await a.post('/products', { csrfToken: adminToken, partNumber: 'A-1', description: 'Ánodo', presentation: 'unidad', newCategory: 'Categoría admin' })).status, 303);
  assert.match(await (await a.get('/products/2')).text(), /Categoría<\/dt><dd>Categoría admin/);
});

test('the form no longer exposes Estado; archiving stays on the detail page', async (t) => {
  const a = await app(t);
  assert.doesNotMatch(await (await a.get('/products/new')).text(), /name="state"/);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'ARC', description: 'Archivado', presentation: 'KIT', state: 'archived' })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Estado<\/dt><dd>Archivado/);
  const active = await (await a.get('/products')).text();
  assert.doesNotMatch(active, /ARC/);
  assert.equal((await a.post('/products/1/restore', { csrfToken: a.csrfToken })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Estado<\/dt><dd>Activo/);
});
