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
  findPurchaseOrder,
  findUserByUsername,
  hasAdministrator,
  insertUser,
  listProducts,
  listCategories,
  listProductTypes,
  listSuppliers,
  listPurchaseOrderLines,
  listPurchaseOrders,
  listUsers,
  openDatabase,
  setProductArchived,
  updateUserRole,
} from './database.mjs';
import { accountsPage, forbiddenPage, inventoryPage, productsPage, productDetailPage, purchaseOrderPage, purchaseOrdersPage, purchaseSelectionPage, loginPage, notFoundPage, productFormPage, setupPage, importPage } from './views.mjs';
import { catalogState, filterProducts, formatCents, paginateProducts, validateProduct } from './products.mjs';
import { archiveSelection, CatalogError, saveCatalogProduct } from './catalog.mjs';
import { addPurchaseLine, addSelectionToPurchase, archivePurchaseOrder, createPurchaseDraft, PurchaseError, removePurchaseLine, reopenPurchaseOrder, savePurchaseDraft, selectableProducts } from './purchases.mjs';
import { readImportForm, previewImport, applyImport, ImportError, parseImportView } from './imports.mjs';
import { exportPurchaseOrder, exportView, parseExportView, selectExportProducts, ExportError } from './exports.mjs';
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
import {
  countImages,
  imageDirectoryFor,
  MAX_IMAGE_BYTES,
  readImageUpload,
  readProductImage,
} from './images.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const PASSWORD_MIN_LENGTH = 12;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const stylesheet = readFile(join(sourceDirectory, '..', 'public', 'style.css'));
const catalogScript = readFile(join(sourceDirectory, '..', 'public', 'catalog.js'));

function readCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return [part.trim(), ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }));
}

async function readBody(request, maxLength, tooLargeMessage) {
  const chunks = [];
  let size = 0;
  let exceeded = false;
  // Keep draining an oversized body so the connection stays healthy; only bounded data is kept.
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxLength) exceeded = true;
    else chunks.push(chunk);
  }
  if (exceeded) throw new Error(tooLargeMessage);
  return Buffer.concat(chunks);
}

async function readForm(request, maxLength = 16_384) {
  const body = await readBody(request, maxLength, 'El formulario supera el tamaño permitido.');
  return new URLSearchParams(body.toString('utf8'));
}

// The product form can carry a file, so a multipart body is parsed as FormData; plain forms keep working.
async function readProductForm(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.startsWith('multipart/form-data')) return readForm(request);
  const body = await readBody(request, MAX_IMAGE_BYTES + 256 * 1024, 'La imagen supera el límite de 2 MB.');
  try {
    return await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new Error('No se pudo leer el formulario. Inténtalo de nuevo.');
  }
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
    long_description: form.get('longDescription') ?? previous.long_description ?? '',
    price: form.get('price') ?? (previous.price_cents != null ? formatCents(previous.price_cents) : ''),
    initial_quantity: form.get('initialQuantity') ?? '',
    category_id: form.get('categoryId') ?? previous.category_id ?? '',
    new_category: form.get('newCategory') ?? '',
    product_type_id: form.get('productTypeId') ?? previous.product_type_id ?? '',
    new_product_type: form.get('newProductType') ?? '',
    supplier_id: form.get('supplierId') ?? previous.supplier_id ?? '',
    new_supplier: form.get('newSupplier') ?? '',
  };
}

function productFormOptions(database) {
  return { categories: listCategories(database), productTypes: listProductTypes(database), suppliers: listSuppliers(database) };
}

function sendProductFormError(response, form, session, message, { isNew = true, previousProduct = {}, status = 400, categories = [], productTypes = [], suppliers = [] } = {}) {
  return sendHtml(response, productFormPage({
    ...session,
    product: productFrom(form, previousProduct),
    isNew,
    error: message,
    categories, productTypes, suppliers,
  }), status);
}

function isUniqueViolation(error) {
  return error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: products\.part_number/i.test(error.message);
}

