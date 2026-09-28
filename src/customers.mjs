import { findCustomerByTaxId, findUser, insertCustomer, replaceCustomerAddress, replaceCustomerContacts, updateCustomer } from './database.mjs';
import { canManageInventory } from './permissions.mjs';

export class CustomerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MAX_NAME = 120;
export const MAX_TAX_ID = 20;
export const MAX_EMAIL = 200;
export const MAX_PHONE = 30;
export const MAX_NOTES = 2000;
export const MAX_ADDRESS = 120;
export const MAX_POSTAL_CODE = 20;

// Venezuela is the only country for now; the field stays visible with a fixed value.
export const DEFAULT_COUNTRY = 'Venezuela';

// The 23 states plus the Capital District, used by the only free-text-free address field.
export const VENEZUELA_STATES = [
  'Amazonas', 'Anzoátegui', 'Apure', 'Aragua', 'Barinas', 'Bolívar', 'Carabobo', 'Cojedes',
  'Delta Amacuro', 'Distrito Capital', 'Falcón', 'Guárico', 'La Guaira', 'Lara', 'Mérida',
  'Miranda', 'Monagas', 'Nueva Esparta', 'Portuguesa', 'Sucre', 'Táchira', 'Trujillo',
  'Yaracuy', 'Zulia',
];

// Form field -> column for the plain text parts of the address. The country and state are handled
// apart because one is fixed and the other must come from VENEZUELA_STATES.
export const ADDRESS_FIELDS = [
  ['addressFirstName', 'first_name'],
  ['addressLastName', 'last_name'],
  ['addressCompany', 'company'],
  ['address1', 'address1'],
  ['address2', 'address2'],
  ['addressPostalCode', 'postal_code'],
  ['addressCity', 'city'],
];

// The form carries the principal contact plus two fixed extra slots, so at most three of each.
// The first field of each list is the mandatory principal contact.
export const EMAIL_FIELDS = ['email', 'emailExtra1', 'emailExtra2'];
export const PHONE_FIELDS = ['phone', 'phoneExtra1', 'phoneExtra2'];

export function customerName(customer) {
  return [customer?.name, customer?.last_name].filter(Boolean).join(' ');
}

// Ubicación for the list: Ciudad, Estado, País of the delivery address, empty without one.
export function customerLocation(customer) {
  return [customer?.address_city, customer?.address_state, customer?.address_country].filter(Boolean).join(', ');
}

// Instant search matches only the name (name and last name); never email, phone or RIF/Cédula.
export function filterCustomers(customers, params) {
  const query = (params.get('q') ?? '').trim().toLowerCase();
  if (!query) return customers;
  return customers.filter((customer) => customerName(customer).toLowerCase().includes(query));
}

export const CUSTOMERS_PER_PAGE = 50;

export function paginateCustomers(customers, params) {
  const total = customers.length;
  const pages = Math.max(1, Math.ceil(total / CUSTOMERS_PER_PAGE));
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;
  return { customers: customers.slice((page - 1) * CUSTOMERS_PER_PAGE, page * CUSTOMERS_PER_PAGE), pagination: { page, pageSize: CUSTOMERS_PER_PAGE, total, pages } };
}

function slotValues(form, fields) {
  return fields.map((field) => (form.get(field) ?? '').trim()).filter(Boolean);
}

