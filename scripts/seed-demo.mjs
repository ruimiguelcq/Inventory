import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOrCreateNamed, openDatabase } from '../src/database.mjs';

const scrypt = promisify(scryptCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const database = openDatabase(join(root, 'data', 'inventory.sqlite'));

async function hashPassword(password) {
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, passwordSalt, 64)).toString('hex');
  return { passwordSalt, passwordHash };
}

// part_number, description, presentation, brand, location, minimum_stock, category, type, supplier, price$, cost$, quantity, archived, long_description
const products = [
  ['402500-00011', 'Camisa de cilindro', 'SET', 'Yanmar', 'A-01', 4, 'Motor base y componentes internos', 'Liner y pistón', 'Marine Parts C.A.', 245, 150, 30, 0, 'Camisa húmeda para motores Yanmar de la serie 4LHA. Incluye anillos de sellado.'],
  ['7123-02410', 'Pistón completo', 'unidad', 'Yanmar', 'A-02', 3, 'Motor base y componentes internos', 'Liner y pistón', 'Marine Parts C.A.', 610, 400, 2, 0, 'Pistón con pasador y anillos. Requiere verificación de tolerancia antes de montar.'],
  ['15421-23010', 'Biela', 'unidad', 'Yanmar', 'A-03', 2, 'Motor base y componentes internos', 'Liner y pistón', 'Marine Parts C.A.', 780, 520, 6, 0, null],
  ['119175-18100', 'Turbocargador', 'unidad', 'IHI', 'B-01', 1, 'Admisión, escape y sobrealimentación', 'Turbocargador', 'TurboMarine Import', 2450, 1700, 1, 0, 'Turbocargador de intercambio. Núcleo devuelto obligatorio.'],
  ['129670-18010', 'Codo de escape', 'unidad', 'Yanmar', 'B-02', 2, 'Admisión, escape y sobrealimentación', null, 'TurboMarine Import', 320, 210, 5, 0, null],
  ['13261-16500', 'Bomba de agua', 'unidad', 'Yanmar', 'C-01', 2, 'Enfriamiento y agua de mar', 'Bomba de agua', 'Repuestos del Caribe', 495, 330, 4, 0, 'Bomba de agua de mar. Sello y rodamiento nuevos.'],
  ['119574-44200', 'Termostato', 'unidad', 'Yanmar', 'C-02', 5, 'Enfriamiento y agua de mar', null, 'Repuestos del Caribe', 65, 40, 12, 0, null],
  ['129574-49700', 'Impulsor de bomba', 'SET', null, 'C-03', 6, 'Enfriamiento y agua de mar', 'Impulsor', 'Repuestos del Caribe', 48, 28, 3, 0, null],
  ['119770-35300', 'Filtro de aceite', 'unidad', 'Yanmar', 'D-01', 10, 'Lubricación', 'Filtro', 'Global Diesel Supply', 22, 12, 40, 0, null],
  ['129150-34900', 'Enfriador de aceite', 'unidad', null, 'D-02', 1, 'Lubricación', null, 'Global Diesel Supply', 540, 360, 2, 0, null],
  ['119321-53900', 'Inyector', 'unidad', 'Denso', 'E-01', 6, 'Combustible e inyección', 'Inyector', 'Global Diesel Supply', 380, 250, 8, 0, 'Inyector reconstruido y calibrado.'],
  ['129100-53010', 'Bomba de inyección', 'unidad', 'Zexel', 'E-02', 1, 'Combustible e inyección', 'Inyector', 'Global Diesel Supply', 1560, 1100, 0, 0, 'Sin existencias: pedido en curso con el proveedor.'],
  ['119810-55600', 'Filtro de combustible', 'unidad', 'Yanmar', 'E-03', 12, 'Combustible e inyección', 'Filtro', 'Global Diesel Supply', 18, 9, 25, 0, null],
  ['128271-77200', 'Alternador 12V', 'unidad', 'Kubota', 'F-01', 2, 'Eléctrico, arranque y control', null, 'Repuestos del Caribe', 420, 280, 3, 0, null],
  ['119626-77100', 'Motor de arranque', 'unidad', 'Hitachi', 'F-02', 1, 'Eléctrico, arranque y control', null, 'Repuestos del Caribe', 890, 610, 1, 0, null],
  ['120110-02140', 'Empaquetadura de culata', 'SET', null, 'G-01', 4, 'Montaje y accesorios', 'Empaquetadura', 'Marine Parts C.A.', 135, 85, 10, 0, null],
  ['26106-10030', 'Sensor de presión de aceite', 'unidad', null, 'G-02', 6, 'Montaje y accesorios', 'Sensor', 'Repuestos del Caribe', 90, 55, 2, 0, null],
  ['104200-01330', 'Kit de montaje inferior', 'KIT', null, 'G-03', 1, 'Montaje y accesorios', 'Empaquetadura', 'Marine Parts C.A.', 260, 175, 1, 1, 'Kit archivado: sustituido por la referencia 104200-01340.'],
];

