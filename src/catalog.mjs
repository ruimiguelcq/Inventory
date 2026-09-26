import { findOrCreateNamed, findUser, insertProduct, setProductClassification, setProductImage, updateProduct } from './database.mjs';
import { removeProductImage, storeProductImage } from './images.mjs';
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
    tooLongMessage: 'La categoría no puede superar los 100 caracteres.',
    conflictMessage: 'Elige una categoría existente o escribe una nueva.',
    invalidMessage: 'Elige una categoría válida.',
  },
  productType: {
    table: 'product_types',
    tooLongMessage: 'El tipo de producto no puede superar los 100 caracteres.',
    conflictMessage: 'Elige un tipo de producto existente o escribe uno nuevo.',
    invalidMessage: 'Elige un tipo de producto válido.',
  },
  supplier: {
    table: 'suppliers',
    tooLongMessage: 'El proveedor no puede superar los 100 caracteres.',
    conflictMessage: 'Elige un proveedor existente o escribe uno nuevo.',
    invalidMessage: 'Elige un proveedor válido.',
  },
};

function resolveNamedList(database, { table, tooLongMessage, conflictMessage, invalidMessage }, idInput, newInput, existingId) {
  const id = idInput ?? (existingId != null ? String(existingId) : '');
  const name = (newInput ?? '').trim();
  if (name.length > 100) throw new CatalogError(tooLongMessage);
  if (name && id) throw new CatalogError(conflictMessage);
  if (id) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))
      || !database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(id))) {
      throw new CatalogError(invalidMessage);
    }
    return Number(id);
  }
  if (name) return findOrCreateNamed(database, table, name);
  return null;
}

// Named-list creation, classification, the image and the initial movement commit together with the article.
export function saveCatalogProduct(database, userId, product, form, existingProduct, { image = null, removeImage = false, imageDirectory = null } = {}) {
  database.exec('BEGIN IMMEDIATE');
  let writtenImage = null;
  try {
    requireManager(database, userId);
    const categoryId = resolveNamedList(database, NAMED_LISTS.category, form.get('categoryId'), form.get('newCategory'), existingProduct?.category_id);
    const productTypeId = resolveNamedList(database, NAMED_LISTS.productType, form.get('productTypeId'), form.get('newProductType'), existingProduct?.product_type_id);
    const supplierId = resolveNamedList(database, NAMED_LISTS.supplier, form.get('supplierId'), form.get('newSupplier'), existingProduct?.supplier_id);
    const id = existingProduct?.id ?? Number(insertProduct(database, product).lastInsertRowid);
    if (existingProduct) updateProduct(database, id, product);
    // A form that omits a field preserves the stored value; an empty field clears it.
    setProductClassification(database, id, {
      longDescription: product.longDescriptionProvided ? product.longDescription : (existingProduct?.long_description ?? null),
      priceCents: product.priceProvided ? product.priceCents : (existingProduct?.price_cents ?? null),
      categoryId, productTypeId, supplierId,
    });
    const previousImage = existingProduct?.image_filename ?? null;
    if (image && imageDirectory) {
      writtenImage = storeProductImage(imageDirectory, id, image);
      setProductImage(database, id, writtenImage);
    } else if (removeImage) {
      setProductImage(database, id, null);
    }
    if (!existingProduct && product.initialQuantity > 0) {
      recordStock(database, userId, { productId: id, operation: 'set', quantity: product.initialQuantity,
        previousQuantity: 0, newQuantity: product.initialQuantity, presentation: product.presentation, reason: null }, 'creation');
    }
    database.exec('COMMIT');
    // Only drop the replaced file once the new state is committed.
    if (previousImage && (image || removeImage)) removeProductImage(imageDirectory, previousImage);
  } catch (error) {
    database.exec('ROLLBACK');
    if (writtenImage) removeProductImage(imageDirectory, writtenImage);
    throw error;
  }
}

