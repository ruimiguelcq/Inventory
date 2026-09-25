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
