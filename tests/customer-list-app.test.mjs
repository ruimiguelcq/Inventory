import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-customer-list-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const server = createInventoryServer({ databasePath });
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
  const csrfToken = token(await (await get('/products')).text());
  return { url, get, post, csrfToken };
}

const base = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
  email: 'ana@example.com', phone: '+58 412 000 0000', ...overrides,
});

const names = (html) => [...html.matchAll(/class="product-description"[^>]*>([^<]+)</g)].map((match) => match[1]);
const rowfor = (html, text) => html.match(new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*${text}(?:(?!</tr>)[\\s\\S])*</tr>`))?.[0] ?? '';
const toolbar = (html) => html.match(/<form class="catalog-toolbar"[\s\S]*?<\/form>/)?.[0] ?? '';

test('la lista muestra Nombre del cliente y Ubicación, en ese orden y sin RIF', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { addressCity: 'Maracaibo', addressState: 'Zulia', address1: 'Calle 5' }));
  const html = await (await a.get('/customers')).text();

  const header = html.match(/<thead>([\s\S]*?)<\/thead>/)[1];
  assert.ok(header.indexOf('Nombre del cliente') < header.indexOf('Ubicación'));
  assert.doesNotMatch(header, /RIF|Cédula/);
  assert.match(rowfor(html, 'Ana Pérez'), /Maracaibo, Zulia, Venezuela/);
});

test('Ubicación queda vacía cuando el cliente no tiene dirección', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a));
  const html = await (await a.get('/customers')).text();
  const row = rowfor(html, 'Ana Pérez');
  assert.equal([...row.matchAll(/<td/g)].length, 2);
  assert.doesNotMatch(row, /Venezuela/);
});

test('la lista se ordena alfabéticamente por nombre', async (t) => {
  const a = await app(t);
  for (const [name, taxId] of [['Zulema', 'V-3'], ['Ana', 'V-1'], ['Beatriz', 'V-2']]) {
    assert.equal((await a.post('/customers', base(a, { name, taxId }))).status, 303);
  }
  const html = await (await a.get('/customers')).text();
  assert.deepEqual(names(html), ['Ana Pérez', 'Beatriz Pérez', 'Zulema Pérez']);
});

test('la búsqueda es instantánea y solo por nombre (nombre y apellido)', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'J-12345678-9', email: 'contacto@marino.com', phone: '0414-1234567' }));
  const html = await (await a.get('/customers')).text();
  assert.match(toolbar(html), /data-instant-search/);
  assert.match(html, /data-catalog-results/);

  assert.deepEqual(names(await (await a.get('/customers?q=ana')).text()), ['Ana Pérez']);
  assert.deepEqual(names(await (await a.get('/customers?q=pérez')).text()), ['Ana Pérez']);
  for (const q of ['J-12345678-9', 'contacto@marino.com', '0414-1234567']) {
    const filtered = await (await a.get(`/customers?q=${encodeURIComponent(q)}`)).text();
    assert.match(filtered, /Sin resultados/, q);
    assert.deepEqual(names(filtered), [], q);
  }
});

test('la paginación es fija de 50 con Anterior y Siguiente, sin selector de tamaño', async (t) => {
  const a = await app(t);
  for (let index = 1; index <= 51; index += 1) {
    const id = String(index).padStart(2, '0');
    assert.equal((await a.post('/customers', base(a, { name: `Cliente ${id}`, taxId: `V-${index}` }))).status, 303);
  }

  const first = await (await a.get('/customers')).text();
  assert.equal(names(first).length, 50);
  assert.match(first, /51 clientes · Página 1 de 2/);
  assert.match(first, /href="\/customers\?page=2"/);
  assert.doesNotMatch(first, /page=1/);
  assert.doesNotMatch(toolbar(first), /pageSize|<select/);

  const second = await (await a.get('/customers?page=2')).text();
  assert.equal(names(second).length, 1);
  assert.match(second, /Página 2 de 2/);
  assert.match(second, /href="\/customers\?page=1"/);
  assert.doesNotMatch(second, /page=3/);
});

test('la lista no tiene casillas, acciones masivas ni segmentos', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a));
  const html = await (await a.get('/customers')).text();
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /name="segment"/i);
  assert.doesNotMatch(html, /Acciones masivas/i);
});

test('la lista no muestra el encabezado Todos', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a));
  const html = await (await a.get('/customers')).text();
  assert.doesNotMatch(html, /class="table-toolbar"/);
  assert.doesNotMatch(html, />Todos<\/h2>|>Resultados<\/h2>/);
});

test('Agregar cliente abre la ficha de alta', async (t) => {
  const a = await app(t);
  const html = await (await a.get('/customers')).text();
  assert.match(html, /<a class="button button-primary" href="\/customers\/new">Agregar cliente<\/a>/);

  const form = await a.get('/customers/new');
  assert.equal(form.status, 200);
  assert.match(await form.text(), /<h1>Nuevo cliente<\/h1>/);
});
