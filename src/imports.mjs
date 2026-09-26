import ExcelJS from 'exceljs';
import { findOrCreateNamed, findProductByPartNumber, findUser, insertProduct, setProductClassification, updateProduct } from './database.mjs';
import { validateProduct } from './products.mjs';
import { canManageInventory } from './permissions.mjs';
import { recordStock, reviewStock, StockError } from './stock.mjs';

const MAX_UPLOAD = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const VIEWS = ['products', 'inventory'];
// "Producto" is the name and "Descripción" its long description. A file that only brings
// "Descripción" (the v1.1 layout) is resolved afterwards as the name.
const columns = new Map([
  ['p/n', 'partNumber'], ['producto', 'description'], ['descripcion', 'longDescription'],
  ['presentacion', 'presentation'],
  ['marca', 'brand'], ['ubicacion', 'location'], ['ubicacion principal', 'location'],
  ['minimo de stock', 'minimumStock'], ['minimo', 'minimumStock'],
  ['categoria', 'category'],
  ['tipo', 'productType'], ['tipo de producto', 'productType'],
  ['proveedor', 'supplier'],
  ['precio', 'price'],
  ['estado', 'state'],
  ['cantidad', 'quantity'], ['disponible', 'quantity'],
]);

// Category, product type and supplier grow on import with the same mechanism.
const NAMED_LISTS = {
  category: { table: 'categories', tooLong: 'La categoría no puede superar los 100 caracteres.' },
  productType: { table: 'product_types', tooLong: 'El tipo de producto no puede superar los 100 caracteres.' },
  supplier: { table: 'suppliers', tooLong: 'El proveedor no puede superar los 100 caracteres.' },
};

export class ImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function parseImportView(params) {
  const view = params.get('view') ?? 'inventory';
  if (!VIEWS.includes(view)) throw new ImportError('Elige una vista válida para importar.');
  return view;
}

export async function readImportForm(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD + 16_384) throw new ImportError('El archivo supera el límite de 2 MB.');
    chunks.push(chunk);
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
  } catch {
    throw new ImportError('Selecciona un archivo Excel .xlsx válido.');
  }
}

function cellText(cell) {
  if (cell.value === null) return '';
  if (!['string', 'number'].includes(typeof cell.value)) throw new ImportError('Usa valores de texto o número, sin fórmulas, fechas ni enlaces.');
  return cell.text.trim();
}

function descriptiveProduct(product) {
  return { partNumber: product.part_number, description: product.description, presentation: product.presentation,
    brand: product.brand, location: product.location, minimumStock: product.minimum_stock };
}

const CLASSIC_FIELDS = ['partNumber', 'description', 'presentation', 'brand', 'location', 'minimumStock'];

async function readSpreadsheet(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !/\.xlsx$/i.test(file.name) || !file.size) throw new ImportError('Selecciona un archivo Excel .xlsx válido.');
  if (file.size > MAX_UPLOAD) throw new ImportError('El archivo supera el límite de 2 MB.');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(await file.arrayBuffer()); }
  catch { throw new ImportError('No se pudo leer el archivo Excel. Usa un archivo .xlsx válido y sin contraseña.'); }
  if (workbook.worksheets.length !== 1) throw new ImportError('El archivo debe contener una sola hoja con el inventario.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 30) throw new ImportError('El archivo admite hasta 1000 filas de datos y 30 columnas.');
  const mapping = new Map();
  sheet.getRow(1).eachCell((cell, index) => {
    const header = cellText(cell).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const field = columns.get(header);
    if (!field) throw new ImportError(`Columna desconocida: ${cellText(cell)}.`);
    if (mapping.has(field)) throw new ImportError(`Columna repetida: ${cellText(cell)}.`);
    mapping.set(field, index);
  });
  const mappedColumns = new Set(mapping.values());
  sheet.eachRow((row, number) => {
    row.eachCell((cell, index) => {
      if (!mappedColumns.has(index)) throw new ImportError(`La fila ${number} contiene datos sin encabezado de columna.`);
    });
  });
  // With no "Producto" column, a lone "Descripción" keeps its v1.1 meaning: the article name.
  if (!mapping.has('description') && mapping.has('longDescription')) {
    mapping.set('description', mapping.get('longDescription'));
    mapping.delete('longDescription');
  }
  return { sheet, mapping };
}