// [part_number, operation, quantity, previous, next, reason, days_ago, source]
const movements = [
  ['402500-00011', 'set', 24, 0, 24, 'Alta inicial de inventario', 12, 'creation'],
  ['402500-00011', 'adjust', 6, 24, 30, 'Compra a proveedor', 3, 'manual'],
  ['7123-02410', 'set', 2, 0, 2, 'Alta inicial de inventario', 12, 'creation'],
  ['15421-23010', 'set', 6, 0, 6, 'Alta inicial de inventario', 12, 'creation'],
  ['119175-18100', 'set', 1, 0, 1, 'Alta inicial de inventario', 10, 'creation'],
  ['13261-16500', 'set', 5, 0, 5, 'Alta inicial de inventario', 11, 'creation'],
  ['13261-16500', 'adjust', -1, 5, 4, 'Venta a taller', 2, 'manual'],
  ['119770-35300', 'set', 40, 0, 40, 'Importación Excel', 9, 'import'],
  ['119321-53900', 'set', 10, 0, 10, 'Alta inicial de inventario', 8, 'creation'],
  ['119321-53900', 'adjust', -2, 10, 8, 'Venta a taller', 1, 'manual'],
  ['129100-53010', 'set', 1, 0, 1, 'Alta inicial de inventario', 8, 'creation'],
  ['129100-53010', 'adjust', -1, 1, 0, 'Pieza montada en motor', 4, 'manual'],
  ['129574-49700', 'set', 3, 0, 3, 'Alta inicial de inventario', 11, 'creation'],
  ['26106-10030', 'set', 5, 0, 5, 'Alta inicial de inventario', 7, 'creation'],
  ['26106-10030', 'adjust', -3, 5, 2, 'Venta a taller', 1, 'manual'],
  ['104200-01330', 'set', 1, 0, 1, 'Alta inicial de inventario', 6, 'creation'],
];

// [name, last_name, tax_id, notes, [emails], [phones], address|null]
const customers = [
  ['Carlos', 'Mendoza', 'V-12345678', 'Cliente frecuente. Prefiere contacto por WhatsApp.', ['carlos.mendoza@example.com', 'compras@tallermendoza.com'], ['+58 412-555-0101', '+58 414-555-0202'], { country: 'Venezuela', first_name: 'Carlos', last_name: 'Mendoza', company: 'Taller Mendoza', address1: 'Av. Principal, galpón 4', address2: 'Zona Industrial Los Pinos', postal_code: '6023', city: 'Puerto La Cruz', state: 'Anzoátegui' }],
  ['María', 'González', 'V-9876543', null, ['maria.gonzalez@example.com'], ['+58 416-555-0303'], { country: 'Venezuela', first_name: 'María', last_name: 'González', company: null, address1: 'Calle Bolívar, casa 12', address2: null, postal_code: '5101', city: 'Porlamar', state: 'Nueva Esparta' }],
  ['Taller Marino del Caribe', 'C.A.', 'J-30123456-7', 'Cuenta corporativa. Facturar a nombre de la empresa.', ['admin@marinodelcaribe.com', 'pagos@marinodelcaribe.com'], ['+58 212-555-0404', '+58 424-555-0505'], { country: 'Venezuela', first_name: 'José', last_name: 'Ramírez', company: 'Taller Marino del Caribe, C.A.', address1: 'Calle 5, edificio Marina', address2: 'Piso 3, oficina 3B', postal_code: '1010', city: 'Caracas', state: 'Distrito Capital' }],
  ['Luis', 'Rivas', 'V-19123456', 'Aún sin dirección de entrega.', ['luis.rivas@example.com'], ['+58 426-555-0606', '+58 412-555-0707'], null],
  ['Ana', 'Pérez', 'V-14234567', null, ['ana.perez@example.com'], ['+58 414-555-0808'], { country: 'Venezuela', first_name: 'Ana', last_name: 'Pérez', company: null, address1: 'Av. Bella Vista, torre Norte', address2: 'Apto 12-A', postal_code: '4001', city: 'Maracaibo', state: 'Zulia' }],
  ['Pedro', 'Salazar', 'E-84123456', 'Cliente extranjero, factura en dólares.', ['pedro.salazar@example.com'], ['+58 424-555-0909'], null],
];

// [status, [[part_number, quantity|null], ...], days_ago]
const orders = [
  ['draft', [['402500-00011', 8], ['119321-53900', 6], ['119770-35300', 20], ['129574-49700', 10]], 2],
  ['draft', [['129100-53010', 1], ['119175-18100', 2], ['26106-10030', null]], 1],
  ['archived', [['13261-16500', 4], ['119810-55600', 24]], 5],
];

