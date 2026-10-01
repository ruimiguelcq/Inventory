import { assignableRoles, canManageInventory } from './permissions.mjs';
import { MAX_LONG_DESCRIPTION, PRESENTATIONS as presentationValues, formatCents, inventoryLevel, presentationLabel, stockStatus } from './products.mjs';
import { DEFAULT_COUNTRY, MAX_ADDRESS, MAX_EMAIL, MAX_NAME, MAX_NOTES, MAX_PHONE, MAX_POSTAL_CODE, MAX_TAX_ID, VENEZUELA_STATES, customerLocation, customerName } from './customers.mjs';
import { MAX_NOTES as MAX_ORDER_NOTES, MAX_COMMENT as MAX_ORDER_COMMENT, orderLifecycle, orderTotals, parseDiscount } from './orders.mjs';

const PRESENTATIONS = presentationValues.map((value) => [value, presentationLabel(value)]);

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

// Signed dollars for the margin: -$2.00 rather than $-2.00.
function formatMargin(cents) {
  return cents < 0 ? `-$${formatCents(-cents)}` : `$${formatCents(cents)}`;
}

// Shared stock marker: zero wins as agotado, then a positive quantity at or below the minimum.
function stockBadge(status) {
  return status === 'agotado' ? '<span class="badge badge-out">Agotado</span>'
    : status === 'stockbajo' ? '<span class="badge badge-low">Stock bajo</span>' : '';
}

// A product with no image renders nothing, so the row never shows a broken placeholder.
function productThumb(product) {
  return product.image_filename
    ? `<img class="product-thumb" src="/products/${product.id}/image" alt="" loading="lazy" width="34" height="34">`
    : '';
}

// Shopify-style sidebar. Icons are decorative (aria-hidden), so each link keeps the label text as
// its accessible name; nested items are indented and carry no icon.
const SIDEBAR_ICONS = {
  products: 'M3.8 6.4 10 3l6.2 3.4v7.2L10 17l-6.2-3.4z M3.8 6.4 10 9.8l6.2-3.4 M10 9.8V17',
  orders: 'M6 3.3h8v13.4l-2-1.3-2 1.3-2-1.3-2 1.3z M8 7h4 M8 10h4',
  customers: 'M10 9.6a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4z M4.9 16.6c0-2.6 2.3-4.4 5.1-4.4s5.1 1.8 5.1 4.4',
  users: 'M10 3.3 16 5.4v4.1c0 3.6-2.5 5.7-6 7.1-3.5-1.4-6-3.5-6-7.1V5.4z M7.6 9.9l1.7 1.7 3.2-3.3',
  backups: 'M10 3.3c3.3 0 6 1.1 6 2.5S13.3 8.3 10 8.3 4 7.2 4 5.8 6.7 3.3 10 3.3z M4 5.8v8.4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5.8 M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5',
};

// The sidebar keeps Productos and Pedidos as collapsible groups; each group header is itself a
// link to its section and its children sit in an expandable list.
const SIDEBAR_MAIN = [
  { key: 'products', href: '/products', label: 'Productos', icon: 'products', children: [
    { key: 'inventory', href: '/inventory', label: 'Inventario' },
    { key: 'purchases', href: '/purchase-orders', label: 'Órdenes de compra' },
  ] },
  { key: 'orders', href: '/orders', label: 'Pedidos', icon: 'orders', children: [
    { key: 'drafts', href: '/drafts', label: 'Borradores' },
  ] },
  { key: 'customers', href: '/customers', label: 'Clientes', icon: 'customers' },
];

const SIDEBAR_ADMIN = [
  { key: 'users', href: '/users', label: 'Cuentas y permisos', icon: 'users' },
  { key: 'backups', href: '/backups', label: 'Copias de seguridad', icon: 'backups' },
];

function sidebarIcon(name) {
  return `<span class="sidebar-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="${SIDEBAR_ICONS[name]}"/></svg></span>`;
}

function sidebarLink({ key, href, label, icon = null }, active, { child = false } = {}) {
  const isActive = active === key;
  return `<a class="sidebar-link${child ? ' sidebar-child' : ''}${isActive ? ' is-active' : ''}" href="${href}"${isActive ? ' aria-current="page"' : ''}>${icon ? sidebarIcon(icon) : ''}<span class="sidebar-label">${label}</span></a>`;
}

// A group renders its header link plus a toggle and an expandable list of children. Without
// JavaScript the list stays open, so every destination remains reachable.
function sidebarGroup(entry, active) {
  const { key, children = [] } = entry;
  const id = `sidebar-children-${key}`;
  const childLinks = children.map((child) => sidebarLink(child, active, { child: true })).join('');
  return `<div class="sidebar-group" data-sidebar-group>
    <div class="sidebar-row">${sidebarLink(entry, active)}
      <button type="button" class="sidebar-toggle" data-sidebar-toggle aria-expanded="true" aria-controls="${id}" aria-label="Contraer ${escapeHtml(entry.label)}"><span aria-hidden="true">▾</span></button>
    </div>
    <div class="sidebar-children" id="${id}" data-sidebar-children>${childLinks}</div>
  </div>`;
}

function page(title, content, { active = 'inventory', username, role, csrfToken, message } = {}) {
  const navigation = username ? `
    <header class="topbar">
      <a class="brand" href="/products" aria-label="Taller Marino, productos">
        <span class="brand-mark" aria-hidden="true">T</span>
        <span>Taller Marino</span>
      </a>
      <div class="account-area">
        <span class="account-name">${escapeHtml(username)}</span>
        <form method="post" action="/logout">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
          <button class="button button-quiet" type="submit">Cerrar sesión</button>
        </form>
      </div>
    </header>
    <aside class="sidebar"><nav class="sidebar-nav" aria-label="Navegación principal">
      ${SIDEBAR_MAIN.map((entry) => (entry.children ? sidebarGroup(entry, active) : sidebarLink(entry, active))).join('')}
      ${role === 'admin' ? `<div class="sidebar-footer">
      <p class="sidebar-section-title">Configuración</p>
      ${SIDEBAR_ADMIN.map((entry) => sidebarLink(entry, active)).join('')}
      </div>` : ''}
    </nav></aside>` : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)} · Taller Marino</title>
    <link rel="stylesheet" href="/assets/style.css">
    <script src="/assets/catalog.js" defer></script>
  </head>
  <body class="${username ? 'authenticated' : 'public-page'}">
    ${navigation}
    <main class="page-shell">
      ${message ? `<p class="notice" role="status">${escapeHtml(message)}</p>` : ''}
      ${content}
    </main>
  </body>
