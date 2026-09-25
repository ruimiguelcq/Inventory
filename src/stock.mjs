import { findProduct, findUser } from './database.mjs';
import { canManageInventory } from './permissions.mjs';

export class StockError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function reviewStock(product, form) {
  const operation = form.get('operation');
  const input = (form.get('quantity') ?? '').trim();
  const quantity = Number(input);
  const reason = (form.get('reason') ?? '').trim();
  if (!['adjust', 'set'].includes(operation)) throw new StockError('Elige Ajustar por o Establecer en.');
  if (!/^[+-]?\d+$/.test(input) || !Number.isSafeInteger(quantity)) throw new StockError('La cantidad debe ser un número entero de presentaciones completas.');
  const newQuantity = operation === 'adjust' ? product.quantity + quantity : quantity;
  if (newQuantity < 0) throw new StockError('Las existencias no pueden quedar por debajo de cero.');
  if (!Number.isSafeInteger(newQuantity)) throw new StockError('La cantidad supera el máximo permitido.');
  if (reason.length > 500) throw new StockError('El motivo no puede superar los 500 caracteres.');
  return { productId: product.id, version: product.stock_version, presentation: product.presentation,
    operation, quantity, previousQuantity: product.quantity, newQuantity, reason };
}

export function saveStock(database, userId, change) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!canManageInventory(findUser(database, userId)?.role)) {
      throw new StockError('No tienes permiso para realizar esta operación.', 403);
    }
    const product = findProduct(database, change.productId);
    if (!product || product.stock_version !== change.version || product.presentation !== change.presentation) {
      throw new StockError('Las existencias o la presentación han cambiado. Revisa de nuevo la operación.', 409);
    }
    database.prepare(`UPDATE products SET quantity = ?, stock_version = stock_version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(change.newQuantity, change.productId);
    database.prepare(`INSERT INTO stock_movements
      (product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(change.productId, userId, change.operation,
      change.quantity, change.previousQuantity, change.newQuantity, change.presentation, change.reason || null, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function stockHistory(database, productId) {
  return database.prepare(`SELECT m.*, u.username FROM stock_movements m JOIN users u ON u.id = m.user_id
    WHERE m.product_id = ? ORDER BY m.id DESC`).all(productId);
}
