import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createAdministrator,
  findProduct,
  findUserByUsername,
  hasAdministrator,
  insertProduct,
  listProducts,
  openDatabase,
  updateProduct,
} from './database.mjs';
import { escapeHtml, inventoryPage, loginPage, notFoundPage, productFormPage, renderPresentations, setupPage } from './views.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const PASSWORD_MIN_LENGTH = 12;
const presentationValues = new Set(renderPresentations().map(([value]) => value));
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFile(join(sourceDirectory, '..', 'public', 'style.css'));

function readCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return [part.trim(), ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

async function readForm(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('El formulario supera el tamaño permitido.');
  }
  return new URLSearchParams(body);
}

function sendHtml(response, html, status = 200, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(html);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  response.end();
}

function validateProduct(form) {
  const partNumber = (form.get('partNumber') ?? '').trim();
  const description = (form.get('description') ?? '').trim();
  const presentation = form.get('presentation') ?? '';
  const brand = (form.get('brand') ?? '').trim();
  const location = (form.get('location') ?? '').trim();
  const minimumInput = (form.get('minimumStock') ?? '').trim();
  const product = {
    partNumber,
    description,
    presentation,
    brand: brand || null,
    location: location || null,
    minimumStock: minimumInput === '' ? null : Number(minimumInput),
  };

  if (!partNumber || partNumber.length > 100) return { error: 'Escribe un P/N de hasta 100 caracteres.', product };
  if (!description || description.length > 240) return { error: 'Escribe una descripción de hasta 240 caracteres.', product };
  if (!presentationValues.has(presentation)) return { error: 'Elige una presentación válida: Set, Kit o Unidad.', product };
  if (brand && brand.length > 100) return { error: 'La marca no puede superar los 100 caracteres.', product };
  if (location && location.length > 120) return { error: 'La ubicación no puede superar los 120 caracteres.', product };
  if (minimumInput !== '' && (!Number.isSafeInteger(product.minimumStock) || product.minimumStock < 0)) {
    return { error: 'El mínimo de stock debe ser un número entero igual o mayor que cero.', product };
  }
  return { product };
}

function productFrom(form, previous = {}) {
  return {
    ...previous,
    part_number: form.get('partNumber') ?? '',
    description: form.get('description') ?? '',
    presentation: form.get('presentation') ?? '',
    brand: form.get('brand') ?? '',
    location: form.get('location') ?? '',
    minimum_stock: form.get('minimumStock') ?? '',
  };
}

function isUniqueViolation(error) {
  return error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: products\.part_number/i.test(error.message);
}

function createSession(sessions, user) {
  const id = randomBytes(32).toString('base64url');
  const session = {
    userId: user.id,
    username: user.username,
    csrfToken: randomBytes(32).toString('base64url'),
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
  };
  sessions.set(id, session);
  return { id, session };
}

