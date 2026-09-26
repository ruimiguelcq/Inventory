import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

function inspectCounts(database) {
  const counts = database.prepare(`SELECT
    (SELECT COUNT(*) FROM products) AS products,
    (SELECT COUNT(*) FROM stock_movements) AS movements,
    (SELECT COUNT(*) FROM users) AS users`).get();
  // Snapshots from before categories remain valid restore points; migration adds an empty table.
  const hasCategories = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'categories'").get();
  return { ...counts, categories: hasCategories ? database.prepare('SELECT COUNT(*) AS count FROM categories').get().count : 0 };
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
    return { ...info, valid: integrity === 'ok', integrity, ...counts };
  } catch {
    return { ...info, valid: false, integrity: 'error', products: null, movements: null, users: null };
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
  for (const entry of backupFiles(directory).slice(Math.max(retention, 1))) unlinkSync(entry.path);
}

export function createBackup(database, directory, { now = new Date(), retention = DEFAULT_BACKUP_RETENTION } = {}) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${FILE_PREFIX}${timestamp(now)}-${randomBytes(4).toString('hex')}${FILE_SUFFIX}`);
  // VACUUM INTO writes a consistent, compact snapshot without blocking the live connection.
  database.exec(`VACUUM INTO ${sqlLiteral(file)}`);
  pruneBackups(directory, retention);
  return inspectBackup(file);
}

export function summarizeDatabase(database) {
  const integrity = database.prepare('PRAGMA integrity_check').get().integrity_check;
  return { integrity, ...inspectCounts(database) };
}

// Copy the snapshot aside before anything can prune it, so the chosen source survives.
export function stageBackup(databasePath, backupPath) {
  const stagedPath = `${databasePath}.restoring`;
  copyFileSync(backupPath, stagedPath);
  return stagedPath;
}

// The caller closes the live database first so the staged file can take its place.
export function installStagedDatabase(databasePath, stagedPath) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${databasePath}${suffix}`);
    } catch {
      // The database uses the default rollback journal, so these rarely exist.
    }
  }
  renameSync(stagedPath, databasePath);
}

export function replaceDatabaseFile(databasePath, backupPath) {
  installStagedDatabase(databasePath, stageBackup(databasePath, backupPath));
}
