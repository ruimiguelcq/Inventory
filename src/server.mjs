import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createAdministrator,
  findUser,
  findProduct,
  findUserByUsername,
  hasAdministrator,
  insertProduct,
  insertUser,
  listProducts,
  listUsers,
  openDatabase,
  setProductArchived,
  updateProduct,
  updateUserRole,
} from './database.mjs';
import { accountsPage, forbiddenPage, inventoryPage, loginPage, notFoundPage, productFormPage, setupPage, importPage } from './views.mjs';
import { filterProducts, validateProduct } from './products.mjs';
import { readImportForm, previewImport, applyImport, ImportError } from './imports.mjs';
import { exportInventory, selectExportProducts, ExportError } from './exports.mjs';
import { canManageInventory, isAssignableRole } from './permissions.mjs';
import { reviewStock, saveStock, stockHistory, StockError } from './stock.mjs';
import { stockPage, historyPage, backupsPage, restoreBackupPage } from './views.mjs';
import {
  BackupError,
  backupDirectoryFor,
  createBackup,
  findBackup,
  installStagedDatabase,
  listBackups,
  replaceDatabaseFile,
  stageBackup,
  summarizeDatabase,
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_RETENTION,
} from './backups.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const PASSWORD_MIN_LENGTH = 12;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFile(join(sourceDirectory, '..', 'public', 'style.css'));

function readCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return [part.trim(), ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

async function readForm(request, maxLength = 16_384) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxLength) throw new Error('El formulario supera el tamaño permitido.');
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

function sendProductFormError(response, form, session, message, { isNew = true, previousProduct = {}, status = 400 } = {}) {
  return sendHtml(response, productFormPage({
    ...session,
    product: productFrom(form, previousProduct),
    isNew,
    error: message,
  }), status);
}

function isUniqueViolation(error) {
  return error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: products\.part_number/i.test(error.message);
}

function saveProduct(database, response, { form, session, product, isNew, existingProduct }) {
  // A role may change while the request body is arriving. Check again at the write boundary.
  const user = findUser(database, session.userId);
  if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
  try {
    if (isNew) insertProduct(database, product);
    else updateProduct(database, existingProduct.id, product);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const message = isNew ? 'Ya existe un repuesto con ese P/N.' : 'Ya existe otro repuesto con ese P/N.';
      return sendProductFormError(response, form, session, message, { isNew, previousProduct: existingProduct, status: 409 });
    }
    throw error;
  }
  return redirect(response, '/inventory?saved=1');
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

function startSession(response, sessions, user) {
  const { id } = createSession(sessions, user);
  return redirect(response, '/inventory', {
    'set-cookie': `inventory_session=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`,
  });
}

function sessionFor(request, sessions, database) {
  const id = readCookies(request.headers.cookie).inventory_session;
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  const user = findUser(database, session.userId);
  if (!user) return null;
  return { id, ...session, username: user.username, role: user.role };
}

function authenticatedPage(response, content) {
  sendHtml(response, content);
}

function backupError(response, session, backupDirectory, message, status) {
  return sendHtml(response, backupsPage({ ...session, backups: listBackups(backupDirectory), error: message }), status);
}

function requireVerifiedBackup(directory, file) {
  const backup = findBackup(directory, file);
  if (!backup) throw new BackupError('No encontramos una copia de seguridad con ese nombre.', 404);
  if (!backup.valid) throw new BackupError('La copia seleccionada no supera la verificación.', 422);
  return backup;
}

function validateCsrf(form, session) {
  return matchesToken(form.get('csrfToken') ?? '', session.csrfToken);
}

function matchesToken(submitted, expected) {
  return submitted.length === expected.length && timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
}

function validateCredentials(username, password) {
  if (!/^[\p{L}\p{N}_.-]{3,50}$/u.test(username)) return 'El usuario debe tener entre 3 y 50 letras, números, puntos, guiones o guiones bajos.';
  if (password.length < PASSWORD_MIN_LENGTH) return 'La contraseña debe tener al menos 12 caracteres.';
  return '';
}

async function hashPassword(password) {
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, passwordSalt, 64)).toString('hex');
  return { passwordSalt, passwordHash };
}

