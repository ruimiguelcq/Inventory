import { assignableRoles, canManageInventory } from './permissions.mjs';
import { MAX_LONG_DESCRIPTION, PRESENTATIONS as presentationValues, formatCents, stockStatus } from './products.mjs';

const PRESENTATIONS = presentationValues.map((value) => [value, value]);

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

// Shared stock marker: zero wins as agotado, then a positive quantity at or below the minimum.
function stockBadge(status) {
  return status === 'agotado' ? '<span class="badge badge-out">Agotado</span>'
    : status === 'stockbajo' ? '<span class="badge badge-low">Stock bajo</span>' : '';
}

function page(title, content, { active = 'inventory', username, role, csrfToken, message } = {}) {
  const navigation = username ? `
    <header class="topbar">
      <a class="brand" href="/products" aria-label="Taller Marino, productos">
        <span class="brand-mark" aria-hidden="true">T</span>
        <span>Taller Marino</span>
      </a>
      <nav aria-label="Administración">
        ${role === 'admin' ? `<a class="nav-link ${active === 'users' ? 'is-active' : ''}" href="/users">Cuentas y permisos</a>` : ''}
        ${role === 'admin' ? `<a class="nav-link ${active === 'backups' ? 'is-active' : ''}" href="/backups">Copias de seguridad</a>` : ''}
      </nav>
      <div class="account-area">
        <span class="account-name">${escapeHtml(username)}</span>
        <form method="post" action="/logout">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
          <button class="button button-quiet" type="submit">Cerrar sesión</button>
        </form>
      </div>
    </header>
    <aside class="sidebar"><nav aria-label="Navegación principal">
      ${[['products', '/products', 'Productos'], ['inventory', '/inventory', 'Inventario'], ['purchases', '/purchase-orders', 'Órdenes de compra']].map(([key, href, label]) => `<a class="sidebar-link ${key !== 'products' ? 'sidebar-child' : ''} ${active === key ? 'is-active' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}
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

function catalogPage({ products, filters = {}, categories = [], brands = [], pagination, queryParams = new URLSearchParams(), inventory = false, ...session }) {
  const canManage = canManageInventory(session.role);
  const archivedView = !inventory && (filters.state === 'archived' || (!filters.state && Boolean(filters.archived)));
  const route = inventory ? '/inventory' : '/products';
  const title = inventory ? 'Inventario' : 'Productos';
  const view = inventory ? 'inventory' : 'products';
  const importHref = `/imports?view=${view}`;
  const hasActiveFilter = Boolean(filters.q || filters.presentation || filters.category || filters.brand || filters.outOfStock || filters.lowStock);
  const csrfToken = session.csrfToken;
  // The "all" export carries the current filters and view state, so it covers every matching page.
  const exportParams = new URLSearchParams(queryParams);
  exportParams.delete('page');
  exportParams.delete('pageSize');
  exportParams.set('view', view);
  exportParams.set('scope', 'all');
  const exportHref = `/exports?${exportParams.toString()}`;

  const stockActions = (product) => {
    const history = `<a href="/products/${product.id}/history">Historial</a>`;
    if (!canManage) return history;
    if (product.archived) {
      return `${history} · <form method="post" action="/products/${product.id}/restore" class="inline-form">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="text-link">Desarchivar</button></form>`;
    }
    if (inventory) return `<a href="/products/${product.id}/stock">Ajustar existencias</a> · ${history}`;
    return `${history} · <form method="post" action="/products/${product.id}/archive" class="inline-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
      <button type="submit" class="text-link">Archivar</button></form>`;
  };

  const rows = products.map((product) => {
    const status = stockStatus(product);
    return `<tr>
      <td><input type="checkbox" name="id" value="${product.id}" form="export-selection" data-row-selection aria-label="Seleccionar ${escapeHtml(product.part_number)}"></td>
      <td><a class="product-description" href="/products/${product.id}">${escapeHtml(product.description)}</a></td>
      <td class="part-number">${escapeHtml(product.part_number)}</td>
      ${inventory ? '' : `<td><span class="status-tag">${product.archived ? 'Archivado' : 'Activo'}</span></td>`}
      <td class="quantity-cell">${product.quantity}${status ? ` ${stockBadge(status)}` : ''}</td>
      ${inventory ? `<td data-column="location" hidden>${escapeHtml(product.location || '—')}</td>
        <td data-column="minimum" hidden class="quantity-cell">${product.minimum_stock ?? '—'}</td>` : `<td class="muted">${escapeHtml(product.category_name ?? 'Sin categoría')}</td>
        <td>${escapeHtml(product.presentation)}</td><td>${escapeHtml(product.brand || '—')}</td>`}
      <td>${stockActions(product)}</td>
    </tr>`;
  }).join('');

  const header = `
    <thead><tr>
      <th scope="col"><input type="checkbox" data-select-all aria-label="Seleccionar todos los productos visibles"></th>
      <th scope="col">Nombre</th>
      <th scope="col">P/N</th>
      ${inventory ? '' : '<th scope="col">Estado</th>'}
      <th scope="col" class="align-right">Existencias</th>
      ${inventory ? '<th scope="col" data-column="location" hidden>Ubicación</th><th scope="col" data-column="minimum" hidden>Mínimo de stock</th>' : '<th scope="col">Categoría</th><th scope="col">Presentación</th><th scope="col">Marca</th>'}
      <th scope="col">Acciones</th>
    </tr></thead>`;

  const headingTitle = hasActiveFilter ? 'Resultados' : archivedView ? 'Repuestos archivados' : 'Todos';

  const emptyState = hasActiveFilter
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3>
      <p>Ningún repuesto coincide con la búsqueda o los filtros.</p>
      <a class="button button-secondary" href="${route}">Limpiar filtros</a></div>`
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

  const filterBar = `
    <form class="filter-bar" method="get" action="${route}">
      <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por P/N o descripción" aria-label="Buscar repuestos">
      <select name="presentation" aria-label="Filtrar por presentación">
        <option value="">Todas las presentaciones</option>
        ${PRESENTATIONS.map(([value]) => `<option value="${value}" ${filters.presentation === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select>
      <select name="category" aria-label="Filtrar por categoría">
        <option value="">Todas las categorías</option>
        <option value="none" ${filters.category === 'none' ? 'selected' : ''}>Sin categoría</option>
        ${categories.map((category) => `<option value="${category.id}" ${filters.category === String(category.id) ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}
      </select>
      <select name="brand" aria-label="Filtrar por marca">
        <option value="">Todas las marcas</option>
        ${brands.map((brand) => `<option value="${escapeHtml(brand)}" ${filters.brand === brand ? 'selected' : ''}>${escapeHtml(brand)}</option>`).join('')}
      </select>
      <label class="filter-check"><input type="checkbox" name="outOfStock" ${filters.outOfStock ? 'checked' : ''}> Agotados</label>
      <label class="filter-check"><input type="checkbox" name="lowStock" ${filters.lowStock ? 'checked' : ''}> Stock bajo</label>
      ${inventory ? '' : `<select name="state" aria-label="Filtrar por estado">
        <option value="active" ${filters.state === 'active' ? 'selected' : ''}>Activos</option>
        <option value="archived" ${archivedView ? 'selected' : ''}>Archivados</option>
        <option value="all" ${filters.state === 'all' ? 'selected' : ''}>Todos los estados</option>
      </select>`}
      <label class="page-size">Filas por página <select name="pageSize" aria-label="Filas por página">
        ${[25, 50, 100].map((size) => `<option value="${size}" ${(pagination?.pageSize ?? 50) === size ? 'selected' : ''}>${size}</option>`).join('')}
      </select></label>
      <button class="button button-secondary" type="submit">Filtrar</button>
      ${hasActiveFilter || archivedView || filters.state === 'all' ? `<a class="button button-quiet" href="${route}">Limpiar</a>` : ''}
    </form>`;

  const pageLink = (number, label) => {
    const params = new URLSearchParams(queryParams);
    params.set('page', number);
    params.set('pageSize', pagination.pageSize);
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
      <div class="form-actions">
        ${canManage ? `<a class="button button-secondary" href="${importHref}">${inventory ? 'Importar' : 'Importar productos'}</a>` : ''}
        <a class="button button-secondary" href="${escapeHtml(exportHref)}">${inventory ? 'Exportar' : 'Exportar productos'}</a>
        ${canManage && !inventory ? '<a class="button button-primary" href="/products/new">Agregar producto</a>' : ''}
      </div>
    </div>
    <section class="inventory-panel" aria-label="Lista de repuestos">
      <div class="table-toolbar">
        <div>
          <h2>${headingTitle}</h2>
        </div>
        <form id="export-selection" class="selection-actions" method="post" action="/exports">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="view" value="${view}">
          <input type="hidden" name="scope" value="selected">
          <span data-selection-count role="status">0 seleccionados</span>
          <button class="button button-secondary" type="submit" data-requires-selection disabled>Exportar selección a Excel</button>
          ${canManage && inventory ? '<button class="button button-secondary" type="submit" formaction="/purchase-orders/add-selection" data-requires-selection disabled>Añadir a lista de compra</button>' : ''}
          ${canManage && !inventory ? `<button class="button button-secondary" type="submit" formaction="/products/archive" data-requires-selection disabled>Archivar selección</button>
            <button class="button button-secondary" type="submit" formaction="/products/restore" data-requires-selection disabled>Desarchivar selección</button>` : ''}
        </form>
      </div>
      ${filterBar}
      ${inventory ? `<fieldset class="column-controls"><legend>Columnas opcionales</legend>
        <label><input type="checkbox" data-column-toggle="location"> Ubicación</label>
        <label><input type="checkbox" data-column-toggle="minimum"> Mínimo de stock</label>
      </fieldset>` : ''}
      ${archivedView ? '' : '<p class="export-hint">Para volver a importar: máximo 1000 filas y 2 MB por archivo. Divide exportaciones mayores en lotes conservando los encabezados.</p>'}
      ${products.length ? `
        <div class="table-scroll">
          <table>${header}<tbody>${rows}</tbody></table>
        </div>` : emptyState}
      ${pager}
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
        <p class="page-subtitle">Prepara los repuestos a pedir. Guardar un borrador no cambia las existencias ni crea movimientos.</p></div>
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
      <td><a class="product-description" href="/products/${line.id}">${escapeHtml(line.description)}</a>
        ${line.archived ? '<span class="status-tag">Archivado</span>' : ''}</td>
      <td class="quantity-cell">${line.quantity}${badge}</td>
      ${editable ? `<td><input class="line-quantity" type="number" min="1" step="1" inputmode="numeric"
          name="line-${line.line_id}" value="${escapeHtml(quantity)}" aria-label="Cantidad solicitada de ${escapeHtml(line.part_number)}"></td>
        <td class="row-action"><button class="text-link" type="submit" formaction="/purchase-orders/${order.id}/lines/${line.line_id}/remove">Retirar</button></td>`
        : `<td class="quantity-cell">${quantity === '' ? '<span class="muted">—</span>' : quantity}</td>`}
    </tr>`;
  }).join('');

  const table = lines.length ? `<div class="table-scroll"><table><thead><tr>
      <th scope="col">P/N</th><th scope="col">Nombre</th><th scope="col" class="align-right">Existencias</th>
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

// Review step for adding an Inventory selection: active articles only, new list or existing draft.
export function purchaseSelectionPage({ products = [], orders = [], confirmationToken = '', error = '', ...session }) {
  const rows = products.map((product) => {
    const status = stockStatus(product);
    return `<tr>
      <td class="part-number">${escapeHtml(product.part_number)}</td>
      <td><a class="product-description" href="/products/${product.id}">${escapeHtml(product.description)}</a></td>
      <td class="quantity-cell">${product.quantity}${status ? ` ${stockBadge(status)}` : ''}</td>
    </tr>`;
  }).join('');
  const destinationOptions = `<option value="new">Nueva lista de compra</option>
    ${orders.map((order) => `<option value="${order.id}">Compra #${order.id} · ${order.line_count} ${order.line_count === 1 ? 'artículo' : 'artículos'}</option>`).join('')}`;

  return page('Añadir a lista de compra', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span aria-hidden="true">/</span><span>Añadir a lista de compra</span></div>
    <div class="page-heading"><div><p class="eyebrow">Selección revisada</p><h1>Añadir a lista de compra</h1>
      <p class="page-subtitle">Solo se añaden artículos activos. Los artículos que ya están en la lista conservan su línea y cantidad; las líneas nuevas empiezan sin cantidad.</p></div></div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <section class="inventory-panel" aria-label="Artículos seleccionados">
      <h2>${products.length} ${products.length === 1 ? 'artículo seleccionado' : 'artículos seleccionados'}</h2>
      <div class="table-scroll"><table><thead><tr>
        <th scope="col">P/N</th><th scope="col">Nombre</th><th scope="col" class="align-right">Existencias</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    <form class="product-form" method="post" action="/purchase-orders/add-selection/confirm">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
      <section class="form-section"><h2>Lista de destino</h2>
        <div class="form-grid"><div class="field field-wide">
          <label for="destination">Añadir a</label>
          <select id="destination" name="destination" required>${destinationOptions}</select>
          <p class="form-hint">Las listas archivadas no se ofrecen como destino; reábrelas para seguir editándolas.</p>
        </div></div>
      </section>
      <div class="form-actions">
        <a class="button button-quiet" href="/inventory">Cancelar</a>
        <button class="button button-primary" type="submit">Añadir a la lista</button>
      </div>
    </form>`, { ...session, active: 'inventory' });
}