function saveProduct(database, response, { form, session, product, isNew, existingProduct, image = null, removeImage = false, imageDirectory }) {
  // A role may change while the request body is arriving. Check again at the write boundary.
  const user = findUser(database, session.userId);
  if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
  try {
    saveCatalogProduct(database, session.userId, product, form, existingProduct, { image, removeImage, imageDirectory });
  } catch (error) {
    if (error instanceof CatalogError) {
      return sendProductFormError(response, form, session, error.message, { isNew, previousProduct: existingProduct, status: error.status, ...productFormOptions(database) });
    }
    if (isUniqueViolation(error)) {
      const message = isNew ? 'Ya existe un repuesto con ese P/N.' : 'Ya existe otro repuesto con ese P/N.';
      return sendProductFormError(response, form, session, message, { isNew, previousProduct: existingProduct, status: 409, ...productFormOptions(database) });
    }
    throw error;
  }
  return redirect(response, '/products?saved=1');
}

// Both product routes share the same CSRF check, validation, image handling and error rendering.
async function saveProductFromRequest(database, response, { request, session, id = null, imageDirectory }) {
  const form = await readProductForm(request);
  if (!validateCsrf(form, session)) return sendHtml(response, loginPage({ error: 'La sesión caducó. Inicia sesión de nuevo.' }), 403);
  const existingProduct = id === null ? undefined : findProduct(database, id);
  if (id !== null && !existingProduct) return sendHtml(response, notFoundPage(session), 404);
  const isNew = id === null;
  const { error, product } = validateProduct(form);
  const options = { isNew, previousProduct: existingProduct ?? {}, ...productFormOptions(database) };
  if (error) return sendProductFormError(response, form, session, error, options);
  const upload = await readImageUpload(form.get('image'));
  if (upload.error) return sendProductFormError(response, form, session, upload.error, options);
  return saveProduct(database, response, {
    form, session, product, isNew, existingProduct, image: upload.image,
    removeImage: form.get('removeImage') === 'on', imageDirectory,
  });
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
  return redirect(response, '/products', {
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
    category: params.get('category') ?? '',
    brand: params.get('brand') ?? '',
    state: catalogState(params),
    outOfStock: params.get('outOfStock') === 'on',
    lowStock: params.get('lowStock') === 'on',
    archived: params.get('archived') === 'on',
  };
}

export function createInventoryServer({
  databasePath = process.env.DATABASE_PATH ?? 'data/inventory.sqlite',
  backupDirectory = backupDirectoryFor(databasePath),
  imageDirectory = imageDirectoryFor(databasePath),
  backupIntervalMs = Number(process.env.BACKUP_INTERVAL_MS) || DEFAULT_BACKUP_INTERVAL_MS,
  backupRetention = Number(process.env.BACKUP_RETENTION) || DEFAULT_BACKUP_RETENTION,
  automaticBackups = true,
} = {}) {
  let database = openDatabase(databasePath);
  const sessions = new Map();
  const initialSetupToken = randomBytes(32).toString('base64url');
  let lastRestore = null;

  function catalogOptions(params, inventory = false) {
    params = new URLSearchParams(params);
    if (inventory) params.set('state', 'active');
    const products = listProducts(database);
    return {
      ...paginateProducts(filterProducts(products, params), params),
      filters: inventoryFilters(params),
      categories: listCategories(database),
      brands: [...new Set(products.map((product) => product.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
      queryParams: params,
    };
  }

  function runAutomaticBackup() {
    try {
      createBackup(database, backupDirectory, { retention: backupRetention, imageDirectory });
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

      if (request.method === 'GET' && url.pathname === '/assets/catalog.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
        return response.end(await catalogScript);
      }

      if (request.method === 'GET' && url.pathname === '/') {
        if (!hasAdministrator(database)) return sendHtml(response, setupPage({ setupToken: initialSetupToken }));
        return redirect(response, session ? '/products' : '/login');
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

      // Product images are private to the session but readable by every authenticated role.
      const imageMatch = url.pathname.match(/^\/products\/(\d+)\/image$/);
      if (request.method === 'GET' && imageMatch) {
        const product = findProduct(database, Number(imageMatch[1]));
        const image = product ? readProductImage(imageDirectory, product.image_filename) : null;
        if (!image) return sendHtml(response, notFoundPage(session), 404);
        response.writeHead(200, {
          'content-type': image.mimeType,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(image.bytes);
      }

      // Export is read-only for every authenticated role; POST keeps large selections out of the URL.
      if (['GET', 'POST'].includes(request.method) && url.pathname === '/exports') {
        const params = request.method === 'POST' ? await readForm(request, 2 * 1024 * 1024) : url.searchParams;
        if (request.method === 'POST' && !validateCsrf(params, session)) return sendHtml(response, forbiddenPage(session), 403);
        let view = 'inventory';
        try {
          view = parseExportView(params);
          const viewParams = new URLSearchParams(params);
          // Inventory only ever exports active articles; products honors its state filter.
          if (view === 'inventory') viewParams.set('state', 'active');
          const selected = selectExportProducts(listProducts(database), viewParams);
          const buffer = await exportView(selected, view);
          response.writeHead(200, {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="${view === 'products' ? 'productos.xlsx' : 'inventario.xlsx'}"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return response.end(buffer);
        } catch (error) {
          if (!(error instanceof ExportError)) throw error;
          const render = view === 'products' ? productsPage : inventoryPage;
          const fallback = new URLSearchParams(params);
          return sendHtml(response, render({ ...session, ...catalogOptions(fallback, view === 'inventory'), message: error.message }), 400);
        }
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
            createBackup(database, backupDirectory, { retention: backupRetention, imageDirectory });
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
            const safetyBackup = createBackup(database, backupDirectory, { retention: backupRetention, imageDirectory });
            database.close();
            try {
              installStagedDatabase(databasePath, staged, imageDirectory);
              database = openDatabase(databasePath);
              const summary = summarizeDatabase(database);
              summary.images = countImages(imageDirectory);
              if (summary.integrity !== 'ok' || summary.products !== backup.products
                || summary.movements !== backup.movements || summary.users !== backup.users || summary.categories !== backup.categories
                || summary.purchaseOrders !== backup.purchaseOrders || summary.purchaseOrderLines !== backup.purchaseOrderLines
                || summary.images !== backup.images) {
                throw new BackupError('La restauración no coincide con la copia verificada.', 500);
              }
              lastRestore = { backup: backup.file, safety: safetyBackup.file, restoredAt: new Date().toISOString(), ...summary };
            } catch (error) {
              // Any failure after the swap rolls back to the snapshot taken moments ago.
              if (database.isOpen) database.close();
              replaceDatabaseFile(databasePath, safetyBackup.path, imageDirectory);
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

      if (url.pathname === '/purchase-orders') {
        if (request.method === 'GET') {
          return sendHtml(response, purchaseOrdersPage({ ...session, orders: listPurchaseOrders(database) }));
        }
        if (request.method === 'POST') {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          // A role may change while the request body is arriving. Check again at the write boundary.
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          const id = createPurchaseDraft(database, session.userId);
          return redirect(response, `/purchase-orders/${id}`);
        }
      }

      // Inventory selection -> purchase list: review, choose destination, then confirm once.
      if (['/purchase-orders/add-selection', '/purchase-orders/add-selection/confirm'].includes(url.pathname)) {
        if (request.method !== 'POST') return sendHtml(response, notFoundPage(session), 404);
        const form = await readForm(request, 2 * 1024 * 1024);
        if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
        const user = findUser(database, session.userId);
        if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
        const storedSession = sessions.get(session.id);
        const draftOrders = listPurchaseOrders(database).filter((order) => order.status === 'draft');
        const renderSelectionError = (message) => sendHtml(response, inventoryPage({
          ...session, ...catalogOptions(url.searchParams, true), message,
        }), 400);

        if (url.pathname === '/purchase-orders/add-selection') {
          const values = form.getAll('id');
          if (!values.length || values.length > 100 || values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
            return renderSelectionError('Selecciona entre 1 y 100 artículos activos para añadir a una lista de compra.');
          }
          const ids = [...new Set(values.map(Number))];
          const products = listProducts(database);
          const selected = ids.map((id) => products.find((product) => product.id === id));
          if (selected.some((product) => !product)) return renderSelectionError('Algún artículo de la selección ya no existe. Vuelve a seleccionarlos.');
          if (selected.some((product) => product.archived)) return renderSelectionError('Solo puedes añadir artículos activos a una lista de compra.');
          const confirmationToken = randomBytes(32).toString('base64url');
          storedSession.purchaseSelection = { ids, confirmationToken };
          return sendHtml(response, purchaseSelectionPage({ ...session, products: selected, orders: draftOrders, confirmationToken }));
        }

        const pending = storedSession.purchaseSelection;
        const renderReview = (products, error) => sendHtml(response, purchaseSelectionPage({
          ...session, products, orders: draftOrders, confirmationToken: pending?.confirmationToken ?? '', error,
        }), 400);
        if (!pending || !matchesToken(form.get('confirmationToken') ?? '', pending.confirmationToken)) {
          delete storedSession.purchaseSelection;
          return renderSelectionError('Vuelve a seleccionar los artículos y repite la operación para confirmar.');
        }
        const products = listProducts(database);
        const selected = pending.ids.map((id) => products.find((product) => product.id === id));
        if (selected.some((product) => !product || product.archived)) {
          delete storedSession.purchaseSelection;
          return renderSelectionError('Algún artículo de la selección ya no está activo. Vuelve a seleccionarlos.');
        }
        const destination = form.get('destination') ?? 'new';
        let purchaseOrderId = null;
        if (destination !== 'new') {
          if (!/^[1-9]\d*$/.test(destination) || !Number.isSafeInteger(Number(destination))) {
            return renderReview(selected, 'Elige una lista de compra válida.');
          }
          const order = findPurchaseOrder(database, Number(destination));
          if (!order || order.status !== 'draft') {
            return renderReview(selected, 'Esa lista ya no está en borrador. Elige otra lista o crea una nueva.');
          }
          purchaseOrderId = order.id;
        }
        try {
          const orderId = addSelectionToPurchase(database, session.userId, { purchaseOrderId, productIds: pending.ids });
          delete storedSession.purchaseSelection;
          return redirect(response, `/purchase-orders/${orderId}?added=selection`);
        } catch (error) {
          if (!(error instanceof PurchaseError)) throw error;
          if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
          if (error.status === 404) return sendHtml(response, notFoundPage(session), 404);
          delete storedSession.purchaseSelection;
          return renderSelectionError(error.message);
        }
      }

      const purchaseOrderMatch = url.pathname.match(/^\/purchase-orders\/(\d+)$/);
      const purchaseAddMatch = url.pathname.match(/^\/purchase-orders\/(\d+)\/lines$/);
      const purchaseRemoveMatch = url.pathname.match(/^\/purchase-orders\/(\d+)\/lines\/(\d+)\/remove$/);
      const purchaseStatusMatch = url.pathname.match(/^\/purchase-orders\/(\d+)\/(archive|reopen)$/);
      const purchaseExportMatch = url.pathname.match(/^\/purchase-orders\/(\d+)\/export$/);
      const purchaseMatch = purchaseOrderMatch ?? purchaseAddMatch ?? purchaseRemoveMatch ?? purchaseStatusMatch ?? purchaseExportMatch;
      if (purchaseMatch) {
        const order = findPurchaseOrder(database, Number(purchaseMatch[1]));
        if (!order) return sendHtml(response, notFoundPage(session), 404);
        const purchaseLines = () => listPurchaseOrderLines(database, order.id);
        const renderPurchase = ({ values = {}, error = '', message = '' } = {}) => sendHtml(response, purchaseOrderPage({
          ...session, order, lines: purchaseLines(),
          products: selectableProducts(listProducts(database)), values, error, message,
        }), error ? 400 : 200);

        // Export is read-only for every authenticated role and never archives or touches stock.
        if (request.method === 'GET' && purchaseExportMatch) {
          try {
            const buffer = await exportPurchaseOrder(purchaseLines());
            response.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': `attachment; filename="compra-${order.id}.xlsx"`,
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            return response.end(buffer);
          } catch (error) {
            if (!(error instanceof ExportError)) throw error;
            return renderPurchase({ error: error.message });
          }
        }

        if (request.method === 'GET' && purchaseOrderMatch) {
          const message = url.searchParams.get('added') === 'selection' ? 'Artículos añadidos a la lista.'
            : url.searchParams.get('added') === '1' ? 'Artículo añadido a la lista.'
            : url.searchParams.get('duplicate') === '1' ? 'El artículo ya formaba parte de la lista.'
            : url.searchParams.get('removed') === '1' ? 'Artículo retirado de la lista.'
            : url.searchParams.get('saved') === '1' ? 'Borrador guardado.'
            : url.searchParams.get('archived') === '1' ? 'Lista archivada.'
            : url.searchParams.get('reopened') === '1' ? 'Lista reabierta.' : '';
          return renderPurchase({ message });
        }

        if (request.method === 'POST' && !purchaseExportMatch) {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          try {
            let flag;
            if (purchaseStatusMatch) {
              const archiving = purchaseStatusMatch[2] === 'archive';
              if (archiving) archivePurchaseOrder(database, session.userId, order.id);
              else reopenPurchaseOrder(database, session.userId, order.id);
              flag = archiving ? 'archived' : 'reopened';
            } else if (purchaseAddMatch) {
              flag = addPurchaseLine(database, session.userId, order.id, form.get('productId')) ? 'added' : 'duplicate';
            } else if (purchaseRemoveMatch) {
              removePurchaseLine(database, session.userId, order.id, purchaseRemoveMatch[2]);
              flag = 'removed';
            } else {
              savePurchaseDraft(database, session.userId, order.id, form);
              flag = 'saved';
            }
            return redirect(response, `/purchase-orders/${order.id}?${flag}=1`);
          } catch (error) {
            if (!(error instanceof PurchaseError)) throw error;
            if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
            if (error.status === 404) return sendHtml(response, notFoundPage(session), 404);
            return renderPurchase({ values: Object.fromEntries(form), error: error.message });
          }
        }
      }

      if (request.method === 'GET' && ['/inventory', '/products'].includes(url.pathname)) {
        const params = url.searchParams;
        // Preserve old archived bookmarks while keeping Inventory active-only.
        if (url.pathname === '/inventory' && params.get('archived') === 'on') {
          return redirect(response, `/products?${params}`);
        }
        const message = params.get('msg') === 'archived' ? 'Repuesto archivado.'
          : params.get('msg') === 'restored' ? 'Repuesto restaurado.'
          : params.get('imported') === '1' ? 'Importación aplicada.'
          : params.get('saved') === '1' ? 'Repuesto guardado.' : '';
        const render = url.pathname === '/products' ? productsPage : inventoryPage;
        return authenticatedPage(response, render({
          ...session,
          ...catalogOptions(params, url.pathname === '/inventory'),
          message,
        }));
      }

      if (['/imports', '/imports/confirm', '/imports/cancel'].includes(url.pathname)) {
        if (!canManageInventory(session.role)) return sendHtml(response, forbiddenPage(session), 403);
        const storedSession = sessions.get(session.id);
        if (request.method === 'GET' && url.pathname === '/imports') {
          try {
            return sendHtml(response, importPage({ ...session, view: parseImportView(url.searchParams) }));
          } catch (error) {
            if (!(error instanceof ImportError)) throw error;
            return sendHtml(response, importPage({ ...session, error: error.message }), error.status);
          }
        }
        if (request.method === 'POST') {
          const initialGeneration = storedSession.importGeneration ?? 0;
          let view = 'inventory';
          try {
            const form = url.pathname === '/imports' ? await readImportForm(request) : await readForm(request);
            if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
            view = parseImportView(form);
            if (!canManageInventory(findUser(database, session.userId)?.role)) return sendHtml(response, forbiddenPage(session), 403);
            if (url.pathname === '/imports/cancel') {
              storedSession.importGeneration = (storedSession.importGeneration ?? 0) + 1;
              delete storedSession.importReview;
              return redirect(response, view === 'products' ? '/products' : '/inventory');
            }
            if (url.pathname === '/imports') {
              if ((storedSession.importGeneration ?? 0) !== initialGeneration) throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              const generation = initialGeneration + 1;
              storedSession.importGeneration = generation;
              const review = await previewImport(database, form, view);
              if (storedSession.importGeneration !== generation || sessions.get(session.id) !== storedSession) {
                throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              }
              if (!canManageInventory(findUser(database, session.userId)?.role)) return sendHtml(response, forbiddenPage(session), 403);
              const confirmationToken = randomBytes(32).toString('base64url');
              if (!review.rows.some((row) => row.errors.length)) storedSession.importReview = { review, confirmationToken };
              return sendHtml(response, importPage({ ...session, review, confirmationToken, view }));
            }
            const pending = storedSession.importReview;
            if (!pending || !matchesToken(form.get('confirmationToken') ?? '', pending.confirmationToken)) {
              throw new ImportError('Revisa de nuevo el archivo antes de confirmar.', 409);
            }
            delete storedSession.importReview;
            applyImport(database, session.userId, pending.review);
            return redirect(response, pending.review.view === 'products' ? '/products?imported=1' : '/inventory?imported=1');
          } catch (error) {
            if (!(error instanceof ImportError)) throw error;
            return sendHtml(response, importPage({ ...session, view, error: error.message }), error.status);
          }
        }
      }

      if (request.method === 'GET' && url.pathname === '/products/new') {
        return authenticatedPage(response, productFormPage({ ...session, ...productFormOptions(database) }));
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
        return await saveProductFromRequest(database, response, { request, session, imageDirectory });
      }

      if (request.method === 'POST' && ['/products/archive', '/products/restore'].includes(url.pathname)) {
        const form = await readForm(request);
        if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
        const archiving = url.pathname === '/products/archive';
        try {
          archiveSelection(database, session.userId, form.getAll('id'), archiving);
        } catch (error) {
          if (!(error instanceof CatalogError)) throw error;
          if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
          return sendHtml(response, productsPage({ ...session, ...catalogOptions(url.searchParams), message: error.message }), error.status);
        }
        return redirect(response, archiving ? '/products?msg=archived' : '/products?msg=restored&state=archived');
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
        return redirect(response, archiving ? '/products?msg=archived' : '/products?msg=restored&archived=on');
      }

      const editMatch = url.pathname.match(/^\/products\/(\d+)\/edit$/);
      if (request.method === 'GET' && editMatch) {
        const product = findProduct(database, Number(editMatch[1]));
        if (!product) return sendHtml(response, notFoundPage(session), 404);
        return authenticatedPage(response, productFormPage({ ...session, product, isNew: false, ...productFormOptions(database) }));
      }

      const updateMatch = url.pathname.match(/^\/products\/(\d+)$/);
      if (request.method === 'GET' && updateMatch) {
        const product = findProduct(database, Number(updateMatch[1]));
        if (!product) return sendHtml(response, notFoundPage(session), 404);
        return sendHtml(response, productDetailPage({ ...session, product }));
      }
      if (request.method === 'POST' && updateMatch) {
        return await saveProductFromRequest(database, response, { request, session, id: Number(updateMatch[1]), imageDirectory });
      }

      return sendHtml(response, notFoundPage(session), 404);
    } catch (error) {
      const allowed = ['El formulario supera el tamaño permitido.', 'La imagen supera el límite de 2 MB.', 'No se pudo leer el formulario. Inténtalo de nuevo.'];
      const message = allowed.includes(error.message) ? error.message : 'No se pudo completar la operación. Revisa los datos e inténtalo de nuevo.';
      sendHtml(response, session ? productsPage({ ...session, ...catalogOptions(url.searchParams), message }) : loginPage({ error: message }), 400);
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
