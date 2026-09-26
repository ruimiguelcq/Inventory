import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryServer } from '../src/server.mjs';
import { openDatabase } from '../src/database.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mk0iIiIiIgBoSygABc6zbAAA', 'base64');

async function app(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-image-'));
  const backupDirectory = join(directory, 'backups');
  const imageDirectory = join(directory, 'images');
  const server = createInventoryServer({
    databasePath: join(directory, 'inventory.sqlite'),
    backupDirectory,
    imageDirectory,
    ...options,
  });
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
  const csrfToken = token(await (await get('/inventory')).text());
  const signIn = async (username, password) => {
    const session = await post('/login', { username, password });
    cookie = session.headers.get('set-cookie').split(';')[0];
    return token(await (await get('/inventory')).text());
  };
  return { url, get, post, token, csrfToken, signIn, directory, backupDirectory, imageDirectory, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

// Builds the multipart product form, attaching an image file only when one is given.
function productForm(token, fields, image) {
  const form = new FormData();
  form.set('csrfToken', token);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (image) form.set('image', image);
  return form;
}

const imageFile = (bytes, name = 'foto.png', type = 'image/png') => new File([bytes], name, { type });

const product = { partNumber: '001-MAR', description: 'Junta de motor', presentation: 'KIT' };

async function imageFiles(directory) {
  return readdir(directory).catch(() => []);
}

test('uploading a valid image associates it and serves it by an application route', async (t) => {
  const a = await app(t);
  const created = await a.post('/products', productForm(a.csrfToken, product, imageFile(PNG)));
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/products?saved=1');

  const served = await a.get('/products/1/image');
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  assert.equal((await imageFiles(a.imageDirectory)).length, 1);
  const products = await (await a.get('/products')).text();
  assert.match(products, /src="\/products\/1\/image"/);
  const inventory = await (await a.get('/inventory')).text();
  assert.match(inventory, /src="\/products\/1\/image"/);
  const detail = await (await a.get('/products/1')).text();
  assert.match(detail, /<img class="product-image" src="\/products\/1\/image"/);

  const form = await (await a.get('/products/new')).text();
  assert.match(form, /enctype="multipart\/form-data"/);
  assert.match(form, /name="image" type="file" accept="image\/jpeg,image\/png,image\/webp"/);
  const edit = await (await a.get('/products/1/edit')).text();
  assert.match(edit, /Quitar la imagen actual/);
  assert.match(edit, /product-image-preview/);
});

test('JPG, PNG and WEBP are accepted while other formats and oversized files are rejected', async (t) => {
  const a = await app(t);
  for (const [index, [bytes, name, type]] of [[PNG, 'a.png', 'image/png'], [JPEG, 'b.jpg', 'image/jpeg'], [WEBP, 'c.webp', 'image/webp']].entries()) {
    const response = await a.post('/products', productForm(a.csrfToken, { ...product, partNumber: `IMG-${index}` }, imageFile(bytes, name, type)));
    assert.equal(response.status, 303, name);
    const served = await a.get(`/products/${index + 1}/image`);
    assert.equal(served.status, 200, name);
    assert.equal(served.headers.get('content-type'), type, name);
  }

  const gif = await a.post('/products', productForm(a.csrfToken, { ...product, partNumber: 'GIF' }, imageFile(Buffer.from('GIF89a-no-es-imagen'), 'x.gif', 'image/gif')));
  assert.equal(gif.status, 400);
  assert.match(await gif.text(), /Formato de imagen no admitido\. Usa JPG, PNG o WEBP\./);

  const huge = await a.post('/products', productForm(a.csrfToken, { ...product, partNumber: 'HUGE' }, imageFile(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), 'grande.png')));
  assert.equal(huge.status, 400);
  assert.match(await huge.text(), /La imagen supera el límite de 2 MB\./);

  // A rejected upload never creates the article.
  const listing = await (await a.get('/products')).text();
  assert.doesNotMatch(listing, /GIF|HUGE/);
});

test('changing an image substitutes it and quitting it removes the file', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', productForm(a.csrfToken, product, imageFile(PNG)))).status, 303);

  // Saving without a file keeps the current image (an omitted field preserves the value).
  assert.equal((await a.post('/products/1', { csrfToken: a.csrfToken, ...product })).status, 303);
  assert.deepEqual(Buffer.from(await (await a.get('/products/1/image')).arrayBuffer()), PNG);

  // A new file replaces the stored one and deletes the previous file.
  assert.equal((await a.post('/products/1', productForm(a.csrfToken, product, imageFile(JPEG, 'nueva.jpg', 'image/jpeg')))).status, 303);
  const served = await a.get('/products/1/image');
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), JPEG);
  assert.equal((await imageFiles(a.imageDirectory)).length, 1);

  // Quitting the image deletes the file and stops rendering the thumbnail.
  assert.equal((await a.post('/products/1', productForm(a.csrfToken, { ...product, removeImage: 'on' }))).status, 303);
  assert.equal((await a.get('/products/1/image')).status, 404);
  assert.deepEqual(await imageFiles(a.imageDirectory), []);
  assert.doesNotMatch(await (await a.get('/products')).text(), /products\/1\/image/);
});

test('a product without an image renders without a broken placeholder', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  const products = await (await a.get('/products')).text();
  assert.match(products, /Junta de motor/);
  assert.doesNotMatch(products, /products\/1\/image|product-thumb/);
  const detail = await (await a.get('/products/1')).text();
  assert.doesNotMatch(detail, /product-image/);
});

