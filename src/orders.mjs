import {
  findChannel,
  findCustomer,
  findOrCreateNamed,
  findProduct,
  findUser,
  insertOrder,
  insertOrderLine,
  takeOrderNumber,
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

export const ORDERS_PER_PAGE = 50;

// The list search matches the order number (with or without a leading #) and the customer name;
// the channel filter is exact by id. Both are read from the query string and combined.
export function filterOrders(orders, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const channel = (params.get('channel') ?? '').trim();
  const needle = query.replace(/^#/, '');
  return orders.filter((order) => {
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