// Productos importa catálogo/categoría y, opcionalmente, inventario en el mismo lote.
// Inventario solo actualiza cantidades de artículos que ya existen.
export async function previewImport(database, form, view) {
  if (!VIEWS.includes(view)) throw new ImportError('Elige una vista válida para importar.');
  const descriptions = view === 'products';
  const stock = descriptions ? form.get('stock') === 'on' : true;
  const operation = form.get('operation');
  if (stock && !['adjust', 'set'].includes(operation)) throw new ImportError('Elige explícitamente Ajustar por o Establecer en.');
  const { sheet, mapping } = await readSpreadsheet(form.get('file'));
  const required = ['partNumber', ...(descriptions ? ['description', 'presentation'] : []), ...(stock ? ['quantity'] : [])];
  if (required.some((field) => !mapping.has(field))) {
    throw new ImportError(descriptions
      ? 'Faltan columnas obligatorias: P/N, Producto (o Descripción) y Presentación, y Cantidad si importas inventario.'
      : 'Faltan columnas obligatorias para Inventario: P/N y Cantidad.');
  }
  const rows = [];
  for (let number = 2; number <= sheet.rowCount; number++) {
    const excelRow = sheet.getRow(number);
    if (!excelRow.hasValues) continue;
    const row = { number, errors: [], partNumber: '', previous: null, product: null, category: undefined,
      productType: undefined, supplier: undefined, categoryName: null, productTypeName: null, supplierName: null, change: null };
    try {
      row.partNumber = cellText(excelRow.getCell(mapping.get('partNumber')));
      if (typeof excelRow.getCell(mapping.get('partNumber')).value === 'number') throw new ImportError('Guarda el P/N como texto en Excel para conservar su formato y ceros iniciales.');
      if (!row.partNumber || row.partNumber.length > 100) throw new ImportError('Escribe un P/N de hasta 100 caracteres.');
      row.previous = findProductByPartNumber(database, row.partNumber) ?? null;
      if (!descriptions && !row.previous) throw new ImportError('P/N no encontrado: la importación de Inventario solo actualiza artículos existentes.');
      row.product = row.previous ? descriptiveProduct(row.previous) : {};
      // The Estado column is informational, but reading it keeps the "values, no formulas" rule.
      if (mapping.has('state')) cellText(excelRow.getCell(mapping.get('state')));
      if (descriptions) {
        const values = new URLSearchParams();
        for (const field of CLASSIC_FIELDS) {
          values.set(field, mapping.has(field) ? cellText(excelRow.getCell(mapping.get(field))) : row.product[field] ?? '');
        }
        // A present long-description/price column replaces the value; an absent one preserves it.
        if (mapping.has('longDescription')) values.set('longDescription', cellText(excelRow.getCell(mapping.get('longDescription'))));
        if (mapping.has('price')) values.set('price', cellText(excelRow.getCell(mapping.get('price'))));
        const validated = validateProduct(values);
        if (validated.error) throw new ImportError(validated.error);
        row.product = validated.product;
        // Show what will actually be kept: an absent long-description/price column preserves it.
        if (!row.product.longDescriptionProvided) row.product.longDescription = row.previous?.long_description ?? '';
        if (!row.product.priceProvided) row.product.priceCents = row.previous?.price_cents ?? null;
        for (const [field, { tooLong }] of Object.entries(NAMED_LISTS)) {
          if (!mapping.has(field)) continue;
          const name = cellText(excelRow.getCell(mapping.get(field)));
          if (name.length > 100) throw new ImportError(tooLong);
          // An empty cell clears the value; an absent column preserves the current one.
          row[field] = name || null;
        }
      }
      row.categoryName = row.category === undefined ? row.previous?.category_name ?? null : row.category;
      row.productTypeName = row.productType === undefined ? row.previous?.product_type_name ?? null : row.productType;
      row.supplierName = row.supplier === undefined ? row.previous?.supplier_name ?? null : row.supplier;
      if (stock) {
        const base = descriptions
          ? { ...(row.previous ?? {}), quantity: row.previous?.quantity ?? 0, presentation: row.product.presentation }
          : row.previous;
        row.change = reviewStock(base, new URLSearchParams({ operation, quantity: cellText(excelRow.getCell(mapping.get('quantity'))), reason: 'Importación Excel' }));
      }
    } catch (error) {
      if (!(error instanceof ImportError || error instanceof StockError)) throw error;
      row.errors.push(error.message);
    }
    rows.push(row);
  }
  if (!rows.length) throw new ImportError('El archivo no contiene filas de datos.');
  // SQLite NOCASE folds ASCII only; use the same identity rule as the catalog.
  const key = (pn) => pn.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const counts = new Map();
  for (const row of rows) counts.set(key(row.partNumber), (counts.get(key(row.partNumber)) ?? 0) + 1);
  for (const row of rows) if (row.partNumber && counts.get(key(row.partNumber)) > 1) row.errors.push('P/N duplicado dentro del archivo.');
  return { rows, descriptions, stock, operation, view };
}

// Named lists are reused case-insensitively so equivalent names never duplicate. An absent
// column keeps the stored reference; an empty cell clears it.
function namedListId(database, field, value, existingId) {
  if (value === undefined) return existingId ?? null;
  return value ? findOrCreateNamed(database, NAMED_LISTS[field].table, value) : null;
}

function classification(database, row) {
  const previous = row.previous;
  return {
    longDescription: row.product.longDescriptionProvided ? row.product.longDescription : (previous?.long_description ?? null),
    priceCents: row.product.priceProvided ? row.product.priceCents : (previous?.price_cents ?? null),
    // Excel carries no cost, so importing always keeps the stored one.
    costCents: previous?.cost_cents ?? null,
    categoryId: namedListId(database, 'category', row.category, previous?.category_id),
    productTypeId: namedListId(database, 'productType', row.productType, previous?.product_type_id),
    supplierId: namedListId(database, 'supplier', row.supplier, previous?.supplier_id),
  };
}

export function applyImport(database, userId, review) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!canManageInventory(findUser(database, userId)?.role)) throw new ImportError('No tienes permiso para realizar esta operación.', 403);
    if (review.rows.some((row) => row.errors.length)) throw new ImportError('Corrige todas las filas con errores antes de confirmar.');
    for (const row of review.rows) {
      const current = findProductByPartNumber(database, row.partNumber) ?? null;
      if (JSON.stringify(current) !== JSON.stringify(row.previous)) throw new ImportError('Los artículos o el inventario han cambiado. Revisa de nuevo el archivo.', 409);
    }
    for (const row of review.rows) {
      let id = row.previous?.id;
      if (review.descriptions) {
        if (!id) id = Number(insertProduct(database, row.product).lastInsertRowid);
        else updateProduct(database, id, row.product);
        setProductClassification(database, id, classification(database, row));
      }
      if (row.change) recordStock(database, userId, { ...row.change, productId: id }, 'import');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
