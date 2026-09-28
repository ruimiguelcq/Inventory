import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-customer-address-'));
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
  const csrfToken = token(await (await get('/products')).text());
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/products')).text());
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  const open = async () => {
    server = createInventoryServer({ databasePath });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  };
  return {
    url, get, post, token, csrfToken, signIn, close, open, databasePath,
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

const base = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
  email: 'ana@example.com', phone: '+58 412 000 0000', ...overrides,
});

const address = {
  addressFirstName: 'Ana', addressLastName: 'Pérez', addressCompany: 'Astilleros del Caribe',
  address1: 'Av. Libertador, casa 12', address2: 'Apto 3-B', addressPostalCode: '1010',
  addressCity: 'Caracas', addressState: 'Distrito Capital',
};

const countAddresses = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM customer_addresses').get().count;
  } finally { db.close(); }
};

test('el cliente guarda una única dirección y la ficha la muestra', async (t) => {
  const a = await app(t);
  const created = await a.post('/customers', base(a, address));
  assert.equal(created.status, 303);

  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /Dirección predeterminada<\/dt><dd>Ana Pérez<br>Astilleros del Caribe/);
  assert.match(detail, /Av\. Libertador, casa 12/);
  assert.match(detail, /Apto 3-B/);
  assert.match(detail, /Caracas, Distrito Capital/);
  assert.match(detail, /1010/);
  assert.match(detail, /Venezuela/);

  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM customer_addresses').get();
    assert.equal(row.customer_id, 1);
    assert.equal(row.country, 'Venezuela');
    assert.equal(row.city, 'Caracas');
    assert.equal(row.state, 'Distrito Capital');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_addresses').get().count, 1);
  } finally { db.close(); }
});

test('un cliente puede guardarse sin dirección', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/customers', base(a))).status, 303);
  assert.equal(countAddresses(a.databasePath), 0);
  assert.match(await (await a.get('/customers/1')).text(), /Dirección predeterminada<\/dt><dd>Sin dirección/);
});

test('editar la dirección la reemplaza sin duplicarla', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, address));
  const updated = await a.post('/customers/1', base(a, {
    ...address, addressCity: 'Maracaibo', addressState: 'Zulia', address1: 'Calle 5',
  }));
  assert.equal(updated.status, 303);
  assert.equal(countAddresses(a.databasePath), 1);
  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /Calle 5/);
  assert.match(detail, /Maracaibo, Zulia/);
  assert.doesNotMatch(detail, /Distrito Capital/);
});

test('quitar la dirección la borra sin tocar el resto del cliente', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, address));
  const cleared = await a.post('/customers/1', base(a, {
    addressFirstName: '', addressLastName: '', addressCompany: '', address1: '',
    address2: '', addressPostalCode: '', addressCity: '', addressState: '',
  }));
  assert.equal(cleared.status, 303);
  assert.equal(countAddresses(a.databasePath), 0);
  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /Ana Pérez/);
  assert.match(detail, /Dirección predeterminada<\/dt><dd>Sin dirección/);
});

test('el estado debe salir de la lista de Venezuela', async (t) => {
  const a = await app(t);
  const invalid = await a.post('/customers', base(a, { ...address, addressState: 'Atlantis' }));
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /estado de Venezuela/);
  assert.equal(countAddresses(a.databasePath), 0);
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});

test('el modal ofrece exactamente los campos de la dirección y ninguno de teléfono', async (t) => {
  const a = await app(t);
  const form = await (await a.get('/customers/new')).text();
  const dialog = form.match(/<dialog[^>]*data-address-dialog[\s\S]*?<\/dialog>/)?.[0] ?? '';
  for (const label of ['País o región', 'Nombre', 'Apellido', 'Empresa', 'Calle y número de casa', 'Apartamento, local, etc.', 'Código postal', 'Ciudad', 'Estado']) {
    assert.match(dialog, new RegExp(label.replace(/[.()]/g, '\\$&')), label);
  }
  for (const name of ['addressCountry', 'addressFirstName', 'addressLastName', 'addressCompany', 'address1', 'address2', 'addressPostalCode', 'addressCity', 'addressState']) {
    assert.match(dialog, new RegExp(`name="${name}"`), name);
  }
  assert.doesNotMatch(dialog, /name="addressPhone"|Número de teléfono/);
  assert.match(dialog, /name="addressCountry" value="Venezuela" readonly/);
  assert.match(dialog, /<select id="addressState" name="addressState">/);
  assert.match(dialog, /<option value="Zulia"/);
});

test('el modal vive dentro de la ficha y sus botones no envían el formulario', async (t) => {
  const a = await app(t);
  const form = await (await a.get('/customers/new')).text();
  // El diálogo y sus campos van dentro del <form> del cliente: cerrarlo no navega ni pierde el resto.
  const formMarkup = form.match(/<form class="product-form product-form--split"[\s\S]*?action="\/customers"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.match(formMarkup, /<dialog[^>]*data-address-dialog/);
  assert.match(formMarkup, /name="addressCity"/);
  for (const hook of ['data-address-open', 'data-address-cancel', 'data-address-apply', 'data-address-remove']) {
    const button = formMarkup.match(new RegExp(`<button[^>]*${hook}[^>]*>`))?.[0] ?? '';
    assert.match(button, /type="button"/, hook);
  }
});

test('Consulta ve la dirección pero no puede editarla', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, address));
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' })).status, 303);
  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  const detail = await a.get('/customers/1');
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Caracas, Distrito Capital/);
  assert.equal((await a.get('/customers/1/edit')).status, 403);
  assert.equal((await a.post('/customers/1', { ...base(a, address), csrfToken: viewerToken })).status, 403);
  assert.equal(countAddresses(a.databasePath), 1);
});

test('una base existente gana la tabla de direcciones sin perder sus datos', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'LEGACY-1', description: 'Repuesto existente', presentation: 'KIT', initialQuantity: '7' })).status, 303);
  assert.equal((await a.post('/customers', base(a, address))).status, 303);

  await a.close();
  const legacy = new DatabaseSync(a.databasePath);
  legacy.exec('DROP TABLE customer_addresses;');
  const before = legacy.prepare('SELECT * FROM products ORDER BY id').all();
  legacy.close();
  await a.open();

  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'customer_addresses'").get().count, 1);
    assert.deepEqual(db.prepare('SELECT * FROM products ORDER BY id').all(), before);
  } finally { db.close(); }
  // La tabla recreada queda vacía; la sesión se perdió al reiniciar, así que se vuelve a entrar.
  assert.equal(countAddresses(a.databasePath), 0);
  await a.signIn('admin', 'marina-segura-123');
  assert.match(await (await a.get('/customers/1')).text(), /Sin dirección/);
});
