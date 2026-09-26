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

// The complete export covers every article matching the view search, across all pages.
export function selectExportProducts(products, params) {
  if (params.get('scope') !== 'all') throw new ExportError('Elige una exportación completa.');
  return filterProducts(products, params);
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
  { header: 'Producto', key: 'description', width: 48 },
  { header: 'Descripción', key: 'long_description', width: 48 },
  { header: 'Presentación', key: 'presentation', width: 16 },
  { header: 'Marca', key: 'brand', width: 24 },
  { header: 'Ubicación', key: 'location', width: 28 },
  { header: 'Mínimo de stock', key: 'minimum_stock', width: 20 },
  { header: 'Categoría', key: 'category_name', width: 24 },
  { header: 'Tipo', key: 'product_type_name', width: 24 },
  { header: 'Proveedor', key: 'supplier_name', width: 24 },
  { header: 'Precio', key: 'price', width: 14, style: { numFmt: '0.00' } },
  { header: 'Estado', key: 'state', width: 12 },
  { header: 'Cantidad', key: 'quantity', width: 16 },
];

const INVENTORY_COLUMNS = [
  { header: 'P/N', key: 'part_number', width: 24, style: { numFmt: '@' } },
  { header: 'Producto', key: 'description', width: 48 },
  { header: 'Cantidad', key: 'quantity', width: 16 },
];

// Dollars as a number so Excel can work with the price; the two-decimal format is display only.
// The state is informational: archiving still happens from the product form.
function productExportRow(product) {
  return {
    part_number: product.part_number,
    description: product.description,
    long_description: product.long_description,
    presentation: product.presentation,
    brand: product.brand,
    location: product.location,
    minimum_stock: product.minimum_stock,
    category_name: product.category_name,
    product_type_name: product.product_type_name,
    supplier_name: product.supplier_name,
    price: product.price_cents == null ? null : product.price_cents / 100,
    state: product.archived ? 'Archivado' : 'Activo',
    quantity: product.quantity,
  };
}

export function exportProducts(products) {
  return writeSheet(PRODUCT_COLUMNS, products.map(productExportRow), 'Productos');
}

export function exportInventory(products) {
  return writeSheet(INVENTORY_COLUMNS, products, 'Inventario');
}

export function exportView(products, view) {
  return view === 'products' ? exportProducts(products) : exportInventory(products);
}

// A purchase export carries only P/N, name and requested quantity, with no prices, taxes,
// supplier, number or date inside the document.
const PURCHASE_COLUMNS = [
  { header: 'P/N', key: 'part_number', width: 24, style: { numFmt: '@' } },
  { header: 'Nombre', key: 'description', width: 48 },
  { header: 'Cantidad solicitada', key: 'requested_quantity', width: 20 },
];

// Exporting needs at least one line and every requested quantity filled with a positive integer.
export function validatePurchaseExport(lines) {
  if (!lines.length) throw new ExportError('La lista no tiene artículos que exportar.');
  if (lines.some((line) => !Number.isSafeInteger(line.requested_quantity) || line.requested_quantity <= 0)) {
    throw new ExportError('Todas las cantidades solicitadas deben ser números enteros mayores que cero para exportar.');
  }
  return lines;
}

export function exportPurchaseOrder(lines) {
  return writeSheet(PURCHASE_COLUMNS, validatePurchaseExport(lines), 'Compra');
}