</html>`;
}

export function setupPage({ error = '', setupToken = '' } = {}) {
  return page('Configurar acceso', `
    <section class="auth-layout">
      <div class="auth-intro">
        <p class="eyebrow">Inventario privado</p>
        <h1>Prepara el acceso del equipo</h1>
        <p>Este primer acceso será la cuenta administradora del inventario. Guarda la contraseña en un lugar seguro.</p>
      </div>
      <form class="auth-panel" method="post" action="/setup">
        <h2>Configura el acceso inicial</h2>
        <p class="form-hint">Elige un nombre de usuario y una contraseña de al menos 12 caracteres.</p>
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <input type="hidden" name="setupToken" value="${escapeHtml(setupToken)}">
        <label for="username">Usuario</label>
        <input id="username" name="username" autocomplete="username" minlength="3" maxlength="50" required>
        <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
        <button class="button button-primary button-wide" type="submit">Crear acceso</button>
      </form>
    </section>`);
}

export function loginPage({ error = '' } = {}) {
  return page('Iniciar sesión', `
    <section class="auth-layout">
      <div class="auth-intro">
        <p class="eyebrow">Inventario privado</p>
        <h1>Repuestos a la vista. Stock bajo control.</h1>
        <p>Accede al inventario interno del almacén.</p>
      </div>
      <form class="auth-panel" method="post" action="/login">
        <h2>Iniciar sesión</h2>
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <label for="username">Usuario</label>
        <input id="username" name="username" autocomplete="username" required>
        <label for="password">Contraseña</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="button button-primary button-wide" type="submit">Entrar al inventario</button>
      </form>
    </section>`);
}

export function inventoryPage(options) {
  return catalogPage({ ...options, inventory: true });
}

export function productsPage(options) {
  return catalogPage(options);
}

function catalogPage({ products, filters = {}, pagination, queryParams = new URLSearchParams(), inventory = false, ...session }) {
  const canManage = canManageInventory(session.role);
  const archivedView = !inventory && (filters.state === 'archived' || (!filters.state && Boolean(filters.archived)));
  const route = inventory ? '/inventory' : '/products';
  const title = inventory ? 'Inventario' : 'Productos';
  const view = inventory ? 'inventory' : 'products';
  const importHref = `/imports?view=${view}`;
  const hasActiveFilter = Boolean(filters.q);
  const csrfToken = session.csrfToken;
  // The "all" export carries the current search and state, so it covers every matching page.
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete('page');
  exportParams.delete('pageSize');
  exportParams.set('view', view);
  exportParams.set('scope', 'all');
  const exportHref = `/exports?${exportParams.toString()}`;

  // Inventory edits the read-only-to-viewers Disponible number in place; Products keeps its
  // read-only stock cell coloured by the product minimum.
  const stockCell = (product) => {
    const level = `quantity-cell inventory-${inventoryLevel(product)}`;
    if (!canManage) return `<td class="${level}">${product.quantity}</td>`;
    return `<td class="${level}" data-stock-cell>
        <a class="stock-value" href="/products/${product.id}/stock" data-stock-open aria-label="Ajustar inventario de ${escapeHtml(product.part_number)}">${product.quantity}</a>
        <form class="stock-editor" method="post" action="/products/${product.id}/stock/apply" data-stock-form hidden>
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="q" value="${escapeHtml(filters.q ?? '')}">
          <select name="operation" aria-label="Operación">
            <option value="set">Fijar en</option>
            <option value="adjust">Ajustar</option>
          </select>
          <input type="number" name="quantity" step="1" inputmode="numeric" value="${product.quantity}" data-current="${product.quantity}" aria-label="Cantidad de ${escapeHtml(product.part_number)}">
          <input type="text" name="reason" maxlength="500" placeholder="Motivo (opcional)" aria-label="Motivo">
          <button class="button button-primary" type="submit">Guardar</button>
          <button class="button button-quiet" type="button" data-stock-cancel>Cancelar</button>
        </form>
      </td>`;
  };

  const rows = products.map((product) => {
    if (inventory) {
      return `<tr>
      <td class="align-left"><span class="product-cell">${productThumb(product)}<a class="product-description" href="/products/${product.id}">${escapeHtml(product.description)}</a></span></td>
      <td class="part-number">${escapeHtml(product.part_number)}</td>
      ${stockCell(product)}
      <td><a href="/products/${product.id}/history">Historial</a></td>
    </tr>`;
    }
    return `<tr>
      <td class="align-left"><span class="product-cell">${productThumb(product)}<a class="product-description" href="/products/${product.id}">${escapeHtml(product.description)}</a></span></td>
      <td class="part-number align-left">${escapeHtml(product.part_number)}</td>
      <td><span class="status-tag">${product.archived ? 'Archivado' : 'Activo'}</span></td>
      <td class="quantity-cell inventory-${inventoryLevel(product)}">${product.quantity} existencias</td>
      <td class="muted">${escapeHtml(product.category_name ?? 'Sin categoría')}</td>
      <td>${escapeHtml(product.product_type_name ?? '—')}</td>
      <td>${escapeHtml(product.supplier_name ?? '—')}</td>
    </tr>`;
  }).join('');

  const header = inventory
    ? `<thead><tr>
      <th scope="col" class="align-left">Producto</th>
      <th scope="col">P/N</th>
      <th scope="col" class="align-right">Disponible</th>
      <th scope="col">Historial</th>
    </tr></thead>`
    : `<thead><tr>
      <th scope="col" class="align-left">Producto</th>
      <th scope="col" class="align-left">P/N</th>
      <th scope="col">Estado</th>
      <th scope="col" class="align-right">Inventario</th>
      <th scope="col">Categoría</th>
      <th scope="col">Tipo de producto</th>
      <th scope="col">Proveedor</th>
    </tr></thead>`;

  const emptyState = hasActiveFilter
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3>
      <p>Ningún repuesto coincide con la búsqueda.</p>
      <a class="button button-secondary" href="${route}">Limpiar búsqueda</a></div>`
    : archivedView
      ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
        <h3>No hay repuestos archivados</h3>
        <p>Al archivar un repuesto, se retira del inventario activo sin borrar su historial.</p></div>`
      : `<div class="empty-state">
          <span class="empty-icon" aria-hidden="true">⌁</span>
          <h3>Tu inventario está listo para empezar</h3>
          ${canManage ? `<p>Añade el primer repuesto con su P/N y presentación.</p>
          <a class="button button-secondary" href="/products/new">Añadir primer repuesto</a>` : '<p>Todavía no hay repuestos registrados.</p>'}
        </div>`;

  // Both catalog views search while typing (progressive enhancement, normal submit as fallback).
  // Inventory has no extra filters; Products adds its state selector; both page at a fixed 50.
  const catalogToolbar = (extra = '') => `
    <form class="catalog-toolbar" method="get" action="${route}" data-instant-search>
      <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por P/N o nombre" aria-label="Buscar por P/N o nombre">
      ${extra}
      <button class="visually-hidden" type="submit">Buscar</button>
    </form>`;
  const stateSelector = `<select name="state" aria-label="Estado">
        <option value="active" ${filters.state === 'active' || !filters.state ? 'selected' : ''}>Activos</option>
        <option value="archived" ${filters.state === 'archived' ? 'selected' : ''}>Archivados</option>
        <option value="all" ${filters.state === 'all' ? 'selected' : ''}>Todos</option>
      </select>`;
  const inventoryToolbar = catalogToolbar();
  const productsToolbar = catalogToolbar(stateSelector);

  const headerActions = inventory
    ? `${canManage ? `<a class="button button-secondary" href="${importHref}">Importar</a>` : ''}
      <a class="button button-secondary" href="${escapeHtml(exportHref)}">Exportar</a>`
    : `${canManage ? `<a class="button button-secondary" href="${importHref}">Importar</a>` : ''}
      <a class="button button-secondary" href="${escapeHtml(exportHref)}">Exportar</a>
      ${canManage ? '<a class="button button-primary" href="/products/new">Agregar producto</a>' : ''}`;

  const pageLink = (number, label) => {
    const params = new URLSearchParams(queryParams);
    params.set('page', number);
    return `<a class="button button-secondary" href="${route}?${escapeHtml(params.toString())}">${label}</a>`;
  };
  const pager = pagination ? `<nav class="pagination" aria-label="Paginación">
    <span>${pagination.total} artículos · Página ${pagination.page} de ${pagination.pages}</span>
    <div>${pagination.page > 1 ? pageLink(pagination.page - 1, 'Anterior') : ''}
      ${pagination.page < pagination.pages ? pageLink(pagination.page + 1, 'Siguiente') : ''}</div>
  </nav>` : '';

  const content = `
    <div class="page-heading">
      <div>
        <h1>${title}</h1>
      </div>
      <div class="form-actions">${headerActions}</div>
    </div>
    <section class="inventory-panel" aria-label="Lista de repuestos">
      ${inventory ? inventoryToolbar : productsToolbar}
      ${archivedView ? '' : '<p class="export-hint">Para volver a importar: máximo 1000 filas y 2 MB por archivo. Divide exportaciones mayores en lotes conservando los encabezados.</p>'}
      <div data-catalog-results>
        ${products.length ? `
          <div class="table-scroll">
            <table>${header}<tbody>${rows}</tbody></table>
          </div>` : emptyState}
        ${pager}
      </div>
    </section>`;
  return page(title, content, { ...session, active: inventory ? 'inventory' : 'products' });
}

function formatTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  return /Z$/i.test(text) ? formatUtc(text) : `${text.replace('T', ' ')} UTC`;
}

function timestampAttribute(value) {
  return String(value ?? '').replace(' ', 'T');
}

export function purchaseOrdersPage({ orders = [], error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const createForm = `<form method="post" action="/purchase-orders">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <button class="button button-primary" type="submit">Nueva lista de compra</button>
    </form>`;
  const rows = orders.map((order) => {
    const exportable = order.line_count > 0 && order.ready_count === order.line_count;
    return `<tr>
    <td class="part-number"><a href="/purchase-orders/${order.id}">Compra #${order.id}</a></td>
    <td><time datetime="${escapeHtml(timestampAttribute(order.created_at))}">${escapeHtml(formatTimestamp(order.created_at))}</time></td>
    <td><span class="status-tag">${order.status === 'archived' ? 'Archivada' : 'Borrador'}</span></td>
    <td class="quantity-cell" title="${order.ready_count} con cantidad de ${order.line_count} artículos">${order.ready_count}/${order.line_count}</td>
    <td><a href="/purchase-orders/${order.id}">${canManage && order.status === 'draft' ? 'Editar' : 'Ver'}</a>${exportable ? ` · <a href="/purchase-orders/${order.id}/export">Exportar</a>` : ''}</td>
  </tr>`;
  }).join('');

  const content = `
    <div class="page-heading">
      <div><p class="eyebrow">Compras</p><h1>Órdenes de compra</h1>
        <p class="page-subtitle">Prepara los repuestos a pedir. Guardar un borrador no cambia el inventario ni crea movimientos.</p></div>
      ${canManage ? createForm : ''}
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <section class="inventory-panel" aria-label="Listas de compra">
      ${orders.length ? `<div class="table-scroll"><table><thead><tr>
        <th scope="col">Número</th><th scope="col">Fecha (UTC)</th><th scope="col">Estado</th>
        <th scope="col" class="align-right">Artículos</th><th scope="col"><span class="visually-hidden">Acciones</span></th>
      </tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state">
        <span class="empty-icon" aria-hidden="true">⌁</span>
        <h3>Todavía no hay listas de compra</h3>
        <p>${canManage ? 'Crea una lista y añade los repuestos que necesitas pedir.' : 'Cuando Gestión cree una lista, aparecerá aquí.'}</p>
      </div>`}
    </section>`;
  return page('Órdenes de compra', content, { ...session, active: 'purchases' });
}

export function purchaseOrderPage({ order, lines = [], products = [], values = {}, error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  // Archived lists stay readable and exportable, but only drafts can be edited until reopened.
  const editable = canManage && order.status === 'draft';
  const inList = new Set(lines.map((line) => line.id));
  const available = products.filter((product) => !inList.has(product.id));
  const options = available.map((product) => {
    const status = stockStatus(product);
    const note = status === 'agotado' ? ' · Agotado' : status === 'stockbajo' ? ' · Stock bajo' : '';
    return `<option value="${product.id}">${escapeHtml(product.part_number)} — ${escapeHtml(product.description)} · ${product.quantity}${note}</option>`;
  }).join('');
  const rows = lines.map((line) => {
    const submitted = values[`line-${line.line_id}`];
    const quantity = submitted === undefined ? (line.requested_quantity ?? '') : submitted;
    const status = stockStatus(line);
    const badge = status ? ` ${stockBadge(status)}` : '';
    return `<tr>
      <td class="part-number">${escapeHtml(line.part_number)}</td>
      <td><span class="product-cell">${productThumb(line)}<a class="product-description" href="/products/${line.id}">${escapeHtml(line.description)}</a>
        ${line.archived ? '<span class="status-tag">Archivado</span>' : ''}</span></td>
      <td class="quantity-cell">${line.quantity}${badge}</td>
      ${editable ? `<td><input class="line-quantity" type="number" min="1" step="1" inputmode="numeric"
          name="line-${line.line_id}" value="${escapeHtml(quantity)}" aria-label="Cantidad solicitada de ${escapeHtml(line.part_number)}"></td>
        <td class="row-action"><button class="text-link" type="submit" formaction="/purchase-orders/${order.id}/lines/${line.line_id}/remove">Retirar</button></td>`
        : `<td class="quantity-cell">${quantity === '' ? '<span class="muted">—</span>' : quantity}</td>`}
    </tr>`;
  }).join('');

  const table = lines.length ? `<div class="table-scroll"><table><thead><tr>
      <th scope="col">P/N</th><th scope="col">Nombre</th><th scope="col" class="align-right">Inventario</th>
      <th scope="col" class="align-right">Cantidad solicitada</th>${editable ? '<th scope="col"><span class="visually-hidden">Acciones</span></th>' : ''}
    </tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty-state"><p>Todavía no hay artículos en esta lista.</p></div>`;

  const addSection = editable ? `<section class="form-section">
      <h2>Añadir artículo</h2>
      <p class="form-hint">Se ofrecen solo artículos activos; los agotados y con stock bajo aparecen primero.</p>
      ${available.length ? `<div class="form-grid"><div class="field field-wide">
          <label for="productId">Artículo activo</label>
          <select id="productId" name="productId">
            <option value="">Selecciona un artículo</option>
            ${options}
          </select>
        </div></div>
        <div class="form-actions"><button class="button button-secondary" type="submit" formaction="/purchase-orders/${order.id}/lines">Añadir artículo</button></div>`
        : '<p class="form-hint">Todos los artículos activos ya están en esta lista.</p>'}
    </section>` : '';

  const detail = editable ? `<form class="product-form" method="post" action="/purchase-orders/${order.id}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="form-section"><h2>Artículos de la lista</h2>
        <p class="form-hint">Deja una cantidad vacía para guardar el borrador incompleto. Las cantidades escritas deben ser enteros mayores que cero. La lista se exporta cuando todas las cantidades estén completas.</p>
        ${table}
      </section>
      ${addSection}
      <div class="form-actions"><a class="button button-quiet" href="/purchase-orders">Volver</a>
        <button class="button button-primary" type="submit">Guardar borrador</button></div>
    </form>`
    : `<section class="inventory-panel" aria-label="Artículos de la lista">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      ${canManage ? '<p class="form-hint">La lista está archivada. Reábrela para editar cantidades o retirar artículos.</p>' : ''}
      ${table}
    </section>`;

  const actions = `<div class="form-actions">
      <a class="button button-secondary" href="/purchase-orders/${order.id}/export">Exportar a Excel</a>
      ${canManage ? `<form method="post" action="/purchase-orders/${order.id}/${order.status === 'archived' ? 'reopen' : 'archive'}">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <button class="button button-secondary" type="submit">${order.status === 'archived' ? 'Reabrir' : 'Archivar'}</button>
      </form>` : ''}
    </div>`;

  const content = `
    <div class="breadcrumb"><a href="/purchase-orders">Órdenes de compra</a><span aria-hidden="true">/</span><span>Compra #${order.id}</span></div>
    <div class="page-heading"><div><p class="eyebrow">${order.status === 'archived' ? 'Archivada' : 'Borrador'}</p>
      <h1>Compra #${order.id}</h1>
      <p class="page-subtitle">Creada el ${escapeHtml(formatTimestamp(order.created_at))} · ${lines.length} ${lines.length === 1 ? 'artículo' : 'artículos'}</p></div>
      ${actions}</div>
    ${detail}`;
  return page(`Compra #${order.id}`, content, { ...session, active: 'purchases' });
}

function movementSourceLabel(source) {
  if (source === 'creation') return 'Alta';
  if (source === 'import') return 'Importación Excel';
  if (source === 'order') return 'Pedido';
  return 'Manual';
}

// Orders and drafts hold money in integer cents; the interface always shows USD with two decimals.
function formatUsd(cents) {
  return `$${formatCents(cents ?? 0)}`;
}

function formatPercent(bps) {
  return `${(bps / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} %`;
}

const ORDER_LIFECYCLE_LABELS = { open: 'Abierto', archived: 'Archivado', annulled: 'Anulado' };

function orderLifecycleLabel(order) {
  return ORDER_LIFECYCLE_LABELS[orderLifecycle(order)] ?? order.status;
}

// A single pill reads as a coloured dot plus a label, the way the Shopify order header shows state.
function orderPill(label, tone = '') {
  return `<span class="order-pill${tone}"><span class="order-pill__dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

// The header shows the operational states side by side: payment, fulfilment and, when it applies,
// archived or annulled. An annulled order is cancelled, so its operational pills are dropped.
function orderHeaderPills(order) {
  if (order.status === 'annulled') return orderPill('Anulado', ' is-annulled');
  const pills = [
    orderPill(order.paid_at ? 'Pagado' : 'Sin pagar', order.paid_at ? ' is-paid' : ' is-pending'),
    orderPill(order.fulfilled_at ? 'Preparado' : 'Sin preparar', order.fulfilled_at ? ' is-fulfilled' : ' is-pending'),
  ];
  if (order.archived_at) pills.push(orderPill('Archivado', ' is-archived'));
  return pills.join('');
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// The timeline groups events by calendar day in UTC, the same clock the order timestamps use.
function eventDayLabel(value) {
  const day = String(value ?? '').slice(0, 10);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  if (day === today) return 'Hoy';
  if (day === yesterday) return 'Ayer';
  const [year, month, date] = day.split('-').map(Number);
  return `${date} de ${MONTH_NAMES[month - 1]} de ${year}`;
}

function orderEventText(event, order) {
  switch (event.kind) {
    case 'created': return `Se creó el pedido #${order.number}.`;
    case 'paid': return 'Se marcó el pedido como pagado.';
    case 'fulfilled': return 'Se marcó el pedido como preparado.';
    case 'archived': return 'Se archivó el pedido.';
    case 'unarchived': return 'Se desarchivó el pedido.';
    case 'annulled': return 'Se anuló el pedido y se repuso el inventario.';
    default: return '';
  }
}

// The timeline is a rail of events grouped per day: automatic actions read as plain sentences and
// comments show the author above their free text.
function orderTimeline(events, order) {
  if (!events.length) return '<p class="order-card__empty">Todavía no hay actividad.</p>';
  const groups = [];
  for (const event of events) {
    const label = eventDayLabel(event.created_at);
    let group = groups.at(-1);
    if (!group || group.label !== label) {
      group = { label, items: [] };
      groups.push(group);
    }
    const isComment = event.kind === 'comment';
    group.items.push(`<li class="order-timeline__event${isComment ? ' is-comment' : ''}">
      <div class="order-timeline__body">
        ${isComment && event.author ? `<p class="order-timeline__author">${escapeHtml(event.author)}</p>` : ''}
        <p class="order-timeline__text">${escapeHtml(isComment ? event.body : orderEventText(event, order)).replace(/\n/g, '<br>')}</p>
      </div>
      <time class="order-timeline__time" datetime="${escapeHtml(timestampAttribute(event.created_at))}">${escapeHtml(String(event.created_at).slice(11, 16))}</time>
    </li>`);
  }
  return `<div class="order-timeline">${groups.map((group) => `
    <section class="order-timeline__group">
      <h3 class="order-timeline__day">${escapeHtml(group.label)}</h3>
      <ol class="order-timeline__events">${group.items.join('')}</ol>
    </section>`).join('')}</div>`;
}

