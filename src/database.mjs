import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The movement source is shared by the fresh table, the ALTER migration and the table rebuild.
// Orders discount and restock inventory through the same history with the 'order' origin.
const MOVEMENT_SOURCES = ['manual', 'import', 'creation', 'order'];
const MOVEMENT_SOURCE_COLUMN = `source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN (${MOVEMENT_SOURCES.map((source) => `'${source}'`).join(', ')}))`;

const STOCK_MOVEMENT_COLUMNS = `
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK (operation IN ('adjust', 'set')),
      quantity INTEGER NOT NULL,
      previous_quantity INTEGER NOT NULL CHECK (previous_quantity >= 0),
      new_quantity INTEGER NOT NULL CHECK (new_quantity >= 0),
      presentation TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      ${MOVEMENT_SOURCE_COLUMN}`;

// The warehouse works with a fixed starter set of categories; more can only be added by an
// administrator. They are ensured on every open and never remove an existing category.
export const DEFAULT_CATEGORIES = [
  'Motor base y componentes internos',
  'Admisión, escape y sobrealimentación',
  'Enfriamiento y agua de mar',
  'Lubricación',
  'Combustible e inyección',
  'Eléctrico, arranque y control',
  'Montaje y accesorios',
];

// Sales channels start with a sensible set and grow on save, following categories, types and
// suppliers. They are ensured on every open and never remove an existing channel.
export const DEFAULT_CHANNELS = ['Online', 'Tienda', 'Correo'];

