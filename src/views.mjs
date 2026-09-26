import { assignableRoles, canManageInventory } from './permissions.mjs';
import { MAX_LONG_DESCRIPTION, PRESENTATIONS as presentationValues, formatCents, inventoryLevel, stockStatus } from './products.mjs';

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
  // read-only `N existencias` cell coloured by the product minimum.
  const stockCell = (product) => {
    const level = `quantity-cell inventory-${inventoryLevel(product)}`;
    if (!canManage) return `<td class="${level}">${product.quantity}</td>`;
    return `<td class="${level}" data-stock-cell>
        <a class="stock-value" href="/products/${product.id}/stock" data-stock-open aria-label="Ajustar existencias de ${escapeHtml(product.part_number)}">${product.quantity}</a>
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

  const headingTitle = hasActiveFilter ? 'Resultados' : archivedView ? 'Repuestos archivados' : 'Todos';

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
      <div class="table-toolbar">
        <div>
          <h2>${headingTitle}</h2>
        </div>
      </div>
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

export function productDetailPage({ product, ...session }) {
  return page(product.description, `<div class="breadcrumb"><a href="/products">Productos</a><span>/</span><span>Ficha del producto</span></div>
    <div class="page-heading"><h1>${escapeHtml(product.description)}</h1>
      ${canManageInventory(session.role) ? `<a class="button button-primary" href="/products/${product.id}/edit">Editar producto</a>` : ''}</div>
    <section class="product-form form-section">${product.image_filename ? `<img class="product-image" src="/products/${product.id}/image" alt="Imagen de ${escapeHtml(product.description)}">` : ''}
      <h2>${escapeHtml(product.part_number)}</h2>
      <dl class="product-details">
        <dt>Estado</dt><dd>${product.archived ? 'Archivado' : 'Activo'}</dd>
        <dt>Existencias</dt><dd>${product.quantity}</dd>
        <dt>Precio</dt><dd>${product.price_cents == null ? '—' : `$${formatCents(product.price_cents)}`}</dd>
        <dt>Precio de fábrica</dt><dd>${product.cost_cents == null ? '—' : `$${formatCents(product.cost_cents)}`}</dd>
        ${product.price_cents != null && product.cost_cents != null ? `<dt>Ganancia</dt><dd>${formatMargin(product.price_cents - product.cost_cents)}</dd>` : ''}
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

// A named list renders as a native <select> (the no-JS fallback and the submitted value) that
// catalog.js upgrades into a searchable combobox with optional inline creation.
function namedListCombo({ field, newField, newLabel, placeholder, searchPlaceholder, options, selectedId, canCreate, newValue = '' }) {
  const selected = String(selectedId ?? '');
  const optionMarkup = options.map((option) => `<option value="${option.id}" ${String(option.id) === selected ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('');
  return `<div class="combo" data-combo>
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
      ${!isNew ? `<div>Existencias: <strong>${product.quantity}</strong> · <a href="/products/${product.id}/history">Historial</a></div>` : ''}
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
              : `<p class="form-hint"><a href="/products/${product.id}/stock">Ajustar existencias</a>; cada cambio queda en el historial.</p>`}
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

function importDetails(product, names = {}) {
  if (!product) return 'Artículo nuevo';
  const longDescription = product.long_description ?? product.longDescription ?? '';
  const priceCents = product.price_cents ?? product.priceCents ?? null;
  const minimum = product.minimum_stock ?? product.minimumStock;
  return `${escapeHtml(product.description)} · ${escapeHtml(product.presentation)}${longDescription ? `<br>${escapeHtml(longDescription)}` : ''}<br>
    Marca: ${escapeHtml(product.brand || '—')} · Ubicación: ${escapeHtml(product.location || '—')} · Mínimo: ${escapeHtml(minimum ?? '—')} · Categoría: ${escapeHtml(names.category || 'Sin categoría')}
    · Tipo: ${escapeHtml(names.productType || '—')} · Proveedor: ${escapeHtml(names.supplier || '—')} · Precio: ${priceCents == null ? '—' : `$${formatCents(priceCents)}`}`;
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
          <p>Catálogo, categoría, tipo y proveedor: ${review.descriptions ? 'sí' : 'no'} · Existencias: ${review.stock ? (review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en') : 'sin cambios'}</p></div></div>
        <div class="table-scroll"><table><thead><tr><th>Fila</th><th>P/N</th><th>Resultado</th><th>Datos anteriores</th><th>Datos nuevos</th><th>Existencias</th><th>Errores</th></tr></thead>
          <tbody>${review.rows.map((row) => `<tr><td>${row.number}</td><td>${escapeHtml(row.partNumber)}</td>
            <td>${row.errors.length ? 'Error' : row.previous ? 'Actualización' : 'Alta'}</td>
            <td>${importDetails(row.previous, { category: row.previous?.category_name, productType: row.previous?.product_type_name, supplier: row.previous?.supplier_name })}</td>
            <td>${review.descriptions && row.product ? importDetails(row.product, { category: row.categoryName, productType: row.productTypeName, supplier: row.supplierName }) : (row.previous ? 'Sin cambios de catálogo' : '—')}</td>
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
          <p>Columnas: <strong>P/N, Producto, Descripción, Presentación, Marca, Ubicación, Mínimo de stock, Categoría, Tipo, Proveedor, Precio, Estado</strong> y, opcionalmente, <strong>Cantidad</strong>.</p>
          <p>Guarda P/N como texto para conservar ceros iniciales. Presentación: SET, KIT o unidad. Precio en dólares con hasta dos decimales. Usa valores, sin fórmulas.</p>
          <p>Se requieren P/N, Producto (o Descripción en archivos antiguos) y Presentación. «Producto» es el nombre y «Descripción» la descripción larga; si el archivo solo trae «Descripción», se usa como nombre.
            Las columnas opcionales ausentes se conservan; las celdas vacías las borran. Categoría, tipo y proveedor escritos se crean o reutilizan sin duplicar equivalentes.
            «Estado» es informativo: archivar y desarchivar se hace desde la ficha del producto. Las altas sin stock comienzan en cero.</p>`}
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
  const images = backup.images ?? 0;
  return `${articles} ${articles === 1 ? 'artículo' : 'artículos'} · ${movements} ${movements === 1 ? 'movimiento' : 'movimientos'} · ${backup.categories ?? 0} categorías · ${purchases} ${purchases === 1 ? 'lista de compra' : 'listas de compra'} · ${images} ${images === 1 ? 'imagen' : 'imágenes'}`;
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
