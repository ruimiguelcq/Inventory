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
      available_quantity INTEGER NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return database;
}

export function hasAdministrator(database) {
  return database.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
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

export function findProduct(database, id) {
  return database.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function listProducts(database) {
  return database.prepare(`
    SELECT id, part_number, description, presentation, brand, location, minimum_stock, available_quantity
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
