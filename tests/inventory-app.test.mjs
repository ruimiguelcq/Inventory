import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
