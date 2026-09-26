import { findUser, insertProduct, updateProduct, setProductArchived } from './database.mjs';
import { canManageInventory } from './permissions.mjs';

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

// Category creation and assignment commit together with the article, including P/N validation.
export function saveCatalogProduct(database, userId, product, form, existingProduct) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const categoryInput = form.get('categoryId') ?? String(existingProduct?.category_id ?? '');
    const newCategory = (form.get('newCategory') ?? '').trim();
    if (newCategory.length > 100) throw new CatalogError('La categoría no puede superar los 100 caracteres.');
    if (newCategory && categoryInput) throw new CatalogError('Elige una categoría existente o escribe una nueva.');
    let categoryId = null;
    if (categoryInput) {
      if (!/^[1-9]\d*$/.test(categoryInput) || !Number.isSafeInteger(Number(categoryInput))
        || !database.prepare('SELECT 1 FROM categories WHERE id = ?').get(Number(categoryInput))) {
        throw new CatalogError('Elige una categoría válida.');
      }
      categoryId = Number(categoryInput);
    } else if (newCategory) {
      database.prepare('INSERT INTO categories (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(newCategory);
      categoryId = database.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(newCategory).id;
    }
    const id = existingProduct?.id ?? Number(insertProduct(database, product).lastInsertRowid);
    if (existingProduct) updateProduct(database, id, product);
    database.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(categoryId, id);
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
