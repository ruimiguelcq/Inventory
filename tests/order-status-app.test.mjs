import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-order-status-'));
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
  csrfToken = token(await (await get('/orders')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = token(await (await get('/orders')).text());
    return csrfToken;
  };
  return {
    url, get, post, token, signIn,
    get csrfToken() { return csrfToken; }, set csrfToken(value) { csrfToken = value; },
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

async function seed(a) {
  assert.equal((await a.post('/customers', {
    csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
    email: 'ana@example.com', phone: '+58 412 000 0000',
  })).status, 303);
  assert.equal((await a.post('/products', {
    csrfToken: a.csrfToken, partNumber: 'JUNTA', description: 'Junta de culata', presentation: 'KIT',
    price: '10.00', initialQuantity: '5',
  })).status, 303);
}

const createOrder = (a) => a.post('/orders', {
  csrfToken: a.csrfToken, customerId: '1', channelId: '1', discount: '0', notes: '',
  productId: ['1'], quantity: ['2'],
});
const action = (a, number, name) => a.post(`/orders/${number}/${name}`, { csrfToken: a.csrfToken });
const comment = (a, number, body) => a.post(`/orders/${number}/comments`, { csrfToken: a.csrfToken, body });
const orderLinks = (html) => [...html.matchAll(/class="part-number"><a href="\/orders\/(\d+)"/g)].map((match) => match[1]);

test('la ficha nace Abierta con pago y preparación pendientes y registra el alta', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);

  const detail = await (await a.get('/orders/1001')).text();
  assert.match(detail, /order-pill is-pending[^>]*>[\s\S]*?Sin pagar/);
  assert.match(detail, /order-pill is-pending[^>]*>[\s\S]*?Sin preparar/);
  assert.doesNotMatch(detail, /is-archived/);
  // The timeline starts with the automatic creation event.
  assert.match(detail, /Cronología/);
  assert.match(detail, /Se creó el pedido #1001\./);
});

test('marcar pagado y preparado registra eventos y archiva solo al completar ambos', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);

  const paid = await action(a, 1001, 'pay');
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.get('location'), '/orders/1001?pay=1');
  const afterPaid = await (await a.get('/orders/1001?pay=1')).text();
  assert.match(afterPaid, /order-pill is-paid/);
  assert.match(afterPaid, /Pedido marcado como pagado\./);
  assert.match(afterPaid, /Se marcó el pedido como pagado\./);
  assert.doesNotMatch(afterPaid, /is-archived/);

  const prepared = await action(a, 1001, 'prepare');
  assert.equal(prepared.status, 303);
  assert.equal(prepared.headers.get('location'), '/orders/1001?prepare=1');
  const afterPrepared = await (await a.get('/orders/1001?prepare=1')).text();
  assert.match(afterPrepared, /order-pill is-fulfilled/);
  assert.match(afterPrepared, /Pedido marcado como preparado\./);
  // Paid + prepared archives automatically and logs it, keeping the order visible.
  assert.match(afterPrepared, /order-pill is-archived/);
  assert.match(afterPrepared, /Se archivó el pedido\./);
});

test('la lista filtra Abiertos/Archivados/Anulados/Todos por ciclo de vida', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);

  const open = await (await a.get('/orders')).text();
  assert.deepEqual(orderLinks(open), ['1001']);
  assert.match(open, /<option value="open" selected>Abiertos<\/option>/);
  assert.match(open, /<td><span class="status-tag">Abierto<\/span><\/td>/);

  assert.equal((await action(a, 1001, 'archive')).status, 303);

  assert.deepEqual(orderLinks(await (await a.get('/orders')).text()), []);
  const archived = await (await a.get('/orders?state=archived')).text();
  assert.deepEqual(orderLinks(archived), ['1001']);
  assert.match(archived, /<option value="archived" selected>Archivados<\/option>/);
  assert.match(archived, /<td><span class="status-tag">Archivado<\/span><\/td>/);

  assert.deepEqual(orderLinks(await (await a.get('/orders?state=all')).text()), ['1001']);

  // Unarchiving returns it to the open view and records the step.
  assert.equal((await action(a, 1001, 'unarchive')).status, 303);
  assert.deepEqual(orderLinks(await (await a.get('/orders')).text()), ['1001']);
  assert.match(await (await a.get('/orders/1001')).text(), /Se desarchivó el pedido\./);
});

test('los comentarios internos se publican en la cronología con su autor', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);

  const posted = await comment(a, 1001, 'El cliente pidió factura separada.');
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.get('location'), '/orders/1001?comment=1');

  const detail = await (await a.get('/orders/1001?comment=1')).text();
  assert.match(detail, /Comentario publicado\./);
  assert.match(detail, /order-timeline__author">admin</);
  assert.match(detail, /El cliente pidió factura separada\./);

  const empty = await comment(a, 1001, '   ');
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /Escribe un comentario/);
});

test('un pedido anulado rechaza cambiar sus estados y Consulta no puede actuar', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);
  assert.equal((await a.post('/orders/1001/annul', { csrfToken: a.csrfToken })).status, 303);
  const annulled = await action(a, 1001, 'pay');
  assert.equal(annulled.status, 409);
  assert.match(await annulled.text(), /El pedido está anulado/);

  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'viewer', password: 'equipo-seguro-123', role: 'viewer' })).status, 303);
  assert.equal((await createOrder(a)).status, 303);
  await a.signIn('viewer', 'equipo-seguro-123');
  const detail = await (await a.get('/orders/1002')).text();
  assert.doesNotMatch(detail, /Marcar como pagado/);
  assert.doesNotMatch(detail, /order-comment-form/);
  assert.equal((await action(a, 1002, 'pay')).status, 403);
  assert.equal((await comment(a, 1002, 'no debería')).status, 403);
});

test('marcar pagado exige CSRF', async (t) => {
  const a = await app(t);
  await seed(a);
  assert.equal((await createOrder(a)).status, 303);
  assert.equal((await a.post('/orders/1001/pay', {})).status, 403);
  assert.doesNotMatch(await (await a.get('/orders/1001')).text(), /order-pill is-paid/);
});