// Only active articles can be part of a new order, listed with their availability.
function orderProductOptions(products, selectedId = '') {
  return products
    .filter((product) => !product.archived)
    .map((product) => {
      const note = stockStatus(product) === 'agotado' ? ' · Agotado' : stockStatus(product) === 'stockbajo' ? ' · Stock bajo' : '';
      const selected = String(product.id) === String(selectedId) ? ' selected' : '';
      return `<option value="${product.id}" data-price="${product.price_cents ?? 0}" data-available="${product.quantity}"${selected}>${escapeHtml(product.part_number)} — ${escapeHtml(product.description)} · ${product.quantity}${note}</option>`;
    })
    .join('');
}

function orderLineRow(line, products) {
  const product = products.find((candidate) => String(candidate.id) === String(line.productId));
  const quantity = line.quantity ?? '';
  const unitPrice = product ? (product.price_cents ?? 0) : null;
  const lineTotal = product && /^[1-9]\d*$/.test(String(quantity)) ? unitPrice * Number(quantity) : null;
  return `<tr data-order-line>
    <td><select class="order-line__product" name="productId" data-order-product aria-label="Producto de la línea">
      <option value="">Selecciona un artículo</option>
      ${orderProductOptions(products, line.productId)}
    </select></td>
    <td class="order-line__availability" data-order-available>${product ? product.quantity : '—'}</td>
    <td><input class="line-quantity" type="number" min="1" step="1" inputmode="numeric" name="quantity" value="${escapeHtml(quantity)}" data-order-quantity aria-label="Cantidad de la línea"></td>
    <td class="order-line__price" data-order-price>${unitPrice == null ? '—' : escapeHtml(formatUsd(unitPrice))}</td>
    <td class="order-line__subtotal" data-order-line-total>${lineTotal == null ? '—' : escapeHtml(formatUsd(lineTotal))}</td>
    <td class="row-action"><button type="button" class="text-link" data-order-line-remove>Quitar</button></td>
  </tr>`;
}

// The Artículos cell reveals the breakdown of the order in place, without leaving the list:
// product, P/N, presentation and quantity. A base disclosure element keeps it script-free.
function orderArticlesCell(order, lines) {
  const count = order.line_count ?? lines.length;
  const label = `${count} ${count === 1 ? 'artículo' : 'artículos'}`;
  if (!lines.length) return `<td class="order-articles"><span class="muted">${label}</span></td>`;
  const rows = lines.map((line) => `<tr>
    <td class="align-left">${escapeHtml(line.description)}</td>
    <td class="part-number">${escapeHtml(line.part_number)}</td>
    <td>${escapeHtml(presentationLabel(line.presentation))}</td>
    <td class="quantity-cell">${line.quantity}</td>
  </tr>`).join('');
  return `<td class="order-articles">
    <details class="order-breakdown">
      <summary>${label}</summary>
      <table><thead><tr>
        <th scope="col" class="align-left">Producto</th><th scope="col">P/N</th>
        <th scope="col">Presentación</th><th scope="col" class="align-right">Cantidad</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </details>
  </td>`;
}

// The list keeps the same pattern as the other sections: a clean heading with only Exportar and
// Crear pedido, instant search by number or customer, channel and state filters, a fixed 50-row
// pager and the article breakdown revealed from the Artículos cell.
export function ordersPage({ orders = [], filters = {}, pagination, queryParams = new URLSearchParams(), channels = [], linesByOrder = {}, error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const state = filters.state ?? 'open';
  const hasActiveFilter = Boolean(filters.q || filters.channel || state !== 'open');
  // The complete export follows the visible search and channel filter, across all pages.
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete('page');
  exportParams.set('view', 'orders');
  exportParams.set('scope', 'all');
  const exportHref = `/exports?${exportParams.toString()}`;
  const headerActions = `<a class="button button-secondary" href="${escapeHtml(exportHref)}">Exportar</a>
    ${canManage ? '<a class="button button-primary" href="/orders/new">Crear pedido</a>' : ''}`;

  const rows = orders.map((order) => {
    const lines = linesByOrder[order.id] ?? [];
    return `<tr>
      <td class="part-number"><a href="/orders/${order.number}">#${order.number}</a></td>
      <td><time datetime="${escapeHtml(timestampAttribute(order.created_at))}">${escapeHtml(formatTimestamp(order.created_at))}</time></td>
      <td class="align-left">${escapeHtml(customerName({ name: order.customer_name, last_name: order.customer_last_name }))}</td>
      <td>${escapeHtml(order.channel_name)}</td>
      <td>${escapeHtml(formatPercent(order.discount_bps))}</td>
      <td class="quantity-cell">${escapeHtml(formatUsd(order.total_cents))}</td>
      ${orderArticlesCell(order, lines)}
      <td><span class="status-tag">${escapeHtml(orderLifecycleLabel(order))}</span></td>
    </tr>`;
  }).join('');

  const channelOptions = channels.map((channel) => `<option value="${channel.id}" ${String(channel.id) === String(filters.channel ?? '') ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`).join('');

  const pageLink = (number, label) => {
    const params = new URLSearchParams(queryParams);
    params.set('page', number);
    return `<a class="button button-secondary" href="/orders?${escapeHtml(params.toString())}">${label}</a>`;
  };
  const pager = pagination ? `<nav class="pagination" aria-label="Paginación">
    <span>${pagination.total} pedidos · Página ${pagination.page} de ${pagination.pages}</span>
    <div>${pagination.page > 1 ? pageLink(pagination.page - 1, 'Anterior') : ''}
      ${pagination.page < pagination.pages ? pageLink(pagination.page + 1, 'Siguiente') : ''}</div>
  </nav>` : '';

  const emptyState = hasActiveFilter
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3>
      <p>Ningún pedido coincide con la búsqueda o el filtro.</p>
      <a class="button button-secondary" href="/orders">Limpiar filtros</a></div>`
    : `<div class="empty-state">
      <span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Todavía no hay pedidos</h3>
      <p>${canManage ? 'Crea un pedido: elige cliente, canal y artículos; el inventario se descuenta al guardar.' : 'Cuando Gestión cree un pedido, aparecerá aquí.'}</p>
    </div>`;

  const content = `
    <div class="page-heading">
      <div><h1>Pedidos</h1>
        <p class="page-subtitle">Cada pedido descuenta inventario al crearse y queda registrado en el historial de cada artículo.</p></div>
      <div class="form-actions">${headerActions}</div>
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <section class="inventory-panel" aria-label="Lista de pedidos">
      <form class="catalog-toolbar" method="get" action="/orders" data-instant-search>
        <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por pedido o cliente" aria-label="Buscar por pedido o cliente">
        <select name="channel" aria-label="Canal">
          <option value="">Todos los canales</option>
          ${channelOptions}
        </select>
        <select name="state" aria-label="Estado">
          <option value="open" ${state === 'open' ? 'selected' : ''}>Abiertos</option>
          <option value="archived" ${state === 'archived' ? 'selected' : ''}>Archivados</option>
          <option value="annulled" ${state === 'annulled' ? 'selected' : ''}>Anulados</option>
          <option value="all" ${state === 'all' ? 'selected' : ''}>Todos</option>
        </select>
        <button class="visually-hidden" type="submit">Buscar</button>
      </form>
      <div data-catalog-results>
        ${orders.length ? `<div class="table-scroll"><table><thead><tr>
          <th scope="col">Pedido</th><th scope="col">Fecha (UTC)</th><th scope="col" class="align-left">Cliente</th>
          <th scope="col">Canal</th><th scope="col">Descuento</th><th scope="col" class="align-right">Total</th>
          <th scope="col">Artículos</th><th scope="col">Estado</th>
        </tr></thead><tbody>${rows}</tbody></table></div>` : emptyState}
        ${pager}
      </div>
    </section>`;
  return page('Pedidos', content, { ...session, active: 'orders' });
}

// Alta de pedido: cliente registrado, canal de la lista editable, líneas del catálogo con cantidad,
// precio unitario automático (solo lectura), descuento en % y notas.
export function orderFormPage({ customers = [], channels = [], products = [], values = {}, error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const customerOptions = customers.map((customer) => ({ id: customer.id, name: customerName(customer) }));
  const lineValues = values.lines?.length ? values.lines : [{ productId: '', quantity: '' }, { productId: '', quantity: '' }, { productId: '', quantity: '' }];
  const rows = lineValues.map((line) => orderLineRow(line, products)).join('');
  const selectedLines = lineValues
    .map((line) => {
      const product = products.find((candidate) => String(candidate.id) === String(line.productId));
      const quantity = Number(line.quantity);
      return product && Number.isSafeInteger(quantity) ? { quantity, unitPriceCents: product.price_cents ?? 0 } : null;
    })
    .filter(Boolean);
  const discount = parseDiscount(values.discount);
  const totals = orderTotals(selectedLines, discount.bps ?? 0);
  const noCustomers = customers.length === 0;
  const content = `
    <div class="breadcrumb"><a href="/orders">Pedidos</a><span aria-hidden="true">/</span><span>Nuevo pedido</span></div>
    <div class="page-heading form-heading"><div><p class="eyebrow">Alta de pedido</p><h1>Nuevo pedido</h1>
      <p class="page-subtitle">Al guardar, el inventario de cada artículo se descuenta y queda el movimiento en su historial.</p></div></div>
    <form class="product-form" method="post" action="/orders" data-order-form>
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="form-section form-card">
        <h2>Cliente y canal</h2>
        ${noCustomers ? `<p class="form-hint">Todavía no hay clientes registrados. Crea uno para poder registrar el pedido.
          ${canManage ? '<a href="/customers/new">Agregar cliente</a>.' : ''}</p>` : ''}
        <div class="field-row">
          ${namedListCombo({ field: 'customerId', newField: '', newLabel: '', placeholder: 'Elige un cliente registrado', searchPlaceholder: 'Buscar clientes', options: customerOptions, selectedId: values.customerId, canCreate: false })}
          ${canManage ? '<button type="button" class="button button-secondary customer-inline-trigger" data-customer-open>Nuevo cliente</button>' : ''}
        </div>
        ${namedListCombo({ field: 'channelId', newField: 'newChannel', newLabel: 'Crear canal', placeholder: 'Elige un canal', searchPlaceholder: 'Buscar o agregar canal', options: channels, selectedId: values.channelId, canCreate: true, newValue: values.newChannel ?? '' })}
      </section>
      <section class="form-section form-card">
        <h2>Líneas del pedido</h2>
        <p class="form-hint">Elige artículos del catálogo y fija su cantidad. El precio unitario viene del producto y no se edita. No se puede pedir más que el disponible.</p>
        <div class="table-scroll"><table class="order-lines"><thead><tr>
          <th scope="col">Producto</th><th scope="col" class="align-right">Disponible</th>
          <th scope="col" class="align-right">Cantidad</th><th scope="col" class="align-right">Precio unitario</th>
          <th scope="col" class="align-right">Importe</th><th scope="col"><span class="visually-hidden">Acciones</span></th>
        </tr></thead><tbody data-order-lines>${rows}</tbody></table></div>
        <template data-order-line-template>${orderLineRow({ productId: '', quantity: '' }, products)}</template>
        <div class="form-actions"><button class="button button-secondary" type="button" data-order-line-add>Añadir artículo</button></div>
      </section>
      <div class="product-layout">
        <div class="product-layout__main">
          <section class="form-section form-card">
            <h2>Descuento y total</h2>
            <div class="order-totals">
              <div><span>Subtotal</span><output data-order-subtotal>${escapeHtml(formatUsd(totals.subtotalCents))}</output></div>
              <div><label for="discount">Descuento</label>
                <span class="order-discount"><input id="discount" name="discount" inputmode="decimal" value="${escapeHtml(values.discount ?? '')}" data-order-discount aria-label="Descuento en porcentaje"> <span aria-hidden="true">%</span></span></div>
              <div class="order-total"><span>Total</span><output data-order-total>${escapeHtml(formatUsd(totals.totalCents))}</output></div>
            </div>
          </section>
          <div class="form-actions">
            <a class="button button-secondary" href="/orders">Cancelar</a>
            <button class="button button-primary" type="submit">Crear pedido</button>
          </div>
        </div>
        <aside class="product-layout__side">
          <section class="form-section form-card">
            <h2>Notas</h2>
            <p class="form-hint">Las notas son privadas y no se comparten con el cliente.</p>
            <div class="field"><label class="visually-hidden" for="notes">Notas</label>
              <textarea id="notes" name="notes" rows="5" maxlength="${MAX_ORDER_NOTES}" placeholder="Notas internas">${escapeHtml(values.notes ?? '')}</textarea></div>
          </section>
        </aside>
      </div>
    </form>
    ${canManage ? inlineCustomerDialog() : ''}`;
  return page('Nuevo pedido', content, { ...session, active: 'orders' });
}

// The ficha follows the Shopify order page: a header with the status pill and the action, a main
// column with the item and totals cards, and a sidebar with notes, customer and shipping address.
export function orderDetailPage({ order, lines = [], events = [], customer = null, customerOrderCount = 0, message = '', error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const subtotalCents = lines.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);
  const totalCents = order.total_cents;
  const items = lines.map((line) => {
    const lineTotal = line.quantity * line.unit_price_cents;
    const thumb = line.image_filename
      ? `<img class="product-thumb" src="/products/${line.product_id}/image" alt="" loading="lazy" width="40" height="40">`
      : '<span class="order-item__placeholder" aria-hidden="true"></span>';
    return `<li class="order-item">
      <span class="order-item__media">${thumb}</span>
      <div class="order-item__main">
        <p class="order-item__title">${escapeHtml(line.description)}${line.archived ? ' <span class="status-tag">Archivado</span>' : ''}</p>
        <p class="order-item__meta">${escapeHtml(line.part_number)} · ${escapeHtml(presentationLabel(line.presentation))}</p>
      </div>
      <p class="order-item__price">${escapeHtml(formatUsd(line.unit_price_cents))} × ${line.quantity}</p>
      <p class="order-item__total">${escapeHtml(formatUsd(lineTotal))}</p>
    </li>`;
  }).join('');
  const itemsList = lines.length
    ? `<ul class="order-items">${items}</ul>`
    : '<p class="order-card__empty">Este pedido no tiene artículos.</p>';
  const subtitle = [
    `Creado el ${escapeHtml(formatTimestamp(order.created_at))}`,
    escapeHtml(order.channel_name),
    order.source_draft_number
      ? (order.source_draft_id
        ? `<a class="text-link" href="/drafts/${order.source_draft_number}">Desde borrador #D${order.source_draft_number}</a>`
        : `Desde borrador #D${order.source_draft_number}`)
      : '',
  ].filter(Boolean).join(' · ');
  // Management drives the order states by hand: mark paid, mark prepared, archive/unarchive, annul.
  // An annulled order is final, so it only keeps its read-only ficha.
  const actionForm = (action, label) => `<form method="post" action="/orders/${order.number}/${action}">
    <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
    <button class="button button-secondary" type="submit">${label}</button>
  </form>`;
  const actions = [];
  if (canManage && order.status !== 'annulled') {
    if (!order.paid_at) actions.push(actionForm('pay', 'Marcar como pagado'));
    if (!order.fulfilled_at) actions.push(actionForm('prepare', 'Marcar como preparado'));
    actions.push(order.archived_at ? actionForm('unarchive', 'Desarchivar') : actionForm('archive', 'Archivar'));
    actions.push(actionForm('annul', 'Anular pedido'));
  }
  const actionsHtml = actions.length ? `<div class="order-detail__actions">${actions.join('')}</div>` : '';
  const emails = customer?.emails ?? [];
  const phones = customer?.phones ?? [];
  const contacts = (values) => values.length
    ? values.map((value, index) => `<p class="order-contact">${escapeHtml(value)}${index === 0 ? ' <span class="presentation-tag">Principal</span>' : ''}</p>`).join('')
    : '<p class="order-contact muted">—</p>';
  const address = addressLines(customer?.address);
  const content = `
    <div class="order-detail__head">
      <div class="order-detail__identity">
        <a class="order-back" href="/orders" aria-label="Volver a la lista de pedidos">←</a>
        <div>
          <div class="order-detail__titleline"><h1>Pedido #${order.number}</h1>${orderHeaderPills(order)}</div>
          <p class="order-detail__date">${subtitle}</p>
        </div>
      </div>
      ${actionsHtml}
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="order-detail">
      <div class="order-detail__main">
        <section class="order-card">
          <header class="order-card__head"><h2>${lines.length} ${lines.length === 1 ? 'artículo' : 'artículos'}</h2></header>
          ${itemsList}
        </section>
        <section class="order-card">
          <dl class="order-totals-list">
            <div><dt>Subtotal</dt><dd>${escapeHtml(formatUsd(subtotalCents))}</dd></div>
            <div><dt>Descuento</dt><dd>${escapeHtml(formatPercent(order.discount_bps))}</dd></div>
            <div class="order-totals-list__total"><dt>Total</dt><dd>${escapeHtml(formatUsd(totalCents))}</dd></div>
          </dl>
        </section>
        <section class="order-card order-timeline-card">
          <header class="order-card__head"><h2>Cronología</h2></header>
          <div class="order-card__body">
            ${canManage ? `<form class="order-comment-form" method="post" action="/orders/${order.number}/comments">
              <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
              <label class="visually-hidden" for="order-comment">Comentario</label>
              <textarea id="order-comment" name="body" rows="3" maxlength="${MAX_ORDER_COMMENT}" placeholder="Deja un comentario…"></textarea>
              <div class="order-comment-form__footer">
                <span class="muted">Solo tú y otros empleados pueden ver los comentarios.</span>
                <button class="button button-primary" type="submit">Publicar</button>
              </div>
            </form>` : ''}
            ${orderTimeline(events, order)}
          </div>
        </section>
      </div>
      <aside class="order-detail__side">
        <section class="order-card">
          <header class="order-card__head"><h2>Notas</h2></header>
          <div class="order-card__body"><p class="order-notes${order.notes ? '' : ' muted'}">${order.notes ? escapeHtml(order.notes) : 'Sin notas'}</p></div>
        </section>
        <section class="order-card">
          <header class="order-card__head"><h2>Cliente</h2></header>
          <div class="order-card__body">
            <a class="text-link" href="/customers/${order.customer_id}">${escapeHtml(customerName({ name: order.customer_name, last_name: order.customer_last_name }))}</a>
            <p class="muted">${customerOrderCount} ${customerOrderCount === 1 ? 'pedido' : 'pedidos'}</p>
            <h3 class="order-card__subhead">Información de contacto</h3>
            ${contacts(emails)}${contacts(phones)}
            <h3 class="order-card__subhead">Dirección de envío</h3>
            ${address.length ? `<address class="order-address">${address.map(escapeHtml).join('<br>')}</address>` : '<p class="order-contact muted">Sin dirección</p>'}
          </div>
        </section>
      </aside>
    </div>`;
  return page(`Pedido #${order.number}`, content, { ...session, active: 'orders', message });
}

