import ExcelJS from 'exceljs';

export class ExportError extends Error {}

export function selectExportProducts(products, params) {
  const scope = params.get('scope');
  if (scope === 'all') return products;
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

export async function exportInventory(products) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inventario');
  sheet.columns = [
    { header: 'P/N', key: 'part_number', width: 24, style: { numFmt: '@' } },
    { header: 'Descripción', key: 'description', width: 48 },
    { header: 'Presentación', key: 'presentation', width: 16 },
    { header: 'Marca', key: 'brand', width: 24 },
    { header: 'Ubicación', key: 'location', width: 28 },
    { header: 'Mínimo de stock', key: 'minimum_stock', width: 20 },
    { header: 'Cantidad', key: 'quantity', width: 16 },
  ];
  // Strings stay literal, including P/N with leading zeros or text beginning with '='.
  sheet.addRows(products);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:G1';
  return workbook.xlsx.writeBuffer();
}