// Required: name, RIF/Cédula, one email and one phone. The principal contact must be the first
// field itself, so an extra slot alone never satisfies it. Empty slots simply drop out.
export function validateCustomer(form) {
  const customer = {
    name: (form.get('name') ?? '').trim(),
    lastName: (form.get('lastName') ?? '').trim(),
    taxId: (form.get('taxId') ?? '').trim(),
    notes: (form.get('notes') ?? '').trim(),
    emails: slotValues(form, EMAIL_FIELDS),
    phones: slotValues(form, PHONE_FIELDS),
  };
  if (!customer.name || customer.name.length > MAX_NAME) return { error: `Escribe un nombre de cliente de hasta ${MAX_NAME} caracteres.`, customer };
  if (customer.lastName.length > MAX_NAME) return { error: `El apellido no puede superar los ${MAX_NAME} caracteres.`, customer };
  if (!customer.taxId || customer.taxId.length > MAX_TAX_ID) return { error: `Escribe un RIF / Cédula de hasta ${MAX_TAX_ID} caracteres.`, customer };
  const principalEmail = (form.get(EMAIL_FIELDS[0]) ?? '').trim();
  const principalPhone = (form.get(PHONE_FIELDS[0]) ?? '').trim();
  if (!principalEmail || principalEmail.length > MAX_EMAIL) return { error: 'Escribe el correo electrónico principal.', customer };
  if (!principalPhone || principalPhone.length > MAX_PHONE) return { error: 'Escribe el número de teléfono principal.', customer };
  if (customer.emails.some((email) => email.length > MAX_EMAIL)) return { error: `Cada correo puede tener hasta ${MAX_EMAIL} caracteres.`, customer };
  if (customer.phones.some((phone) => phone.length > MAX_PHONE)) return { error: `Cada teléfono puede tener hasta ${MAX_PHONE} caracteres.`, customer };
  if (customer.notes.length > MAX_NOTES) return { error: `Las notas no pueden superar los ${MAX_NOTES} caracteres.`, customer };
  return { customer };
}

// The address is optional and single. Empty means "no address"; any field filled in stores one,
// with the country forced to Venezuela and the state restricted to the fixed list.
export function validateAddress(form) {
  const address = { country: DEFAULT_COUNTRY, state: (form.get('addressState') ?? '').trim() };
  for (const [field, column] of ADDRESS_FIELDS) address[column] = (form.get(field) ?? '').trim();
  if (address.state && !VENEZUELA_STATES.includes(address.state)) return { error: 'Elige un estado de Venezuela.' };
  if (address.postal_code.length > MAX_POSTAL_CODE) return { error: `El código postal puede tener hasta ${MAX_POSTAL_CODE} caracteres.` };
  for (const [, column] of ADDRESS_FIELDS) {
    if (column === 'postal_code') continue;
    if (address[column].length > MAX_ADDRESS) return { error: `Cada dato de la dirección puede tener hasta ${MAX_ADDRESS} caracteres.` };
  }
  const present = Boolean(address.state) || ADDRESS_FIELDS.some(([, column]) => address[column]);
  return { address: present ? address : null };
}

// Reads the address back out of a submitted form, keeping cleared fields cleared (?? only keeps the
// previous value when the field is absent entirely, which is how a re-rendered form behaves).
export function addressFromForm(form, previous = {}) {
  const address = { ...previous, country: previous.country ?? DEFAULT_COUNTRY, state: form.get('addressState') ?? previous.state ?? '' };
  for (const [field, column] of ADDRESS_FIELDS) address[column] = form.get(field) ?? previous[column] ?? '';
  return address;
}

function requireManager(database, userId) {
  const user = findUser(database, userId);
  if (!canManageInventory(user?.role)) {
    throw new CustomerError('No tienes permiso para realizar esta operación.', 403);
  }
}

// The write itself, without opening a transaction, so bulk imports can commit many rows as one.
export function writeCustomer(database, userId, customer, address = null, existing = null) {
  requireManager(database, userId);
  const clash = findCustomerByTaxId(database, customer.taxId);
  if (clash && clash.id !== (existing?.id ?? null)) throw new CustomerError('Ya existe un cliente con ese RIF / Cédula.', 409);
  const record = {
    name: customer.name,
    lastName: customer.lastName || null,
    language: 'es',
    notes: customer.notes || null,
    taxId: customer.taxId,
  };
  const id = existing ? existing.id : Number(insertCustomer(database, record).lastInsertRowid);
  if (existing) updateCustomer(database, id, record);
  replaceCustomerContacts(database, id, customer.emails, customer.phones);
  replaceCustomerAddress(database, id, address);
  return id;
}

// The customer, its contacts and its address commit together; a duplicate RIF/Cédula aborts the lot.
export function saveCustomer(database, userId, customer, address = null, existing = null) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const id = writeCustomer(database, userId, customer, address, existing);
    database.exec('COMMIT');
    return id;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
