import { findCustomerByTaxId, findUser, insertCustomer, replaceCustomerContacts, updateCustomer } from './database.mjs';
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

// Spanish is the only language for now; the field stays visible with a single option.
export const LANGUAGES = [['es', 'Español [Predeterminado]']];
export const DEFAULT_LANGUAGE = 'es';

// The form carries the principal contact plus two fixed extra slots, so at most three of each.
// The first field of each list is the mandatory principal contact.
export const EMAIL_FIELDS = ['email', 'emailExtra1', 'emailExtra2'];
export const PHONE_FIELDS = ['phone', 'phoneExtra1', 'phoneExtra2'];

export function customerName(customer) {
  return [customer?.name, customer?.last_name].filter(Boolean).join(' ');
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
    language: form.get('language') ?? DEFAULT_LANGUAGE,
    notes: (form.get('notes') ?? '').trim(),
    emails: slotValues(form, EMAIL_FIELDS),
    phones: slotValues(form, PHONE_FIELDS),
  };
  if (!customer.name || customer.name.length > MAX_NAME) return { error: `Escribe un nombre de cliente de hasta ${MAX_NAME} caracteres.`, customer };
  if (customer.lastName.length > MAX_NAME) return { error: `El apellido no puede superar los ${MAX_NAME} caracteres.`, customer };
  if (!customer.taxId || customer.taxId.length > MAX_TAX_ID) return { error: `Escribe un RIF / Cédula de hasta ${MAX_TAX_ID} caracteres.`, customer };
  if (customer.language !== DEFAULT_LANGUAGE) return { error: 'El idioma debe ser Español.', customer };
  const principalEmail = (form.get(EMAIL_FIELDS[0]) ?? '').trim();
  const principalPhone = (form.get(PHONE_FIELDS[0]) ?? '').trim();
  if (!principalEmail || principalEmail.length > MAX_EMAIL) return { error: 'Escribe el correo electrónico principal.', customer };
  if (!principalPhone || principalPhone.length > MAX_PHONE) return { error: 'Escribe el número de teléfono principal.', customer };
  if (customer.emails.some((email) => email.length > MAX_EMAIL)) return { error: `Cada correo puede tener hasta ${MAX_EMAIL} caracteres.`, customer };
  if (customer.phones.some((phone) => phone.length > MAX_PHONE)) return { error: `Cada teléfono puede tener hasta ${MAX_PHONE} caracteres.`, customer };
  if (customer.notes.length > MAX_NOTES) return { error: `Las notas no pueden superar los ${MAX_NOTES} caracteres.`, customer };
  return { customer };
}

function requireManager(database, userId) {
  const user = findUser(database, userId);
  if (!canManageInventory(user?.role)) {
    throw new CustomerError('No tienes permiso para realizar esta operación.', 403);
  }
}

// The customer, its emails and its phones commit together; a duplicate RIF/Cédula aborts the lot.
export function saveCustomer(database, userId, customer, existing = null) {
  database.exec('BEGIN IMMEDIATE');
  try {
    requireManager(database, userId);
    const clash = findCustomerByTaxId(database, customer.taxId);
    if (clash && clash.id !== (existing?.id ?? null)) throw new CustomerError('Ya existe un cliente con ese RIF / Cédula.', 409);
    const record = {
      name: customer.name,
      lastName: customer.lastName || null,
      language: customer.language,
      notes: customer.notes || null,
      taxId: customer.taxId,
    };
    const id = existing ? existing.id : Number(insertCustomer(database, record).lastInsertRowid);
    if (existing) updateCustomer(database, id, record);
    replaceCustomerContacts(database, id, customer.emails, customer.phones);
    database.exec('COMMIT');
    return id;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
