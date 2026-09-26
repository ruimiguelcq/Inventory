import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createInventoryServer } from '../src/server.mjs';

let temporaryDirectory;
let server;
let baseUrl;
let administratorCookie;
let administratorUsername;

async function getCsrfToken(cookie = administratorCookie, path = '/inventory') {
  const page = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  const html = await page.text();
  return html.match(/name="csrfToken" value="([^"]+)"/)[1];
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'inventory-app-'));
  server = createInventoryServer({ databasePath: join(temporaryDirectory, 'inventory.sqlite') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('the administrator can set up access and create a repuesto visible in the inventory', async () => {
  const setupPage = await fetch(baseUrl);
  const setupHtml = await setupPage.text();
  assert.match(setupHtml, /Configura el acceso inicial/);
  const setupToken = setupHtml.match(/name="setupToken" value="([^"]+)"/)[1];

  const unverifiedSetup = await fetch(`${baseUrl}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'marina-segura-123' }),
  });
  assert.equal(unverifiedSetup.status, 403);

  const setupAttempts = await Promise.all(['admin', 'admin-alternate'].map(async (username) => ({
    username,
    response: await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ setupToken, username, password: 'marina-segura-123' }),
    }),
  })));
  const successfulSetup = setupAttempts.find(({ response }) => response.status === 303);
  const rejectedSetup = setupAttempts.find(({ response }) => response.status === 409);
  assert.ok(successfulSetup);
  assert.ok(rejectedSetup);
  administratorUsername = successfulSetup.username;
  const setupResponse = successfulSetup.response;
  assert.equal(setupResponse.status, 303);
  const setCookie = setupResponse.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  administratorCookie = setCookie.split(';')[0];

  const inventoryPage = await fetch(`${baseUrl}/inventory`, { headers: { cookie: administratorCookie } });
  const inventoryHtml = await inventoryPage.text();
  assert.match(inventoryHtml, /<h1>Inventario<\/h1>/);
  assert.equal(setupResponse.headers.get('location'), '/products');

  const csrfToken = inventoryHtml.match(/name="csrfToken" value="([^"]+)"/)[1];
  const createResponse = await fetch(`${baseUrl}/products`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: administratorCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken,
      partNumber: '  6L-12345  ',
      description: 'Conchas de biela',
      presentation: 'SET',
      brand: 'Marina Parts',
      location: 'Estante B · caja 4',
      minimumStock: '2',
    }),
  });
  assert.equal(createResponse.status, 303);

  const savedPage = await fetch(`${baseUrl}/inventory`, { headers: { cookie: administratorCookie } });
  const savedHtml = await savedPage.text();
  assert.match(savedHtml, /6L-12345/);
  assert.match(savedHtml, /Conchas de biela/);
  // Inventory shows only Producto, P/N and a read-only Disponible; location and minimum are gone.
  assert.match(savedHtml, /<th scope="col" class="align-left">Producto<\/th>\s*<th scope="col">P\/N<\/th>\s*<th scope="col" class="align-right">Disponible<\/th>\s*<th scope="col">Historial<\/th>/);
  assert.doesNotMatch(savedHtml, /data-column|Ubicación|Mínimo de stock|Estante B/);
  const catalogHtml = await (await fetch(`${baseUrl}/products`, { headers: { cookie: administratorCookie } })).text();
  assert.match(catalogHtml, /6L-12345/);
  const detailHtml = await (await fetch(`${baseUrl}/products/1`, { headers: { cookie: administratorCookie } })).text();
  assert.match(detailHtml, /Marina Parts/);
});

test('a duplicate P/N is rejected without changing the saved repuesto', async () => {
  const response = await fetch(`${baseUrl}/products`, {
    method: 'POST',
    headers: { cookie: administratorCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken: await getCsrfToken(),
      partNumber: '6l-12345',
      description: 'Descripción duplicada',
      presentation: 'KIT',
      brand: '',
      location: '',
      minimumStock: '',
    }),
  });
  assert.equal(response.status, 409);
  const responseHtml = await response.text();
  assert.match(responseHtml, /Ya existe un repuesto con ese P\/N/);

  const inventoryResponse = await fetch(`${baseUrl}/inventory`, { headers: { cookie: administratorCookie } });
  const inventoryHtml = await inventoryResponse.text();
  assert.match(inventoryHtml, /Conchas de biela/);
  assert.doesNotMatch(inventoryHtml, /Descripción duplicada/);
});

test('the administrator can edit a repuesto and see the updated details', async () => {
  const editPage = await fetch(`${baseUrl}/products/1/edit`, { headers: { cookie: administratorCookie } });
  assert.equal(editPage.status, 200);
  const editHtml = await editPage.text();
  assert.match(editHtml, /Editar repuesto/);
  assert.match(editHtml, /Ubicación principal/);

  const response = await fetch(`${baseUrl}/products/1`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: administratorCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrfToken: editHtml.match(/name="csrfToken" value="([^"]+)"/)[1],
      partNumber: '6L-12345',
      description: 'Conchas de biela originales',
      presentation: 'SET',
      brand: 'Marina Parts',
      location: 'Estante C',
      minimumStock: '3',
    }),
  });
  assert.equal(response.status, 303);

  const inventoryResponse = await fetch(`${baseUrl}/inventory`, { headers: { cookie: administratorCookie } });
  const inventoryHtml = await inventoryResponse.text();
  assert.match(inventoryHtml, /Conchas de biela originales/);
  assert.doesNotMatch(inventoryHtml, /Estante C/);
});

test('unauthenticated visitors are redirected and the administrator can sign in and out', async () => {
  const privatePage = await fetch(`${baseUrl}/inventory`, { redirect: 'manual' });
  assert.equal(privatePage.status, 303);
  assert.equal(privatePage.headers.get('location'), '/login');

  const invalidLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: administratorUsername, password: 'incorrecta' }),
  });
  assert.equal(invalidLogin.status, 401);
  assert.match(await invalidLogin.text(), /Usuario o contraseña incorrectos/);

  const validLogin = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: administratorUsername.toUpperCase(), password: 'marina-segura-123' }),
  });
  assert.equal(validLogin.status, 303);
  const sessionCookie = validLogin.headers.get('set-cookie').split(';')[0];
  const inventoryResponse = await fetch(`${baseUrl}/inventory`, { headers: { cookie: sessionCookie } });
  assert.match(await inventoryResponse.text(), /Conchas de biela originales/);

  const csrfToken = await getCsrfToken(sessionCookie);
  const logout = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken }),
  });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const afterLogout = await fetch(`${baseUrl}/inventory`, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(afterLogout.headers.get('location'), '/login');
});

async function postForm(path, fields, cookie = administratorCookie) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

test('the administrator creates a consulta account that can sign in and read the catalog', async () => {
  const accounts = await fetch(`${baseUrl}/users`, { headers: { cookie: administratorCookie } });
  assert.equal(accounts.status, 200);
  assert.match(await accounts.text(), /Crear cuenta/);
  const created = await postForm('/users', {
    csrfToken: await getCsrfToken(), username: 'consulta', password: 'consulta-segura-123', role: 'viewer',
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/users?saved=1');
  const listing = await fetch(`${baseUrl}/users`, { headers: { cookie: administratorCookie } });
  const html = await listing.text();
  assert.match(html, /consulta/);
  assert.match(html, /Consulta/);
  assert.doesNotMatch(html, /consulta-segura-123|password_hash|password_salt/);
  const login = await postForm('/login', { username: 'CONSULTA', password: 'consulta-segura-123' }, '');
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const inventory = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  assert.equal(inventory.status, 200);
  assert.match(await inventory.text(), /Conchas de biela originales/);
});

async function signIn(username, password) {
  const response = await postForm('/login', { username, password }, '');
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';')[0];
}

test('consulta cannot mutate the catalog or manage accounts even through direct requests', async () => {
  const cookie = await signIn('consulta', 'consulta-segura-123');
  const csrfToken = await getCsrfToken(cookie);
  const page = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const html = await page.text();
  assert.doesNotMatch(html, /Añadir repuesto|Editar|href="\/users"|\/products\/\d+\/edit/);
  for (const path of ['/products/new', '/products/1/edit', '/users']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    assert.equal(response.status, 403, path);
    assert.match(await response.text(), /Acceso denegado/);
  }
  for (const path of ['/products', '/products/1', '/products/1/archive', '/products/1/stock', '/users', '/users/1/role']) {
    const response = await postForm(path, {
      csrfToken, partNumber: 'PROHIBIDO', description: 'Cambio prohibido', presentation: 'KIT',
      username: 'intruso', password: 'intruso-seguro-123', role: 'admin',
    }, cookie);
    assert.equal(response.status, 403, path);
  }
  const unchanged = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const unchangedHtml = await unchanged.text();
  assert.match(unchangedHtml, /Conchas de biela originales/);
  assert.doesNotMatch(unchangedHtml, /PROHIBIDO|Cambio prohibido/);
  const invalidForm = await fetch(`${baseUrl}/inventory`, {
    method: 'POST', headers: { cookie }, body: 'x'.repeat(17000),
  });
  assert.equal(invalidForm.status, 403);
  assert.doesNotMatch(await invalidForm.text(), /Añadir repuesto|Editar/);
});

test('gestión can maintain articles and role changes apply to an existing session immediately', async () => {
  const created = await postForm('/users', {
    csrfToken: await getCsrfToken(), username: 'gestion', password: 'gestion-segura-123', role: 'manager',
  });
  assert.equal(created.status, 303);
  const cookie = await signIn('gestion', 'gestion-segura-123');
  const csrfToken = await getCsrfToken(cookie);
  const form = await fetch(`${baseUrl}/products/new`, { headers: { cookie } });
  assert.equal(form.status, 200);
  assert.match(await form.text(), /Guardar repuesto/);
  const product = { csrfToken, partNumber: 'GEST-1', description: 'Filtro de aceite', presentation: 'unidad' };
  assert.equal((await postForm('/products', product, cookie)).status, 303);
  const inventory = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const html = await inventory.text();
  assert.match(html, /Filtro de aceite/);
  assert.doesNotMatch(html, /href="\/users"/);
  const id = html.match(/href="\/products\/(\d+)">Filtro de aceite/)[1];
  assert.equal((await postForm(`/products/${id}`, { ...product, description: 'Filtro actualizado' }, cookie)).status, 303);
  assert.equal((await postForm('/users', { csrfToken, username: 'otra', password: 'otra-segura-123', role: 'manager' }, cookie)).status, 403);
  const deniedAccounts = await fetch(`${baseUrl}/users`, { headers: { cookie } });
  assert.equal(deniedAccounts.status, 403);

  const accounts = await fetch(`${baseUrl}/users`, { headers: { cookie: administratorCookie } });
  const accountsHtml = await accounts.text();
  const userId = accountsHtml.match(/<td>gestion<\/td>[\s\S]*?action="\/users\/(\d+)\/role"/)[1];
  assert.equal((await postForm(`/users/${userId}/role`, { csrfToken, role: 'admin' }, cookie)).status, 403);
  const adminToken = await getCsrfToken();
  assert.equal((await postForm(`/users/${userId}/role`, { csrfToken: adminToken, role: 'viewer' })).status, 303);
  const demoted = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const demotedHtml = await demoted.text();
  assert.match(demotedHtml, /Filtro actualizado/);
  assert.doesNotMatch(demotedHtml, /Añadir repuesto|Editar/);
  assert.equal((await postForm(`/products/${id}`, product, cookie)).status, 403);
  assert.equal((await postForm(`/users/${userId}/role`, { csrfToken: adminToken, role: 'manager' })).status, 303);
  assert.equal((await postForm(`/products/${id}`, product, cookie)).status, 303);
});

test('account administration validates credentials, rejects forged roles and requires CSRF protection', async () => {
  const csrfToken = await getCsrfToken();
  const valid = { csrfToken, username: 'nueva', password: 'nueva-segura-123', role: 'viewer' };
  for (const fields of [{ username: 'x' }, { password: 'corta' }, { role: 'admin' }, { role: 'unknown' }]) {
    const response = await postForm('/users', { ...valid, ...fields });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /value="nueva-segura-123"|value="corta"/);
  }
  const duplicate = await postForm('/users', { ...valid, username: 'CONSULTA', role: 'manager' });
  assert.equal(duplicate.status, 409);
  assert.match(await duplicate.text(), /Ese usuario ya existe/);
  assert.equal((await postForm('/users', { ...valid, csrfToken: '' })).status, 403);
  assert.equal((await postForm('/users/2/role', { role: 'manager' })).status, 403);
  assert.equal((await postForm('/users/2/role', { csrfToken, role: 'admin' })).status, 400);
  assert.equal((await postForm('/users/1/role', { csrfToken, role: 'viewer' })).status, 403);
  assert.equal((await postForm('/users/99999/role', { csrfToken, role: 'viewer' })).status, 404);
  for (const path of ['/users', '/products/new', '/products/1/edit']) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
  }
  assert.equal((await postForm('/users', valid, '')).headers.get('location'), '/login');
  const cookie = await signIn('consulta', 'consulta-segura-123');
  assert.equal((await postForm('/products', { csrfToken: await getCsrfToken(cookie) }, cookie)).status, 403);
  assert.equal((await postForm('/logout', { csrfToken: await getCsrfToken(cookie) }, cookie)).status, 303);
});

test('accounts and assigned permissions survive an application restart', async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = createInventoryServer({ databasePath: join(temporaryDirectory, 'inventory.sqlite') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = await signIn('consulta', 'consulta-segura-123');
  const inventory = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const html = await inventory.text();
  assert.match(html, /Conchas de biela originales/);
  assert.doesNotMatch(html, /Añadir repuesto|Editar/);
  assert.equal((await postForm('/products', { csrfToken: await getCsrfToken(cookie) }, cookie)).status, 403);
  const managerCookie = await signIn('gestion', 'gestion-segura-123');
  assert.equal((await fetch(`${baseUrl}/products/new`, { headers: { cookie: managerCookie } })).status, 200);
  administratorCookie = await signIn(administratorUsername, 'marina-segura-123');
  assert.equal((await fetch(`${baseUrl}/users`, { headers: { cookie: administratorCookie } })).status, 200);
});

test('demotion to consulta rejects a write whose request body is still arriving', async (t) => {
  const cookie = await signIn('gestion', 'gestion-segura-123');
  const csrfToken = await getCsrfToken(cookie);
  const accounts = await fetch(`${baseUrl}/users`, { headers: { cookie: administratorCookie } });
  const userId = (await accounts.text()).match(/<td>gestion<\/td>[\s\S]*?action="\/users\/(\d+)\/role"/)[1];
  const adminToken = await getCsrfToken();
  for (const path of ['/products', '/products/1', '/products/1/stock', '/products/1/stock/confirm', '/products/1/stock/apply', '/products/1/archive', '/products/1/restore']) {
    assert.equal((await postForm(`/users/${userId}/role`, { csrfToken: adminToken, role: 'manager' })).status, 303);
    const pending = request(`${baseUrl}${path}`, {
      method: 'POST', headers: { cookie, Expect: '100-continue', 'content-type': 'application/x-www-form-urlencoded' },
    });
    t.after(() => pending.destroy());
    const result = new Promise((resolve, reject) => {
      pending.on('response', (response) => { response.resume(); resolve(response.statusCode); });
      pending.on('error', reject);
    });
    await new Promise((resolve) => { pending.once('continue', resolve); pending.flushHeaders(); });
    assert.equal((await postForm(`/users/${userId}/role`, { csrfToken: adminToken, role: 'viewer' })).status, 303);
    pending.end(new URLSearchParams({ csrfToken, partNumber: 'TARDIO', description: 'Cambio tardío', presentation: 'KIT' }).toString());
    assert.equal(await result, 403, path);
  }
  const inventory = await fetch(`${baseUrl}/inventory`, { headers: { cookie } });
  const html = await inventory.text();
  assert.match(html, /Conchas de biela originales/);
  assert.doesNotMatch(html, /TARDIO|Cambio tardío/);
});

async function readPage(path, cookie = administratorCookie) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

test('stock changes are reviewed before saving and attributed in the article history', async () => {
  const csrfToken = await getCsrfToken();
  assert.match(await readPage('/inventory'), /href="\/products\/1\/stock"/);
  assert.match(await readPage('/products/1/edit'), /href="\/products\/1\/stock"/);
  const form = await readPage('/products/1/stock');
  assert.match(form, /Ajustar por/);
  assert.match(form, /Establecer en/);
  assert.match(form, /SET/);
  const preview = await postForm('/products/1/stock', { csrfToken, operation: 'adjust', quantity: '5', reason: 'Recepción del proveedor' });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Revisar cambio/);
  assert.match(html, /Anterior: <strong>0<\/strong>/);
  assert.match(html, /Nueva: <strong>5<\/strong>/);
  assert.match(await readPage('/products/1/history'), /Todavía no hay movimientos/);
  const confirmationToken = html.match(/name="confirmationToken" value="([^"]+)"/)[1];
  const saved = await postForm('/products/1/stock/confirm', { csrfToken, confirmationToken });
  assert.equal(saved.status, 303);
  const history = await readPage(saved.headers.get('location'));
  assert.match(history, /Ajustar por/);
  assert.match(history, /<td>0<\/td><td>5<\/td>/);
  assert.ok(history.includes(administratorUsername));
  assert.match(history, /Recepción del proveedor/);
  assert.match(history, /<time datetime="\d{4}-\d{2}-\d{2}T/);
  assert.match(await readPage('/products/1/stock'), /Disponible: <strong>5<\/strong>/);
});

async function previewStock(fields, cookie = administratorCookie, productId = 1) {
  const csrfToken = await getCsrfToken(cookie);
  const response = await postForm(`/products/${productId}/stock`, { csrfToken, ...fields }, cookie);
  assert.equal(response.status, 200);
  const html = await response.text();
  return { csrfToken, confirmationToken: html.match(/name="confirmationToken" value="([^"]+)"/)[1] };
}

test('gestión can subtract complete presentations and set an exact total, while consulta can only read history', async () => {
  const accountsHtml = await readPage('/users');
  const userId = accountsHtml.match(/<td>gestion<\/td>[\s\S]*?action="\/users\/(\d+)\/role"/)[1];
  await postForm(`/users/${userId}/role`, { csrfToken: await getCsrfToken(), role: 'manager' });
  const manager = await signIn('gestion', 'gestion-segura-123');
  const subtract = await previewStock({ operation: 'adjust', quantity: '-2', reason: '<Entrega>' }, manager);
  assert.equal((await postForm('/products/1/stock/confirm', subtract, manager)).status, 303);
  assert.match(await readPage('/products/1/history', manager), /<td>-2<\/td><td>5<\/td><td>3<\/td>/);
  const set = await previewStock({ operation: 'set', quantity: '8' }, manager);
  assert.equal((await postForm('/products/1/stock/confirm', set, manager)).status, 303);
  const viewer = await signIn('consulta', 'consulta-segura-123');
  const history = await readPage('/products/1/history', viewer);
  assert.match(history, /Establecer en/);
  assert.match(history, /<td>8<\/td><td>3<\/td><td>8<\/td>/);
  assert.match(history, /<td>gestion<\/td>/);
  assert.match(history, /&lt;Entrega&gt;/);
  assert.doesNotMatch(history, /Ajustar inventario|Confirmar cambio|Editar|Eliminar/);
  assert.equal((await fetch(`${baseUrl}/products/1/stock`, { headers: { cookie: viewer } })).status, 403);
  assert.equal((await postForm('/products/1/stock/confirm', { csrfToken: await getCsrfToken(viewer), confirmationToken: set.confirmationToken }, viewer)).status, 403);
  for (const path of ['/products/1/history', '/products/1/history/1', '/products/1/history/1/delete']) {
    assert.equal((await postForm(path, { csrfToken: await getCsrfToken() })).status, 404);
  }
});

test('invalid quantities and unverified confirmations leave stock and history unchanged', async () => {
  const csrfToken = await getCsrfToken();
  const before = await readPage('/products/1/history');
  for (const fields of [
    { operation: 'adjust', quantity: '-9' }, { operation: 'set', quantity: '-1' },
    { quantity: '1.5' }, { quantity: '' }, { quantity: 'NaN' }, { quantity: 'Infinity' },
    { quantity: '9007199254740992' }, { quantity: '9007199254740991' },
    { operation: 'other' }, { reason: 'x'.repeat(501) },
  ]) {
    const response = await postForm('/products/1/stock', { csrfToken, operation: 'adjust', quantity: '1', ...fields });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match(await response.text(), /role="alert"/);
  }
  assert.equal((await postForm('/products/1/stock', { operation: 'set', quantity: '0' })).status, 403);
  assert.equal((await postForm('/products/1/stock/confirm', { csrfToken, confirmationToken: 'forged' })).status, 409);
  assert.equal((await postForm('/products/99999/stock', { csrfToken })).status, 404);
  assert.equal(await readPage('/products/1/history'), before);
});

test('stale reviews and repeated submissions cannot overwrite or duplicate stock movements', async () => {
  const otherAdmin = await signIn(administratorUsername, 'marina-segura-123');
  const stale = await previewStock({ operation: 'set', quantity: '2' });
  const concurrent = await previewStock({ operation: 'adjust', quantity: '1' }, otherAdmin);
  assert.equal((await postForm('/products/1/stock/confirm', concurrent, otherAdmin)).status, 303);
  const history = await readPage('/products/1/history');
  assert.equal((await postForm('/products/1/stock/confirm', concurrent, otherAdmin)).status, 409);
  const conflict = await postForm('/products/1/stock/confirm', stale);
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /han cambiado/);
  assert.equal(await readPage('/products/1/history'), history);
  const zero = await previewStock({ operation: 'set', quantity: '0' });
  assert.equal((await postForm('/products/1/stock/confirm', { ...zero, quantity: '999', operation: 'adjust', userId: '999' })).status, 303);
  assert.match(await readPage('/products/1/history'), /<td>0<\/td><td>9<\/td><td>0<\/td>/);
});

test('stock and its complete history survive restart', async () => {
  const before = await readPage('/products/1/history');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = createInventoryServer({ databasePath: join(temporaryDirectory, 'inventory.sqlite') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  administratorCookie = await signIn(administratorUsername, 'marina-segura-123');
  const after = await readPage('/products/1/history');
  assert.equal(after.replace(/name="csrfToken" value="[^"]+"/g, ''), before.replace(/name="csrfToken" value="[^"]+"/g, ''));
});

test('Inventario saves a Disponible adjustment in one step and records it in the history', async () => {
  assert.match(await readPage('/inventory'), /action="\/products\/1\/stock\/apply"/);
  const applied = await postForm('/products/1/stock/apply', { csrfToken: await getCsrfToken(), operation: 'set', quantity: '7', reason: '<Recuento inline>' });
  assert.equal(applied.status, 303);
  assert.equal(applied.headers.get('location'), '/inventory?msg=stocked');
  const inventory = await readPage('/inventory?msg=stocked');
  assert.match(inventory, /Existencias actualizadas\./);
  assert.match(inventory, /class="quantity-cell inventory-ok"[^>]*>\s*<a class="stock-value"[^>]*>7<\/a>/);
  const history = await readPage('/products/1/history');
  assert.match(history, /&lt;Recuento inline&gt;/);
  assert.match(history, /<td>7<\/td>/);

  // The search survives the round trip.
  const filtered = await postForm('/products/1/stock/apply', { csrfToken: await getCsrfToken(), operation: 'adjust', quantity: '1', q: 'biela' });
  assert.equal(filtered.headers.get('location'), '/inventory?msg=stocked&q=biela');

  // Validation and permissions are unchanged.
  const csrfToken = await getCsrfToken();
  assert.equal((await postForm('/products/1/stock/apply', { csrfToken, operation: 'set', quantity: '-1' })).status, 400);
  assert.equal((await postForm('/products/1/stock/apply', { csrfToken, operation: 'other', quantity: '1' })).status, 400);
  assert.equal((await postForm('/products/1/stock/apply', { operation: 'set', quantity: '1' })).status, 403);
  const viewer = await signIn('consulta', 'consulta-segura-123');
  assert.equal((await postForm('/products/1/stock/apply', { csrfToken: await getCsrfToken(viewer), operation: 'set', quantity: '1' }, viewer)).status, 403);
  assert.equal((await postForm('/products/99999/stock/apply', { csrfToken, operation: 'set', quantity: '1' })).status, 404);
});