export function productDetailPage({ product, ...session }) {
  return page(product.description, `<div class="breadcrumb"><a href="/products">Productos</a><span>/</span><span>Ficha del producto</span></div>
    <div class="page-heading"><h1>${escapeHtml(product.description)}</h1>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/products/${product.id}/edit">Editar producto</a>` : ''}</div>
    <section class="product-form form-section"><h2>${escapeHtml(product.part_number)}</h2>
      <dl class="product-details">
        <dt>Estado</dt><dd>${product.archived ? 'Archivado' : 'Activo'}</dd>
        <dt>Existencias</dt><dd>${product.quantity}</dd>
        <dt>Precio</dt><dd>${product.price_cents == null ? '—' : `$${formatCents(product.price_cents)}`}</dd>
        <dt>Descripción</dt><dd class="long-description">${product.long_description ? escapeHtml(product.long_description) : '—'}</dd>
        <dt>Categoría</dt><dd>${escapeHtml(product.category_name ?? 'Sin categoría')}</dd>
        <dt>Tipo de producto</dt><dd>${escapeHtml(product.product_type_name ?? '—')}</dd>
        <dt>Proveedor</dt><dd>${escapeHtml(product.supplier_name ?? '—')}</dd>
        <dt>Presentación</dt><dd>${escapeHtml(product.presentation)}</dd>
        <dt>Marca</dt><dd>${escapeHtml(product.brand || '—')}</dd>
        <dt>Ubicación</dt><dd>${escapeHtml(product.location || '—')}</dd>
        <dt>Mínimo de stock</dt><dd>${product.minimum_stock ?? '—'}</dd>
      </dl>
      <a class="button button-secondary" href="/products/${product.id}/history">Historial</a>
      ${canManageInventory(session.role) && !product.archived ? `<a class="button button-secondary" href="/products/${product.id}/stock">Ajustar existencias</a>` : ''}
    </section>`, { ...session, active: 'products' });
}

function roleOptions(selectedRole = 'viewer') {
  return assignableRoles.map(([value, label]) => `<option value="${value}" ${selectedRole === value ? 'selected' : ''}>${label}</option>`).join('');
}

export function accountsPage({ users, account = {}, error = '', ...session }) {
  return page('Cuentas y permisos', `
    <div class="page-heading"><div><p class="eyebrow">Equipo</p><h1>Cuentas y permisos</h1>
      <p class="page-subtitle">Consulta permite ver el inventario. Gestión permite mantener artículos y existencias.</p></div></div>
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

export function productFormPage({ product = {}, categories = [], productTypes = [], suppliers = [], error = '', isNew = true, ...session }) {
  const presentationOptions = `
    <option value="" disabled ${product.presentation ? '' : 'selected'}>Selecciona una presentación</option>
    ${PRESENTATIONS.map(([value, label]) => `<option value="${value}" ${product.presentation === value ? 'selected' : ''}>${label}</option>`).join('')}
  `;
  const priceValue = product.price ?? (product.price_cents != null ? formatCents(product.price_cents) : '');
  const action = isNew ? '/products' : `/products/${product.id}`;
  const title = isNew ? 'Añadir repuesto' : 'Editar repuesto';
  const content = `
    <div class="breadcrumb"><a href="/products">Productos</a><span aria-hidden="true">/</span><span>${title}</span></div>
    <div class="page-heading form-heading">
      <div><p class="eyebrow">Ficha del artículo</p><h1>${title}</h1></div>
      ${!isNew ? `<div>Existencias: <strong>${product.quantity}</strong> · ${!product.archived ? `<a href="/products/${product.id}/stock">Ajustar existencias</a> · ` : ''}<a href="/products/${product.id}/history">Historial</a></div>` : ''}
    </div>
    <form class="product-form" method="post" action="${action}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="form-section">
        <h2>Identificación</h2>
        <p class="form-hint">P/N, Producto y Presentación son obligatorios. El estado por defecto es Activo.</p>
        <div class="form-grid">
          <div class="field field-wide">
            <label for="partNumber">P/N <span class="required-mark">Obligatorio</span></label>
            <input id="partNumber" name="partNumber" value="${escapeHtml(product.part_number ?? '')}" maxlength="100" required>
          </div>
          <div class="field field-wide">
            <label for="description">Producto <span class="required-mark">Obligatorio</span></label>
            <input id="description" name="description" value="${escapeHtml(product.description ?? '')}" maxlength="240" required>
          </div>
          <div class="field field-wide">
            <label for="longDescription">Descripción <span class="optional-mark">Opcional</span></label>
            <textarea id="longDescription" name="longDescription" rows="4" maxlength="${MAX_LONG_DESCRIPTION}">${escapeHtml(product.long_description ?? '')}</textarea>
            <p class="form-hint">Texto plano para detalles más allá del nombre.</p>
          </div>
          <div class="field">
            <label for="presentation">Presentación</label>
            <select id="presentation" name="presentation" required>${presentationOptions}</select>
          </div>
          <div class="field">
            <label for="price">Precio (USD) <span class="optional-mark">Opcional</span></label>
            <input id="price" name="price" inputmode="decimal" value="${escapeHtml(priceValue)}" placeholder="0.00">
            <p class="form-hint">Dólares con dos decimales.</p>
          </div>
        </div>
      </section>
      <section class="form-section">
        <h2>Clasificación</h2>
        <p class="form-hint">Las listas crecen al guardar: elige una existente o escribe una nueva.</p>
        <div class="form-grid">
          <div class="field">
            <label for="categoryId">Categoría <span class="optional-mark">Opcional</span></label>
            <select id="categoryId" name="categoryId">
              <option value="">Sin categoría</option>
              ${categories.map((category) => `<option value="${category.id}" ${String(product.category_id) === String(category.id) ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="newCategory">Crear categoría</label>
            <input id="newCategory" name="newCategory" value="${escapeHtml(product.new_category ?? '')}" maxlength="100" aria-describedby="category-help">
            <p id="category-help" class="form-hint">Elige Sin categoría para crear y asignar una nueva al guardar.</p>
          </div>
          <div class="field">
            <label for="productTypeId">Tipo de producto <span class="optional-mark">Opcional</span></label>
            <select id="productTypeId" name="productTypeId">
              <option value="">Sin tipo</option>
              ${productTypes.map((type) => `<option value="${type.id}" ${String(product.product_type_id) === String(type.id) ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="newProductType">Crear tipo de producto</label>
            <input id="newProductType" name="newProductType" value="${escapeHtml(product.new_product_type ?? '')}" maxlength="100">
            <p class="form-hint">Elige Sin tipo para crear y asignar uno nuevo al guardar.</p>
          </div>
          <div class="field">
            <label for="supplierId">Proveedor <span class="optional-mark">Opcional</span></label>
            <select id="supplierId" name="supplierId">
              <option value="">Sin proveedor</option>
              ${suppliers.map((supplier) => `<option value="${supplier.id}" ${String(product.supplier_id) === String(supplier.id) ? 'selected' : ''}>${escapeHtml(supplier.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="newSupplier">Crear proveedor</label>
            <input id="newSupplier" name="newSupplier" value="${escapeHtml(product.new_supplier ?? '')}" maxlength="100">
            <p class="form-hint">Elige Sin proveedor para crear y asignar uno nuevo al guardar.</p>
          </div>
          <div class="field">
            <label for="brand">Marca <span class="optional-mark">Opcional</span></label>
            <input id="brand" name="brand" value="${escapeHtml(product.brand ?? '')}" maxlength="100">
          </div>
        </div>
      </section>
      <section class="form-section">
        <h2>Almacén</h2>
        <p class="form-hint">La ubicación puede ser un estante, una caja u otra referencia interna.</p>
        <div class="form-grid">
          <div class="field">
            <label for="location">Ubicación principal <span class="optional-mark">Opcional</span></label>
            <input id="location" name="location" value="${escapeHtml(product.location ?? '')}" maxlength="120">
          </div>
          <div class="field">
            <label for="minimumStock">Mínimo de stock <span class="optional-mark">Opcional</span></label>
            <input id="minimumStock" name="minimumStock" type="number" min="0" step="1" value="${escapeHtml(product.minimum_stock ?? '')}">
          </div>
          ${isNew ? `<div class="field">
            <label for="initialQuantity">Cantidad inicial <span class="optional-mark">Opcional</span></label>
            <input id="initialQuantity" name="initialQuantity" type="number" min="0" step="1" value="${escapeHtml(product.initial_quantity ?? '')}">
            <p class="form-hint">Se registra en el historial como movimiento de alta.</p>
          </div>` : ''}
        </div>
      </section>
      <div class="form-actions">
        <a class="button button-quiet" href="/products">Cancelar</a>
        <button class="button button-primary" type="submit">Guardar repuesto</button>
      </div>
    </form>`;
  return page(title, content, { ...session, active: 'products' });
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
  return page('Ajustar existencias', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span>/</span><a href="/products/${product.id}/history">Historial</a></div>
    <div class="page-heading"><div><p class="eyebrow">${escapeHtml(product.part_number)} · ${escapeHtml(product.presentation)}</p>
      <h1>${change ? 'Revisar cambio' : 'Ajustar existencias'}</h1><p>${escapeHtml(product.description)}</p></div></div>
    <form class="product-form" method="post" action="/products/${product.id}/stock${change ? '/confirm' : ''}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      <section class="form-section">
        ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
        ${change ? `
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
          <h2>${change.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'} ${change.quantity} ${escapeHtml(change.presentation)}</h2>
          <p>Anterior: <strong>${change.previousQuantity}</strong> → Nueva: <strong>${change.newQuantity}</strong></p>
          <p>Motivo: ${escapeHtml(change.reason || 'Sin motivo')}</p>` : `
          <p>Disponible: <strong>${product.quantity}</strong> ${escapeHtml(product.presentation)}</p>
          <p class="form-hint">Cuenta presentaciones vendibles completas; no componentes de SET o KIT.</p>
          <div class="form-grid">
            <div class="field"><label for="operation">Operación</label><select id="operation" name="operation" required>
              <option value="adjust" ${values.operation === 'adjust' ? 'selected' : ''}>Ajustar por — sumar o restar</option>
              <option value="set" ${values.operation === 'set' ? 'selected' : ''}>Establecer en — total exacto</option>
            </select></div>
            <div class="field"><label for="quantity">Cantidad (${escapeHtml(product.presentation)})</label>
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
  return page('Historial de existencias', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span>/</span><span>Historial</span></div>
    <div class="page-heading"><div><p class="eyebrow">${escapeHtml(product.part_number)}</p><h1>Historial de existencias</h1>
      <p>${escapeHtml(product.description)} · Disponible: <strong>${product.quantity}</strong> ${escapeHtml(product.presentation)}</p></div>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/products/${product.id}/stock">Ajustar existencias</a>` : ''}</div>
    <section class="inventory-panel" aria-label="Movimientos de existencias">
      ${movements.length ? `<div class="table-scroll"><table><thead><tr>
        <th>Fecha/hora (UTC)</th><th>Usuario</th><th>Operación</th><th>Cantidad</th><th>Anterior</th><th>Nueva</th><th>Presentación</th><th>Motivo</th><th>Origen</th>
      </tr></thead><tbody>${movements.map((movement) => `<tr>
        <td><time datetime="${escapeHtml(movement.created_at)}">${escapeHtml(movement.created_at.replace('T', ' ').replace('Z', ' UTC'))}</time></td>
        <td>${escapeHtml(movement.username)}</td><td>${movement.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'}</td>
        <td>${movement.quantity}</td><td>${movement.previous_quantity}</td><td>${movement.new_quantity}</td>
         <td>${escapeHtml(movement.presentation)}</td><td>${escapeHtml(movement.reason || '—')}</td>
         <td>${movement.source === 'creation' ? 'Alta' : movement.source === 'import' ? 'Importación Excel' : 'Manual'}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>Todavía no hay movimientos.</p></div>'}
    </section>`, session);
}

function importDetails(product, categoryName) {
  if (!product) return 'Artículo nuevo';
  return `${escapeHtml(product.description)} · ${escapeHtml(product.presentation)}<br>
    Marca: ${escapeHtml(product.brand || '—')} · Ubicación: ${escapeHtml(product.location || '—')} · Mínimo: ${escapeHtml(product.minimumStock ?? product.minimum_stock ?? '—')} · Categoría: ${escapeHtml(categoryName || 'Sin categoría')}`;
}

export function importPage({ review, confirmationToken, error = '', view = 'inventory', ...session }) {
  const inventory = view === 'inventory';
  const route = inventory ? '/inventory' : '/products';
  const title = inventory ? 'Importar existencias' : 'Importar productos';
  const invalid = review?.rows.filter((row) => row.errors.length).length ?? 0;
  return page(title, `
    <div class="breadcrumb"><a href="${route}">${inventory ? 'Inventario' : 'Productos'}</a><span>/</span><span>Importar Excel</span></div>
    <div class="page-heading"><div><p class="eyebrow">Carga revisada</p><h1>${review ? 'Revisar importación' : title}</h1>
      <p>Los cambios solo se guardan al confirmar el lote completo.</p></div></div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${review ? `
      <section class="inventory-panel" aria-label="Vista previa de importación">
        <div class="table-toolbar"><div><h2>${review.rows.filter((row) => !row.previous && !row.errors.length).length} altas · ${review.rows.filter((row) => row.previous && !row.errors.length).length} actualizaciones · ${invalid} filas con errores</h2>
          <p>Catálogo y categoría: ${review.descriptions ? 'sí' : 'no'} · Existencias: ${review.stock ? (review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en') : 'sin cambios'}</p></div></div>
        <div class="table-scroll"><table><thead><tr><th>Fila</th><th>P/N</th><th>Resultado</th><th>Datos anteriores</th><th>Datos nuevos</th><th>Existencias</th><th>Errores</th></tr></thead>
          <tbody>${review.rows.map((row) => `<tr><td>${row.number}</td><td>${escapeHtml(row.partNumber)}</td>
            <td>${row.errors.length ? 'Error' : row.previous ? 'Actualización' : 'Alta'}</td>
            <td>${importDetails(row.previous, row.previous?.category_name)}</td>
            <td>${review.descriptions && row.product ? importDetails(row.product, row.categoryName) : (row.previous ? 'Sin cambios de catálogo' : '—')}</td>
            <td>${row.change ? `${row.change.previousQuantity} → ${row.change.newQuantity} ${escapeHtml(row.change.presentation)}<br>${review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'} ${row.change.quantity}` : 'Sin cambios'}</td>
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
          <p>Columnas: <strong>P/N, Cantidad</strong>. La importación de Inventario solo actualiza las existencias de artículos que ya existen y rechaza los P/N desconocidos.</p>
          <p>Guarda P/N como texto para conservar ceros iniciales. Usa valores, sin fórmulas.</p>` : `
          <p>Columnas: <strong>P/N, Descripción, Presentación, Marca, Ubicación, Mínimo de stock, Categoría</strong> y, opcionalmente, <strong>Cantidad</strong>.</p>
          <p>Guarda P/N como texto para conservar ceros iniciales. Presentación: SET, KIT o unidad. Usa valores, sin fórmulas.</p>
          <p>Se requieren P/N, Descripción y Presentación. La descripción se usa como nombre. Las columnas opcionales ausentes se conservan; las celdas vacías las borran.
            Una categoría escrita se crea o reutiliza sin duplicar categorías equivalentes. Las altas sin stock comienzan en cero.</p>`}
          <div class="field"><label for="file">Archivo Excel</label><input id="file" name="file" type="file" accept=".xlsx" required></div>
          ${inventory ? '' : '<p><label><input type="checkbox" name="stock"> Importar existencias además del catálogo</label></p>'}
          <div class="field"><label for="operation">Operación para existencias</label><select id="operation" name="operation" ${inventory ? 'required' : ''}>
            <option value="">Selecciona si importas existencias</option>
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
  return `${articles} ${articles === 1 ? 'artículo' : 'artículos'} · ${movements} ${movements === 1 ? 'movimiento' : 'movimientos'} · ${backup.categories ?? 0} categorías · ${purchases} ${purchases === 1 ? 'lista de compra' : 'listas de compra'}`;
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
        <p class="page-subtitle">Las copias se crean automáticamente. Restaurar una copia devuelve cuentas, artículos, categorías, existencias, historial y listas de compra.</p></div>
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
