import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-customer-inline-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const server = createInventoryServer({ databasePath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
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
  csrfToken = token(await (await get('/orders/new')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/orders/new')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

const inline = (a, overrides = {}) => a.post('/customers/inline', {
  csrfToken: a.csrfToken, name: 'Nuevo', lastName: 'Cliente', taxId: 'V-9000',
  email: 'nuevo@example.com', phone: '+58 414 000 0000', notes: '', address1: '', addressCity: '', addressState: '', ...overrides,
});

async function seedProduct(a) {
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT',
    price: '10.00', initialQuantity: '5',
  })).status, 303);
}

test('crear un cliente al vuelo lo deja en Clientes y devuelve su id', async (t) => {
  const a = await app(t);
  const response = await inline(a);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const data = await response.json();
  assert.equal(data.id, 1);
  assert.equal(data.name, 'Nuevo Cliente');

  // The customer lands in the Clientes section with its RIF.
  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /Nuevo Cliente/);
  assert.match(detail, /V-9000/);
});

test('un RIF repetido se rechaza con un mensaje claro y sin crear duplicado', async (t) => {
  const a = await app(t);
  assert.equal((await inline(a)).status, 201);
  const repeated = await inline(a, { name: 'Otro', taxId: 'v-9000' });
  assert.equal(repeated.status, 409);
  assert.match((await repeated.json()).error, /Ya existe un cliente con ese RIF \/ Cédula/);
  // Only the first customer exists; the duplicate never landed.
  assert.match((await (await a.get('/customers/1')).text()), /V-9000/);
  assert.equal((await a.get('/customers/2')).status, 404);
});

test('el cliente creado al vuelo se asigna al pedido al guardarlo', async (t) => {
  const a = await app(t);
  await seedProduct(a);
  const created = await inline(a, { name: 'María', lastName: 'López', taxId: 'V-7777' });
  const { id } = await created.json();

  const order = await a.post('/orders', {
    csrfToken: a.csrfToken, customerId: String(id), channelId: '1', discount: '0', notes: '',
    productId: ['1'], quantity: ['1'],
  });
  assert.equal(order.status, 303);
  const detail = await (await a.get('/orders/1001')).text();
  assert.match(detail, /<a class="text-link" href="\/customers\/\d+">María López<\/a>/);
  assert.equal(id, 1);
});

test('el alta de pedido y de borrador ofrecen buscar o crear cliente', async (t) => {
  const a = await app(t);
  for (const path of ['/orders/new', '/drafts/new']) {
    const html = await (await a.get(path)).text();
    assert.match(html, /data-combo\b[^>]*data-combo-customer|data-combo-customer/, `${path} tiene el combo de cliente`);
    assert.match(html, /data-customer-open>Nuevo cliente</, `${path} ofrece crear cliente`);
    assert.match(html, /<dialog class="customer-dialog"[^>]*data-customer-dialog/, `${path} trae el modal`);
    assert.match(html, /action="\/customers\/inline"/, `${path} apunta al alta al vuelo`);
    assert.match(html, /name="customerId"/, `${path} busca entre los clientes existentes`);
  }
});

test('Consulta no puede crear clientes desde el pedido; el modal no se le ofrece', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  await a.signIn('viewer', 'equipo-seguro-123');

  const html = await (await a.get('/orders/new')).text();
  assert.doesNotMatch(html, /data-customer-open/);
  assert.doesNotMatch(html, /data-customer-dialog/);
  assert.equal((await inline(a)).status, 403);
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});

test('el alta al vuelo exige CSRF', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/customers/inline', {
    name: 'Sin', taxId: 'V-1', email: 'x@example.com', phone: '+58 400 000 0000',
  })).status, 403);
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});
