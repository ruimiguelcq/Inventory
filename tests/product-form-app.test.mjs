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

test('the product form ships the two-column layout, media box below the description and Estado', async (t) => {
  const a = await app(t);
  const form = await (await a.get('/products/new')).text();
  // Shopify-style split: main column plus a sidebar for Estado and Organización del producto.
  assert.match(form, /class="product-layout"/);
  assert.match(form, /class="product-layout__main"/);
  assert.match(form, /class="product-layout__side"/);
  assert.match(form, /Organización del producto/);
  assert.match(form, /name="state"/);
  assert.match(form, /<option value="active" selected>Activo<\/option>/);
  assert.match(form, /<option value="archived"[^>]*>Archivado<\/option>/);
  // The media box sits between the long description and the category.
  const description = form.indexOf('name="longDescription"');
  const image = form.indexOf('name="image"');
  const category = form.indexOf('name="categoryId"');
  assert.ok(description > -1 && image > description && category > image, 'imagen va tras la descripción');
  assert.match(form, /name="image" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(form, /class="media-box"/);
  // Named lists render as a native select (no-JS fallback) plus a searchable combobox.
  assert.match(form, /data-combo-search/);
  assert.match(form, /placeholder="Buscar categorías"/);
  assert.match(form, /placeholder="Buscar o agregar tipo de producto"/);
  assert.match(form, /placeholder="Buscar o agregar proveedor"/);
  assert.match(form, /data-combo-add/);
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

test('the Estado field archives and restores an article and defaults to Activo', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'ACT', description: 'Activo', presentation: 'KIT' })).status, 303);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'ARC', description: 'Archivado', presentation: 'KIT', state: 'archived' })).status, 303);
  assert.match(await (await a.get('/products/1')).text(), /Estado<\/dt><dd>Activo/);
  assert.match(await (await a.get('/products/2')).text(), /Estado<\/dt><dd>Archivado/);
  // The archived article leaves the active catalog.
  const active = await (await a.get('/products')).text();
  assert.match(active, /Activo/);
  assert.doesNotMatch(active, /ARC/);
  // Editing the form changes the state without touching stock or history.
  assert.equal((await a.post('/products/2', { csrfToken: a.csrfToken, partNumber: 'ARC', description: 'Archivado', presentation: 'KIT', state: 'active' })).status, 303);
  assert.match(await (await a.get('/products/2')).text(), /Estado<\/dt><dd>Activo/);
  assert.match(await (await a.get('/products/2/history')).text(), /Todavía no hay movimientos/);
});