// Filters shared by the inventory view and the generic error fallback so both show a consistent list.
function inventoryFilters(params) {
  return {
    q: (params.get('q') ?? '').trim(),
    presentation: params.get('presentation') ?? '',
    outOfStock: params.get('outOfStock') === 'on',
    lowStock: params.get('lowStock') === 'on',
    archived: params.get('archived') === 'on',
  };
}

export function createInventoryServer({
  databasePath = process.env.DATABASE_PATH ?? 'data/inventory.sqlite',
  backupDirectory = backupDirectoryFor(databasePath),
  backupIntervalMs = Number(process.env.BACKUP_INTERVAL_MS) || DEFAULT_BACKUP_INTERVAL_MS,
  backupRetention = Number(process.env.BACKUP_RETENTION) || DEFAULT_BACKUP_RETENTION,
  automaticBackups = true,
} = {}) {
  let database = openDatabase(databasePath);
  const sessions = new Map();
  const initialSetupToken = randomBytes(32).toString('base64url');
  let lastRestore = null;

  function runAutomaticBackup() {
    try {
      createBackup(database, backupDirectory, { retention: backupRetention });
    } catch (error) {
      // A failed snapshot must never take the inventory down.
      console.error('No se pudo crear la copia de seguridad automática:', error.message);
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const session = sessionFor(request, sessions, database);

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
        if (!hasAdministrator(database)) return sendHtml(response, setupPage({ setupToken: initialSetupToken }));
        return redirect(response, session ? '/inventory' : '/login');
      }

      if (request.method === 'GET' && url.pathname === '/setup') {
        return sendHtml(response, hasAdministrator(database) ? loginPage() : setupPage({ setupToken: initialSetupToken }));
      }

      if (request.method === 'POST' && url.pathname === '/setup') {
        const form = await readForm(request);
        if (hasAdministrator(database)) return sendHtml(response, loginPage({ error: 'El acceso inicial ya se configuró. Inicia sesión.' }), 409);
        if (!matchesToken(form.get('setupToken') ?? '', initialSetupToken)) {
          return sendHtml(response, setupPage({ error: 'No se pudo verificar el formulario. Recarga la página e inténtalo de nuevo.', setupToken: initialSetupToken }), 403);
        }
        const username = (form.get('username') ?? '').trim();
        const password = form.get('password') ?? '';
        const credentialError = validateCredentials(username, password);
        if (credentialError) return sendHtml(response, setupPage({ error: credentialError, setupToken: initialSetupToken }), 400);
        const { passwordSalt, passwordHash } = await hashPassword(password);
        try {
          createAdministrator(database, { username, passwordSalt, passwordHash });
        } catch (error) {
          if (error.code === 'INITIAL_ACCESS_ALREADY_CONFIGURED') {
            return sendHtml(response, loginPage({ error: 'El acceso inicial ya se configuró. Inicia sesión.' }), 409);
          }
          if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: users\.username/i.test(error.message)) {
            return sendHtml(response, setupPage({ error: 'Ese usuario ya existe. Elige otro.', setupToken: initialSetupToken }), 409);
          }
          throw error;
        }
        return startSession(response, sessions, { id: 1, username });
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
        return startSession(response, sessions, user);
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

      if (!session) {
        return redirect(response, hasAdministrator(database) ? '/login' : '/setup');
      }

      // Export is read-only for every authenticated role; POST keeps large selections out of the URL.
      if (['GET', 'POST'].includes(request.method) && url.pathname === '/exports') {
        const params = request.method === 'POST' ? await readForm(request, 2 * 1024 * 1024) : url.searchParams;
        if (request.method === 'POST' && !validateCsrf(params, session)) return sendHtml(response, forbiddenPage(session), 403);
        const products = listProducts(database);
        let selected;
        try {
          selected = selectExportProducts(products, params);
        } catch (error) {
          if (!(error instanceof ExportError)) throw error;
          return sendHtml(response, inventoryPage({ ...session, products, message: error.message }), 400);
        }
        const buffer = await exportInventory(selected);
        response.writeHead(200, {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': 'attachment; filename="inventario.xlsx"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(buffer);
      }

      // Every private mutation requires gestión, including future stock/archive routes.
      if (!canManageInventory(session.role) && (request.method !== 'GET' || url.pathname === '/products/new' || /^\/products\/\d+\/edit$/.test(url.pathname))) {
        return sendHtml(response, forbiddenPage(session), 403);
      }

      if (url.pathname.startsWith('/users')) {
        if (session.role !== 'admin') return sendHtml(response, forbiddenPage(session), 403);
        const roleMatch = url.pathname.match(/^\/users\/(\d+)\/role$/);
        if (request.method === 'POST' && roleMatch) {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const role = form.get('role');
          const fail = (error, status = 400) => sendHtml(response, accountsPage({ ...session, users: listUsers(database), error }), status);
          if (!isAssignableRole(role)) return fail('Elige un permiso válido: Consulta o Gestión.');
          const user = findUser(database, Number(roleMatch[1]));
          if (!user) return fail('No encontramos esa cuenta.', 404);
          if (user.role === 'admin') return fail('El permiso de la cuenta administradora no se puede cambiar.', 403);
          updateUserRole(database, user.id, role);
          return redirect(response, '/users?saved=1');
        }
        if (request.method === 'GET' && url.pathname === '/users') {
          return sendHtml(response, accountsPage({ ...session, users: listUsers(database), message: url.searchParams.get('saved') === '1' ? 'Cuenta guardada.' : '' }));
        }
        if (request.method === 'POST' && url.pathname === '/users') {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const username = (form.get('username') ?? '').trim();
          const password = form.get('password') ?? '';
          const role = form.get('role') ?? '';
          const fail = (error, status = 400) => sendHtml(response, accountsPage({ ...session, users: listUsers(database), account: { username, role }, error }), status);
          const credentialError = validateCredentials(username, password);
          if (credentialError) return fail(credentialError);
          if (!isAssignableRole(role)) return fail('Elige un permiso válido: Consulta o Gestión.');
          const { passwordSalt, passwordHash } = await hashPassword(password);
          try {
            insertUser(database, { username, passwordSalt, passwordHash, role });
          } catch (error) {
            if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: users\.username/i.test(error.message)) return fail('Ese usuario ya existe. Elige otro.', 409);
            throw error;
          }
          return redirect(response, '/users?saved=1');
        }
      }

      if (url.pathname.startsWith('/backups')) {
        if (session.role !== 'admin') return sendHtml(response, forbiddenPage(session), 403);
        const storedSession = sessions.get(session.id);
        try {
          if (request.method === 'GET' && url.pathname === '/backups') {
            const message = url.searchParams.get('restored') === '1'
              ? 'Restauración completada y verificada.'
              : url.searchParams.get('created') === '1' ? 'Copia creada.' : '';
            return sendHtml(response, backupsPage({ ...session, backups: listBackups(backupDirectory), message, lastRestore }));
          }
          if (request.method === 'POST' && url.pathname === '/backups') {
            const form = await readForm(request);
            if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
            createBackup(database, backupDirectory, { retention: backupRetention });
            return redirect(response, '/backups?created=1');
          }
          if (url.pathname === '/backups/restore' && request.method === 'GET') {
            const backup = requireVerifiedBackup(backupDirectory, url.searchParams.get('file'));
            const confirmationToken = randomBytes(32).toString('base64url');
            storedSession.backupRestore = { file: backup.file, confirmationToken };
            return sendHtml(response, restoreBackupPage({ ...session, backup, confirmationToken }));
          }
          if (url.pathname === '/backups/restore' && request.method === 'POST') {
            const form = await readForm(request);
            if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
            const backup = requireVerifiedBackup(backupDirectory, form.get('file'));
            const pending = storedSession.backupRestore;
            if (!pending || pending.file !== backup.file || !matchesToken(form.get('confirmationToken') ?? '', pending.confirmationToken)) {
              throw new BackupError('La restauración caducó. Abre de nuevo la copia y confirma la operación.', 409);
            }
            delete storedSession.backupRestore;
            // Stage the chosen snapshot first: creating the safety copy prunes older files.
            const staged = stageBackup(databasePath, backup.path);
            const safetyBackup = createBackup(database, backupDirectory, { retention: backupRetention });
            database.close();
            try {
              installStagedDatabase(databasePath, staged);
              database = openDatabase(databasePath);
              const summary = summarizeDatabase(database);
              if (summary.integrity !== 'ok' || summary.products !== backup.products
                || summary.movements !== backup.movements || summary.users !== backup.users) {
                throw new BackupError('La restauración no coincide con la copia verificada.', 500);
              }
              lastRestore = { backup: backup.file, safety: safetyBackup.file, restoredAt: new Date().toISOString(), ...summary };
            } catch (error) {
              // Any failure after the swap rolls back to the snapshot taken moments ago.
              if (database.isOpen) database.close();
              replaceDatabaseFile(databasePath, safetyBackup.path);
              database = openDatabase(databasePath);
              if (error instanceof BackupError) throw error;
              throw new BackupError('No se pudo completar la restauración; se recuperó el estado anterior.', 500);
            }
            return redirect(response, '/backups?restored=1');
          }
          return sendHtml(response, notFoundPage(session), 404);
        } catch (error) {
          if (!(error instanceof BackupError)) throw error;
          if (!database.isOpen) database = openDatabase(databasePath);
          return backupError(response, session, backupDirectory, error.message, error.status);
        }
      }

      if (request.method === 'GET' && url.pathname === '/inventory') {
        const params = url.searchParams;
        const message = params.get('msg') === 'archived' ? 'Repuesto archivado.'
          : params.get('msg') === 'restored' ? 'Repuesto restaurado.'
          : params.get('imported') === '1' ? 'Importación aplicada.'
          : params.get('saved') === '1' ? 'Repuesto guardado.' : '';
        return authenticatedPage(response, inventoryPage({
          ...session,
          products: filterProducts(listProducts(database), params),
          filters: inventoryFilters(params),
          message,
        }));
      }

      if (['/imports', '/imports/confirm', '/imports/cancel'].includes(url.pathname)) {
        if (!canManageInventory(session.role)) return sendHtml(response, forbiddenPage(session), 403);
        const storedSession = sessions.get(session.id);
        if (request.method === 'GET' && url.pathname === '/imports') {
          return sendHtml(response, importPage(session));
        }
        if (request.method === 'POST') {
          const initialGeneration = storedSession.importGeneration ?? 0;
          try {
            const form = url.pathname === '/imports' ? await readImportForm(request) : await readForm(request);
            if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
            if (!canManageInventory(findUser(database, session.userId)?.role)) return sendHtml(response, forbiddenPage(session), 403);
            if (url.pathname === '/imports/cancel') {
              storedSession.importGeneration = (storedSession.importGeneration ?? 0) + 1;
              delete storedSession.importReview;
              return redirect(response, '/inventory');
            }
            if (url.pathname === '/imports') {
              if ((storedSession.importGeneration ?? 0) !== initialGeneration) throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              const generation = initialGeneration + 1;
              storedSession.importGeneration = generation;
              const review = await previewImport(database, form);
              if (storedSession.importGeneration !== generation || sessions.get(session.id) !== storedSession) {
                throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              }
              if (!canManageInventory(findUser(database, session.userId)?.role)) return sendHtml(response, forbiddenPage(session), 403);
              const confirmationToken = randomBytes(32).toString('base64url');
              if (!review.rows.some((row) => row.errors.length)) storedSession.importReview = { review, confirmationToken };
              return sendHtml(response, importPage({ ...session, review, confirmationToken }));
            }
            const pending = storedSession.importReview;
            if (!pending || !matchesToken(form.get('confirmationToken') ?? '', pending.confirmationToken)) {
              throw new ImportError('Revisa de nuevo el archivo antes de confirmar.', 409);
            }
            delete storedSession.importReview;
            applyImport(database, session.userId, pending.review);
            return redirect(response, '/inventory?imported=1');
          } catch (error) {
            if (!(error instanceof ImportError)) throw error;
            return sendHtml(response, importPage({ ...session, error: error.message }), error.status);
          }
        }
      }

      if (request.method === 'GET' && url.pathname === '/products/new') {
        return authenticatedPage(response, productFormPage(session));
      }

      const stockMatch = url.pathname.match(/^\/products\/(\d+)\/(stock(?:\/confirm)?|history)$/);
      if (stockMatch) {
        const product = findProduct(database, Number(stockMatch[1]));
        if (!product) return sendHtml(response, notFoundPage(session), 404);
        const action = stockMatch[2];
        if (request.method === 'GET' && action === 'history') {
          return sendHtml(response, historyPage({ ...session, product, movements: stockHistory(database, product.id) }));
        }
        if (action.startsWith('stock')) {
          if (!canManageInventory(session.role)) return sendHtml(response, forbiddenPage(session), 403);
          if (request.method === 'GET' && action === 'stock') return sendHtml(response, stockPage({ ...session, product }));
          if (request.method === 'POST') {
            const form = await readForm(request);
            if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
            const user = findUser(database, session.userId);
            if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
            const storedSession = sessions.get(session.id);
            const currentProduct = findProduct(database, product.id);
            try {
              if (action === 'stock') {
                const change = reviewStock(currentProduct, form);
                const confirmationToken = randomBytes(32).toString('base64url');
                storedSession.stockReview = { change, confirmationToken };
                return sendHtml(response, stockPage({ ...session, product: currentProduct, change, confirmationToken }));
              }
              const review = storedSession.stockReview;
              if (!review || review.change.productId !== product.id || !matchesToken(form.get('confirmationToken') ?? '', review.confirmationToken)) {
                return sendHtml(response, stockPage({ ...session, product: currentProduct, error: 'Revisa de nuevo el cambio antes de confirmarlo.' }), 409);
              }
              delete storedSession.stockReview;
              saveStock(database, session.userId, review.change);
              return redirect(response, `/products/${product.id}/history`);
            } catch (error) {
              if (!(error instanceof StockError)) throw error;
              return sendHtml(response, stockPage({ ...session, product: findProduct(database, product.id), values: Object.fromEntries(form), error: error.message }), error.status);
            }
          }
        }
      }

      if (request.method === 'POST' && url.pathname === '/products') {
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
        const { error, product } = validateProduct(form);
        if (error) return sendProductFormError(response, form, session, error);
        return saveProduct(database, response, { form, session, product, isNew: true });
      }

      const archiveMatch = url.pathname.match(/^\/products\/(\d+)\/(archive|restore)$/);
      if (request.method === 'POST' && archiveMatch) {
        if (!canManageInventory(session.role)) return sendHtml(response, forbiddenPage(session), 403);
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
        // A role may change while the request body is arriving. Check again at the write boundary.
        const user = findUser(database, session.userId);
        if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
        const product = findProduct(database, Number(archiveMatch[1]));
        if (!product) return sendHtml(response, notFoundPage(session), 404);
        const archiving = archiveMatch[2] === 'archive';
        setProductArchived(database, product.id, archiving);
        return redirect(response, archiving ? '/inventory?msg=archived' : '/inventory?msg=restored&archived=on');
      }

      const editMatch = url.pathname.match(/^\/products\/(\d+)\/edit$/);
      if (request.method === 'GET' && editMatch) {
        const product = findProduct(database, Number(editMatch[1]));
        if (!product) return sendHtml(response, notFoundPage(session), 404);
        return authenticatedPage(response, productFormPage({ ...session, product, isNew: false }));
      }

      const updateMatch = url.pathname.match(/^\/products\/(\d+)$/);
      if (request.method === 'POST' && updateMatch) {
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
        const id = Number(updateMatch[1]);
        const existingProduct = findProduct(database, id);
        if (!existingProduct) return sendHtml(response, notFoundPage(session), 404);
        const { error, product } = validateProduct(form);
        if (error) return sendProductFormError(response, form, session, error, { isNew: false, previousProduct: existingProduct });
        return saveProduct(database, response, { form, session, product, isNew: false, existingProduct });
      }

      return sendHtml(response, notFoundPage(session), 404);
    } catch (error) {
      const message = error.message === 'El formulario supera el tamaño permitido.' ? error.message : 'No se pudo completar la operación. Revisa los datos e inténtalo de nuevo.';
      const filters = inventoryFilters(url.searchParams);
      sendHtml(response, session ? inventoryPage({ ...session, products: filterProducts(listProducts(database), url.searchParams), filters, message }) : loginPage({ error: message }), 400);
    }
  });

  let backupTimer = null;
  if (automaticBackups) {
    runAutomaticBackup();
    backupTimer = setInterval(runAutomaticBackup, backupIntervalMs);
    backupTimer.unref?.();
  }

  server.on('close', () => {
    if (backupTimer) clearInterval(backupTimer);
    if (database.isOpen) database.close();
  });
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
