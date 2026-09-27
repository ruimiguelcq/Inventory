import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-customers-'));
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
  const restart = async () => { await close(); await open(); };
  return {
    url, get, post, token, csrfToken, signIn, close, open, restart, databasePath,
    get cookie() { return cookie; }, set cookie(value) { cookie = value; },
  };
}

const base = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
  email: 'ana@example.com', phone: '+58 412 000 0000', ...overrides,
});

test('un cliente se crea y su ficha muestra los datos guardados', async (t) => {
  const a = await app(t);
  const created = await a.post('/customers', base(a, { notes: 'Nota privada' }));
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/customers/1?saved=1');

  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /<h1>Ana Pérez<\/h1>/);
  assert.match(detail, /Idioma<\/dt><dd>Español/);
  assert.match(detail, /Correo electrónico<\/dt><dd>ana@example\.com/);
  assert.match(detail, /Número de teléfono<\/dt><dd>\+58 412 000 0000/);
  assert.match(detail, /RIF \/ Cédula<\/dt><dd>V-1000/);
  assert.match(detail, /Nota privada/);

  const list = await (await a.get('/customers')).text();
  assert.match(list, /Ana Pérez/);
});

test('Nombre, correo, teléfono y RIF / Cédula son obligatorios', async (t) => {
  const a = await app(t);
  const cases = [
    ['name', /nombre de cliente/],
    ['email', /correo electrónico principal/],
    ['phone', /teléfono principal/],
    ['taxId', /RIF \/ Cédula/],
  ];
  for (const [field, message] of cases) {
    const response = await a.post('/customers', base(a, { [field]: '' }));
    assert.equal(response.status, 400, `${field} requerido`);
    assert.match(await response.text(), message);
  }
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});

test('el RIF / Cédula es único y se compara sin distinguir mayúsculas', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/customers', base(a, { taxId: 'J-12345678-9' }))).status, 303);
  const duplicate = await a.post('/customers', base(a, { name: 'Otro', email: 'otro@example.com', taxId: 'j-12345678-9' }));
  assert.equal(duplicate.status, 409);
  assert.match(await duplicate.text(), /Ya existe un cliente con ese RIF \/ Cédula/);
  // El duplicado no llega a guardarse.
  assert.equal([...(await (await a.get('/customers')).text()).matchAll(/class="product-description"/g)].length, 1);

  // Editar otro cliente hacia ese mismo RIF también se rechaza y conserva su valor.
  assert.equal((await a.post('/customers', base(a, { name: 'Bea', email: 'bea@example.com', taxId: 'V-2' }))).status, 303);
  const conflict = await a.post('/customers/2', base(a, { name: 'Bea', email: 'bea@example.com', taxId: 'j-12345678-9' }));
  assert.equal(conflict.status, 409);
  assert.match(await (await a.get('/customers/2')).text(), /RIF \/ Cédula<\/dt><dd>V-2/);
});

test('guarda hasta tres correos y tres teléfonos con el principal primero', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/customers', base(a, {
    email: 'uno@example.com', emailExtra1: 'dos@example.com', emailExtra2: 'tres@example.com',
    phone: '111', phoneExtra1: '222', phoneExtra2: '333',
  }))).status, 303);

  const detail = await (await a.get('/customers/1')).text();
  const emails = detail.match(/Correo electrónico<\/dt><dd>([\s\S]*?)<\/dd>/)[1];
  assert.match(emails, /uno@example\.com <span class="presentation-tag">Principal<\/span>/);
  assert.match(emails, /dos@example\.com/);
  assert.match(emails, /tres@example\.com/);
  const phones = detail.match(/Número de teléfono<\/dt><dd>([\s\S]*?)<\/dd>/)[1];
  assert.match(phones, /111 <span class="presentation-tag">Principal<\/span>/);
  assert.match(phones, /333/);

  // El formulario ofrece exactamente dos huecos adicionales por tipo.
  const form = await (await a.get('/customers/1/edit')).text();
  assert.equal([...form.matchAll(/name="emailExtra\d"/g)].length, 2);
  assert.equal([...form.matchAll(/name="phoneExtra\d"/g)].length, 2);
  assert.doesNotMatch(form, /emailExtra3|phoneExtra3/);
});

test('los huecos adicionales vacíos no se guardan', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/customers', base(a, { emailExtra1: '  ', emailExtra2: '', phoneExtra1: '' }))).status, 303);
  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_emails').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_phones').get().count, 1);
  } finally { db.close(); }
});

test('una edición inválida vuelve a mostrar el formulario de ese cliente', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1' }));
  const invalid = await a.post('/customers/1', base(a, { name: '', taxId: 'V-1' }));
  assert.equal(invalid.status, 400);
  const html = await invalid.text();
  assert.match(html, /nombre de cliente/);
  assert.match(html, /action="\/customers\/1"/);
  assert.doesNotMatch(html, /customers\/undefined/);
});

