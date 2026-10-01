import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  countOrdersForCustomer,
  createAdministrator,
  findCustomer,
  findCustomerAddress,
  findUser,
  findProduct,
  findOrderByNumber,
  findPurchaseOrder,
  findUserByUsername,
  hasAdministrator,
  insertUser,
  listChannels,
  listCustomerEmails,
  listCustomerPhones,
  listCustomers,
  listOrderEvents,
  listOrderLines,
  listOrderLinesForOrders,
  listOrders,
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
import { accountsPage, customerDetailPage, customerFormPage, customerImportPage, customersPage, forbiddenPage, inventoryPage, productsPage, productDetailPage, orderDetailPage, orderFormPage, ordersPage, purchaseOrderPage, purchaseOrdersPage, loginPage, notFoundPage, productFormPage, setupPage, importPage } from './views.mjs';
import { addOrderComment, annulOrder, archiveOrder, createOrderFromForm, filterOrders, markOrderPaid, markOrderPrepared, OrderError, orderFormValues, orderState, paginateOrders, unarchiveOrder } from './orders.mjs';
import { addressFromForm, CustomerError, EMAIL_FIELDS, filterCustomers, paginateCustomers, PHONE_FIELDS, saveCustomer, validateAddress, validateCustomer } from './customers.mjs';
import { catalogState, filterProducts, formatCents, paginateProducts, validateProduct } from './products.mjs';
import { CatalogError, saveCatalogProduct } from './catalog.mjs';
import { addPurchaseLine, archivePurchaseOrder, createPurchaseDraft, PurchaseError, removePurchaseLine, reopenPurchaseOrder, savePurchaseDraft, selectableProducts } from './purchases.mjs';
import { readImportForm, previewImport, previewCustomerImport, applyImport, applyCustomerImport, ImportError, parseImportView } from './imports.mjs';
import { exportCustomers, exportOrders, exportPurchaseOrder, exportView, parseExportView, selectExportCustomers, selectExportOrders, selectExportProducts, ExportError } from './exports.mjs';
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
    cost: form.get('cost') ?? (previous.cost_cents != null ? formatCents(previous.cost_cents) : ''),
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

function isUniqueViolation(error, target) {
  return error.code === 'ERR_SQLITE_ERROR' && error.message.includes(`UNIQUE constraint failed: ${target}`);
}

// The customer form carries the principal contact plus two fixed extra slots; empty slots drop out.
function customerFrom(form, previous = {}) {
  return {
    ...previous,
    name: form.get('name') ?? previous.name ?? '',
    last_name: form.get('lastName') ?? previous.last_name ?? '',
    tax_id: form.get('taxId') ?? previous.tax_id ?? '',
    notes: form.get('notes') ?? previous.notes ?? '',
    emails: EMAIL_FIELDS.map((field) => (form.get(field) ?? '').trim()),
    phones: PHONE_FIELDS.map((field) => (form.get(field) ?? '').trim()),
  };
}

function customerView(database, row) {
  if (!row) return null;
  return { ...row, emails: listCustomerEmails(database, row.id), phones: listCustomerPhones(database, row.id), address: findCustomerAddress(database, row.id) ?? null };
}

