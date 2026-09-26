export const PRESENTATIONS = ['SET', 'KIT', 'unidad'];
export const MAX_LONG_DESCRIPTION = 2000;
// The catalog colours the inventory cell against the product minimum, falling back to ten.
export const DEFAULT_MINIMUM_STOCK = 10;

// Dollars typed by the user become integer cents; parsing the string avoids float rounding.
export function parsePrice(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!text) return { cents: null };
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return { error: 'El precio debe ser un número en dólares con hasta dos decimales.' };
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { error: 'El precio supera el máximo permitido.' };
  return { cents };
}

export function formatCents(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2);
}

export function validateProduct(form) {
  const partNumber = (form.get('partNumber') ?? '').trim();
  const description = (form.get('description') ?? '').trim();
  const presentation = form.get('presentation') ?? '';
  const brand = (form.get('brand') ?? '').trim();
  const location = (form.get('location') ?? '').trim();
  const minimumInput = (form.get('minimumStock') ?? '').trim();
  const longDescriptionInput = form.get('longDescription');
  const priceInput = form.get('price');
  const costInput = form.get('cost');
  const longDescription = (longDescriptionInput ?? '').trim();
  const initialInput = (form.get('initialQuantity') ?? '').trim();
  const stateInput = form.get('state');
  const product = { partNumber, description, presentation, brand: brand || null,
    location: location || null, minimumStock: minimumInput === '' ? null : Number(minimumInput),
    longDescription: longDescription || null, longDescriptionProvided: longDescriptionInput !== null,
    priceCents: null, priceProvided: priceInput !== null, costCents: null, costProvided: costInput !== null,
    initialQuantity: initialInput === '' ? 0 : Number(initialInput),
    archivedProvided: stateInput !== null && stateInput !== '', archived: stateInput === 'archived' };
  if (!partNumber || partNumber.length > 100) return { error: 'Escribe un P/N de hasta 100 caracteres.', product };
  if (!description || description.length > 240) return { error: 'Escribe un nombre de producto de hasta 240 caracteres.', product };
  if (!PRESENTATIONS.includes(presentation)) return { error: 'Elige una presentación válida: Set, Kit o Unidad.', product };
  if (brand && brand.length > 100) return { error: 'La marca no puede superar los 100 caracteres.', product };
  if (location && location.length > 120) return { error: 'La ubicación no puede superar los 120 caracteres.', product };
  if (minimumInput !== '' && (!Number.isSafeInteger(product.minimumStock) || product.minimumStock < 0)) {
    return { error: 'El mínimo de stock debe ser un número entero igual o mayor que cero.', product };
  }
  if (longDescription.length > MAX_LONG_DESCRIPTION) return { error: `La descripción no puede superar los ${MAX_LONG_DESCRIPTION} caracteres.`, product };
  const price = parsePrice(priceInput);
  if (price.error) return { error: price.error, product };
  product.priceCents = price.cents;
  const cost = parsePrice(costInput);
  if (cost.error) return { error: cost.error.replace('El precio', 'El costo'), product };
  product.costCents = cost.cents;
  if (stateInput !== null && stateInput !== '' && !['active', 'archived'].includes(stateInput)) {
    return { error: 'Elige un estado válido: Activo o Archivado.', product };
  }
  if (initialInput !== '' && (!Number.isSafeInteger(product.initialQuantity) || product.initialQuantity < 0)) {
    return { error: 'La cantidad inicial debe ser un número entero igual o mayor que cero.', product };
  }
  return { product };
}

// Cero existencias tiene prioridad y se marca "agotado"; con mínimo configurado, cantidad menor o igual al mínimo es "stock bajo".
export function stockStatus(product) {
  if (product.quantity === 0) return 'agotado';
  if (product.minimum_stock !== null && product.minimum_stock !== undefined && product.quantity <= product.minimum_stock) return 'stockbajo';
  return null;
}

// Colour rule for the catalog inventory cell: green when the quantity reaches the
// product minimum (10 by default), red when it falls short.
export function inventoryLevel(product) {
  return product.quantity >= (product.minimum_stock ?? DEFAULT_MINIMUM_STOCK) ? 'ok' : 'low';
}

// Estado elegido para el catálogo; sin parámetro se muestran los activos.
export function catalogState(params) {
  return params.get('state') ?? (params.get('archived') === 'on' ? 'archived' : 'active');
}

// Filtra el listado del inventario a partir de los parámetros de búsqueda de la interfaz.
export function filterProducts(products, params) {
  const state = catalogState(params);
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const presentation = params.get('presentation') ?? '';
  const category = params.get('category') ?? '';
  const brand = params.get('brand') ?? '';
  const statuses = [];
  if (params.get('outOfStock') === 'on') statuses.push('agotado');
  if (params.get('lowStock') === 'on') statuses.push('stockbajo');

  return products.filter((product) => {
    if (state !== 'all' && Boolean(product.archived) !== (state === 'archived')) return false;
    if (query && !product.part_number.toLowerCase().includes(query) && !product.description.toLowerCase().includes(query)) return false;
    if (presentation && product.presentation !== presentation) return false;
    if (category === 'none' ? product.category_id != null : category && String(product.category_id) !== category) return false;
    if (brand && product.brand !== brand) return false;
    if (statuses.length && !statuses.includes(stockStatus(product))) return false;
    return true;
  });
}

export function paginateProducts(products, params) {
  const requestedSize = Number(params.get('pageSize'));
  const pageSize = [25, 50, 100].includes(requestedSize) ? requestedSize : 50;
  const total = products.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;
  return { products: products.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, pages } };
}