test('editar un cliente reemplaza sus correos y teléfonos', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1', email: 'a@x.com', emailExtra1: 'b@x.com', phone: '1', phoneExtra1: '2' }));
  const updated = await a.post('/customers/1', base(a, {
    taxId: 'V-1', name: 'Ana María', email: 'solo@x.com', emailExtra1: '', emailExtra2: '',
    phone: '9', phoneExtra1: '8', phoneExtra2: '7',
  }));
  assert.equal(updated.status, 303);
  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /Ana María/);
  assert.doesNotMatch(detail, /a@x\.com|b@x\.com/);
  assert.match(detail, /solo@x\.com/);
  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_emails').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_phones').get().count, 3);
  } finally { db.close(); }
});

test('Consulta ve la ficha, pero no puede crear ni editar clientes', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1' }));
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' })).status, 303);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'gestion', password: 'equipo-seguro-123', role: 'manager' })).status, 303);
  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  assert.equal((await a.get('/customers')).status, 200);
  const detail = await a.get('/customers/1');
  assert.equal(detail.status, 200);
  assert.doesNotMatch(await detail.text(), /Editar cliente/);
  assert.equal((await a.get('/customers/new')).status, 403);
  assert.equal((await a.get('/customers/1/edit')).status, 403);
  assert.equal((await a.post('/customers', { ...base(a, { taxId: 'V-9' }), csrfToken: viewerToken })).status, 403);
  assert.equal((await a.post('/customers/1', { ...base(a, { taxId: 'V-1' }), csrfToken: viewerToken })).status, 403);

  // Gestión sí crea y edita.
  const managerToken = await a.signIn('gestion', 'equipo-seguro-123');
  assert.equal((await a.post('/customers', { ...base(a, { taxId: 'V-77' }), csrfToken: managerToken })).status, 303);
  assert.equal((await a.get('/customers/2/edit')).status, 200);
});

test('el correo y el teléfono principales no se pueden sustituir por un adicional', async (t) => {
  const a = await app(t);
  const email = await a.post('/customers', base(a, { email: '', emailExtra1: 'solo@extra.com' }));
  assert.equal(email.status, 400);
  assert.match(await email.text(), /correo electrónico principal/);
  const phone = await a.post('/customers', base(a, { taxId: 'V-5', phone: '', phoneExtra1: '999' }));
  assert.equal(phone.status, 400);
  assert.match(await phone.text(), /teléfono principal/);
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});

test('rechaza un idioma distinto del español y unas notas excesivas', async (t) => {
  const a = await app(t);
  const language = await a.post('/customers', base(a, { language: 'en' }));
  assert.equal(language.status, 400);
  assert.match(await language.text(), /idioma debe ser Español/);
  const notes = await a.post('/customers', base(a, { taxId: 'V-1', notes: 'x'.repeat(2001) }));
  assert.equal(notes.status, 400);
  assert.match(await notes.text(), /notas/);
  assert.match(await (await a.get('/customers')).text(), /Todavía no hay clientes/);
});

test('una base existente gana las tablas de clientes sin perder sus datos', async (t) => {
  const a = await app(t);
  // Un estado completo: cuenta, artículo con inventario e historial, y un borrador de compra.
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, partNumber: 'LEGACY-1', description: 'Repuesto existente', presentation: 'KIT', initialQuantity: '7' })).status, 303);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'equipo', password: 'equipo-seguro-123', role: 'manager' })).status, 303);
  assert.equal((await a.post('/purchase-orders', { csrfToken: a.csrfToken })).status, 303);

  // Emula el esquema anterior a la v1.3 quitando las tablas de clientes y reabriendo la base.
  await a.close();
  const legacy = new DatabaseSync(a.databasePath);
  legacy.exec('DROP TABLE customer_phones; DROP TABLE customer_emails; DROP TABLE customers;');
  const before = {
    products: legacy.prepare('SELECT * FROM products ORDER BY id').all(),
    users: legacy.prepare('SELECT * FROM users ORDER BY id').all(),
    movements: legacy.prepare('SELECT * FROM stock_movements ORDER BY id').all(),
    orders: legacy.prepare('SELECT * FROM purchase_orders ORDER BY id').all(),
  };
  legacy.close();
  await a.open();

  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('customers', 'customer_emails', 'customer_phones') ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(tables, ['customer_emails', 'customer_phones', 'customers']);
    assert.deepEqual(db.prepare('SELECT * FROM products ORDER BY id').all(), before.products);
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), before.users);
    assert.deepEqual(db.prepare('SELECT * FROM stock_movements ORDER BY id').all(), before.movements);
    assert.deepEqual(db.prepare('SELECT * FROM purchase_orders ORDER BY id').all(), before.orders);
  } finally { db.close(); }
});
