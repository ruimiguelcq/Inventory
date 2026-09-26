import {
  findProduct,
  findPurchaseOrder,
  findPurchaseOrderLine,
  findUser,
  insertPurchaseOrder,
  insertPurchaseOrderLine,
  listPurchaseOrderLines,
  removePurchaseOrderLine,
  setPurchaseOrderLineQuantity,
  setPurchaseOrderStatus,
  touchPurchaseOrder,
} from './database.mjs';
import { canManageInventory } from './permissions.mjs';
import { stockStatus } from './products.mjs';

export class PurchaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireManager(database, userId) {
  if (!canManageInventory(findUser(database, userId)?.role)) {
    throw new PurchaseError('No tienes permiso para realizar esta operación.', 403);
  }
}

function positiveId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

// Every mutation opens one transaction, revalidates the role and loads the list it acts on.
// Editing is only offered while the list is a draft; archived lists are read-only until reopened.
function withDraft(database, userId, purchaseOrderId, run, { allowArchived = false } = {}) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const order = findPurchaseOrder(database, purchaseOrderId);
    if (!order) throw new PurchaseError('No encontramos esa lista de compra.', 404);
    if (!allowArchived && order.status !== 'draft') {
      throw new PurchaseError('Reabre la lista para poder editarla.', 409);
    }
    const result = run(order);
    touchPurchaseOrder(database, order.id);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Articles the draft selector may offer: active only, agotado first, then stock bajo, then the rest.
export function selectableProducts(products) {
  const priority = (product) => {
    const status = stockStatus(product);
    return status === 'agotado' ? 0 : status === 'stockbajo' ? 1 : 2;
  };
  return products
    .filter((product) => !product.archived)
    .sort((left, right) => priority(left) - priority(right)
      || left.part_number.localeCompare(right.part_number, 'es')
      || left.id - right.id);
}

export function createPurchaseDraft(database, userId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const id = Number(insertPurchaseOrder(database).lastInsertRowid);
    database.exec('COMMIT');
    return id;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Saving writes only the requested quantities of the list: stock and history stay untouched.
export function savePurchaseDraft(database, userId, purchaseOrderId, form) {
  return withDraft(database, userId, purchaseOrderId, (order) => {
    const updates = [];
    for (const line of listPurchaseOrderLines(database, order.id)) {
      const raw = form.get(`line-${line.line_id}`);
      if (raw === null) continue;
      const value = String(raw).trim();
      if (value === '') {
        updates.push([line.line_id, null]);
        continue;
      }
      // A draft may stay incomplete, but a written quantity must be a positive integer.
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new PurchaseError('Las cantidades solicitadas deben ser números enteros mayores que cero, o quedar vacías.');
      }
      updates.push([line.line_id, Number(value)]);
    }
    for (const [lineId, quantity] of updates) setPurchaseOrderLineQuantity(database, order.id, lineId, quantity);
  });
}

// Adding and removing act on their own line, so a pending quantity in another row never blocks them.
export function addPurchaseLine(database, userId, purchaseOrderId, productId) {
  return withDraft(database, userId, purchaseOrderId, (order) => {
    if (!positiveId(productId)) throw new PurchaseError('Elige un artículo activo para añadir.');
    const product = findProduct(database, Number(productId));
    if (!product) throw new PurchaseError('El artículo seleccionado ya no existe.');
    if (product.archived) throw new PurchaseError('No puedes añadir un artículo archivado a una lista de compra.');
    if (findPurchaseOrderLine(database, order.id, product.id)) return false;
    insertPurchaseOrderLine(database, order.id, product.id);
    return true;
  });
}

export function removePurchaseLine(database, userId, purchaseOrderId, lineId) {
  return withDraft(database, userId, purchaseOrderId, (order) => {
    if (!positiveId(lineId)) throw new PurchaseError('La línea que intentas retirar no es válida.');
    if (removePurchaseOrderLine(database, order.id, Number(lineId)).changes === 0) {
      throw new PurchaseError('La línea ya no forma parte de la lista.', 404);
    }
  });
}

// Archiving and reopening only change the list status; they never touch stock or history.
export function archivePurchaseOrder(database, userId, purchaseOrderId) {
  return withDraft(database, userId, purchaseOrderId, (order) => {
    setPurchaseOrderStatus(database, order.id, 'archived');
  }, { allowArchived: true });
}

export function reopenPurchaseOrder(database, userId, purchaseOrderId) {
  return withDraft(database, userId, purchaseOrderId, (order) => {
    setPurchaseOrderStatus(database, order.id, 'draft');
  }, { allowArchived: true });
}