test('backups include the images and a restore brings them back with a safety copy of the previous state', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', productForm(a.csrfToken, product, imageFile(PNG)))).status, 303);
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const listing = await (await a.get('/backups')).text();
  assert.match(listing, /1 imagen\b/);
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  // Diverge: replace the image and add another article.
  assert.equal((await a.post('/products/1', productForm(a.csrfToken, product, imageFile(JPEG, 'nueva.jpg', 'image/jpeg')))).status, 303);
  assert.equal((await a.post('/products', productForm(a.csrfToken, { partNumber: 'NUEVO', description: 'Posterior', presentation: 'SET' }, imageFile(WEBP, 'posterior.webp', 'image/webp')))).status, 303);

  const confirmation = await a.get(`/backups/restore?file=${file}`);
  const restoreHtml = await confirmation.text();
  const restored = await a.post('/backups/restore', {
    csrfToken: a.csrfToken, file, confirmationToken: a.token(restoreHtml, 'confirmationToken'),
  });
  assert.equal(restored.status, 303);
  assert.equal(restored.headers.get('location'), '/backups?restored=1');

  // The backed-up image returns and the article added later is gone.
  const served = await a.get('/products/1/image');
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.doesNotMatch(await (await a.get('/products')).text(), /NUEVO/);

  const verified = await (await a.get('/backups?restored=1')).text();
  assert.match(verified, /integridad correcta/i);
  assert.match(verified, /Copia de seguridad del estado anterior/);
  assert.match(verified, /1 imagen\b/);

  // The safety snapshot still holds the image that was live before restoring.
  const imageDirs = (await readdir(a.backupDirectory)).filter((name) => name.endsWith('.images'));
  const contents = await Promise.all(imageDirs.map((name) => readdir(join(a.backupDirectory, name))));
  assert.ok(contents.some((files) => files.some((name) => name.endsWith('.jpg'))), 'safety backup keeps the replaced image');

  // Staging files are working copies and never linger beside the database.
  const leftovers = (await readdir(a.directory)).filter((name) => name.includes('.restoring'));
  assert.deepEqual(leftovers, []);
});

test('restoring a snapshot without images clears the images added later', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', { csrfToken: a.csrfToken, ...product })).status, 303);
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const file = (await (await a.get('/backups')).text()).match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  assert.equal((await a.post('/products/1', productForm(a.csrfToken, product, imageFile(PNG)))).status, 303);
  assert.equal((await a.get('/products/1/image')).status, 200);

  const confirmation = await a.get(`/backups/restore?file=${file}`);
  assert.equal((await a.post('/backups/restore', {
    csrfToken: a.csrfToken, file, confirmationToken: a.token(await confirmation.text(), 'confirmationToken'),
  })).status, 303);
  assert.equal((await a.get('/products/1/image')).status, 404);
  assert.doesNotMatch(await (await a.get('/products')).text(), /products\/1\/image/);
});

test('a snapshot whose referenced images are missing is not verifiable and cannot be restored', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', productForm(a.csrfToken, product, imageFile(PNG)))).status, 303);
  assert.equal((await a.post('/backups', { csrfToken: a.csrfToken })).status, 303);
  const listing = await (await a.get('/backups')).text();
  const file = listing.match(/href="\/backups\/restore\?file=([^"]+)"/)[1];

  // A copy that lost its image folder is not a sound restore point.
  await rm(join(a.backupDirectory, `${file}.images`), { recursive: true, force: true });
  const after = await (await a.get('/backups')).text();
  assert.match(after, /No verificable/);
  assert.equal((await a.get(`/backups/restore?file=${file}`)).status, 422);
  assert.equal((await a.get('/products/1/image')).status, 200);
});

test('images are visible to every role but only gestión and administración can change them', async (t) => {
  const a = await app(t);
  assert.equal((await a.post('/products', productForm(a.csrfToken, product, imageFile(PNG)))).status, 303);
  await a.post('/users', { csrfToken: a.csrfToken, username: 'consulta', password: 'consulta-segura-123', role: 'viewer' });

  const viewerToken = await a.signIn('consulta', 'consulta-segura-123');
  assert.equal((await a.get('/products/1/image')).status, 200);
  assert.match(await (await a.get('/products')).text(), /products\/1\/image/);
  const forbidden = await a.post('/products/1', productForm(viewerToken, product, imageFile(JPEG, 'x.jpg', 'image/jpeg')));
  assert.equal(forbidden.status, 403);
  assert.deepEqual(Buffer.from(await (await a.get('/products/1/image')).arrayBuffer()), PNG);
});

test('an existing database gains the image column and keeps its articles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inventory-image-migration-'));
  const databasePath = join(directory, 'inventory.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      part_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL,
      presentation TEXT NOT NULL CHECK (presentation IN ('SET', 'KIT', 'unidad')),
      brand TEXT,
      location TEXT,
      minimum_stock INTEGER,
      quantity INTEGER NOT NULL DEFAULT 0,
      stock_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (part_number, description, presentation) VALUES ('LEGACY-1', 'Repuesto existente', 'KIT');
  `);
  legacy.close();

  const upgraded = openDatabase(databasePath);
  t.after(async () => {
    upgraded.close();
    await rm(directory, { recursive: true, force: true });
  });
  const columns = upgraded.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  assert.ok(columns.includes('image_filename'), 'image column added');
  assert.equal(upgraded.prepare("SELECT image_filename FROM products WHERE part_number = 'LEGACY-1'").get().image_filename, null);

  // Reopening an already-migrated file is a no-op.
  const again = openDatabase(databasePath);
  assert.equal(again.prepare('SELECT image_filename FROM products WHERE id = 1').get().image_filename, null);
  again.close();
});
