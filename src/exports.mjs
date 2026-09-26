import ExcelJS from 'exceljs';
import { filterProducts } from './products.mjs';

export class ExportError extends Error {}

export const EXPORT_VIEWS = ['products', 'inventory'];

// Productos exporta el catálogo descriptivo con su categoría; Inventario solo P/N, nombre y existencias.
export function parseExportView(params) {
  const view = params.get('view') ?? 'inventory';
  if (!EXPORT_VIEWS.includes(view)) throw new ExportError('Elige una vista válida para exportar.');
  return view;
}

// `scope=all` exports every article matching the view filters, across all pages.
// `scope=selected` is always explicit and never falls back to the complete catalog.
export function selectExportProducts(products, params) {
  const scope = params.get('scope');
  if (scope === 'all') return filterProducts(products, params);
  if (scope !== 'selected') throw new ExportError('Elige una exportación completa o de la selección.');
  const values = params.getAll('id');
  if (!values.length) throw new ExportError('Selecciona al menos un artículo para exportar.');
  if (values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new ExportError('La selección de artículos no es válida. Vuelve a seleccionarlos.');
  }
  const ids = new Set(values.map(Number));
  const selected = products.filter((product) => ids.has(product.id));
  if (selected.length !== ids.size) throw new ExportError('Algún artículo de la selección ya no existe. Vuelve a seleccionarlos.');
  return selected;
}

async function writeSheet(columns, products, title) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title);
  sheet.columns = columns;
  // Strings stay literal, including P/N with leading zeros or text beginning with '='.
  sheet.addRows(products);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = `A1:${String.fromCharCode(64 + columns.length)}1`;
  return workbook.xlsx.writeBuffer();
}

const PRODUCT_COLUMNS = [
  { header: 'P/N', key: 'part_number', width: 24, style: { numFmt: '@' } },
  { header: 'Descripción', key: 'description', width: 48 },
  { header: 'Presentación', key: 'presentation', width: 16 },
  { header: 'Marca', key: 'brand', width: 24 },
  { header: 'Ubicación', key: 'location', width: 28 },
  { header: 'Mínimo de stock', key: 'minimum_stock', width: 20 },
  { header: 'Categoría', key: 'category_name', width: 24 },
  { header: 'Cantidad', key: 'quantity', width: 16 },
];

const INVENTORY_COLUMNS = [
  { header: 'P/N', key: 'part_number', width: 24, style: { numFmt: '@' } },
  { header: 'Descripción', key: 'description', width: 48 },
  { header: 'Cantidad', key: 'quantity', width: 16 },
];

export function exportProducts(products) {
  return writeSheet(PRODUCT_COLUMNS, products, 'Productos');
}

export function exportInventory(products) {
  return writeSheet(INVENTORY_COLUMNS, products, 'Inventario');
}

export function exportView(products, view) {
  return view === 'products' ? exportProducts(products) : exportInventory(products);
}
