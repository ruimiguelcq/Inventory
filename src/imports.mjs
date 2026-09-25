import ExcelJS from 'exceljs';
import { findUser, insertProduct, updateProduct } from './database.mjs';
import { validateProduct } from './products.mjs';
import { canManageInventory } from './permissions.mjs';
import { recordStock, reviewStock, StockError } from './stock.mjs';

const MAX_UPLOAD = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const columns = new Map([
  ['p/n', 'partNumber'], ['descripcion', 'description'], ['presentacion', 'presentation'],
  ['marca', 'brand'], ['ubicacion', 'location'], ['ubicacion principal', 'location'],
  ['minimo de stock', 'minimumStock'], ['minimo', 'minimumStock'],
  ['cantidad', 'quantity'], ['disponible', 'quantity'],
]);

export class ImportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
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

export async function previewImport(database, form) {
  const descriptions = form.get('descriptions') === 'on';
  const stock = form.get('stock') === 'on';
  const operation = form.get('operation');
  if (!descriptions && !stock) throw new ImportError('Elige datos descriptivos y/o existencias.');
  if (stock && !['adjust', 'set'].includes(operation)) throw new ImportError('Elige explícitamente Ajustar por o Establecer en.');
  const file = form.get('file');
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
  const required = ['partNumber', ...(descriptions ? ['description', 'presentation'] : []), ...(stock ? ['quantity'] : [])];
  if (required.some((field) => !mapping.has(field))) throw new ImportError('Faltan columnas obligatorias: P/N, Descripción y Presentación para datos descriptivos; Cantidad para existencias.');
  const rows = [];
  const find = database.prepare('SELECT * FROM products WHERE part_number = ? COLLATE NOCASE');
  for (let number = 2; number <= sheet.rowCount; number++) {
    const excelRow = sheet.getRow(number);
    if (!excelRow.hasValues) continue;
    excelRow.eachCell((cell, index) => {
      if (![...mapping.values()].includes(index)) throw new ImportError(`La fila ${number} contiene datos sin encabezado de columna.`);
    });
    const row = { number, errors: [], partNumber: '', previous: null, product: null, change: null };
    try {
      row.partNumber = cellText(excelRow.getCell(mapping.get('partNumber')));
      if (typeof excelRow.getCell(mapping.get('partNumber')).value === 'number') throw new ImportError('Guarda el P/N como texto en Excel para conservar su formato y ceros iniciales.');
      if (!row.partNumber || row.partNumber.length > 100) throw new ImportError('Escribe un P/N de hasta 100 caracteres.');
      row.previous = find.get(row.partNumber) ?? null;
      if (!descriptions && !row.previous) throw new ImportError('P/N no encontrado: activa datos descriptivos para crear el artículo.');
      row.product = row.previous ? descriptiveProduct(row.previous) : {};
      if (descriptions) {
        const values = new URLSearchParams();
        for (const field of ['partNumber', 'description', 'presentation', 'brand', 'location', 'minimumStock']) {
          values.set(field, mapping.has(field) ? cellText(excelRow.getCell(mapping.get(field))) : row.product[field] ?? '');
        }
        const validated = validateProduct(values);
        if (validated.error) throw new ImportError(validated.error);
        row.product = validated.product;
      }
      if (stock) {
        row.change = reviewStock({ ...row.previous, quantity: row.previous?.quantity ?? 0, presentation: row.product.presentation },
          new URLSearchParams({ operation, quantity: cellText(excelRow.getCell(mapping.get('quantity'))), reason: 'Importación Excel' }));
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
  return { rows, descriptions, stock, operation };
}

export function applyImport(database, userId, review) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!canManageInventory(findUser(database, userId)?.role)) throw new ImportError('No tienes permiso para realizar esta operación.', 403);
    if (review.rows.some((row) => row.errors.length)) throw new ImportError('Corrige todas las filas con errores antes de confirmar.');
    const find = database.prepare('SELECT * FROM products WHERE part_number = ? COLLATE NOCASE');
    for (const row of review.rows) {
      const current = find.get(row.partNumber) ?? null;
      if (JSON.stringify(current) !== JSON.stringify(row.previous)) throw new ImportError('Los artículos o las existencias han cambiado. Revisa de nuevo el archivo.', 409);
    }
    for (const row of review.rows) {
      let id = row.previous?.id;
      if (!id) id = Number(insertProduct(database, row.product).lastInsertRowid);
      else if (review.descriptions) updateProduct(database, id, row.product);
      if (row.change) recordStock(database, userId, { ...row.change, productId: id }, 'import');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