function sessionFor(request, sessions) {
  const id = readCookies(request.headers.cookie).inventory_session;
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function authenticatedPage(response, content) {
  sendHtml(response, content);
}

function validateCsrf(form, session) {
  const submitted = form.get('csrfToken') ?? '';
  const expected = session.csrfToken;
  return submitted.length === expected.length && timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}

export function createInventoryServer({ databasePath = process.env.DATABASE_PATH ?? 'data/inventory.sqlite' } = {}) {
  const database = openDatabase(databasePath);
  const sessions = new Map();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const session = sessionFor(request, sessions);

    try {
      if (request.method === 'GET' && url.pathname === '/assets/style.css') {
        response.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
        });
        response.end(await stylesheet);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        if (!hasAdministrator(database)) return sendHtml(response, setupPage());
        return redirect(response, session ? '/inventory' : '/login');
      }

      if (request.method === 'GET' && url.pathname === '/setup') {
        return sendHtml(response, hasAdministrator(database) ? loginPage() : setupPage());
      }

      if (request.method === 'POST' && url.pathname === '/setup') {
        const form = await readForm(request);
        if (hasAdministrator(database)) return sendHtml(response, loginPage({ error: 'El acceso inicial ya se configuró. Inicia sesión.' }), 409);
        const username = (form.get('username') ?? '').trim();
        const password = form.get('password') ?? '';
        if (!/^[\p{L}\p{N}_.-]{3,50}$/u.test(username)) {
          return sendHtml(response, setupPage({ error: 'El usuario debe tener entre 3 y 50 letras, números, puntos, guiones o guiones bajos.' }), 400);
        }
        if (password.length < PASSWORD_MIN_LENGTH) {
          return sendHtml(response, setupPage({ error: 'La contraseña debe tener al menos 12 caracteres.' }), 400);
        }
        const passwordSalt = randomBytes(16).toString('hex');
        const passwordHash = (await scrypt(password, passwordSalt, 64)).toString('hex');
        if (hasAdministrator(database)) return sendHtml(response, loginPage({ error: 'El acceso inicial ya se configuró. Inicia sesión.' }), 409);
        try {
          createAdministrator(database, { username, passwordSalt, passwordHash });
        } catch (error) {
          if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: users\.username/i.test(error.message)) {
            return sendHtml(response, setupPage({ error: 'Ese usuario ya existe. Elige otro.' }), 409);
          }
          throw error;
        }
        const { id } = createSession(sessions, { id: 1, username });
        return redirect(response, '/inventory', {
          'set-cookie': `inventory_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`,
        });
      }

      if (request.method === 'GET' && url.pathname === '/login') {
        return sendHtml(response, hasAdministrator(database) ? loginPage() : setupPage());
      }

      if (request.method === 'POST' && url.pathname === '/login') {
        const form = await readForm(request);
        const user = findUserByUsername(database, (form.get('username') ?? '').trim());
        const supplied = form.get('password') ?? '';
        let valid = false;
        if (user) {
          const suppliedHash = await scrypt(supplied, user.password_salt, 64);
          valid = timingSafeEqual(suppliedHash, Buffer.from(user.password_hash, 'hex'));
        } else {
          await scrypt(supplied, randomBytes(16), 64);
        }
        if (!valid) return sendHtml(response, loginPage({ error: 'Usuario o contraseña incorrectos.' }), 401);
        const { id } = createSession(sessions, user);
        return redirect(response, '/inventory', {
          'set-cookie': `inventory_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`,
        });
      }

      if (request.method === 'POST' && url.pathname === '/logout') {
        if (!session) return redirect(response, '/login');
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
        sessions.delete(session.id);
        return redirect(response, '/login', {
          'set-cookie': 'inventory_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        });
      }

      if (!session && (url.pathname === '/inventory' || url.pathname.startsWith('/products'))) {
        return redirect(response, hasAdministrator(database) ? '/login' : '/setup');
      }

      if (request.method === 'GET' && url.pathname === '/inventory') {
        const message = url.searchParams.get('saved') === '1' ? 'Repuesto guardado.' : '';
        return authenticatedPage(response, inventoryPage({
          products: listProducts(database),
          username: session.username,
          csrfToken: session.csrfToken,
          message,
        }));
      }

      if (request.method === 'GET' && url.pathname === '/products/new') {
        return authenticatedPage(response, productFormPage({ username: session.username, csrfToken: session.csrfToken }));
      }

      if (request.method === 'POST' && url.pathname === '/products') {
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
        const { error, product } = validateProduct(form);
        if (error) return sendHtml(response, productFormPage({ product: productFrom(form), username: session.username, csrfToken: session.csrfToken, error }), 400);
        try {
          insertProduct(database, product);
        } catch (insertError) {
          if (isUniqueViolation(insertError)) {
            return sendHtml(response, productFormPage({ product: productFrom(form), username: session.username, csrfToken: session.csrfToken, error: 'Ya existe un repuesto con ese P/N.' }), 409);
          }
          throw insertError;
        }
        return redirect(response, '/inventory?saved=1');
      }

      const editMatch = url.pathname.match(/^\/products\/(\d+)\/edit$/);
      if (request.method === 'GET' && editMatch) {
        const product = findProduct(database, Number(editMatch[1]));
        if (!product) return sendHtml(response, notFoundPage({ username: session.username, csrfToken: session.csrfToken }), 404);
        return authenticatedPage(response, productFormPage({ product, username: session.username, csrfToken: session.csrfToken, isNew: false }));
      }

      const updateMatch = url.pathname.match(/^\/products\/(\d+)$/);
      if (request.method === 'POST' && updateMatch) {
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
        const id = Number(updateMatch[1]);
        const existingProduct = findProduct(database, id);
        if (!existingProduct) return sendHtml(response, notFoundPage({ username: session.username, csrfToken: session.csrfToken }), 404);
        const { error, product } = validateProduct(form);
        if (error) return sendHtml(response, productFormPage({ product: productFrom(form, existingProduct), username: session.username, csrfToken: session.csrfToken, isNew: false, error }), 400);
        try {
          updateProduct(database, id, product);
        } catch (updateError) {
          if (isUniqueViolation(updateError)) {
            return sendHtml(response, productFormPage({ product: productFrom(form, existingProduct), username: session.username, csrfToken: session.csrfToken, isNew: false, error: 'Ya existe otro repuesto con ese P/N.' }), 409);
          }
          throw updateError;
        }
        return redirect(response, '/inventory?saved=1');
      }

      return sendHtml(response, session ? notFoundPage({ username: session.username, csrfToken: session.csrfToken }) : loginPage(), 404);
    } catch (error) {
      const message = error.message === 'El formulario supera el tamaño permitido.' ? error.message : 'No se pudo completar la operación. Revisa los datos e inténtalo de nuevo.';
      sendHtml(response, session ? inventoryPage({ products: listProducts(database), username: session.username, csrfToken: session.csrfToken, message }) : loginPage({ error: message }), 400);
    }
  });

  server.on('close', () => database.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  const host = '127.0.0.1';
  const server = createInventoryServer();
  server.listen(port, host, () => {
    console.log(`Inventario disponible en http://${host}:${port}`);
  });
}
