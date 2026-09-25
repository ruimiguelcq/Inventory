export const PRESENTATIONS = ['SET', 'KIT', 'unidad'];

export function validateProduct(form) {
  const partNumber = (form.get('partNumber') ?? '').trim();
  const description = (form.get('description') ?? '').trim();
  const presentation = form.get('presentation') ?? '';
  const brand = (form.get('brand') ?? '').trim();
  const location = (form.get('location') ?? '').trim();
  const minimumInput = (form.get('minimumStock') ?? '').trim();
  const product = { partNumber, description, presentation, brand: brand || null,
    location: location || null, minimumStock: minimumInput === '' ? null : Number(minimumInput) };
  if (!partNumber || partNumber.length > 100) return { error: 'Escribe un P/N de hasta 100 caracteres.', product };
  if (!description || description.length > 240) return { error: 'Escribe una descripción de hasta 240 caracteres.', product };
  if (!PRESENTATIONS.includes(presentation)) return { error: 'Elige una presentación válida: Set, Kit o Unidad.', product };
  if (brand && brand.length > 100) return { error: 'La marca no puede superar los 100 caracteres.', product };
  if (location && location.length > 120) return { error: 'La ubicación no puede superar los 120 caracteres.', product };
  if (minimumInput !== '' && (!Number.isSafeInteger(product.minimumStock) || product.minimumStock < 0)) {
    return { error: 'El mínimo de stock debe ser un número entero igual o mayor que cero.', product };
  }
  return { product };
}

// Cero existencias tiene prioridad y se marca "agotado"; con mínimo configurado, cantidad menor o igual al mínimo es "stock bajo".
export function stockStatus(product) {
  if (product.quantity === 0) return 'agotado';
  if (product.minimum_stock !== null && product.minimum_stock !== undefined && product.quantity <= product.minimum_stock) return 'stockbajo';
  return null;
}

// Filtra el listado del inventario a partir de los parámetros de búsqueda de la interfaz.
export function filterProducts(products, params) {
  const archived = params.get('archived') === 'on';
  const query = (params.get('q') ?? '').trim().toLowerCase();
  const presentation = params.get('presentation') ?? '';
  const statuses = [];
  if (params.get('outOfStock') === 'on') statuses.push('agotado');
  if (params.get('lowStock') === 'on') statuses.push('stockbajo');

  return products.filter((product) => {
    if (Boolean(product.archived) !== archived) return false;
    if (query && !product.part_number.toLowerCase().includes(query) && !product.description.toLowerCase().includes(query)) return false;
    if (presentation && product.presentation !== presentation) return false;
    if (statuses.length && !statuses.includes(stockStatus(product))) return false;
    return true;
  });
}