const DRAFT_STATUS_LABELS = { open: 'Abierto', completed: 'Completado' };

function draftStatusLabel(status) {
  return DRAFT_STATUS_LABELS[status] ?? status;
}

// Borradores: cotizaciones con numeración propia (#D1) que no tocan el inventario. La lista es una
// búsqueda instantánea por número o cliente con una tabla Pedido · Fecha · Cliente · Estado · Total.
export function draftsPage({ drafts = [], filters = {}, pagination, queryParams = new URLSearchParams(), error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const hasSearch = Boolean(filters.q);
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete('page');
  exportParams.set('view', 'drafts');
  exportParams.set('scope', 'all');
  const headerActions = `<a class="button button-secondary" href="${escapeHtml(`/exports?${exportParams.toString()}`)}">Exportar</a>
    ${canManage ? '<a class="button button-primary" href="/drafts/new">Crear borrador</a>' : ''}`;

  const rows = drafts.map((draft) => `<tr>
      <td class="part-number"><a href="/drafts/${draft.number}">#D${draft.number}</a></td>
      <td><time datetime="${escapeHtml(timestampAttribute(draft.created_at))}">${escapeHtml(formatTimestamp(draft.created_at))}</time></td>
      <td class="align-left">${escapeHtml(customerName({ name: draft.customer_name, last_name: draft.customer_last_name }))}</td>
      <td><span class="status-tag">${escapeHtml(draftStatusLabel(draft.status))}</span></td>
      <td class="quantity-cell">${escapeHtml(formatUsd(draft.total_cents))}</td>
    </tr>`).join('');

  const pageLink = (number, label) => {
    const params = new URLSearchParams(queryParams);
    params.set('page', number);
    return `<a class="button button-secondary" href="/drafts?${escapeHtml(params.toString())}">${label}</a>`;
  };
  const pager = pagination ? `<nav class="pagination" aria-label="Paginación">
    <span>${pagination.total} borradores · Página ${pagination.page} de ${pagination.pages}</span>
    <div>${pagination.page > 1 ? pageLink(pagination.page - 1, 'Anterior') : ''}
      ${pagination.page < pagination.pages ? pageLink(pagination.page + 1, 'Siguiente') : ''}</div>
  </nav>` : '';

  const emptyState = hasSearch
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3><p>Ningún borrador coincide con la búsqueda.</p>
      <a class="button button-secondary" href="/drafts">Limpiar búsqueda</a></div>`
    : `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Todavía no hay borradores</h3>
      <p>${canManage ? 'Crea una cotización: no descuenta inventario y se edita libremente hasta confirmarla.' : 'Cuando Gestión cree una cotización, aparecerá aquí.'}</p></div>`;

  const content = `
    <div class="page-heading">
      <div><h1>Borradores</h1>
        <p class="page-subtitle">Cotizaciones de precios con numeración propia. Crear, editar o eliminar un borrador no cambia el inventario.</p></div>
      <div class="form-actions">${headerActions}</div>
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <section class="inventory-panel" aria-label="Lista de borradores">
      <form class="catalog-toolbar" method="get" action="/drafts" data-instant-search>
        <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por borrador o cliente" aria-label="Buscar por borrador o cliente">
        <button class="visually-hidden" type="submit">Buscar</button>
      </form>
      <div data-catalog-results>
        ${drafts.length ? `<div class="table-scroll"><table><thead><tr>
          <th scope="col">Pedido</th><th scope="col">Fecha (UTC)</th><th scope="col" class="align-left">Cliente</th>
          <th scope="col">Estado</th><th scope="col" class="align-right">Total</th>
        </tr></thead><tbody>${rows}</tbody></table></div>` : emptyState}
        ${pager}
      </div>
    </section>`;
  return page('Borradores', content, { ...session, active: 'drafts' });
}

// Alta y edición comparten formulario: mismas secciones que un pedido, pero sin tocar el inventario.
export function draftFormPage({ draft = null, customers = [], channels = [], products = [], values = {}, error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const editing = draft !== null;
  const customerOptions = customers.map((customer) => ({ id: customer.id, name: customerName(customer) }));
  const lineValues = values.lines?.length ? values.lines : [{ productId: '', quantity: '' }, { productId: '', quantity: '' }, { productId: '', quantity: '' }];
  const rows = lineValues.map((line) => orderLineRow(line, products)).join('');
  const selectedLines = lineValues
    .map((line) => {
      const product = products.find((candidate) => String(candidate.id) === String(line.productId));
      const quantity = Number(line.quantity);
      return product && Number.isSafeInteger(quantity) ? { quantity, unitPriceCents: product.price_cents ?? 0 } : null;
    })
    .filter(Boolean);
  const discount = parseDiscount(values.discount);
  const totals = orderTotals(selectedLines, discount.bps ?? 0);
  const noCustomers = customers.length === 0;
  const heading = editing ? `Editar borrador #D${draft.number}` : 'Nuevo borrador';
  const action = editing ? `/drafts/${draft.number}` : '/drafts';
  const content = `
    <div class="breadcrumb"><a href="/drafts">Borradores</a><span aria-hidden="true">/</span><span>${escapeHtml(heading)}</span></div>
    <div class="page-heading form-heading"><div><p class="eyebrow">Cotización</p><h1>${escapeHtml(heading)}</h1>
      <p class="page-subtitle">Una cotización de precios: no descuenta inventario. Se puede editar y eliminar hasta confirmarla.</p></div></div>
    <form class="product-form" method="post" action="${action}" data-order-form>
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="form-section form-card">
        <h2>Cliente y canal</h2>
        ${noCustomers ? `<p class="form-hint">Todavía no hay clientes registrados. Crea uno para poder cotizar.
          ${canManage ? '<a href="/customers/new">Agregar cliente</a>.' : ''}</p>` : ''}
        <div class="field-row">
          ${namedListCombo({ field: 'customerId', newField: '', newLabel: '', placeholder: 'Elige un cliente registrado', searchPlaceholder: 'Buscar clientes', options: customerOptions, selectedId: values.customerId, canCreate: false })}
          ${canManage ? '<button type="button" class="button button-secondary customer-inline-trigger" data-customer-open>Nuevo cliente</button>' : ''}
        </div>
        ${namedListCombo({ field: 'channelId', newField: 'newChannel', newLabel: 'Crear canal', placeholder: 'Elige un canal', searchPlaceholder: 'Buscar o agregar canal', options: channels, selectedId: values.channelId, canCreate: true, newValue: values.newChannel ?? '' })}
      </section>
      <section class="form-section form-card">
        <h2>Líneas del borrador</h2>
        <p class="form-hint">Elige artículos del catálogo y fija su cantidad. El precio unitario viene del producto y no se edita. Una cotización puede pedir más que el disponible: no toca el inventario.</p>
        <div class="table-scroll"><table class="order-lines"><thead><tr>
          <th scope="col">Producto</th><th scope="col" class="align-right">Disponible</th>
          <th scope="col" class="align-right">Cantidad</th><th scope="col" class="align-right">Precio unitario</th>
          <th scope="col" class="align-right">Importe</th><th scope="col"><span class="visually-hidden">Acciones</span></th>
        </tr></thead><tbody data-order-lines>${rows}</tbody></table></div>
        <template data-order-line-template>${orderLineRow({ productId: '', quantity: '' }, products)}</template>
        <div class="form-actions"><button class="button button-secondary" type="button" data-order-line-add>Añadir artículo</button></div>
      </section>
      <div class="product-layout">
        <div class="product-layout__main">
          <section class="form-section form-card">
            <h2>Descuento y total</h2>
            <div class="order-totals">
              <div><span>Subtotal</span><output data-order-subtotal>${escapeHtml(formatUsd(totals.subtotalCents))}</output></div>
              <div><label for="discount">Descuento</label>
                <span class="order-discount"><input id="discount" name="discount" inputmode="decimal" value="${escapeHtml(values.discount ?? '')}" data-order-discount aria-label="Descuento en porcentaje"> <span aria-hidden="true">%</span></span></div>
              <div class="order-total"><span>Total</span><output data-order-total>${escapeHtml(formatUsd(totals.totalCents))}</output></div>
            </div>
          </section>
          <div class="form-actions">
            <a class="button button-secondary" href="/drafts">Cancelar</a>
            <button class="button button-primary" type="submit">${editing ? 'Guardar cambios' : 'Crear borrador'}</button>
          </div>
        </div>
        <aside class="product-layout__side">
          <section class="form-section form-card">
            <h2>Notas</h2>
            <p class="form-hint">Las notas son privadas y no se comparten con el cliente.</p>
            <div class="field"><label class="visually-hidden" for="notes">Notas</label>
              <textarea id="notes" name="notes" rows="5" maxlength="${MAX_ORDER_NOTES}" placeholder="Notas internas">${escapeHtml(values.notes ?? '')}</textarea></div>
          </section>
        </aside>
      </div>
    </form>
    ${canManage ? inlineCustomerDialog() : ''}`;
  return page(heading, content, { ...session, active: 'drafts' });
}

// Ficha de la cotización: artículos, totales, notas y cliente, con Editar/Completar/Eliminar.
export function draftDetailPage({ draft, lines = [], customer = null, message = '', error = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const subtotalCents = lines.reduce((sum, line) => sum + line.quantity * line.unit_price_cents, 0);
  const items = lines.map((line) => {
    const lineTotal = line.quantity * line.unit_price_cents;
    const thumb = line.image_filename
      ? `<img class="product-thumb" src="/products/${line.product_id}/image" alt="" loading="lazy" width="40" height="40">`
      : '<span class="order-item__placeholder" aria-hidden="true"></span>';
    return `<li class="order-item">
      <span class="order-item__media">${thumb}</span>
      <div class="order-item__main">
        <p class="order-item__title">${escapeHtml(line.description)}${line.archived ? ' <span class="status-tag">Archivado</span>' : ''}</p>
        <p class="order-item__meta">${escapeHtml(line.part_number)} · ${escapeHtml(presentationLabel(line.presentation))}</p>
      </div>
      <p class="order-item__price">${escapeHtml(formatUsd(line.unit_price_cents))} × ${line.quantity}</p>
      <p class="order-item__total">${escapeHtml(formatUsd(lineTotal))}</p>
    </li>`;
  }).join('');
  const itemsList = lines.length ? `<ul class="order-items">${items}</ul>` : '<p class="order-card__empty">Este borrador no tiene artículos.</p>';
  const open = draft.status === 'open';
  const actionForm = (action, label, variant = 'button-secondary') => `<form method="post" action="/drafts/${draft.number}/${action}">
    <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
    <button class="button ${variant}" type="submit">${label}</button>
  </form>`;
  const actions = [];
  if (canManage) {
    if (open) actions.push(`<a class="button button-secondary" href="/drafts/${draft.number}/edit">Editar</a>`);
    if (open) actions.push(actionForm('convert', 'Convertir en pedido', 'button-primary'));
    actions.push(open ? actionForm('complete', 'Marcar como completado') : actionForm('reopen', 'Reabrir'));
    actions.push(actionForm('delete', 'Eliminar'));
  }
  const actionsHtml = actions.length ? `<div class="order-detail__actions">${actions.join('')}</div>` : '';
  const emails = customer?.emails ?? [];
  const phones = customer?.phones ?? [];
  const contacts = (values) => values.length
    ? values.map((value, index) => `<p class="order-contact">${escapeHtml(value)}${index === 0 ? ' <span class="presentation-tag">Principal</span>' : ''}</p>`).join('')
    : '<p class="order-contact muted">—</p>';
  const address = addressLines(customer?.address);
  const subtitle = [`Creado el ${escapeHtml(formatTimestamp(draft.created_at))}`, escapeHtml(draft.channel_name)].join(' · ');
  const content = `
    <div class="order-detail__head">
      <div class="order-detail__identity">
        <a class="order-back" href="/drafts" aria-label="Volver a la lista de borradores">←</a>
        <div>
          <div class="order-detail__titleline"><h1>Borrador #D${draft.number}</h1>${orderPill(draftStatusLabel(draft.status), open ? ' is-pending' : ' is-fulfilled')}</div>
          <p class="order-detail__date">${subtitle}</p>
        </div>
      </div>
      ${actionsHtml}
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <div class="order-detail">
      <div class="order-detail__main">
        <section class="order-card">
          <header class="order-card__head"><h2>${lines.length} ${lines.length === 1 ? 'artículo' : 'artículos'}</h2></header>
          ${itemsList}
        </section>
        <section class="order-card">
          <dl class="order-totals-list">
            <div><dt>Subtotal</dt><dd>${escapeHtml(formatUsd(subtotalCents))}</dd></div>
            <div><dt>Descuento</dt><dd>${escapeHtml(formatPercent(draft.discount_bps))}</dd></div>
            <div class="order-totals-list__total"><dt>Total</dt><dd>${escapeHtml(formatUsd(draft.total_cents))}</dd></div>
          </dl>
        </section>
      </div>
      <aside class="order-detail__side">
        <section class="order-card">
          <header class="order-card__head"><h2>Notas</h2></header>
          <div class="order-card__body"><p class="order-notes${draft.notes ? '' : ' muted'}">${draft.notes ? escapeHtml(draft.notes) : 'Sin notas'}</p></div>
        </section>
        <section class="order-card">
          <header class="order-card__head"><h2>Cliente</h2></header>
          <div class="order-card__body">
            <a class="text-link" href="/customers/${draft.customer_id}">${escapeHtml(customerName({ name: draft.customer_name, last_name: draft.customer_last_name }))}</a>
            <h3 class="order-card__subhead">Información de contacto</h3>
            ${contacts(emails)}${contacts(phones)}
            <h3 class="order-card__subhead">Dirección de envío</h3>
            ${address.length ? `<address class="order-address">${address.map(escapeHtml).join('<br>')}</address>` : '<p class="order-contact muted">Sin dirección</p>'}
          </div>
        </section>
      </aside>
    </div>`;
  return page(`Borrador #D${draft.number}`, content, { ...session, active: 'drafts', message });
}

export function productDetailPage({ product, ...session }) {
  return page(product.description, `<div class="breadcrumb"><a href="/products">Productos</a><span>/</span><span>Ficha del producto</span></div>
    <div class="page-heading"><h1>${escapeHtml(product.description)}</h1>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/products/${product.id}/edit">Editar producto</a>` : ''}</div>
    <section class="product-form form-section">${product.image_filename ? `<img class="product-image" src="/products/${product.id}/image" alt="Imagen de ${escapeHtml(product.description)}">` : ''}
      <h2>${escapeHtml(product.part_number)}</h2>
      <dl class="product-details">
        <dt>Estado</dt><dd>${product.archived ? 'Archivado' : 'Activo'}</dd>
        <dt>Inventario</dt><dd>${product.quantity}</dd>
        <dt>Precio</dt><dd>${product.price_cents == null ? '—' : `$${formatCents(product.price_cents)}`}</dd>
        <dt>Precio de fábrica</dt><dd>${product.cost_cents == null ? '—' : `$${formatCents(product.cost_cents)}`}</dd>
        ${product.price_cents != null && product.cost_cents != null ? `<dt>Ganancia</dt><dd>${formatMargin(product.price_cents - product.cost_cents)}</dd>` : ''}
        <dt>Descripción</dt><dd class="long-description">${product.long_description ? escapeHtml(product.long_description) : '—'}</dd>
        <dt>Categoría</dt><dd>${escapeHtml(product.category_name ?? 'Sin categoría')}</dd>
        <dt>Tipo de producto</dt><dd>${escapeHtml(product.product_type_name ?? '—')}</dd>
        <dt>Proveedor</dt><dd>${escapeHtml(product.supplier_name ?? '—')}</dd>
        <dt>Presentación</dt><dd>${escapeHtml(presentationLabel(product.presentation))}</dd>
        <dt>Marca</dt><dd>${escapeHtml(product.brand || '—')}</dd>
        <dt>Ubicación</dt><dd>${escapeHtml(product.location || '—')}</dd>
        <dt>Mínimo de stock</dt><dd>${product.minimum_stock ?? '—'}</dd>
      </dl>
      <a class="button button-secondary" href="/products/${product.id}/history">Historial</a>
      ${canManageInventory(session.role) && !product.archived ? `<a class="button button-secondary" href="/products/${product.id}/stock">Ajustar inventario</a>` : ''}
      ${canManageInventory(session.role) ? `<form class="inline-form" method="post" action="/products/${product.id}/${product.archived ? 'restore' : 'archive'}">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <button class="button button-secondary" type="submit">${product.archived ? 'Desarchivar' : 'Archivar'}</button>
      </form>` : ''}
    </section>`, { ...session, active: 'products' });
}

function roleOptions(selectedRole = 'viewer') {
  return assignableRoles.map(([value, label]) => `<option value="${value}" ${selectedRole === value ? 'selected' : ''}>${label}</option>`).join('');
}

export function accountsPage({ users, account = {}, error = '', ...session }) {
  return page('Cuentas y permisos', `
    <div class="page-heading"><div><p class="eyebrow">Equipo</p><h1>Cuentas y permisos</h1>
      <p class="page-subtitle">Consulta permite ver el inventario. Gestión permite mantener artículos e inventario.</p></div></div>
    <section class="inventory-panel" aria-label="Cuentas del equipo">
      <table><thead><tr><th scope="col">Usuario</th><th scope="col">Permiso</th></tr></thead>
        <tbody>${users.map((user) => `<tr><td>${escapeHtml(user.username)}</td><td>${user.role === 'admin' ? 'Administración' : `
          <form method="post" action="/users/${user.id}/role">
            <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
            <label class="visually-hidden" for="role-${user.id}">Permiso de ${escapeHtml(user.username)}</label>
            <select id="role-${user.id}" name="role">
              ${roleOptions(user.role)}
            </select>
            <button class="button button-secondary" type="submit" aria-label="Guardar permiso de ${escapeHtml(user.username)}">Guardar permiso</button>
          </form>`}</td></tr>`).join('')}</tbody>
      </table>
    </section>
    <form class="product-form" method="post" action="/users">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <section class="form-section"><h2>Crear cuenta</h2>
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        <div class="form-grid">
          <div class="field"><label for="username">Usuario</label>
            <input id="username" name="username" value="${escapeHtml(account.username ?? '')}" autocomplete="off" minlength="3" maxlength="50" required></div>
          <div class="field"><label for="password">Contraseña</label>
            <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
            <p class="form-hint">Al menos 12 caracteres.</p></div>
          <div class="field"><label for="role">Permiso</label>
            <select id="role" name="role" required>
              ${roleOptions(account.role)}
            </select></div>
        </div>
      </section>
      <div class="form-actions"><button class="button button-primary" type="submit">Crear cuenta</button></div>
    </form>`, { ...session, active: 'users' });
}

export function forbiddenPage(session) {
  return page('Acceso denegado', `<section class="empty-state"><h1>Acceso denegado</h1>
    <p>No tienes permiso para realizar esta operación.</p>
    <a class="button button-secondary" href="/inventory">Volver al inventario</a></section>`, session);
}

// A named list renders as a native <select> (the no-JS fallback and the submitted value) that
// catalog.js upgrades into a searchable combobox with optional inline creation.
function namedListCombo({ field, newField, newLabel, placeholder, searchPlaceholder, options, selectedId, canCreate, newValue = '' }) {
  const selected = String(selectedId ?? '');
  const optionMarkup = options.map((option) => `<option value="${option.id}" ${String(option.id) === selected ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('');
  return `<div class="combo" data-combo${field === 'customerId' ? ' data-combo-customer' : ''}>
    <select id="${field}" name="${field}" class="combo__native" data-combo-native>
      <option value="">${escapeHtml(placeholder)}</option>
      ${optionMarkup}
    </select>
    <div class="combo__widget" data-combo-widget hidden>
      <button type="button" class="combo__toggle" data-combo-toggle aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(placeholder)}">
        <span data-combo-label>${escapeHtml(placeholder)}</span>
      </button>
      <div class="combo__panel" data-combo-panel hidden>
        <input type="search" class="combo__search" data-combo-search placeholder="${escapeHtml(searchPlaceholder)}" aria-label="${escapeHtml(searchPlaceholder)}">
        <ul class="combo__list" role="listbox" data-combo-list></ul>
        <p class="combo__empty" data-combo-empty hidden>Sin resultados.</p>
        <button type="button" class="combo__add" data-combo-add hidden></button>
      </div>
    </div>
    ${canCreate ? `<div class="field combo__create" data-combo-create>
      <label for="${newField}">${escapeHtml(newLabel)}</label>
      <input id="${newField}" name="${newField}" value="${escapeHtml(newValue)}" maxlength="100">
      <p class="form-hint">Se crea y asigna al guardar, sin duplicar nombres equivalentes.</p>
    </div>` : ''}
  </div>`;
}

export function productFormPage({ product = {}, categories = [], productTypes = [], suppliers = [], error = '', isNew = true, ...session }) {
  const presentationOptions = `
    <option value="" disabled ${product.presentation ? '' : 'selected'}>Selecciona una presentación</option>
    ${PRESENTATIONS.map(([value, label]) => `<option value="${value}" ${product.presentation === value ? 'selected' : ''}>${label}</option>`).join('')}
  `;
  const priceValue = product.price ?? (product.price_cents != null ? formatCents(product.price_cents) : '');
  const costValue = product.cost ?? (product.cost_cents != null ? formatCents(product.cost_cents) : '');
  const profitValue = product.price_cents != null && product.cost_cents != null ? formatMargin(product.price_cents - product.cost_cents) : '—';
  const action = isNew ? '/products' : `/products/${product.id}`;
  const title = isNew ? 'Añadir repuesto' : 'Editar repuesto';
  const content = `
    <div class="breadcrumb"><a href="/products">Productos</a><span aria-hidden="true">/</span><span>${title}</span></div>
    <div class="page-heading form-heading">
      <div><p class="eyebrow">Ficha del artículo</p><h1>${title}</h1></div>
      ${!isNew ? `<div>Inventario: <strong>${product.quantity}</strong> · <a href="/products/${product.id}/history">Historial</a></div>` : ''}
    </div>
    <form class="product-form product-form--split" method="post" action="${action}" enctype="multipart/form-data">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <div class="product-layout">
        <div class="product-layout__main">
          <section class="form-section form-card">
            <div class="form-grid">
              <div class="field">
                <label for="partNumber">P/N <span class="required-mark">Obligatorio</span></label>
                <input id="partNumber" name="partNumber" value="${escapeHtml(product.part_number ?? '')}" maxlength="100" placeholder="001-MAR" required>
              </div>
              <div class="field">
                <label for="presentation">Presentación <span class="required-mark">Obligatorio</span></label>
                <select id="presentation" name="presentation" required>${presentationOptions}</select>
              </div>
              <div class="field field-wide">
                <label for="description">Producto <span class="required-mark">Obligatorio</span></label>
                <input id="description" name="description" value="${escapeHtml(product.description ?? '')}" maxlength="240" placeholder="Nombre del producto" required>
              </div>
              <div class="field field-wide">
                <label for="longDescription">Descripción <span class="optional-mark">Opcional</span></label>
                <textarea id="longDescription" name="longDescription" rows="5" maxlength="${MAX_LONG_DESCRIPTION}" placeholder="Texto plano para detalles más allá del nombre.">${escapeHtml(product.long_description ?? '')}</textarea>
              </div>
            </div>
            <h3 class="form-subheading">Multimedia</h3>
            <div class="media-box">
              ${product.image_filename ? `<div class="media-box__current">
                <img class="product-image-preview" src="/products/${product.id}/image" alt="Imagen actual de ${escapeHtml(product.description ?? '')}">
                <label class="filter-check"><input type="checkbox" name="removeImage"> Quitar la imagen actual</label>
              </div>` : ''}
              <label class="media-box__drop" for="image">
                <span class="media-box__action">${product.image_filename ? 'Cambiar imagen' : 'Subir nuevo'}</span>
                <span class="media-box__hint">Acepta imágenes JPG, PNG o WEBP de hasta 2 MB</span>
                <span class="media-box__note" data-image-name></span>
              </label>
              <input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" class="media-box__input">
            </div>
          </section>
          <section class="form-section form-card price-card">
            <h2>Precio</h2>
            <div class="field">
              <div class="currency-input">
                <input id="price" name="price" inputmode="decimal" value="${escapeHtml(priceValue)}" placeholder="0,00" aria-label="Precio" data-price>
                <span class="currency-input__symbol" aria-hidden="true">$</span>
              </div>
            </div>
            <details class="price-extra" open>
              <summary>Precios adicionales</summary>
              <div class="form-grid">
                <div class="field">
                  <label for="cost">Precio de fábrica <span class="help-dot" title="Lo que nos cuesta el producto. Solo lo ve el equipo.">?</span></label>
                  <div class="currency-input">
                    <input id="cost" name="cost" inputmode="decimal" value="${escapeHtml(costValue)}" placeholder="0,00" data-cost>
                    <span class="currency-input__symbol" aria-hidden="true">$</span>
                  </div>
                </div>
                <div class="field">
                  <label for="profit">Ganancia</label>
                  <output id="profit" class="profit-value" for="price cost" data-profit>${profitValue}</output>
                </div>
              </div>
            </details>
          </section>
          <section class="form-section form-card">
            <h2>Inventario</h2>
            <div class="inventory-card">
              <div class="inventory-card__head"><span>Cantidad</span><span>Disponible</span></div>
              <div class="inventory-card__row">
                <span>Almacén principal</span>
                ${isNew
                  ? `<input id="initialQuantity" name="initialQuantity" type="number" min="0" step="1" value="${escapeHtml(product.initial_quantity ?? '0')}" aria-label="Cantidad disponible">`
                  : `<span class="inventory-card__value">${product.quantity}</span>`}
              </div>
            </div>
            ${isNew
              ? '<p class="form-hint">Se registra en el historial como movimiento de alta.</p>'
              : `<p class="form-hint"><a href="/products/${product.id}/stock">Ajustar inventario</a>; cada cambio queda en el historial.</p>`}
            <div class="field">
              <label for="location">Ubicación principal <span class="optional-mark">Opcional</span></label>
              <input id="location" name="location" value="${escapeHtml(product.location ?? '')}" maxlength="120" placeholder="Estante, caja u otra referencia interna">
            </div>
          </section>
          <div class="form-actions">
            <a class="button button-secondary" href="/products">Cancelar</a>
            <button class="button button-primary" type="submit">Guardar repuesto</button>
          </div>
        </div>
        <aside class="product-layout__side">
          <section class="form-section form-card">
            <h2>Organización del producto</h2>
            ${namedListCombo({ field: 'categoryId', newField: 'newCategory', newLabel: 'Crear categoría', placeholder: 'Elige una categoría de producto', searchPlaceholder: 'Buscar categorías', options: categories, selectedId: product.category_id, canCreate: session.role === 'admin', newValue: product.new_category ?? '' })}
            ${namedListCombo({ field: 'productTypeId', newField: 'newProductType', newLabel: 'Crear tipo de producto', placeholder: 'Sin tipo', searchPlaceholder: 'Buscar o agregar tipo de producto', options: productTypes, selectedId: product.product_type_id, canCreate: true, newValue: product.new_product_type ?? '' })}
            ${namedListCombo({ field: 'supplierId', newField: 'newSupplier', newLabel: 'Crear proveedor', placeholder: 'Sin proveedor', searchPlaceholder: 'Buscar o agregar proveedor', options: suppliers, selectedId: product.supplier_id, canCreate: true, newValue: product.new_supplier ?? '' })}
            <div class="field">
              <label for="brand">Marca <span class="optional-mark">Opcional</span></label>
              <input id="brand" name="brand" value="${escapeHtml(product.brand ?? '')}" maxlength="100" placeholder="Marca del producto">
            </div>
          </section>
        </aside>
      </div>
    </form>`;
  return page(title, content, { ...session, active: 'products' });
}

// Customer directory: Nombre del cliente and Ubicación only, instant search by name, fixed 50.
export function customersPage({ customers = [], filters = {}, pagination, queryParams = new URLSearchParams(), message = '', ...session }) {
  const canManage = canManageInventory(session.role);
  const addButton = canManage ? '<a class="button button-primary" href="/customers/new">Agregar cliente</a>' : '';
  const hasActiveFilter = Boolean(filters.q);
  // The full export follows the visible search, so it covers every matching page.
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete('page');
  exportParams.set('view', 'customers');
  exportParams.set('scope', 'all');
  const exportHref = `/exports?${exportParams.toString()}`;
  const headerActions = `<a class="button button-secondary" href="${escapeHtml(exportHref)}">Exportar</a>
    ${canManage ? '<a class="button button-secondary" href="/imports?view=customers">Importar</a>' : ''}
    ${addButton}`;
  const rows = customers.map((customer) => `<tr>
    <td class="align-left"><a class="product-description" href="/customers/${customer.id}">${escapeHtml(customerName(customer))}</a></td>
    <td class="align-left">${escapeHtml(customerLocation(customer))}</td>
  </tr>`).join('');

  const pageLink = (number, label) => {
    const params = new URLSearchParams(queryParams);
    params.set('page', number);
    return `<a class="button button-secondary" href="/customers?${escapeHtml(params.toString())}">${label}</a>`;
  };
  const pager = pagination ? `<nav class="pagination" aria-label="Paginación">
    <span>${pagination.total} clientes · Página ${pagination.page} de ${pagination.pages}</span>
    <div>${pagination.page > 1 ? pageLink(pagination.page - 1, 'Anterior') : ''}
      ${pagination.page < pagination.pages ? pageLink(pagination.page + 1, 'Siguiente') : ''}</div>
  </nav>` : '';

  const emptyState = hasActiveFilter
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3>
      <p>Ningún cliente coincide con la búsqueda.</p>
      <a class="button button-secondary" href="/customers">Limpiar búsqueda</a></div>`
    : `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Todavía no hay clientes</h3>
      <p>${canManage ? 'Añade el primer cliente con su RIF / Cédula y sus datos de contacto.' : 'Cuando Gestión cree un cliente, aparecerá aquí.'}</p>
      ${addButton}</div>`;

  const content = `
    <div class="page-heading">
      <div><h1>Clientes</h1></div>
      <div class="form-actions">${headerActions}</div>
    </div>
    <section class="inventory-panel" aria-label="Lista de clientes">
      <form class="catalog-toolbar" method="get" action="/customers" data-instant-search>
        <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por nombre" aria-label="Buscar por nombre">
        <button class="visually-hidden" type="submit">Buscar</button>
      </form>
      <div data-catalog-results>
        ${customers.length ? `
          <div class="table-scroll">
            <table>
              <thead><tr>
                <th scope="col" class="align-left">Nombre del cliente</th>
                <th scope="col" class="align-left">Ubicación</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : emptyState}
        ${pager}
      </div>
    </section>`;
  return page('Clientes', content, { ...session, active: 'customers', message });
}

// Customer Excel import: preview with altas, actualizaciones and per-row errors; one transaction.
export function customerImportPage({ review, confirmationToken, error = '', ...session }) {
  const invalid = review?.rows.filter((row) => row.errors.length).length ?? 0;
  const previousCustomer = (row) => (row.previous ? { ...row.previous.customer, emails: row.previous.emails, phones: row.previous.phones } : null);
  const summary = (customer, address) => {
    if (!customer) return '—';
    const parts = [
      customer.name ? customerName({ name: customer.name, last_name: customer.last_name ?? customer.lastName }) : '',
      (customer.emails ?? []).join(' | '),
      (customer.phones ?? []).join(' | '),
      address ? [address.city, address.state, address.country].filter(Boolean).join(', ') : '',
    ].filter(Boolean);
    return parts.length ? parts.map(escapeHtml).join('<br>') : '—';
  };
  const rows = review?.rows.map((row) => `<tr><td>${row.number}</td><td>${escapeHtml(row.taxId)}</td>
      <td>${escapeHtml(customerName({ name: row.customer?.name ?? '', last_name: row.customer?.lastName ?? '' }))}</td>
      <td>${row.errors.length ? 'Error' : row.previous ? 'Actualización' : 'Alta'}</td>
      <td>${summary(previousCustomer(row), row.previous?.address)}</td>
      <td>${summary(row.customer, row.address)}</td>
      <td>${row.errors.map(escapeHtml).join('<br>')}</td></tr>`).join('') ?? '';
  return page('Importar clientes', `
    <div class="breadcrumb"><a href="/customers">Clientes</a><span aria-hidden="true">/</span><span>Importar Excel</span></div>
    <div class="page-heading"><div><p class="eyebrow">Carga revisada</p><h1>${review ? 'Revisar importación' : 'Importar clientes'}</h1>
      <p>Los cambios solo se guardan al confirmar el lote completo.</p></div></div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${review ? `
      <section class="inventory-panel" aria-label="Vista previa de importación">
        <div class="table-toolbar"><div><h2>${review.rows.filter((row) => !row.previous && !row.errors.length).length} altas · ${review.rows.filter((row) => row.previous && !row.errors.length).length} actualizaciones · ${invalid} filas con errores</h2></div></div>
        <div class="table-scroll"><table><thead><tr><th>Fila</th><th>RIF / Cédula</th><th>Nombre</th><th>Resultado</th><th>Datos anteriores</th><th>Datos nuevos</th><th>Errores</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>
      ${invalid ? '<p class="form-error" role="alert">Corrige todas las filas con errores y vuelve a cargar el archivo. No se aplicará ninguna fila.</p>' : `
        <form method="post" action="/imports/confirm" class="form-actions">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <input type="hidden" name="view" value="customers">
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
          <button class="button button-primary" type="submit">Confirmar importación</button>
        </form>`}
      <form method="post" action="/imports/cancel" class="form-actions">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <input type="hidden" name="view" value="customers">
        <a class="button button-secondary" href="/imports?view=customers">Cargar otro archivo</a>
        <button class="button button-quiet" type="submit">Cancelar importación</button>
      </form>` : `
      <form class="product-form" method="post" action="/imports" enctype="multipart/form-data">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <input type="hidden" name="view" value="customers">
        <section class="form-section"><h2>Archivo y opciones</h2>
          <p>Excel .xlsx, una sola hoja, hasta 2 MB y 1000 filas. Primera fila: encabezados.</p>
          <p>Columnas: <strong>Nombre, Apellido, Correo electrónico, Teléfonos, Notas, País, Empresa, Calle, Apartamento, Ciudad, Estado, Código postal, RIF / Cédula</strong>.</p>
          <p><strong>RIF / Cédula</strong> es obligatorio y único. Varios correos o teléfonos van en una celda separados por <strong>|</strong>. Un RIF repetido en el archivo bloquea el lote. Las columnas ausentes conservan el valor guardado; las celdas vacías lo borran. Usa valores, sin fórmulas.</p>
          <div class="field"><label for="file">Archivo Excel</label><input id="file" name="file" type="file" accept=".xlsx" required></div>
        </section>
        <div class="form-actions"><a class="button button-quiet" href="/customers">Volver a Clientes</a>
          <button class="button button-primary" type="submit">Revisar importación</button></div>
      </form>`}`, { ...session, active: 'customers' });
}

// The delivery address is optional and single. Lines collapse to only the parts that are filled in.
function addressLines(address) {
  if (!address) return [];
  return [
    [address.first_name, address.last_name].filter(Boolean).join(' '),
    address.company,
    address.address1,
    address.address2,
    [address.city, address.state].filter(Boolean).join(', '),
    address.postal_code,
    address.country,
  ].filter(Boolean);
}

// The address is optional and single and lives inline inside the customer form, so saving with every
// field empty removes it. The country is fixed; the state is restricted to the Venezuela list.
function addressFields(address) {
  address = address ?? {};
  const value = (column) => escapeHtml(address[column] ?? '');
  const state = address.state ?? '';
  return `
    <h3 class="form-subheading">Dirección</h3>
    <p class="form-hint">Opcional. Una sola dirección de entrega por cliente. Todos los campos son opcionales.</p>
    <div class="form-grid">
      <div class="field field-wide"><label for="addressCountry">País o región</label>
        <input id="addressCountry" name="addressCountry" value="${escapeHtml(DEFAULT_COUNTRY)}" readonly></div>
      <div class="field"><label for="addressFirstName">Nombre</label>
        <input id="addressFirstName" name="addressFirstName" value="${value('first_name')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field"><label for="addressLastName">Apellido</label>
        <input id="addressLastName" name="addressLastName" value="${value('last_name')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field field-wide"><label for="addressCompany">Empresa</label>
        <input id="addressCompany" name="addressCompany" value="${value('company')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field field-wide"><label for="address1">Calle y número de casa</label>
        <input id="address1" name="address1" value="${value('address1')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field field-wide"><label for="address2">Apartamento, local, etc.</label>
        <input id="address2" name="address2" value="${value('address2')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field"><label for="addressPostalCode">Código postal</label>
        <input id="addressPostalCode" name="addressPostalCode" value="${value('postal_code')}" maxlength="${MAX_POSTAL_CODE}"></div>
      <div class="field"><label for="addressCity">Ciudad</label>
        <input id="addressCity" name="addressCity" value="${value('city')}" maxlength="${MAX_ADDRESS}"></div>
      <div class="field field-wide"><label for="addressState">Estado</label>
        <select id="addressState" name="addressState">
          <option value="">Selecciona un estado</option>
          ${VENEZUELA_STATES.map((name) => `<option value="${escapeHtml(name)}"${name === state ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
        </select></div>
    </div>`;
}

// "Cliente al vuelo": a reusable modal that posts to /customers/inline and adds the new customer to
// the customer combo in place, without leaving the order or draft being written. It hides itself
// unless the browser runs scripts, and can be closed by clicking the backdrop or pressing Escape.
function inlineCustomerDialog() {
  const required = '<span class="required-mark">Obligatorio</span>';
  const optional = '<span class="optional-mark">Opcional</span>';
  return `<dialog class="customer-dialog" data-customer-dialog aria-label="Nuevo cliente">
    <form class="product-form" method="post" action="/customers/inline" data-customer-inline>
      <header class="customer-dialog__head">
        <div><p class="eyebrow">Cliente al vuelo</p><h2>Nuevo cliente</h2>
          <p class="form-hint">El cliente queda en Clientes y se asigna al pedido al guardarlo. El RIF / Cédula es único.</p></div>
        <button type="button" class="customer-dialog__close" data-customer-close aria-label="Cerrar">×</button>
      </header>
      <p class="form-error" role="alert" data-customer-error hidden></p>
      <div class="customer-dialog__grid">
        <div class="field"><label for="inline-name">Nombre ${required}</label>
          <input id="inline-name" name="name" maxlength="${MAX_NAME}" required></div>
        <div class="field"><label for="inline-lastName">Apellido ${optional}</label>
          <input id="inline-lastName" name="lastName" maxlength="${MAX_NAME}"></div>
        <div class="field"><label for="inline-taxId">RIF / Cédula ${required}</label>
          <input id="inline-taxId" name="taxId" maxlength="${MAX_TAX_ID}" placeholder="V-12345678-9" required></div>
        <div class="field"><label for="inline-email">Correo electrónico ${required}</label>
          <input id="inline-email" name="email" type="email" maxlength="${MAX_EMAIL}" required></div>
        <div class="field"><label for="inline-phone">Número de teléfono ${required}</label>
          <input id="inline-phone" name="phone" maxlength="${MAX_PHONE}" placeholder="+58 412 000 0000" required></div>
      </div>
      <details class="price-extra">
        <summary>Dirección y notas</summary>
        <p class="form-hint">La dirección es opcional. El estado debe ser de Venezuela.</p>
        <div class="form-grid">
          <div class="field field-wide"><label for="inline-address1">Calle y número de casa</label>
            <input id="inline-address1" name="address1" maxlength="${MAX_ADDRESS}"></div>
          <div class="field"><label for="inline-addressCity">Ciudad</label>
            <input id="inline-addressCity" name="addressCity" maxlength="${MAX_ADDRESS}"></div>
          <div class="field"><label for="inline-addressState">Estado</label>
            <select id="inline-addressState" name="addressState">
              <option value="">Selecciona un estado</option>
              ${VENEZUELA_STATES.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}
            </select></div>
        </div>
        <div class="field"><label for="inline-notes">Notas</label>
          <textarea id="inline-notes" name="notes" rows="3" maxlength="${MAX_NOTES}" placeholder="Notas internas"></textarea></div>
      </details>
      <div class="form-actions">
        <button type="button" class="button button-quiet" data-customer-close>Cancelar</button>
        <button type="button" class="button button-primary" data-customer-submit>Guardar y usar</button>
      </div>
    </form>
  </dialog>`;
}

// The principal email and phone are required; extra contacts live behind "Datos adicionales".
export function customerFormPage({ customer = {}, error = '', isNew = true, ...session }) {
  const emails = customer.emails ?? [];
  const phones = customer.phones ?? [];
  const action = isNew ? '/customers' : `/customers/${customer.id}`;
  const title = isNew ? 'Nuevo cliente' : 'Editar cliente';
  const required = '<span class="required-mark">Obligatorio</span>';
  const optional = '<span class="optional-mark">Opcional</span>';
  const hasExtras = Boolean(emails[1] || emails[2] || phones[1] || phones[2]);
  const content = `
    <div class="breadcrumb"><a href="/customers">Clientes</a><span aria-hidden="true">/</span><span>${title}</span></div>
    <div class="page-heading form-heading"><div><p class="eyebrow">Ficha del cliente</p><h1>${title}</h1></div></div>
    <form class="product-form product-form--split" method="post" action="${action}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <div class="product-layout">
        <div class="product-layout__main">
          <section class="form-section form-card">
            <h2>Descripción general del cliente</h2>
            <div class="form-grid">
              <div class="field"><label for="name">Nombre ${required}</label>
                <input id="name" name="name" value="${escapeHtml(customer.name ?? '')}" maxlength="${MAX_NAME}" required></div>
              <div class="field"><label for="lastName">Apellido ${optional}</label>
                <input id="lastName" name="lastName" value="${escapeHtml(customer.last_name ?? '')}" maxlength="${MAX_NAME}"></div>
              <div class="field"><label for="taxId">RIF / Cédula ${required}</label>
                <input id="taxId" name="taxId" value="${escapeHtml(customer.tax_id ?? '')}" maxlength="${MAX_TAX_ID}" placeholder="V-12345678-9" required>
                <p class="form-hint">Identifica al cliente y evita duplicados.</p></div>
              <div class="field"><label for="email">Correo electrónico ${required}</label>
                <input id="email" name="email" type="email" value="${escapeHtml(emails[0] ?? '')}" maxlength="${MAX_EMAIL}" required></div>
              <div class="field"><label for="phone">Número de teléfono ${required}</label>
                <input id="phone" name="phone" value="${escapeHtml(phones[0] ?? '')}" maxlength="${MAX_PHONE}" placeholder="+58 412 000 0000" required></div>
            </div>
            <details class="price-extra"${hasExtras ? ' open' : ''}>
              <summary>Datos adicionales</summary>
              <p class="form-hint">Hasta 3 correos y 3 teléfonos en total, con el principal primero. Deja un campo vacío para no guardarlo.</p>
              <div class="form-grid">
                <div class="field"><label for="emailExtra1">Correo adicional</label>
                  <input id="emailExtra1" name="emailExtra1" type="email" value="${escapeHtml(emails[1] ?? '')}" maxlength="${MAX_EMAIL}"></div>
                <div class="field"><label for="emailExtra2">Correo adicional</label>
                  <input id="emailExtra2" name="emailExtra2" type="email" value="${escapeHtml(emails[2] ?? '')}" maxlength="${MAX_EMAIL}"></div>
                <div class="field"><label for="phoneExtra1">Teléfono adicional</label>
                  <input id="phoneExtra1" name="phoneExtra1" value="${escapeHtml(phones[1] ?? '')}" maxlength="${MAX_PHONE}"></div>
                <div class="field"><label for="phoneExtra2">Teléfono adicional</label>
                  <input id="phoneExtra2" name="phoneExtra2" value="${escapeHtml(phones[2] ?? '')}" maxlength="${MAX_PHONE}"></div>
              </div>
            </details>
            ${addressFields(customer.address)}
          </section>
          <div class="form-actions">
            <a class="button button-secondary" href="/customers">Cancelar</a>
            <button class="button button-primary" type="submit">Guardar cliente</button>
          </div>
        </div>
        <aside class="product-layout__side">
          <section class="form-section form-card">
            <h2>Notas</h2>
            <p class="form-hint">Las notas son privadas y no se comparten con el cliente.</p>
            <div class="field"><label class="visually-hidden" for="notes">Notas</label>
              <textarea id="notes" name="notes" rows="5" maxlength="${MAX_NOTES}" placeholder="Notas internas">${escapeHtml(customer.notes ?? '')}</textarea></div>
          </section>
        </aside>
      </div>
    </form>`;
  return page(title, content, { ...session, active: 'customers' });
}

export function customerDetailPage({ customer, message = '', ...session }) {
  const emails = customer.emails ?? [];
  const phones = customer.phones ?? [];
  const contacts = (values) => values.length
    ? values.map((value, index) => `${escapeHtml(value)}${index === 0 ? ' <span class="presentation-tag">Principal</span>' : ''}`).join('<br>')
    : '—';
  const lines = addressLines(customer.address);
  const content = `
    <div class="breadcrumb"><a href="/customers">Clientes</a><span aria-hidden="true">/</span><span>Ficha del cliente</span></div>
    <div class="page-heading"><h1>${escapeHtml(customerName(customer))}</h1>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/customers/${customer.id}/edit">Editar cliente</a>` : ''}</div>
    <section class="product-form form-section">
      <dl class="product-details">
        <dt>Nombre</dt><dd>${escapeHtml(customer.name)}</dd>
        <dt>Apellido</dt><dd>${escapeHtml(customer.last_name || '—')}</dd>
        <dt>RIF / Cédula</dt><dd>${escapeHtml(customer.tax_id)}</dd>
        <dt>Correo electrónico</dt><dd>${contacts(emails)}</dd>
        <dt>Número de teléfono</dt><dd>${contacts(phones)}</dd>
        <dt>Dirección predeterminada</dt><dd>${lines.length ? lines.map(escapeHtml).join('<br>') : 'Sin dirección'}</dd>
        <dt>Notas</dt><dd class="long-description">${customer.notes ? escapeHtml(customer.notes) : '—'}</dd>
      </dl>
    </section>`;
  return page(customerName(customer), content, { ...session, active: 'customers', message });
}

export function notFoundPage(session = {}) {
  return page('No encontrado', `
    <section class="empty-state not-found">
      <p class="eyebrow">404</p>
      <h1>No encontramos ese repuesto</h1>
      <p>Puede que el enlace ya no exista o que el artículo se haya eliminado.</p>
      <a class="button button-secondary" href="/inventory">Volver al inventario</a>
    </section>`, session);
}

export function renderPresentations() {
  return PRESENTATIONS;
}

export function stockPage({ product, change, confirmationToken, values = {}, error = '', ...session }) {
  return page('Ajustar inventario', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span>/</span><a href="/products/${product.id}/history">Historial</a></div>
    <div class="page-heading"><div><p class="eyebrow">${escapeHtml(product.part_number)} · ${escapeHtml(presentationLabel(product.presentation))}</p>
      <h1>${change ? 'Revisar cambio' : 'Ajustar inventario'}</h1><p>${escapeHtml(product.description)}</p></div></div>
    <form class="product-form" method="post" action="/products/${product.id}/stock${change ? '/confirm' : ''}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <section class="form-section">
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        ${change ? `
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
          <h2>${change.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'} ${change.quantity} ${escapeHtml(presentationLabel(change.presentation))}</h2>
          <p>Anterior: <strong>${change.previousQuantity}</strong> → Nueva: <strong>${change.newQuantity}</strong></p>
          <p>Motivo: ${escapeHtml(change.reason || 'Sin motivo')}</p>` : `
          <p>Disponible: <strong>${product.quantity}</strong> ${escapeHtml(presentationLabel(product.presentation))}</p>
          <p class="form-hint">Cuenta presentaciones vendibles completas; no componentes de SET o KIT.</p>
          <div class="form-grid">
            <div class="field"><label for="operation">Operación</label><select id="operation" name="operation" required>
              <option value="adjust" ${values.operation === 'adjust' ? 'selected' : ''}>Ajustar por — sumar o restar</option>
              <option value="set" ${values.operation === 'set' ? 'selected' : ''}>Establecer en — total exacto</option>
            </select></div>
            <div class="field"><label for="quantity">Cantidad (${escapeHtml(presentationLabel(product.presentation))})</label>
              <input id="quantity" name="quantity" type="number" step="1" value="${escapeHtml(values.quantity ?? '')}" required></div>
            <div class="field field-wide"><label for="reason">Motivo (opcional)</label>
              <input id="reason" name="reason" maxlength="500" value="${escapeHtml(values.reason ?? '')}"></div>
          </div>`}
      </section>
      <div class="form-actions"><a class="button button-quiet" href="/products/${product.id}/${change ? 'stock' : 'history'}">${change ? 'Volver' : 'Cancelar'}</a>
        <button class="button button-primary" type="submit">${change ? 'Confirmar cambio' : 'Revisar cambio'}</button></div>
    </form>`, session);
}

export function historyPage({ product, movements, ...session }) {
  return page('Historial de inventario', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span>/</span><span>Historial</span></div>
    <div class="page-heading"><div><p class="eyebrow">${escapeHtml(product.part_number)}</p><h1>Historial de inventario</h1>
      <p>${escapeHtml(product.description)} · Disponible: <strong>${product.quantity}</strong> ${escapeHtml(presentationLabel(product.presentation))}</p></div>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/products/${product.id}/stock">Ajustar inventario</a>` : ''}</div>
    <section class="inventory-panel" aria-label="Movimientos de inventario">
      ${movements.length ? `<div class="table-scroll"><table><thead><tr>
        <th>Fecha/hora (UTC)</th><th>Usuario</th><th>Operación</th><th>Cantidad</th><th>Anterior</th><th>Nueva</th><th>Presentación</th><th>Motivo</th><th>Origen</th>
      </tr></thead><tbody>${movements.map((movement) => `<tr>
        <td><time datetime="${escapeHtml(movement.created_at)}">${escapeHtml(movement.created_at.replace('T', ' ').replace('Z', ' UTC'))}</time></td>
        <td>${escapeHtml(movement.username)}</td><td>${movement.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'}</td>
        <td>${movement.quantity}</td><td>${movement.previous_quantity}</td><td>${movement.new_quantity}</td>
         <td>${escapeHtml(presentationLabel(movement.presentation))}</td><td>${escapeHtml(movement.reason || '—')}</td>
         <td>${movementSourceLabel(movement.source)}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>Todavía no hay movimientos.</p></div>'}
    </section>`, session);
}

function importDetails(product, names = {}) {
  if (!product) return 'Artículo nuevo';
  const longDescription = product.long_description ?? product.longDescription ?? '';
  const priceCents = product.price_cents ?? product.priceCents ?? null;
  const minimum = product.minimum_stock ?? product.minimumStock;
  return `${escapeHtml(product.description)} · ${escapeHtml(presentationLabel(product.presentation))}${longDescription ? `<br>${escapeHtml(longDescription)}` : ''}<br>
    Marca: ${escapeHtml(product.brand || '—')} · Ubicación: ${escapeHtml(product.location || '—')} · Mínimo: ${escapeHtml(minimum ?? '—')} · Categoría: ${escapeHtml(names.category || 'Sin categoría')}
    · Tipo: ${escapeHtml(names.productType || '—')} · Proveedor: ${escapeHtml(names.supplier || '—')} · Precio: ${priceCents == null ? '—' : `$${formatCents(priceCents)}`}`;
}

export function importPage({ review, confirmationToken, error = '', view = 'inventory', ...session }) {
  const inventory = view === 'inventory';
  const route = inventory ? '/inventory' : '/products';
  const title = inventory ? 'Importar inventario' : 'Importar productos';
  const invalid = review?.rows.filter((row) => row.errors.length).length ?? 0;
  return page(title, `
    <div class="breadcrumb"><a href="${route}">${inventory ? 'Inventario' : 'Productos'}</a><span>/</span><span>Importar Excel</span></div>
    <div class="page-heading"><div><p class="eyebrow">Carga revisada</p><h1>${review ? 'Revisar importación' : title}</h1>
      <p>Los cambios solo se guardan al confirmar el lote completo.</p></div></div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${review ? `
      <section class="inventory-panel" aria-label="Vista previa de importación">
        <div class="table-toolbar"><div><h2>${review.rows.filter((row) => !row.previous && !row.errors.length).length} altas · ${review.rows.filter((row) => row.previous && !row.errors.length).length} actualizaciones · ${invalid} filas con errores</h2>
          <p>Catálogo, categoría, tipo y proveedor: ${review.descriptions ? 'sí' : 'no'} · Inventario: ${review.stock ? (review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en') : 'sin cambios'}</p></div></div>
        <div class="table-scroll"><table><thead><tr><th>Fila</th><th>P/N</th><th>Resultado</th><th>Datos anteriores</th><th>Datos nuevos</th><th>Inventario</th><th>Errores</th></tr></thead>
          <tbody>${review.rows.map((row) => `<tr><td>${row.number}</td><td>${escapeHtml(row.partNumber)}</td>
            <td>${row.errors.length ? 'Error' : row.previous ? 'Actualización' : 'Alta'}</td>
            <td>${importDetails(row.previous, { category: row.previous?.category_name, productType: row.previous?.product_type_name, supplier: row.previous?.supplier_name })}</td>
            <td>${review.descriptions && row.product ? importDetails(row.product, { category: row.categoryName, productType: row.productTypeName, supplier: row.supplierName }) : (row.previous ? 'Sin cambios de catálogo' : '—')}</td>
            <td>${row.change ? `${row.change.previousQuantity} → ${row.change.newQuantity} ${escapeHtml(presentationLabel(row.change.presentation))}<br>${review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'} ${row.change.quantity}` : 'Sin cambios'}</td>
            <td>${row.errors.map(escapeHtml).join('<br>')}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      ${invalid ? '<p class="form-error" role="alert">Corrige todas las filas con errores y vuelve a cargar el archivo. No se aplicará ninguna fila.</p>' : `
        <form method="post" action="/imports/confirm" class="form-actions">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <input type="hidden" name="view" value="${view}">
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
          <button class="button button-primary" type="submit">Confirmar importación</button>
        </form>`}
      <form method="post" action="/imports/cancel" class="form-actions">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <input type="hidden" name="view" value="${view}">
        <a class="button button-secondary" href="/imports?view=${view}">Cargar otro archivo</a>
        <button class="button button-quiet" type="submit">Cancelar importación</button>
      </form>` : `
      <form class="product-form" method="post" action="/imports" enctype="multipart/form-data">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <input type="hidden" name="view" value="${view}">
        <section class="form-section"><h2>Archivo y opciones</h2>
          <p>Excel .xlsx, una sola hoja, hasta 2 MB y 1000 filas. Primera fila: encabezados.</p>
          ${inventory ? `
          <p>Columnas: <strong>P/N, Cantidad</strong>. La importación de Inventario solo actualiza el inventario de artículos que ya existen y rechaza los P/N desconocidos.</p>
          <p>Guarda P/N como texto para conservar ceros iniciales. Usa valores, sin fórmulas.</p>` : `
          <p>Columnas: <strong>P/N, Producto, Descripción, Presentación, Marca, Ubicación, Mínimo de stock, Categoría, Tipo, Proveedor, Precio, Estado</strong> y, opcionalmente, <strong>Cantidad</strong>.</p>
          <p>Guarda P/N como texto para conservar ceros iniciales. Presentación: SET, KIT o unidad (EA en pantalla). Precio en dólares con hasta dos decimales. Usa valores, sin fórmulas.</p>
          <p>Se requieren P/N, Producto (o Descripción en archivos antiguos) y Presentación. «Producto» es el nombre y «Descripción» la descripción larga; si el archivo solo trae «Descripción», se usa como nombre.
            Las columnas opcionales ausentes se conservan; las celdas vacías las borran. Categoría, tipo y proveedor escritos se crean o reutilizan sin duplicar equivalentes.
            «Estado» es informativo: archivar y desarchivar se hace desde la ficha del producto. Las altas sin stock comienzan en cero.</p>`}
          <div class="field"><label for="file">Archivo Excel</label><input id="file" name="file" type="file" accept=".xlsx" required></div>
          ${inventory ? '' : '<p><label><input type="checkbox" name="stock"> Importar inventario además del catálogo</label></p>'}
          <div class="field"><label for="operation">Operación para inventario</label><select id="operation" name="operation" ${inventory ? 'required' : ''}>
            <option value="">Selecciona si importas inventario</option>
            <option value="adjust">Ajustar por — sumar o restar la cantidad importada</option>
            <option value="set">Establecer en — total exacto indicado</option>
          </select></div>
        </section>
        <div class="form-actions"><a class="button button-quiet" href="${route}">Volver a ${inventory ? 'Inventario' : 'Productos'}</a>
          <button class="button button-primary" type="submit">Revisar importación</button></div>
      </form>`}`, session);
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUtc(value) {
  return String(value).replace('T', ' ').replace('Z', ' UTC');
}

function backupCounts(backup) {
  const articles = backup.products ?? 0;
  const movements = backup.movements ?? 0;
  const purchases = backup.purchaseOrders ?? 0;
  const customers = backup.customers ?? 0;
  const images = backup.images ?? 0;
  return `${articles} ${articles === 1 ? 'artículo' : 'artículos'} · ${movements} ${movements === 1 ? 'movimiento' : 'movimientos'} · ${backup.categories ?? 0} categorías · ${purchases} ${purchases === 1 ? 'lista de compra' : 'listas de compra'} · ${customers} ${customers === 1 ? 'cliente' : 'clientes'} · ${images} ${images === 1 ? 'imagen' : 'imágenes'}`;
}

export function backupsPage({ backups, lastRestore = null, error = '', message = '', ...session }) {
  const rows = backups.map((backup) => `<tr>
    <td class="part-number">${escapeHtml(backup.file)}<br>
      <span class="muted">${backup.valid ? backupCounts(backup) : 'Copia dañada'}</span></td>
    <td><time datetime="${escapeHtml(backup.createdAt)}">${escapeHtml(formatUtc(backup.createdAt))}</time></td>
    <td class="quantity-cell">${escapeHtml(formatBytes(backup.size))}</td>
    <td>${backup.valid ? '<span class="presentation-tag">Correcta</span>' : 'No verificable'}</td>
    <td>${backup.valid
      ? `<a href="/backups/restore?file=${encodeURIComponent(backup.file)}">Restaurar</a>`
      : '<span class="muted">No se puede restaurar</span>'}</td>
  </tr>`).join('');

  const verification = lastRestore ? `
    <section class="inventory-panel" aria-label="Verificación de la restauración">
      <h2>Restauración completada y verificada</h2>
      <p>Copia restaurada: <strong>${escapeHtml(lastRestore.backup)}</strong>. Integridad correcta.</p>
      <p>Contenido restaurado: ${backupCounts(lastRestore)}.</p>
      <p>Copia de seguridad del estado anterior: <strong>${escapeHtml(lastRestore.safety)}</strong>.</p>
    </section>` : '';

  return page('Copias de seguridad', `
    <div class="page-heading">
      <div><p class="eyebrow">Administración</p><h1>Copias de seguridad</h1>
        <p class="page-subtitle">Las copias se crean automáticamente. Restaurar una copia devuelve cuentas, artículos, categorías, inventario, historial y listas de compra.</p></div>
      <form method="post" action="/backups">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <button class="button button-primary" type="submit">Crear copia ahora</button>
      </form>
    </div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${verification}
    <section class="inventory-panel" aria-label="Copias de seguridad disponibles">
      <h2>Copias disponibles</h2>
      ${backups.length ? `<div class="table-scroll"><table><thead><tr>
        <th scope="col">Copia</th><th scope="col">Creada (UTC)</th><th scope="col" class="align-right">Tamaño</th>
        <th scope="col">Integridad</th><th scope="col"><span class="visually-hidden">Acciones</span></th>
      </tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state"><p>Todavía no hay copias de seguridad.</p></div>'}
    </section>`, { ...session, active: 'backups', message });
}

export function restoreBackupPage({ backup, confirmationToken, ...session }) {
  return page('Restaurar copia', `
    <div class="breadcrumb"><a href="/backups">Copias de seguridad</a><span aria-hidden="true">/</span><span>Restaurar</span></div>
    <div class="page-heading"><div><p class="eyebrow">Administración</p><h1>Restaurar copia</h1>
      <p>Se reemplazarán los datos actuales. Antes de restaurar se guarda una copia de seguridad del estado anterior.</p></div></div>
    <section class="inventory-panel" aria-label="Detalles de la copia">
      <h2>${escapeHtml(backup.file)}</h2>
      <p>Creada: <time datetime="${escapeHtml(backup.createdAt)}">${escapeHtml(formatUtc(backup.createdAt))}</time> · Tamaño: ${escapeHtml(formatBytes(backup.size))}</p>
      <p>Contenido verificado: ${backupCounts(backup)} · Integridad correcta.</p>
    </section>
    <form method="post" action="/backups/restore" class="form-actions">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <input type="hidden" name="file" value="${escapeHtml(backup.file)}">
      <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
      <a class="button button-quiet" href="/backups">Cancelar</a>
      <button class="button button-primary" type="submit">Restaurar copia</button>
    </form>`, { ...session, active: 'backups' });
}
