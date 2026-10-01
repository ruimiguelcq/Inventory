import {
  deleteOrder,
  deleteOrderLines,
  findChannel,
  findCustomer,
  findOrCreateNamed,
  findOrderById,
  findProduct,
  findUser,
  insertOrder,
  insertOrderEvent,
  insertOrderLine,
  listOrderLines,
  setOrderArchivedAt,
  setOrderFulfilledAt,
  setOrderPaidAt,
  setOrderStatus,
  takeOrderNumber,
  updateOrder,
} from './database.mjs';
import { customerName } from './customers.mjs';
import { canManageInventory } from './permissions.mjs';
import { recordStock } from './stock.mjs';

export class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MAX_CHANNEL = 100;
export const MAX_NOTES = 2000;
export const MAX_COMMENT = 2000;

export const ORDERS_PER_PAGE = 50;
// The order lifecycle replaces the old "active" label: open while it is being worked, archived
// once it is done, annulled when it is cancelled. Payment and fulfilment are separate flags.
export const ORDER_STATES = ['open', 'archived', 'annulled', 'all'];

export function orderLifecycle(order) {
  if (order.status === 'annulled') return 'annulled';
  return order.archived_at ? 'archived' : 'open';
}

// Without a state the list shows only open orders; archived, annulled and all are explicit choices.
export function orderState(params) {
  return ORDER_STATES.includes(params.get('state')) ? params.get('state') : 'open';
}

// The list search matches the order number (with or without a leading #) and the customer name;
// the channel filter is exact by id and the state filter is open/archived/annulled/all. All combine.
export function filterOrders(orders, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const channel = (params.get('channel') ?? '').trim();
  const state = orderState(params);
  const needle = query.replace(/^#/, '');
  return orders.filter((order) => {
    if (state !== 'all' && orderLifecycle(order) !== state) return false;
    if (channel && String(order.channel_id) !== channel) return false;
    if (!query) return true;
    return String(order.number).includes(needle)
      || customerName({ name: order.customer_name, last_name: order.customer_last_name }).toLowerCase().includes(query);
  });
}

export function paginateOrders(orders, params) {
  const total = orders.length;
  const pages = Math.max(1, Math.ceil(total / ORDERS_PER_PAGE));
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;
  return {
    orders: orders.slice((page - 1) * ORDERS_PER_PAGE, page * ORDERS_PER_PAGE),
    pagination: { page, pageSize: ORDERS_PER_PAGE, total, pages },
  };
}

function positiveId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

// The discount travels as whole basis points (0–10000); the interface types a percentage.
export function parseDiscount(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!text) return { bps: 0 };
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) {
    return { error: 'El descuento debe ser un porcentaje entre 0 y 100 con hasta dos decimales.' };
  }
  const percent = Number(text);
  if (percent > 100) return { error: 'El descuento no puede superar el 100 %.' };
  return { bps: Math.round(percent * 100) };
}

// Subtotal and total are computed from the snapshot prices; the total rounds to whole cents.
export function orderTotals(lines, discountBps) {
  const subtotalCents = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  return { subtotalCents, totalCents: Math.round(subtotalCents * (10000 - discountBps) / 10000) };
}

// Reads the order form: the single fields plus one repeated (productId, quantity) pair per line.
export function orderFormValues(form) {
  const productIds = form.getAll('productId');
  const quantities = form.getAll('quantity');
  const lines = [];
  for (let index = 0; index < Math.max(productIds.length, quantities.length); index += 1) {
    lines.push({ productId: productIds[index] ?? '', quantity: quantities[index] ?? '' });
  }
  return {
    customerId: (form.get('customerId') ?? '').trim(),
    channelId: (form.get('channelId') ?? '').trim(),
    newChannel: (form.get('newChannel') ?? '').trim(),
    discount: (form.get('discount') ?? '').trim(),
    notes: (form.get('notes') ?? '').trim(),
    lines,
  };
}

