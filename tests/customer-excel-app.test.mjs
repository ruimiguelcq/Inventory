import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { createInventoryServer } from '../src/server.mjs';

const HEADERS = ['Nombre', 'Apellido', 'Correo electrónico', 'Teléfonos', 'Notas', 'País', 'Empresa', 'Calle',
  'Apartamento', 'Ciudad', 'Estado', 'Código postal', 'RIF / Cédula'];

async function app(t) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-customer-excel-'));
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
    body: fields instanceof FormData ? fields : new URLSearchParams(fields),
  });
  const token = (html, name = 'csrfToken') => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  const setup = await (await get('/')).text();
  const login = await post('/setup', { setupToken: token(setup, 'setupToken'), username: 'admin', password: 'marina-segura-123' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = token(await (await get('/products')).text());
  const sheetBytes = async (rows) => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Datos').addRows(rows);
    return book.xlsx.writeBuffer();
  };
  async function upload(rows, { csrfToken: uploadedToken = csrfToken, view = 'customers', bytes = null } = {}) {
    const form = new FormData();
    form.set('csrfToken', uploadedToken);
    form.set('view', view);
    form.set('file', new Blob([bytes ?? await sheetBytes(rows)]), 'clientes.xlsx');
    return post('/imports', form);
  }
  const signIn = async (username, password) => {
    const response = await post('/login', { username, password });
    cookie = response.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/products')).text());
  };
  return { url, get, post, token, csrfToken, upload, signIn, databasePath, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

const base = (a, overrides = {}) => ({
  csrfToken: a.csrfToken, name: 'Ana', lastName: 'Pérez', taxId: 'V-1000',
  email: 'ana@example.com', phone: '+58 412 000 0000', ...overrides,
});

const address = {
  addressFirstName: 'Ana', addressLastName: 'Pérez', addressCompany: 'Astilleros',
  address1: 'Av. Libertador, casa 12', address2: 'Apto 3-B', addressPostalCode: '1010',
  addressCity: 'Caracas', addressState: 'Distrito Capital',
};

const exportLink = (html) => {
  const href = html.match(/href="([^"]+)"[^>]*>Exportar<\/a>/)?.[1];
  assert.ok(href, 'missing Exportar link');
  return href.replaceAll('&amp;', '&');
};

async function xlsxBytes(response, filename) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${filename}"`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.arrayBuffer();
}

async function sheetFrom(response, filename) {
  const bytes = await xlsxBytes(response, filename);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.equal(workbook.worksheets.length, 1);
  return workbook.worksheets[0];
}

const countCustomers = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS count FROM customers').get().count; } finally { db.close(); }
};

test('Exportar descarga clientes.xlsx con todas las columnas y sin modificar datos', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, {
    taxId: 'V-1000', email: 'ana@example.com', emailExtra1: 'ana2@example.com',
    phone: '111', phoneExtra1: '222', notes: 'Cliente frecuente', ...address,
  }));
  await a.post('/customers', base(a, { name: 'Beto', lastName: 'Ruiz', taxId: 'V-2000', email: 'beto@example.com', phone: '333' }));
  const before = await (await a.get('/customers')).text();
  const link = exportLink(before);
  assert.match(link, /view=customers/);
  assert.match(link, /scope=all/);

  const sheet = await sheetFrom(await a.get(link), 'clientes.xlsx');
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual(sheet.getRow(1).values.slice(1), HEADERS);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['Ana', 'Pérez', 'ana@example.com | ana2@example.com', '111 | 222',
    'Cliente frecuente', 'Venezuela', 'Astilleros', 'Av. Libertador, casa 12', 'Apto 3-B', 'Caracas', 'Distrito Capital', '1010', 'V-1000']);
  assert.equal(sheet.getCell('M2').type, ExcelJS.ValueType.String);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['Beto', 'Ruiz', 'beto@example.com', '333', '', '', '', '', '', '', '', '', 'V-2000']);
  // Exportar no toca la base.
  assert.equal(await (await a.get('/customers')).text(), before);
});

test('Importar crea clientes con multi-valor y dirección en una sola transacción', async (t) => {
  const a = await app(t);
  const preview = await a.upload([HEADERS,
    ['Ana', 'Pérez', 'a@x.com|b@x.com', '111|222', 'Nota', 'Venezuela', 'Taller', 'Calle 1', 'Apto 2', 'Caracas', 'Distrito Capital', '1010', 'V-1000']]);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /1 altas · 0 actualizaciones · 0 filas con errores/);
  assert.match(html, /a@x\.com \| b@x\.com/);
  assert.doesNotMatch(await (await a.get('/customers')).text(), /Ana Pérez/);

  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') };
  assert.equal((await a.post('/imports/confirm', fields)).status, 303);
  assert.equal((await a.post('/imports/confirm', fields)).status, 409);

  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /<h1>Ana Pérez<\/h1>/);
  assert.match(detail, /a@x\.com <span class="presentation-tag">Principal<\/span><br>b@x\.com/);
  assert.match(detail, /111 <span class="presentation-tag">Principal<\/span><br>222/);
  assert.match(detail, /RIF \/ Cédula<\/dt><dd>V-1000/);
  assert.match(detail, /Caracas, Distrito Capital/);
  assert.match(detail, /Venezuela/);
  assert.match(detail, /Nota/);
  assert.match(await (await a.get('/customers?imported=1')).text(), /Importación aplicada\./);

  const db = new DatabaseSync(a.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_emails').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_phones').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_addresses').get().count, 1);
  } finally { db.close(); }
});

