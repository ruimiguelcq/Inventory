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
  assert.match(inventoryHtml, /Inventario de repuestos/);

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
  assert.match(savedHtml, /SET/);
  assert.match(savedHtml, /Marina Parts/);
  assert.match(savedHtml, /Estante B · caja 4/);
  assert.match(savedHtml, /<td class="quantity-cell">2<\/td>/);
  assert.doesNotMatch(savedHtml, /<th[^>]*>Disponible<\/th>/);
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
  assert.match(inventoryHtml, /Estante C/);
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
  const id = html.match(/href="\/products\/(\d+)\/edit">GEST-1/)[1];
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
  for (const path of ['/products', '/products/1']) {
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