function sendCustomerFormError(response, form, session, message, { isNew = true, previous = {}, status = 400 } = {}) {
  const customer = { ...customerFrom(form, previous), address: addressFromForm(form, previous.address) };
  return sendHtml(response, customerFormPage({ ...session, customer, isNew, error: message }), status);
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
    if (isUniqueViolation(error, 'products.part_number')) {
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

// Both customer write routes share the CSRF check, validation and duplicate-RIF handling.
async function saveCustomerFromRequest(database, response, { request, session, existing = null }) {
  const form = await readForm(request);
  if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
  const user = findUser(database, session.userId);
  if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
  const isNew = !existing;
  const previous = { ...(existing ?? {}), address: existing ? findCustomerAddress(database, existing.id) ?? {} : {} };
  const { error, customer } = validateCustomer(form);
  if (error) return sendCustomerFormError(response, form, session, error, { isNew, previous });
  const { error: addressError, address } = validateAddress(form);
  if (addressError) return sendCustomerFormError(response, form, session, addressError, { isNew, previous });
  try {
    const id = saveCustomer(database, session.userId, customer, address, existing);
    return redirect(response, `/customers/${id}?saved=1`);
  } catch (thrown) {
    if (thrown instanceof CustomerError) return sendCustomerFormError(response, form, session, thrown.message, { isNew, previous, status: thrown.status });
    if (isUniqueViolation(thrown, 'customers.tax_id')) return sendCustomerFormError(response, form, session, 'Ya existe un cliente con ese RIF / Cédula.', { isNew, previous, status: 409 });
    throw thrown;
  }
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

// Query state shared by both catalog views and the generic error fallback so they render consistently.
function catalogFilters(params) {
  return {
    q: (params.get('q') ?? '').trim(),
    state: catalogState(params),
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
    // Both catalog views expose only the instant search and page at a fixed 50; Inventory is
    // always active-only, while Products keeps its state selector.
    const query = (params.get('q') ?? '').trim();
    const queryParams = new URLSearchParams();
    if (query) queryParams.set('q', query);
    queryParams.set('state', inventory ? 'active' : catalogState(params));
    const page = params.get('page');
    if (page) queryParams.set('page', page);
    const products = listProducts(database);
    return {
      ...paginateProducts(filterProducts(products, queryParams), queryParams),
      filters: catalogFilters(queryParams),
      queryParams,
    };
  }

  function customerOptions(params) {
    // The customer directory searches by name only and pages at a fixed 50.
    const query = (params.get('q') ?? '').trim();
    const queryParams = new URLSearchParams();
    if (query) queryParams.set('q', query);
    const page = params.get('page');
    if (page) queryParams.set('page', page);
    return {
      ...paginateCustomers(filterCustomers(listCustomers(database), queryParams), queryParams),
      filters: { q: query },
      queryParams,
    };
  }

  function orderOptions(params) {
    // The order list searches by number or customer, filters by channel and pages at a fixed 50.
    const query = (params.get('q') ?? '').trim();
    const channel = (params.get('channel') ?? '').trim();
    const state = orderState(params);
    const queryParams = new URLSearchParams();
    if (query) queryParams.set('q', query);
    if (channel) queryParams.set('channel', channel);
    if (state !== 'open') queryParams.set('state', state);
    const page = params.get('page');
    if (page) queryParams.set('page', page);
    const { orders, pagination } = paginateOrders(filterOrders(listOrders(database), queryParams), queryParams);
    const linesByOrder = {};
    for (const line of listOrderLinesForOrders(database, orders.map((order) => order.id))) {
      (linesByOrder[line.order_id] ??= []).push(line);
    }
    return {
      orders, pagination, linesByOrder,
      filters: { q: query, channel, state },
      queryParams,
      channels: listChannels(database),
    };
  }

  // The order ficha carries the lines, the customer with their contacts and address, and how many
  // orders that customer has. Drafts are not counted.
  function orderDetailView(order) {
    const customer = customerView(database, findCustomer(database, order.customer_id));
    return {
      order, lines: listOrderLines(database, order.id), events: listOrderEvents(database, order.id),
      customer, customerOrderCount: countOrdersForCustomer(database, order.customer_id),
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

      // Export is read-only for every authenticated role and always covers the whole search.
      if (request.method === 'GET' && url.pathname === '/exports') {
        const params = url.searchParams;
        let view = 'inventory';
        try {
          view = parseExportView(params);
          if (view === 'customers') {
            const customers = listCustomers(database).map((row) => customerView(database, row));
            const buffer = await exportCustomers(selectExportCustomers(customers, params));
            response.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="clientes.xlsx"',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            return response.end(buffer);
          }
          if (view === 'orders') {
            const buffer = await exportOrders(selectExportOrders(listOrders(database), params));
            response.writeHead(200, {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="pedidos.xlsx"',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            });
            return response.end(buffer);
          }
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
          if (view === 'customers') {
            return sendHtml(response, customersPage({ ...session, ...customerOptions(params), message: error.message }), 400);
          }
          if (view === 'orders') {
            return sendHtml(response, ordersPage({ ...session, ...orderOptions(params), error: error.message }), 400);
          }
          const render = view === 'products' ? productsPage : inventoryPage;
          const fallback = new URLSearchParams(params);
          return sendHtml(response, render({ ...session, ...catalogOptions(fallback, view === 'inventory'), message: error.message }), 400);
        }
      }

      // Every private mutation requires gestión, including future stock/archive routes.
      if (!canManageInventory(session.role) && (request.method !== 'GET' || url.pathname === '/products/new' || /^\/products\/\d+\/edit$/.test(url.pathname) || url.pathname === '/customers/new' || /^\/customers\/\d+\/edit$/.test(url.pathname) || url.pathname === '/orders/new')) {
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
                || summary.customers !== backup.customers || summary.customerEmails !== backup.customerEmails
                || summary.customerPhones !== backup.customerPhones || summary.customerAddresses !== backup.customerAddresses
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

      // Orders: read-only for every role, created by Gestión and Administración. Creating discounts
      // stock and records an 'order' movement per line; the detail shows the whole ficha.
      const orderMatch = url.pathname.match(/^\/orders\/(\d+)$/);
      const orderAnnulMatch = url.pathname.match(/^\/orders\/(\d+)\/annul$/);
      const orderActionMatch = url.pathname.match(/^\/orders\/(\d+)\/(pay|prepare|archive|unarchive)$/);
      const orderCommentMatch = url.pathname.match(/^\/orders\/(\d+)\/comments$/);
      if (url.pathname === '/orders' || url.pathname === '/orders/new' || orderMatch || orderAnnulMatch || orderActionMatch || orderCommentMatch) {
        if (request.method === 'GET' && url.pathname === '/orders') {
          return sendHtml(response, ordersPage({ ...session, ...orderOptions(url.searchParams) }));
        }
        if (request.method === 'GET' && url.pathname === '/orders/new') {
          if (!canManageInventory(session.role)) return sendHtml(response, forbiddenPage(session), 403);
          return sendHtml(response, orderFormPage({
            ...session, customers: listCustomers(database), channels: listChannels(database), products: listProducts(database),
          }));
        }
        if (request.method === 'POST' && url.pathname === '/orders') {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          // A role may change while the request body is arriving. Check again at the write boundary.
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          try {
            const number = createOrderFromForm(database, session.userId, form);
            return redirect(response, `/orders/${number}`);
          } catch (error) {
            if (!(error instanceof OrderError)) throw error;
            if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
            return sendHtml(response, orderFormPage({
              ...session, customers: listCustomers(database), channels: listChannels(database), products: listProducts(database),
              values: orderFormValues(form), error: error.message,
            }), error.status);
          }
        }
        // Annulling restores the stock of every line and is refused for viewers or an already
        // annulled order; the order stays visible with Estado Anulado.
        if (request.method === 'POST' && orderAnnulMatch) {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          const order = findOrderByNumber(database, 'order', Number(orderAnnulMatch[1]));
          if (!order) return sendHtml(response, notFoundPage(session), 404);
          try {
            annulOrder(database, session.userId, order.id);
            return redirect(response, `/orders/${order.number}?annulled=1`);
          } catch (error) {
            if (!(error instanceof OrderError)) throw error;
            if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
            if (error.status === 404) return sendHtml(response, notFoundPage(session), 404);
            return sendHtml(response, orderDetailPage({
              ...session, ...orderDetailView(order), error: error.message,
            }), error.status);
          }
        }
        // Payment, fulfilment and archival are manual actions; the order state can be reversed only
        // for archival, so the timeline records every step. Annulled orders refuse these actions.
        if (request.method === 'POST' && orderActionMatch) {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          const order = findOrderByNumber(database, 'order', Number(orderActionMatch[1]));
          if (!order) return sendHtml(response, notFoundPage(session), 404);
          const action = orderActionMatch[2];
          const run = action === 'pay' ? markOrderPaid
            : action === 'prepare' ? markOrderPrepared
              : action === 'archive' ? archiveOrder : unarchiveOrder;
          try {
            run(database, session.userId, order.id);
            return redirect(response, `/orders/${order.number}?${action}=1`);
          } catch (error) {
            if (!(error instanceof OrderError)) throw error;
            if (error.status === 403) return sendHtml(response, forbiddenPage(session), 403);
            if (error.status === 404) return sendHtml(response, notFoundPage(session), 404);
            return sendHtml(response, orderDetailPage({ ...session, ...orderDetailView(order), error: error.message }), error.status);
          }
        }
        // Internal comments land on the timeline; viewers are refused before reaching here.
        if (request.method === 'POST' && orderCommentMatch) {
          const form = await readForm(request);
          if (!validateCsrf(form, session)) return sendHtml(response, forbiddenPage(session), 403);
          const user = findUser(database, session.userId);
          if (!canManageInventory(user?.role)) return sendHtml(response, forbiddenPage({ ...session, role: user?.role }), 403);
          const order = findOrderByNumber(database, 'order', Number(orderCommentMatch[1]));
          if (!order) return sendHtml(response, notFoundPage(session), 404);
          try {
            addOrderComment(database, session.userId, order.id, form.get('body'));
            return redirect(response, `/orders/${order.number}?comment=1`);
          } catch (error) {
            if (!(error instanceof OrderError)) throw error;
            if (error.status === 404) return sendHtml(response, notFoundPage(session), 404);
            return sendHtml(response, orderDetailPage({ ...session, ...orderDetailView(order), error: error.message }), error.status);
          }
        }
        if (request.method === 'GET' && orderMatch) {
          const order = findOrderByNumber(database, 'order', Number(orderMatch[1]));
          if (!order) return sendHtml(response, notFoundPage(session), 404);
          const messages = {
            annulled: 'Pedido anulado y stock repuesto.',
            pay: 'Pedido marcado como pagado.',
            prepare: 'Pedido marcado como preparado.',
            archive: 'Pedido archivado.',
            unarchive: 'Pedido desarchivado.',
            comment: 'Comentario publicado.',
          };
          const message = Object.entries(messages).find(([flag]) => url.searchParams.get(flag) === '1')?.[1] ?? '';
          return sendHtml(response, orderDetailPage({ ...session, ...orderDetailView(order), message }));
        }
      }

      const customerEditMatch = url.pathname.match(/^\/customers\/(\d+)\/edit$/);
      const customerMatch = url.pathname.match(/^\/customers\/(\d+)$/);
      if (url.pathname === '/customers' || url.pathname === '/customers/new' || customerMatch || customerEditMatch) {
        if (request.method === 'GET' && url.pathname === '/customers') {
          const message = url.searchParams.get('imported') === '1' ? 'Importación aplicada.' : '';
          return sendHtml(response, customersPage({ ...session, ...customerOptions(url.searchParams), message }));
        }
        if (request.method === 'GET' && url.pathname === '/customers/new') {
          return sendHtml(response, customerFormPage({ ...session }));
        }
        if (request.method === 'POST' && url.pathname === '/customers') {
          return await saveCustomerFromRequest(database, response, { request, session, existing: null });
        }
        const existing = customerMatch ? findCustomer(database, Number(customerMatch[1])) : null;
        if (customerMatch && !existing) return sendHtml(response, notFoundPage(session), 404);
        if (request.method === 'GET' && customerEditMatch) {
          const row = findCustomer(database, Number(customerEditMatch[1]));
          if (!row) return sendHtml(response, notFoundPage(session), 404);
          return sendHtml(response, customerFormPage({ ...session, customer: customerView(database, row), isNew: false }));
        }
        if (request.method === 'GET' && customerMatch) {
          return sendHtml(response, customerDetailPage({
            ...session, customer: customerView(database, existing),
            message: url.searchParams.get('saved') === '1' ? 'Cliente guardado.' : '',
          }));
        }
        if (request.method === 'POST' && customerMatch) {
          return await saveCustomerFromRequest(database, response, { request, session, existing });
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
          : params.get('msg') === 'stocked' ? 'Inventario actualizado.'
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
            const view = parseImportView(url.searchParams);
            return sendHtml(response, view === 'customers' ? customerImportPage({ ...session }) : importPage({ ...session, view }));
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
              return redirect(response, view === 'customers' ? '/customers' : view === 'products' ? '/products' : '/inventory');
            }
            if (url.pathname === '/imports') {
              if ((storedSession.importGeneration ?? 0) !== initialGeneration) throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              const generation = initialGeneration + 1;
              storedSession.importGeneration = generation;
              const review = view === 'customers' ? await previewCustomerImport(database, form) : await previewImport(database, form, view);
              if (storedSession.importGeneration !== generation || sessions.get(session.id) !== storedSession) {
                throw new ImportError('La carga fue cancelada o sustituida. Revisa de nuevo el archivo.', 409);
              }
              if (!canManageInventory(findUser(database, session.userId)?.role)) return sendHtml(response, forbiddenPage(session), 403);
              const confirmationToken = randomBytes(32).toString('base64url');
              if (!review.rows.some((row) => row.errors.length)) storedSession.importReview = { review, confirmationToken };
              return sendHtml(response, view === 'customers' ? customerImportPage({ ...session, review, confirmationToken }) : importPage({ ...session, review, confirmationToken, view }));
            }
            const pending = storedSession.importReview;
            if (!pending || !matchesToken(form.get('confirmationToken') ?? '', pending.confirmationToken)) {
              throw new ImportError('Revisa de nuevo el archivo antes de confirmar.', 409);
            }
            delete storedSession.importReview;
            if (pending.review.view === 'customers') {
              applyCustomerImport(database, session.userId, pending.review);
              return redirect(response, '/customers?imported=1');
            }
            applyImport(database, session.userId, pending.review);
            return redirect(response, pending.review.view === 'products' ? '/products?imported=1' : '/inventory?imported=1');
          } catch (error) {
            if (!(error instanceof ImportError)) throw error;
            return sendHtml(response, view === 'customers' ? customerImportPage({ ...session, error: error.message }) : importPage({ ...session, view, error: error.message }), error.status);
          }
        }
      }

      if (request.method === 'GET' && url.pathname === '/products/new') {
        return authenticatedPage(response, productFormPage({ ...session, ...productFormOptions(database) }));
      }

      const stockMatch = url.pathname.match(/^\/products\/(\d+)\/(stock(?:\/(?:confirm|apply))?|history)$/);
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
              // The inline editor in Inventario saves in one step; saveStock re-checks the version.
              if (action === 'stock/apply') {
                const change = reviewStock(currentProduct, form);
                saveStock(database, session.userId, change);
                const params = new URLSearchParams({ msg: 'stocked' });
                const query = (form.get('q') ?? '').trim();
                if (query) params.set('q', query);
                return redirect(response, `/inventory?${params}`);
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
              if (action === 'stock/apply') {
                return sendHtml(response, inventoryPage({ ...session, ...catalogOptions(form, true), message: error.message }), error.status);
              }
              return sendHtml(response, stockPage({ ...session, product: findProduct(database, product.id), values: Object.fromEntries(form), error: error.message }), error.status);
            }
          }
        }
      }

      if (request.method === 'POST' && url.pathname === '/products') {
        return await saveProductFromRequest(database, response, { request, session, imageDirectory });
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