export function openDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      part_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL,
      presentation TEXT NOT NULL CHECK (presentation IN ('SET', 'KIT', 'unidad')),
      brand TEXT,
      location TEXT,
      minimum_stock INTEGER CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const productColumns = () => database.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  if (!productColumns().includes('quantity')) {
    database.exec(`BEGIN IMMEDIATE;
      ALTER TABLE products ADD COLUMN quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0 AND quantity <= 9007199254740991);
      ALTER TABLE products ADD COLUMN stock_version INTEGER NOT NULL DEFAULT 0;
      COMMIT;`);
  }
  if (!productColumns().includes('archived')) {
    database.exec('ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));');
  }
  database.exec(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100)
  )`);
  const seedCategory = database.prepare('INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  for (const name of DEFAULT_CATEGORIES) seedCategory.run(name);
  // Product types and suppliers are named lists that grow on save, mirroring categories.
  database.exec(`
    CREATE TABLE IF NOT EXISTS product_types (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100)
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100)
    );
  `);
  if (!productColumns().includes('category_id')) {
    database.exec('ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)');
  }
  // The extended fields stay nullable so pre-v1.2 articles keep their data with no new values.
  if (!productColumns().includes('long_description')) {
    database.exec('ALTER TABLE products ADD COLUMN long_description TEXT');
  }
  if (!productColumns().includes('price_cents')) {
    database.exec('ALTER TABLE products ADD COLUMN price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0)');
  }
  // What the article costs us, kept beside the sale price for margin control.
  if (!productColumns().includes('cost_cents')) {
    database.exec('ALTER TABLE products ADD COLUMN cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0)');
  }
  if (!productColumns().includes('product_type_id')) {
    database.exec('ALTER TABLE products ADD COLUMN product_type_id INTEGER REFERENCES product_types(id)');
  }
  if (!productColumns().includes('supplier_id')) {
    database.exec('ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)');
  }
  // The image lives as a file; the row only remembers its generated name.
  if (!productColumns().includes('image_filename')) {
    database.exec('ALTER TABLE products ADD COLUMN image_filename TEXT');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (${STOCK_MOVEMENT_COLUMNS}
    );
    CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
  `);
  if (!database.prepare('PRAGMA table_info(stock_movements)').all().some((column) => column.name === 'source')) {
    database.exec(`ALTER TABLE stock_movements ADD COLUMN ${MOVEMENT_SOURCE_COLUMN}`);
  } else if (MOVEMENT_SOURCES.some((source) => !(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stock_movements'").get()?.sql ?? '').includes(`'${source}'`))) {
    rebuildStockMovementsForSources(database);
  }
  // Purchase drafts live in the same SQLite file as the rest of the state, so the
  // accepted backup/restore ADR already covers them (see docs/adr/0001).
  database.exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id INTEGER PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER CHECK (quantity IS NULL OR (quantity > 0 AND quantity <= 9007199254740991)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (purchase_order_id, product_id)
    );

    CREATE INDEX IF NOT EXISTS purchase_order_lines_order ON purchase_order_lines(purchase_order_id, id);
  `);
  // Customers are a standalone directory: contact emails and phones plus the RIF/Cédula that
  // identifies them uniquely. They carry no stock or orders, so no product relation is added.
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      last_name TEXT,
      language TEXT NOT NULL DEFAULT 'es' CHECK (language = 'es'),
      notes TEXT,
      tax_id TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(tax_id)) BETWEEN 1 AND 20),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_emails (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS customer_phones (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS customer_emails_customer ON customer_emails(customer_id, position, id);
    CREATE INDEX IF NOT EXISTS customer_phones_customer ON customer_phones(customer_id, position, id);

    -- A customer has at most one delivery address, so customer_id is unique. Removing the
    -- customer removes it, and it carries no phone of its own.
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
      country TEXT NOT NULL DEFAULT 'Venezuela',
      first_name TEXT,
      last_name TEXT,
      company TEXT,
      address1 TEXT,
      address2 TEXT,
      postal_code TEXT,
      city TEXT,
      state TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Orders and drafts share one model: a single table discriminated by kind, with one lines table.
  // An order is numbered from 1001 and is active/annulled; a draft is numbered from 1 (shown #D…)
  // and is open/completed. Channels are a named list that grows on save.
  database.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100)
    );

    CREATE TABLE IF NOT EXISTS order_sequences (
      kind TEXT PRIMARY KEY CHECK (kind IN ('order', 'draft')),
      next_number INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('order', 'draft')),
      number INTEGER NOT NULL CHECK (number > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'annulled', 'open', 'completed')),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      channel_id INTEGER NOT NULL REFERENCES channels(id),
      discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
      notes TEXT,
      total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
      source_draft_number INTEGER,
      source_draft_id INTEGER,
      paid_at TEXT,
      fulfilled_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (kind, number)
    );

    CREATE TABLE IF NOT EXISTS order_lines (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
      unit_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (order_id, product_id)
    );

    CREATE INDEX IF NOT EXISTS order_lines_order ON order_lines(order_id, position, id);

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('created', 'paid', 'fulfilled', 'archived', 'unarchived', 'annulled', 'comment')),
      user_id INTEGER REFERENCES users(id),
      body TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id, id);
  `);
  // Payment, fulfilment and archival are timestamps rather than a second status column, so the
  // order lifecycle (open/archived/annulled) stays independent from the operational states.
  const orderColumns = () => database.prepare('PRAGMA table_info(orders)').all().map((column) => column.name);
  for (const [name, definition] of [['paid_at', 'TEXT'], ['fulfilled_at', 'TEXT'], ['archived_at', 'TEXT'], ['source_draft_id', 'INTEGER']]) {
    if (!orderColumns().includes(name)) database.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
  }
  const seedChannel = database.prepare('INSERT INTO channels (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  for (const name of DEFAULT_CHANNELS) seedChannel.run(name);
  // Numbers are never reused: annulling an order or deleting a draft leaves the sequence advanced.
  database.prepare("INSERT OR IGNORE INTO order_sequences (kind, next_number) VALUES ('order', 1001)").run();
  database.prepare("INSERT OR IGNORE INTO order_sequences (kind, next_number) VALUES ('draft', 1)").run();
  return database;
}

// SQLite cannot change an existing CHECK constraint, so a movement table missing a newer
// source (such as "creation" or "order") needs the whole table rebuilt and its rows copied over.
function rebuildStockMovementsForSources(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE stock_movements_new (${STOCK_MOVEMENT_COLUMNS}
      );
      INSERT INTO stock_movements_new (id, product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source)
        SELECT id, product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source FROM stock_movements;
      DROP TABLE stock_movements;
      ALTER TABLE stock_movements_new RENAME TO stock_movements;
      CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
    `);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function hasAdministrator(database) {
  return database.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get() !== undefined;
}

export function createAdministrator(database, { username, passwordSalt, passwordHash }) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (hasAdministrator(database)) {
      const error = new Error('Initial administrator has already been configured.');
      error.code = 'INITIAL_ACCESS_ALREADY_CONFIGURED';
      throw error;
    }
    const result = database.prepare(`
      INSERT INTO users (username, password_salt, password_hash, role)
      VALUES (?, ?, ?, 'admin')
    `).run(username, passwordSalt, passwordHash);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function findUserByUsername(database, username) {
  return database.prepare(`
    SELECT id, username, password_salt, password_hash, role
    FROM users
    WHERE username = ? COLLATE NOCASE
  `).get(username);
}

export function findUser(database, id) {
  return database.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
}

export function listUsers(database) {
  return database.prepare('SELECT id, username, role FROM users ORDER BY username COLLATE NOCASE').all();
}

export function insertUser(database, { username, passwordSalt, passwordHash, role }) {
  return database.prepare(`
    INSERT INTO users (username, password_salt, password_hash, role) VALUES (?, ?, ?, ?)
  `).run(username, passwordSalt, passwordHash, role);
}

export function updateUserRole(database, id, role) {
  return database.prepare("UPDATE users SET role = ? WHERE id = ? AND role != 'admin'").run(role, id);
}

// Products carry the names of their three named lists so the detail view never needs extra queries.
const PRODUCT_SELECT = `
  SELECT products.*, categories.name AS category_name,
    product_types.name AS product_type_name, suppliers.name AS supplier_name
  FROM products
  LEFT JOIN categories ON categories.id = products.category_id
  LEFT JOIN product_types ON product_types.id = products.product_type_id
  LEFT JOIN suppliers ON suppliers.id = products.supplier_id`;

export function findProduct(database, id) {
  return database.prepare(`${PRODUCT_SELECT} WHERE products.id = ?`).get(id);
}

// The import preview resolves the previous article by P/N with the same joins as the detail
// view, so it can show the category, type and supplier that an absent column will preserve.
export function findProductByPartNumber(database, partNumber) {
  return database.prepare(`${PRODUCT_SELECT} WHERE products.part_number = ? COLLATE NOCASE`).get(partNumber);
}

export function listProducts(database) {
  return database.prepare(`${PRODUCT_SELECT} ORDER BY part_number COLLATE NOCASE, products.id`).all();
}

export function listCategories(database) {
  return database.prepare('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE, id').all();
}

// Categories, product types and suppliers grow on save and reuse an equivalent name.
export function findOrCreateNamed(database, table, name) {
  database.prepare(`INSERT INTO ${table} (name) VALUES (?) ON CONFLICT(name) DO NOTHING`).run(name);
  return database.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).get(name).id;
}

export function listProductTypes(database) {
  return database.prepare('SELECT id, name FROM product_types ORDER BY name COLLATE NOCASE, id').all();
}

export function listSuppliers(database) {
  return database.prepare('SELECT id, name FROM suppliers ORDER BY name COLLATE NOCASE, id').all();
}

export function insertProduct(database, product) {
  return database.prepare(`
    INSERT INTO products (part_number, description, presentation, brand, location, minimum_stock)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    product.partNumber,
    product.description,
    product.presentation,
    product.brand,
    product.location,
    product.minimumStock,
  );
}