function iso(daysAgo, hour = 9) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

const administrator = database.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
if (!administrator) throw new Error('No hay una cuenta administradora; crea el acceso inicial en la aplicación y vuelve a ejecutar el ejemplo.');

const demoUsers = [
  ['gestor', 'demo-gestion-2026', 'manager'],
  ['consulta', 'demo-consulta-2026', 'viewer'],
];

database.exec('BEGIN IMMEDIATE');
try {
  database.exec(`
    DELETE FROM stock_movements;
    DELETE FROM purchase_order_lines;
    DELETE FROM purchase_orders;
    DELETE FROM customer_emails;
    DELETE FROM customer_phones;
    DELETE FROM customer_addresses;
    DELETE FROM customers;
    DELETE FROM products;
    DELETE FROM users WHERE username IN ('gestor', 'consulta');
  `);

  const insertProduct = database.prepare(`
    INSERT INTO products (part_number, description, presentation, brand, location, minimum_stock, archived,
      quantity, category_id, long_description, price_cents, cost_cents, product_type_id, supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const productIds = new Map();
  for (const [partNumber, description, presentation, brand, location, minimum, category, type, supplier, price, cost, quantity, archived, longDescription] of products) {
    insertProduct.run(
      partNumber, description, presentation, brand, location, minimum, archived,
      quantity, findOrCreateNamed(database, 'categories', category), longDescription,
      Math.round(price * 100), Math.round(cost * 100),
      type ? findOrCreateNamed(database, 'product_types', type) : null,
      supplier ? findOrCreateNamed(database, 'suppliers', supplier) : null,
    );
    productIds.set(partNumber, database.prepare('SELECT id FROM products WHERE part_number = ?').get(partNumber).id);
  }

  const insertMovement = database.prepare(`
    INSERT INTO stock_movements (product_id, user_id, operation, quantity, previous_quantity, new_quantity, presentation, reason, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [partNumber, operation, quantity, previous, next, reason, daysAgo, source] of movements) {
    const product = database.prepare('SELECT id, presentation FROM products WHERE part_number = ?').get(partNumber);
    insertMovement.run(product.id, administrator.id, operation, quantity, previous, next, product.presentation, reason, iso(daysAgo), source);
  }

  const insertOrder = database.prepare('INSERT INTO purchase_orders (status, created_at, updated_at) VALUES (?, ?, ?)');
  const insertLine = database.prepare('INSERT INTO purchase_order_lines (purchase_order_id, product_id, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (const [status, lines, daysAgo] of orders) {
    const orderId = insertOrder.run(status, iso(daysAgo), iso(daysAgo)).lastInsertRowid;
    for (const [partNumber, quantity] of lines) {
      insertLine.run(orderId, productIds.get(partNumber), quantity, iso(daysAgo), iso(daysAgo));
    }
  }

  const insertCustomer = database.prepare('INSERT INTO customers (name, last_name, language, notes, tax_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertEmail = database.prepare('INSERT INTO customer_emails (customer_id, email, position) VALUES (?, ?, ?)');
  const insertPhone = database.prepare('INSERT INTO customer_phones (customer_id, phone, position) VALUES (?, ?, ?)');
  const insertAddress = database.prepare(`
    INSERT INTO customer_addresses (customer_id, country, first_name, last_name, company, address1, address2, postal_code, city, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  customers.forEach(([name, lastName, taxId, notes, emails, phones, address], index) => {
    const daysAgo = 14 - index;
    const customerId = insertCustomer.run(name, lastName, 'es', notes, taxId, iso(daysAgo), iso(daysAgo)).lastInsertRowid;
    emails.forEach((email, position) => insertEmail.run(customerId, email, position));
    phones.forEach((phone, position) => insertPhone.run(customerId, phone, position));
    if (address) {
      insertAddress.run(customerId, address.country, address.first_name, address.last_name, address.company, address.address1, address.address2, address.postal_code, address.city, address.state);
    }
  });

  const insertUser = database.prepare('INSERT INTO users (username, password_salt, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const [username, password, role] of demoUsers) {
    const { passwordSalt, passwordHash } = await hashPassword(password);
    insertUser.run(username, passwordSalt, passwordHash, role);
  }

  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

const counts = (table) => database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
console.log('Ejemplos creados en todas las vistas:');
console.log(`  Productos:       ${counts('products')} (${database.prepare('SELECT COUNT(*) AS total FROM products WHERE archived = 1').get().total} archivados)`);
console.log(`  Movimientos:     ${counts('stock_movements')}`);
console.log(`  Listas de compra:${counts('purchase_orders')}`);
console.log(`  Clientes:        ${counts('customers')}`);
console.log(`  Cuentas:         ${counts('users')} (admin + gestor + consulta)`);
console.log('Accesos de ejemplo: gestor / demo-gestion-2026 · consulta / demo-consulta-2026');
database.close();
