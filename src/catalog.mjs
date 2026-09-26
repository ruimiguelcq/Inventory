import { findUser, insertProduct, setProductClassification, updateProduct, setProductArchived } from './database.mjs';
import { canManageInventory } from './permissions.mjs';
import { recordStock } from './stock.mjs';

export class CatalogError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireManager(database, userId) {
  if (!canManageInventory(findUser(database, userId)?.role)) {
    throw new CatalogError('No tienes permiso para realizar esta operación.', 403);
  }
}

// Category, type and supplier share one grow-on-save mechanism: reuse an existing id or create
// the typed name, never both, and never a duplicate of an equivalent name.
const NAMED_LISTS = {
  category: {
    table: 'categories',
    tooLong: 'La categoría no puede superar los 100 caracteres.',
    conflict: 'Elige una categoría existente o escribe una nueva.',
    invalid: 'Elige una categoría válida.',
  },
  productType: {
    table: 'product_types',
    tooLong: 'El tipo de producto no puede superar los 100 caracteres.',
    conflict: 'Elige un tipo de producto existente o escribe uno nuevo.',
    invalid: 'Elige un tipo de producto válido.',
  },
  supplier: {
    table: 'suppliers',
    tooLong: 'El proveedor no puede superar los 100 caracteres.',
    conflict: 'Elige un proveedor existente o escribe uno nuevo.',
    invalid: 'Elige un proveedor válido.',
  },
};

function resolveNamedList(database, { table, tooLong, conflict, invalid }, idInput, newInput, existingId) {
  const id = idInput ?? (existingId != null ? String(existingId) : '');
  const name = (newInput ?? '').trim();
  if (name.length > 100) throw new CatalogError(tooLong);
  if (name && id) throw new CatalogError(conflict);
  if (id) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
      || !database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(id))) {
      throw new CatalogError(invalid);
    }
    return Number(id);
  }
  if (name) {
    database.prepare(`INSERT INTO ${table} (name) VALUES (?) ON CONFLICT(name) DO NOTHING`).run(name);
    return database.prepare(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`).get(name).id;
  }
  return null;
}

// Named-list creation, classification and the initial movement commit together with the article.
export function saveCatalogProduct(database, userId, product, form, existingProduct) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const categoryId = resolveNamedList(database, NAMED_LISTS.category, form.get('categoryId'), form.get('newCategory'), existingProduct?.category_id);
    const productTypeId = resolveNamedList(database, NAMED_LISTS.productType, form.get('productTypeId'), form.get('newProductType'), existingProduct?.product_type_id);
    const supplierId = resolveNamedList(database, NAMED_LISTS.supplier, form.get('supplierId'), form.get('newSupplier'), existingProduct?.supplier_id);
    const id = existingProduct?.id ?? Number(insertProduct(database, product).lastInsertRowid);
    if (existingProduct) updateProduct(database, id, product);
    setProductClassification(database, id, {
      longDescription: product.longDescription ?? null,
      priceCents: product.priceCents ?? null,
      categoryId, productTypeId, supplierId,
    });
    if (!existingProduct && product.initialQuantity > 0) {
      recordStock(database, userId, { productId: id, operation: 'set', quantity: product.initialQuantity,
        previousQuantity: 0, newQuantity: product.initialQuantity, presentation: product.presentation, reason: null }, 'creation');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function archiveSelection(database, userId, values, archived) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    if (!values.length || values.length > 100 || values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new CatalogError('Selecciona entre 1 y 100 artículos válidos de la página visible.');
    }
    const ids = [...new Set(values.map(Number))];
    const exists = database.prepare('SELECT 1 FROM products WHERE id = ?');
    if (ids.some((id) => !exists.get(id))) throw new CatalogError('Algún artículo de la selección ya no existe. Vuelve a seleccionarlos.');
    for (const id of ids) setProductArchived(database, id, archived);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