export function updateProduct(database, id, product) {
  return database.prepare(`
    UPDATE products
    SET part_number = ?, description = ?, presentation = ?, brand = ?, location = ?, minimum_stock = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    product.partNumber,
    product.description,
    product.presentation,
    product.brand,
    product.location,
    product.minimumStock,
    id,
  );
}

// Extended fields and named-list references are written in one place, shared by the product
// form and the Excel import so both preserve or clear them the same way.
export function setProductClassification(database, id, { longDescription, priceCents, costCents, categoryId, productTypeId, supplierId }) {
  return database.prepare(`
    UPDATE products
    SET long_description = ?, price_cents = ?, cost_cents = ?, category_id = ?, product_type_id = ?, supplier_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(longDescription, priceCents, costCents, categoryId, productTypeId, supplierId, id);
}

export function setProductArchived(database, id, archived) {
  return database.prepare(`
    UPDATE products SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(archived ? 1 : 0, id);
}

export function setProductImage(database, id, filename) {
  return database.prepare(`
    UPDATE products SET image_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(filename, id);
}

export function insertPurchaseOrder(database) {
  return database.prepare('INSERT INTO purchase_orders DEFAULT VALUES').run();
}

export function findPurchaseOrder(database, id) {
  return database.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
}

// The list view shows how many articles each draft already includes and how many have a quantity.
export function listPurchaseOrders(database) {
  return database.prepare(`
    SELECT purchase_orders.*,
      (SELECT COUNT(*) FROM purchase_order_lines lines WHERE lines.purchase_order_id = purchase_orders.id) AS line_count,
      (SELECT COUNT(*) FROM purchase_order_lines lines WHERE lines.purchase_order_id = purchase_orders.id AND lines.quantity IS NOT NULL) AS ready_count
    FROM purchase_orders
    ORDER BY purchase_orders.id DESC
  `).all();
}

// Lines join the live product record, so archived articles stay visible and identified in existing lists.
export function listPurchaseOrderLines(database, purchaseOrderId) {
  return database.prepare(`
    SELECT lines.id AS line_id, lines.quantity AS requested_quantity,
      products.*, categories.name AS category_name
    FROM purchase_order_lines lines
    JOIN products ON products.id = lines.product_id
    LEFT JOIN categories ON categories.id = products.category_id
    WHERE lines.purchase_order_id = ?
    ORDER BY products.part_number COLLATE NOCASE, products.id
  `).all(purchaseOrderId);
}

export function findPurchaseOrderLine(database, purchaseOrderId, productId) {
  return database.prepare('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? AND product_id = ?').get(purchaseOrderId, productId);
}

export function insertPurchaseOrderLine(database, purchaseOrderId, productId) {
  return database.prepare('INSERT INTO purchase_order_lines (purchase_order_id, product_id) VALUES (?, ?)').run(purchaseOrderId, productId);
}

export function setPurchaseOrderLineQuantity(database, purchaseOrderId, lineId, quantity) {
  return database.prepare(`
    UPDATE purchase_order_lines SET quantity = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND purchase_order_id = ?
  `).run(quantity, lineId, purchaseOrderId);
}

export function removePurchaseOrderLine(database, purchaseOrderId, lineId) {
  return database.prepare('DELETE FROM purchase_order_lines WHERE id = ? AND purchase_order_id = ?').run(lineId, purchaseOrderId);
}

export function touchPurchaseOrder(database, id) {
  return database.prepare('UPDATE purchase_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

export function setPurchaseOrderStatus(database, id, status) {
  return database.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}

export function insertCustomer(database, { name, lastName, language, notes, taxId }) {
  return database.prepare(`
    INSERT INTO customers (name, last_name, language, notes, tax_id) VALUES (?, ?, ?, ?, ?)
  `).run(name, lastName, language, notes, taxId);
}

export function updateCustomer(database, id, { name, lastName, language, notes, taxId }) {
  return database.prepare(`
    UPDATE customers SET name = ?, last_name = ?, language = ?, notes = ?, tax_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, lastName, language, notes, taxId, id);
}

export function findCustomer(database, id) {
  return database.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

// The RIF/Cédula is the customer identity; SQLite NOCASE folds ASCII so V-1 and v-1 collide.
export function findCustomerByTaxId(database, taxId) {
  return database.prepare('SELECT * FROM customers WHERE tax_id = ? COLLATE NOCASE').get(taxId);
}

// The list shows each customer's location, so the single (optional) address is folded in here.
export function listCustomers(database) {
  return database.prepare(`
    SELECT customers.*,
      customer_addresses.city AS address_city,
      customer_addresses.state AS address_state,
      customer_addresses.country AS address_country
    FROM customers
    LEFT JOIN customer_addresses ON customer_addresses.customer_id = customers.id
    ORDER BY customers.name COLLATE NOCASE, customers.last_name COLLATE NOCASE, customers.id
  `).all();
}

export function listCustomerEmails(database, customerId) {
  return database.prepare('SELECT email FROM customer_emails WHERE customer_id = ? ORDER BY position, id').all(customerId).map((row) => row.email);
}

export function listCustomerPhones(database, customerId) {
  return database.prepare('SELECT phone FROM customer_phones WHERE customer_id = ? ORDER BY position, id').all(customerId).map((row) => row.phone);
}

// Saving the customer rewrites both contact lists in order, so the first is always the principal.
export function replaceCustomerContacts(database, customerId, emails, phones) {
  database.prepare('DELETE FROM customer_emails WHERE customer_id = ?').run(customerId);
  database.prepare('DELETE FROM customer_phones WHERE customer_id = ?').run(customerId);
  const insertEmail = database.prepare('INSERT INTO customer_emails (customer_id, email, position) VALUES (?, ?, ?)');
  emails.forEach((email, position) => insertEmail.run(customerId, email, position));
  const insertPhone = database.prepare('INSERT INTO customer_phones (customer_id, phone, position) VALUES (?, ?, ?)');
  phones.forEach((phone, position) => insertPhone.run(customerId, phone, position));
}

export function findCustomerAddress(database, customerId) {
  return database.prepare('SELECT * FROM customer_addresses WHERE customer_id = ?').get(customerId);
}

// A customer has at most one address: an empty save removes it, otherwise it is rewritten in place.
export function replaceCustomerAddress(database, customerId, address) {
  database.prepare('DELETE FROM customer_addresses WHERE customer_id = ?').run(customerId);
  if (!address) return;
  database.prepare(`
    INSERT INTO customer_addresses (customer_id, country, first_name, last_name, company, address1, address2, postal_code, city, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customerId, address.country, address.first_name, address.last_name, address.company, address.address1, address.address2, address.postal_code, address.city, address.state);
}

export function listChannels(database) {
  return database.prepare('SELECT id, name FROM channels ORDER BY name COLLATE NOCASE, id').all();
}

export function findChannel(database, id) {
  return database.prepare('SELECT id, name FROM channels WHERE id = ?').get(id);
}

// The caller owns the transaction; taking a number advances the non-reusable sequence for a kind.
export function takeOrderNumber(database, kind) {
  const row = database.prepare('SELECT next_number FROM order_sequences WHERE kind = ?').get(kind);
  database.prepare('UPDATE order_sequences SET next_number = next_number + 1 WHERE kind = ?').run(kind);
  return row.next_number;
}

export function insertOrder(database, order) {
  return database.prepare(`
    INSERT INTO orders (kind, number, status, customer_id, channel_id, discount_bps, notes, total_cents, source_draft_number, source_draft_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(order.kind, order.number, order.status, order.customerId, order.channelId, order.discountBps,
    order.notes, order.totalCents, order.sourceDraftNumber ?? null, order.sourceDraftId ?? null);
}

export function insertOrderLine(database, orderId, line, position) {
  return database.prepare(`
    INSERT INTO order_lines (order_id, product_id, quantity, unit_price_cents, position)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, line.productId, line.quantity, line.unitPriceCents, position);
}

// Orders, drafts and their list join the live customer and channel names the same way.
const ORDER_COLUMNS = `orders.*, customers.name AS customer_name, customers.last_name AS customer_last_name,
  channels.name AS channel_name`;
const ORDER_FROM = `FROM orders
  JOIN customers ON customers.id = orders.customer_id
  JOIN channels ON channels.id = orders.channel_id`;

export function findOrderByNumber(database, kind, number) {
  return database.prepare(`SELECT ${ORDER_COLUMNS} ${ORDER_FROM} WHERE orders.kind = ? AND orders.number = ?`).get(kind, number);
}

export function findOrderById(database, id) {
  return database.prepare(`SELECT ${ORDER_COLUMNS} ${ORDER_FROM} WHERE orders.id = ?`).get(id);
}

// The caller owns the transaction; annulling flips the status without touching the lines.
export function setOrderStatus(database, orderId, status) {
  database.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, orderId);
}

// Drafts are edited in place: the header fields are rewritten and their lines replaced wholesale.
export function updateOrder(database, orderId, { customerId, channelId, discountBps, notes, totalCents }) {
  return database.prepare(`
    UPDATE orders
    SET customer_id = ?, channel_id = ?, discount_bps = ?, notes = ?, total_cents = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(customerId, channelId, discountBps, notes, totalCents, orderId);
}

export function deleteOrderLines(database, orderId) {
  return database.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId);
}

// The lines cascade away with the order; drafts never touch stock, so nothing else to clean up.
export function deleteOrder(database, orderId) {
  return database.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
}

// Payment, fulfilment and archival are marked by stamping a timestamp; a NULL means "not yet".
export function setOrderPaidAt(database, orderId, value = 'CURRENT_TIMESTAMP') {
  database.prepare(`UPDATE orders SET paid_at = ${value}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
}

export function setOrderFulfilledAt(database, orderId, value = 'CURRENT_TIMESTAMP') {
  database.prepare(`UPDATE orders SET fulfilled_at = ${value}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
}

export function setOrderArchivedAt(database, orderId, value = 'CURRENT_TIMESTAMP') {
  database.prepare(`UPDATE orders SET archived_at = ${value}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
}

// The timeline is append-only: events carry a kind, the author and an optional comment body.
export function insertOrderEvent(database, { orderId, kind, userId = null, body = null }) {
  return database.prepare('INSERT INTO order_events (order_id, kind, user_id, body) VALUES (?, ?, ?, ?)')
    .run(orderId, kind, userId, body);
}

// The ficha reads the timeline oldest first, with the author name resolved for comments.
export function listOrderEvents(database, orderId) {
  return database.prepare(`
    SELECT order_events.*, users.username AS author
    FROM order_events
    LEFT JOIN users ON users.id = order_events.user_id
    WHERE order_events.order_id = ?
    ORDER BY order_events.id
  `).all(orderId);
}

// The customer card on the order ficha counts only real orders, never drafts.
export function countOrdersForCustomer(database, customerId) {
  return database.prepare("SELECT COUNT(*) AS total FROM orders WHERE kind = 'order' AND customer_id = ?").get(customerId).total;
}

// The list adds the line count and returns the newest orders first.
export function listOrders(database, kind = 'order') {
  return database.prepare(`SELECT ${ORDER_COLUMNS},
      (SELECT COUNT(*) FROM order_lines lines WHERE lines.order_id = orders.id) AS line_count
    ${ORDER_FROM} WHERE orders.kind = ? ORDER BY orders.number DESC`).all(kind);
}

// The list breakdown loads the lines of a whole page in one query, ordered per order and position.
export function listOrderLinesForOrders(database, orderIds) {
  if (!orderIds.length) return [];
  const placeholders = orderIds.map(() => '?').join(', ');
  return database.prepare(`
    SELECT lines.order_id, lines.quantity, lines.unit_price_cents, lines.position,
      products.part_number, products.description, products.presentation
    FROM order_lines lines
    JOIN products ON products.id = lines.product_id
    WHERE lines.order_id IN (${placeholders})
    ORDER BY lines.order_id, lines.position, lines.id
  `).all(...orderIds);
}

// Lines keep the price snapshot taken when the order was created and join the live product record.
export function listOrderLines(database, orderId) {
  return database.prepare(`
    SELECT lines.id AS line_id, lines.product_id, lines.quantity, lines.unit_price_cents, lines.position,
      products.part_number, products.description, products.presentation, products.archived,
      products.image_filename, categories.name AS category_name
    FROM order_lines lines
    JOIN products ON products.id = lines.product_id
    LEFT JOIN categories ON categories.id = products.category_id
    WHERE lines.order_id = ?
    ORDER BY lines.position, lines.id
  `).all(orderId);
}