function requireManager(database, userId) {
  if (!canManageInventory(findUser(database, userId)?.role)) {
    throw new OrderError('No tienes permiso para realizar esta operación.', 403);
  }
}

// Resolves and validates every line against the live catalog, rejecting duplicates, non-positive
// quantities and any request beyond the available stock. Prices are the snapshot for the order.
function resolveOrderLines(database, rawLines) {
  const filled = rawLines.filter((line) => String(line.productId).trim() !== '' || String(line.quantity).trim() !== '');
  if (!filled.length) throw new OrderError('Añade al menos un artículo al pedido.');
  const seen = new Set();
  return filled.map((raw) => {
    const productId = String(raw.productId).trim();
    const quantityText = String(raw.quantity).trim();
    if (!positiveId(productId)) throw new OrderError('Elige un artículo del catálogo en cada línea.');
    const product = findProduct(database, Number(productId));
    if (!product) throw new OrderError('Uno de los artículos del pedido ya no existe.');
    if (product.archived) throw new OrderError(`No puedes pedir el artículo archivado ${product.part_number}.`);
    if (seen.has(product.id)) throw new OrderError(`El artículo ${product.part_number} aparece más de una vez en el pedido.`);
    seen.add(product.id);
    if (!/^[1-9]\d*$/.test(quantityText) || !Number.isSafeInteger(Number(quantityText))) {
      throw new OrderError(`Escribe una cantidad entera mayor que cero para ${product.part_number}.`);
    }
    const quantity = Number(quantityText);
    if (quantity > product.quantity) {
      throw new OrderError(`No hay existencias suficientes de ${product.part_number}: disponible ${product.quantity}, pedido ${quantity}.`);
    }
    return {
      productId: product.id, quantity, unitPriceCents: product.price_cents ?? 0,
      presentation: product.presentation, available: product.quantity,
    };
  });
}

// Resolves the channel from an existing id or a newly typed name, never both.
function resolveChannelId(database, values) {
  if (values.channelId !== '' && values.newChannel !== '') {
    throw new OrderError('Elige un canal existente o escribe uno nuevo, pero no ambos.');
  }
  if (values.channelId !== '') {
    if (!positiveId(values.channelId)) throw new OrderError('Elige un canal válido.');
    const channel = findChannel(database, Number(values.channelId));
    if (!channel) throw new OrderError('El canal seleccionado ya no existe.');
    return channel.id;
  }
  if (values.newChannel !== '') {
    if (values.newChannel.length > MAX_CHANNEL) throw new OrderError(`El canal no puede superar los ${MAX_CHANNEL} caracteres.`);
    return findOrCreateNamed(database, 'channels', values.newChannel);
  }
  throw new OrderError('Elige o crea un canal para el pedido.');
}

