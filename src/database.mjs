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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (!database.prepare('PRAGMA table_info(products)').all().some((column) => column.name === 'quantity')) {
    database.exec(`BEGIN IMMEDIATE;
      ALTER TABLE products ADD COLUMN quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0 AND quantity <= 9007199254740991);
      ALTER TABLE products ADD COLUMN stock_version INTEGER NOT NULL DEFAULT 0;
      COMMIT;`);
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
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
  `);
  return database;
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

export function findProduct(database, id) {
  return database.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function listProducts(database) {
  return database.prepare(`
    SELECT id, part_number, description, presentation, brand, location, minimum_stock, quantity
    FROM products
    ORDER BY part_number COLLATE NOCASE
  `).all();
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
