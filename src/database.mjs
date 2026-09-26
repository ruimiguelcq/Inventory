import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  if (!productColumns().includes('product_type_id')) {
    database.exec('ALTER TABLE products ADD COLUMN product_type_id INTEGER REFERENCES product_types(id)');
  }
  if (!productColumns().includes('supplier_id')) {
    database.exec('ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_movements (
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
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'creation'))
    );
    CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
  `);
  if (!database.prepare('PRAGMA table_info(stock_movements)').all().some((column) => column.name === 'source')) {
    database.exec("ALTER TABLE stock_movements ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'creation'))");
  } else if (!(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stock_movements'").get()?.sql ?? '').includes("'creation'")) {
    rebuildStockMovementsForCreation(database);
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
  return database;
}

// SQLite cannot change an existing CHECK constraint, so the early "creation" source
// needs the whole table rebuilt and its rows copied over.
function rebuildStockMovementsForCreation(database) {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE stock_movements_new (
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
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'creation'))
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

export function listProducts(database) {
  return database.prepare(`${PRODUCT_SELECT} ORDER BY part_number COLLATE NOCASE, products.id`).all();
}

export function listCategories(database) {
  return database.prepare('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE, id').all();
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

// Extended fields and named-list references live apart from the columnar product write,
// so import/export can keep touching only the classic columns.
export function setProductClassification(database, id, { longDescription, priceCents, categoryId, productTypeId, supplierId }) {
  return database.prepare(`
    UPDATE products
    SET long_description = ?, price_cents = ?, category_id = ?, product_type_id = ?, supplier_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(longDescription, priceCents, categoryId, productTypeId, supplierId, id);
}

export function setProductArchived(database, id, archived) {
  return database.prepare(`
    UPDATE products SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(archived ? 1 : 0, id);
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