// Creating an order is one transaction: it validates stock, takes a non-reusable number, writes the
// order and its lines, and records a decrement movement with the 'order' origin for each line.
export function createOrderFromForm(database, userId, form) {
  const values = orderFormValues(form);
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    if (!positiveId(values.customerId)) throw new OrderError('Elige un cliente registrado para el pedido.');
    const customer = findCustomer(database, Number(values.customerId));
    if (!customer) throw new OrderError('El cliente seleccionado ya no existe.');
    const channelId = resolveChannelId(database, values);
    const discount = parseDiscount(values.discount);
    if (discount.error) throw new OrderError(discount.error);
    if (values.notes.length > MAX_NOTES) throw new OrderError(`Las notas no pueden superar los ${MAX_NOTES} caracteres.`);
    const lines = resolveOrderLines(database, values.lines);
    const { totalCents } = orderTotals(lines, discount.bps);
    const number = takeOrderNumber(database, 'order');
    const orderId = Number(insertOrder(database, {
      kind: 'order', number, status: 'active', customerId: customer.id, channelId,
      discountBps: discount.bps, notes: values.notes || null, totalCents,
    }).lastInsertRowid);
    insertOrderEvent(database, { orderId, kind: 'created', userId });
    lines.forEach((line, position) => {
      insertOrderLine(database, orderId, line, position);
      recordStock(database, userId, {
        productId: line.productId, presentation: line.presentation, operation: 'adjust',
        quantity: -line.quantity, previousQuantity: line.available, newQuantity: line.available - line.quantity,
        reason: `Pedido #${number}`,
      }, 'order');
    });
    database.exec('COMMIT');
    return number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Annulling is one transaction: it restores exactly the quantity discounted per line as a positive
// movement with the 'order' origin, then flips the order to annulled. Re-annulling is refused.
export function annulOrder(database, userId, orderId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const order = findOrderById(database, orderId);
    if (!order) throw new OrderError('No encontramos ese pedido.', 404);
    if (order.kind !== 'order') throw new OrderError('No encontramos ese pedido.', 404);
    if (order.status === 'annulled') throw new OrderError('El pedido ya está anulado.', 409);
    if (order.status !== 'active') throw new OrderError('Solo se puede anular un pedido activo.', 409);
    for (const line of listOrderLines(database, order.id)) {
      const product = findProduct(database, line.product_id);
      if (!product) throw new OrderError('Uno de los artículos del pedido ya no existe.', 409);
      recordStock(database, userId, {
        productId: product.id, presentation: product.presentation, operation: 'adjust',
        quantity: line.quantity, previousQuantity: product.quantity, newQuantity: product.quantity + line.quantity,
        reason: `Anulación del pedido #${order.number}`,
      }, 'order');
    }
    setOrderStatus(database, order.id, 'annulled');
    insertOrderEvent(database, { orderId: order.id, kind: 'annulled', userId });
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Status transitions are refused on an annulled order: cancelling is final, only a new order
// replaces it. The caller owns the transaction; each action logs its own timeline event.
function findWritableOrder(database, userId, orderId) {
  requireManager(database, userId);
  const order = findOrderById(database, orderId);
  if (!order) throw new OrderError('No encontramos ese pedido.', 404);
  if (order.status === 'annulled') throw new OrderError('El pedido está anulado.', 409);
  return order;
}

// When an order is both paid and prepared it archives itself, matching the store's setting.
function autoArchiveIfComplete(database, orderId, userId) {
  const order = findOrderById(database, orderId);
  if (order.paid_at && order.fulfilled_at && !order.archived_at) {
    setOrderArchivedAt(database, orderId);
    insertOrderEvent(database, { orderId, kind: 'archived', userId });
  }
}

export function markOrderPaid(database, userId, orderId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = findWritableOrder(database, userId, orderId);
    if (!order.paid_at) {
      setOrderPaidAt(database, order.id);
      insertOrderEvent(database, { orderId: order.id, kind: 'paid', userId });
      autoArchiveIfComplete(database, order.id, userId);
    }
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function markOrderPrepared(database, userId, orderId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = findWritableOrder(database, userId, orderId);
    if (!order.fulfilled_at) {
      setOrderFulfilledAt(database, order.id);
      insertOrderEvent(database, { orderId: order.id, kind: 'fulfilled', userId });
      autoArchiveIfComplete(database, order.id, userId);
    }
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function archiveOrder(database, userId, orderId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = findWritableOrder(database, userId, orderId);
    if (!order.archived_at) {
      setOrderArchivedAt(database, order.id);
      insertOrderEvent(database, { orderId: order.id, kind: 'archived', userId });
    }
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function unarchiveOrder(database, userId, orderId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const order = findWritableOrder(database, userId, orderId);
    if (order.archived_at) {
      setOrderArchivedAt(database, order.id, 'NULL');
      insertOrderEvent(database, { orderId: order.id, kind: 'unarchived', userId });
    }
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Comments are internal notes on the timeline; they are allowed even on an annulled order so the
// team can record why it was cancelled.
export function addOrderComment(database, userId, orderId, body) {
  const text = String(body ?? '').trim();
  if (!text) throw new OrderError('Escribe un comentario antes de publicar.');
  if (text.length > MAX_COMMENT) throw new OrderError(`El comentario no puede superar los ${MAX_COMMENT} caracteres.`);
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const order = findOrderById(database, orderId);
    if (!order) throw new OrderError('No encontramos ese pedido.', 404);
    insertOrderEvent(database, { orderId: order.id, kind: 'comment', userId, body: text });
    database.exec('COMMIT');
    return order.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Borradores (cotizaciones): the same model as an order, but editable, deletable
// and detached from inventory. They are numbered #D1 onwards and are open/completed.
// ---------------------------------------------------------------------------

export const DRAFT_STATES = ['open', 'completed'];

// Drafts search by number (with or without the leading # or D) and by customer name.
export function filterDrafts(drafts, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const raw = query.replace(/^#/, '');
  const numberNeedle = /^d?\d+$/.test(raw) ? raw.replace(/^d/, '') : '';
  return drafts.filter((draft) => {
    if (!query) return true;
    if (numberNeedle && String(draft.number).includes(numberNeedle)) return true;
    return customerName({ name: draft.customer_name, last_name: draft.customer_last_name }).toLowerCase().includes(query);
  });
}

// A draft line only checks that the article exists and is active: it is a price quote, so it is not
// bounded by the available stock and never discounts inventory.
function resolveDraftLines(database, rawLines) {
  const filled = rawLines.filter((line) => String(line.productId).trim() !== '' || String(line.quantity).trim() !== '');
  if (!filled.length) throw new OrderError('Añade al menos un artículo al borrador.');
  const seen = new Set();
  return filled.map((raw) => {
    const productId = String(raw.productId).trim();
    const quantityText = String(raw.quantity).trim();
    if (!positiveId(productId)) throw new OrderError('Elige un artículo del catálogo en cada línea.');
    const product = findProduct(database, Number(productId));
    if (!product) throw new OrderError('Uno de los artículos del borrador ya no existe.');
    if (product.archived) throw new OrderError(`No puedes cotizar el artículo archivado ${product.part_number}.`);
    if (seen.has(product.id)) throw new OrderError(`El artículo ${product.part_number} aparece más de una vez en el borrador.`);
    seen.add(product.id);
    if (!/^[1-9]\d*$/.test(quantityText) || !Number.isSafeInteger(Number(quantityText))) {
      throw new OrderError(`Escribe una cantidad entera mayor que cero para ${product.part_number}.`);
    }
    const quantity = Number(quantityText);
    return { productId: product.id, quantity, unitPriceCents: product.price_cents ?? 0, presentation: product.presentation };
  });
}

// Reads and validates the shared draft/order form fields, returning the resolved header and lines.
function resolveDraftValues(database, values) {
  if (!positiveId(values.customerId)) throw new OrderError('Elige un cliente registrado para el borrador.');
  const customer = findCustomer(database, Number(values.customerId));
  if (!customer) throw new OrderError('El cliente seleccionado ya no existe.');
  const channelId = resolveChannelId(database, values);
  const discount = parseDiscount(values.discount);
  if (discount.error) throw new OrderError(discount.error);
  if (values.notes.length > MAX_NOTES) throw new OrderError(`Las notas no pueden superar los ${MAX_NOTES} caracteres.`);
  const lines = resolveDraftLines(database, values.lines);
  const { totalCents } = orderTotals(lines, discount.bps);
  return { customerId: customer.id, channelId, discountBps: discount.bps, notes: values.notes || null, lines, totalCents };
}

// Creating a draft is one transaction that only writes the draft, its lines and its own number.
export function createDraftFromForm(database, userId, form) {
  const values = orderFormValues(form);
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const draft = resolveDraftValues(database, values);
    const number = takeOrderNumber(database, 'draft');
    const draftId = Number(insertOrder(database, {
      kind: 'draft', number, status: 'open', customerId: draft.customerId, channelId: draft.channelId,
      discountBps: draft.discountBps, notes: draft.notes, totalCents: draft.totalCents,
    }).lastInsertRowid);
    draft.lines.forEach((line, position) => insertOrderLine(database, draftId, line, position));
    database.exec('COMMIT');
    return number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function findWritableDraft(database, userId, draftId) {
  requireManager(database, userId);
  const draft = findOrderById(database, draftId);
  if (!draft || draft.kind !== 'draft') throw new OrderError('No encontramos ese borrador.', 404);
  if (draft.status !== 'open') throw new OrderError('El borrador está completado. Reábrelo para editarlo.', 409);
  return draft;
}

// Editing replaces the header fields and rewrites every line; the number never changes.
export function updateDraftFromForm(database, userId, draftId, form) {
  const values = orderFormValues(form);
  database.exec('BEGIN IMMEDIATE');
  try {
    const draft = findWritableDraft(database, userId, draftId);
    const resolved = resolveDraftValues(database, values);
    updateOrder(database, draft.id, resolved);
    deleteOrderLines(database, draft.id);
    resolved.lines.forEach((line, position) => insertOrderLine(database, draft.id, line, position));
    database.exec('COMMIT');
    return draft.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Deleting a draft never touches inventory or the movement history.
export function deleteDraft(database, userId, draftId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const draft = findOrderById(database, draftId);
    if (!draft || draft.kind !== 'draft') throw new OrderError('No encontramos ese borrador.', 404);
    deleteOrder(database, draft.id);
    database.exec('COMMIT');
    return draft.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Converting a draft into an order is one transaction: it re-resolves the lines against the live
// catalog (so the price snapshot is taken now and the stock is checked), takes an order number,
// writes the order and its lines, discounts the stock per line and marks the draft completed.
// If any line lacks stock the whole transaction rolls back, leaving the draft untouched.
export function convertDraftToOrder(database, userId, draftId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const draft = findOrderById(database, draftId);
    if (!draft || draft.kind !== 'draft') throw new OrderError('No encontramos ese borrador.', 404);
    if (draft.status === 'completed') throw new OrderError('El borrador ya está completado.', 409);
    const rawLines = listOrderLines(database, draft.id).map((line) => ({ productId: String(line.product_id), quantity: String(line.quantity) }));
    const lines = resolveOrderLines(database, rawLines);
    const { totalCents } = orderTotals(lines, draft.discount_bps);
    const number = takeOrderNumber(database, 'order');
    const orderId = Number(insertOrder(database, {
      kind: 'order', number, status: 'active', customerId: draft.customer_id, channelId: draft.channel_id,
      discountBps: draft.discount_bps, notes: draft.notes, totalCents, sourceDraftNumber: draft.number,
      sourceDraftId: draft.id,
    }).lastInsertRowid);
    insertOrderEvent(database, { orderId, kind: 'created', userId });
    lines.forEach((line, position) => {
      insertOrderLine(database, orderId, line, position);
      recordStock(database, userId, {
        productId: line.productId, presentation: line.presentation, operation: 'adjust',
        quantity: -line.quantity, previousQuantity: line.available, newQuantity: line.available - line.quantity,
        reason: `Pedido #${number}`,
      }, 'order');
    });
    setOrderStatus(database, draft.id, 'completed');
    database.exec('COMMIT');
    return number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Open <-> completed; the number and the lines stay untouched.
export function setDraftStatus(database, userId, draftId, status) {
  if (!DRAFT_STATES.includes(status)) throw new OrderError('Estado de borrador inválido.');
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const draft = findOrderById(database, draftId);
    if (!draft || draft.kind !== 'draft') throw new OrderError('No encontramos ese borrador.', 404);
    if (draft.status !== status) setOrderStatus(database, draft.id, status);
    database.exec('COMMIT');
    return draft.number;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
