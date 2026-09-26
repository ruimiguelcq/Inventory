import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { countImages } from './images.mjs';

export const DEFAULT_BACKUP_RETENTION = 10;
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const FILE_PREFIX = 'inventario-';
const FILE_SUFFIX = '.sqlite';

export class BackupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function backupDirectoryFor(databasePath) {
  return process.env.BACKUP_DIRECTORY ?? join(dirname(databasePath), 'backups');
}

// SQLite has no string escaping helpers; a path literal only has to double its quotes.
function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// The images that belong to a snapshot live in a sibling folder named after the database file.
function backupImagesPath(backupFilePath) {
  return `${backupFilePath}.images`;
}

function backupFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .map((name) => {
      const path = join(directory, name);
      const stats = statSync(path);
      return { file: name, path, size: stats.size, createdAt: new Date(stats.mtimeMs).toISOString() };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.file.localeCompare(left.file));
}

function tableCount(database, name) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return exists ? database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count : 0;
}

function inspectCounts(database) {
  const counts = database.prepare(`SELECT
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM stock_movements) AS movements,
    (SELECT COUNT(*) FROM users) AS users`).get();
  // Snapshots from before categories and purchases remain valid restore points; migration adds empty tables.
  return {
    ...counts,
    categories: tableCount(database, 'categories'),
    purchaseOrders: tableCount(database, 'purchase_orders'),
    purchaseOrderLines: tableCount(database, 'purchase_order_lines'),
  };
}

// Replaces the destination folder so a snapshot never keeps stale image files.
function replaceDirectory(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  if (source && existsSync(source)) cpSync(source, destination, { recursive: true });
}

// A snapshot only counts as restorable if every product image it references is present.
function missingImageCount(database, imagesPath) {
  const columns = database.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  if (!columns.includes('image_filename')) return 0;
  return database.prepare('SELECT image_filename FROM products WHERE image_filename IS NOT NULL').all()
    .filter((row) => !existsSync(join(imagesPath, basename(row.image_filename)))).length;
}

// Opens a candidate backup read-only and reports whether it is a sound snapshot.
export function inspectBackup(path) {
  const stats = statSync(path);
  const info = { file: basename(path), path, size: stats.size, createdAt: new Date(stats.mtimeMs).toISOString() };
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
    const counts = inspectCounts(database);
    const imagesPath = backupImagesPath(path);
    const missingImages = missingImageCount(database, imagesPath);
    return { ...info, valid: integrity === 'ok' && missingImages === 0, integrity, ...counts, images: countImages(imagesPath), missingImages };
  } catch {
    return { ...info, valid: false, integrity: 'error', products: null, movements: null, users: null, images: 0, missingImages: null };
  } finally {
    database?.close();
  }
}

export function listBackups(directory) {
  return backupFiles(directory).map((entry) => inspectBackup(entry.path));
}

export function findBackup(directory, file) {
  if (typeof file !== 'string' || !file) return null;
  const entry = backupFiles(directory).find((candidate) => candidate.file === file);
  return entry ? inspectBackup(entry.path) : null;
}

function pruneBackups(directory, retention) {
  for (const entry of backupFiles(directory).slice(Math.max(retention, 1))) {
    unlinkSync(entry.path);
    rmSync(backupImagesPath(entry.path), { recursive: true, force: true });
  }
}

export function createBackup(database, directory, { now = new Date(), retention = DEFAULT_BACKUP_RETENTION, imageDirectory = null } = {}) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${FILE_PREFIX}${timestamp(now)}-${randomBytes(4).toString('hex')}${FILE_SUFFIX}`);
  // VACUUM INTO writes a consistent, compact snapshot without blocking the live connection.
  database.exec(`VACUUM INTO ${sqlLiteral(file)}`);
  // The product images travel next to their database snapshot.
  replaceDirectory(imageDirectory, backupImagesPath(file));
  pruneBackups(directory, retention);
  return inspectBackup(file);
}

export function summarizeDatabase(database) {
  const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
  return { integrity, ...inspectCounts(database) };
}

// Copy the snapshot and its images aside before anything can prune them, so the chosen source survives.
export function stageBackup(databasePath, backupPath) {
  const stagedPath = `${databasePath}.restoring`;
  copyFileSync(backupPath, stagedPath);
  replaceDirectory(backupImagesPath(backupPath), backupImagesPath(stagedPath));
  return stagedPath;
}

// The caller closes the live database first so the staged file can take its place.
export function installStagedDatabase(databasePath, stagedPath, imageDirectory = null) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${databasePath}${suffix}`);
    } catch {
      // The database uses the default rollback journal, so these rarely exist.
    }
  }
  if (imageDirectory) replaceDirectory(backupImagesPath(stagedPath), imageDirectory);
  renameSync(stagedPath, databasePath);
  // The staged image folder is a working copy; drop it once its content is live.
  rmSync(backupImagesPath(stagedPath), { recursive: true, force: true });
}

export function replaceDatabaseFile(databasePath, backupPath, imageDirectory = null) {
  installStagedDatabase(databasePath, stageBackup(databasePath, backupPath), imageDirectory);
}