test('un RIF duplicado en el archivo bloquea el lote completo', async (t) => {
  const a = await app(t);
  const preview = await a.upload([['Nombre', 'Correo electrónico', 'Teléfonos', 'RIF / Cédula'],
    ['Ana', 'a@x.com', '111', 'V-1'],
    ['Beto', 'b@x.com', '222', 'v-1'],
    ['Caro', 'c@x.com', '333', 'V-2'],
  ]);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /RIF \/ Cédula duplicado dentro del archivo/);
  assert.doesNotMatch(html, /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken })).status, 409);
  assert.equal(countCustomers(a.databasePath), 0);

  const missing = await a.upload([['Nombre', 'Correo electrónico', 'Teléfonos'], ['Ana', 'a@x.com', '111']]);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /RIF \/ Cédula/);
  assert.equal(countCustomers(a.databasePath), 0);
});

test('reimportar un archivo exportado actualiza sin duplicar ni perder contactos', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1000', email: 'ana@x.com', emailExtra1: 'ana2@x.com', phone: '111', ...address }));
  await a.post('/customers', base(a, { name: 'Beto', lastName: 'Ruiz', taxId: 'V-2000', email: 'beto@x.com', phone: '333' }));
  const bytes = await xlsxBytes(await a.get(exportLink(await (await a.get('/customers')).text())), 'clientes.xlsx');
  const preview = await a.upload(null, { bytes });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /0 altas · 2 actualizaciones · 0 filas con errores/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: a.token(html, 'confirmationToken') })).status, 303);
  assert.equal(countCustomers(a.databasePath), 2);
  const detail = await (await a.get('/customers/1')).text();
  assert.match(detail, /ana@x\.com <span class="presentation-tag">Principal<\/span><br>ana2@x\.com/);
  assert.match(detail, /Caracas, Distrito Capital/);
});

test('detecta cambios desde la vista previa y evita aplicar dos veces', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1' }));
  const preview = await a.upload([['Nombre', 'RIF / Cédula'], ['Ana importada', 'V-1']]);
  assert.equal(preview.status, 200);
  const fields = { csrfToken: a.csrfToken, confirmationToken: a.token(await preview.text(), 'confirmationToken') };
  // Otra persona edita el mismo cliente antes de confirmar.
  assert.equal((await a.post('/customers/1', base(a, { taxId: 'V-1', name: 'Editado a mano' }))).status, 303);
  const conflict = await a.post('/imports/confirm', fields);
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /han cambiado/);
  assert.match(await (await a.get('/customers/1')).text(), /Editado a mano/);

  // Una confirmación normal no se aplica dos veces.
  const fresh = await a.upload([['Nombre', 'RIF / Cédula'], ['Ana importada', 'V-1']]);
  const token = a.token(await fresh.text(), 'confirmationToken');
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: token })).status, 303);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken, confirmationToken: token })).status, 409);
  assert.match(await (await a.get('/customers/1')).text(), /Ana importada/);
});

test('una fila con errores bloquea el lote y no deja altas parciales', async (t) => {
  const a = await app(t);
  const preview = await a.upload([['Nombre', 'Correo electrónico', 'Teléfonos', 'RIF / Cédula'],
    ['Buena', 'buena@x.com', '111', 'V-1'],
    ['', 'mala@x.com', '222', 'V-2'],
  ]);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /1 filas con errores/);
  assert.match(html, /nombre de cliente/);
  assert.doesNotMatch(html, /Confirmar importación/);
  assert.equal((await a.post('/imports/confirm', { csrfToken: a.csrfToken })).status, 409);
  assert.equal(countCustomers(a.databasePath), 0);
});

test('Consulta exporta pero no importa; Gestión importa y exporta', async (t) => {
  const a = await app(t);
  await a.post('/customers', base(a, { taxId: 'V-1' }));
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' })).status, 303);
  assert.equal((await a.post('/users', { csrfToken: a.csrfToken, username: 'gestion', password: 'equipo-seguro-123', role: 'manager' })).status, 303);

  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  const list = await (await a.get('/customers')).text();
  assert.match(list, />Exportar<\/a>/);
  assert.doesNotMatch(list, />Importar<\/a>/);
  assert.equal((await sheetFrom(await a.get(exportLink(list)), 'clientes.xlsx')).rowCount, 2);
  assert.equal((await a.get('/imports?view=customers')).status, 403);
  assert.equal((await a.upload([HEADERS, ['X', 'Y', 'x@x.com', '1', '', '', '', '', '', '', '', '', 'V-9']], { csrfToken: viewerToken })).status, 403);

  const managerToken = await a.signIn('gestion', 'equipo-seguro-123');
  assert.equal((await a.get('/imports?view=customers')).status, 200);
  const review = await a.upload([['Nombre', 'Correo electrónico', 'Teléfonos', 'RIF / Cédula'], ['Nueva', 'n@x.com', '999', 'V-9']], { csrfToken: managerToken });
  const fields = { csrfToken: managerToken, confirmationToken: a.token(await review.text(), 'confirmationToken') };
  assert.equal((await a.post('/imports/confirm', fields)).status, 303);
  assert.match(await (await a.get('/customers')).text(), /Nueva/);
});
