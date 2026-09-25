import { assignableRoles, canManageInventory } from './permissions.mjs';
import { PRESENTATIONS as presentationValues, stockStatus } from './products.mjs';

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

function page(title, content, { active = 'inventory', username, role, csrfToken, message } = {}) {
  const navigation = username ? `
    <header class="topbar">
      <a class="brand" href="/inventory" aria-label="Taller Marino, inventario">
        <span class="brand-mark" aria-hidden="true">T</span>
        <span>Taller Marino</span>
      </a>
      <nav aria-label="Navegación principal">
        <a class="nav-link ${active === 'inventory' ? 'is-active' : ''}" href="/inventory">Inventario</a>
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
    </header>` : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)} · Taller Marino</title>
    <link rel="stylesheet" href="/assets/style.css">
  </head>
  <body>
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

export function inventoryPage({ products, filters = {}, ...session }) {
  const canManage = canManageInventory(session.role);
  const archivedView = Boolean(filters.archived);
  const hasActiveFilter = Boolean(filters.q || filters.presentation || filters.outOfStock || filters.lowStock);
  const csrfToken = session.csrfToken;

  const badgeOf = (status) => status === 'agotado'
    ? '<span class="badge badge-out">Agotado</span>'
    : status === 'stockbajo' ? '<span class="badge badge-low">Stock bajo</span>' : '';

  const partNumberCell = (product) => (canManage && !archivedView)
    ? `<a href="/products/${product.id}/edit">${escapeHtml(product.part_number)}</a>`
    : escapeHtml(product.part_number);

  const stockActions = (product) => {
    const history = `<a href="/products/${product.id}/history">Historial</a>`;
    if (!canManage) return history;
    if (archivedView) {
      return `${history} · <form method="post" action="/products/${product.id}/restore" class="inline-form">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="text-link">Desarchivar</button></form>`;
    }
    return `${history} · <a href="/products/${product.id}/stock">Ajustar existencias</a> · <form method="post" action="/products/${product.id}/archive" class="inline-form">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
      <button type="submit" class="text-link">Archivar</button></form>`;
  };

  const rows = products.map((product) => {
    const status = stockStatus(product);
    return `<tr>
      ${archivedView ? '' : `<td><input type="checkbox" name="id" value="${product.id}" form="export-selection" aria-label="Seleccionar ${escapeHtml(product.part_number)}"></td>`}
      <td class="part-number">${partNumberCell(product)}</td>
      <td><span class="product-description">${escapeHtml(product.description)}</span></td>
      <td><span class="presentation-tag">${escapeHtml(product.presentation)}</span></td>
      <td>${product.brand ? escapeHtml(product.brand) : '<span class="muted">—</span>'}</td>
      <td>${product.location ? escapeHtml(product.location) : '<span class="muted">—</span>'}</td>
      <td class="quantity-cell">${product.minimum_stock ?? '<span class="muted">—</span>'}</td>
      <td class="quantity-cell">${product.quantity}${status ? ` ${badgeOf(status)}` : ''}</td>
      <td>${stockActions(product)}</td>
      ${canManage && !archivedView ? `<td class="row-action"><a class="text-link" href="/products/${product.id}/edit">Editar</a></td>` : ''}
    </tr>`;
  }).join('');

  const header = archivedView ? `
    <thead><tr>
      <th scope="col">P/N</th>
      <th scope="col">Repuesto</th>
      <th scope="col">Presentación</th>
      <th scope="col">Marca</th>
      <th scope="col">Ubicación</th>
      <th scope="col" class="align-right">Mínimo</th>
      <th scope="col" class="align-right">Disponible</th>
      <th scope="col">Existencias</th>
    </tr></thead>` : `
    <thead><tr>
      <th scope="col">Seleccionar</th>
      <th scope="col">P/N</th>
      <th scope="col">Repuesto</th>
      <th scope="col">Presentación</th>
      <th scope="col">Marca</th>
      <th scope="col">Ubicación</th>
      <th scope="col" class="align-right">Mínimo</th>
      <th scope="col" class="align-right">Disponible</th>
      <th scope="col">Existencias</th>
      ${canManage ? '<th scope="col"><span class="visually-hidden">Acciones</span></th>' : ''}
    </tr></thead>`;

  const headingTitle = hasActiveFilter ? 'Resultados' : archivedView ? 'Repuestos archivados' : 'Todos los repuestos';

  const emptyState = hasActiveFilter
    ? `<div class="empty-state"><span class="empty-icon" aria-hidden="true">⌁</span>
      <h3>Sin resultados</h3>
      <p>Ningún repuesto coincide con la búsqueda o los filtros.</p>
      <a class="button button-secondary" href="/inventory">Limpiar filtros</a></div>`
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
    <form class="filter-bar" method="get" action="/inventory">
      <input type="search" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="Buscar por P/N o descripción" aria-label="Buscar repuestos">
      <select name="presentation" aria-label="Filtrar por presentación">
        <option value="">Todas las presentaciones</option>
        ${PRESENTATIONS.map(([value]) => `<option value="${value}" ${filters.presentation === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select>
      <label class="filter-check"><input type="checkbox" name="outOfStock" ${filters.outOfStock ? 'checked' : ''}> Agotados</label>
      <label class="filter-check"><input type="checkbox" name="lowStock" ${filters.lowStock ? 'checked' : ''}> Stock bajo</label>
      <label class="filter-check"><input type="checkbox" name="archived" ${filters.archived ? 'checked' : ''}> Archivados</label>
      <button class="button button-secondary" type="submit">Filtrar</button>
      ${hasActiveFilter || archivedView ? '<a class="button button-quiet" href="/inventory">Limpiar</a>' : ''}
    </form>`;

  const content = `
    <div class="page-heading">
      <div>
        <p class="eyebrow">Almacén · 1 ubicación</p>
        <h1>Inventario de repuestos</h1>
        <p class="page-subtitle">Consulta y mantén las piezas de tu almacén.</p>
      </div>
      <div class="form-actions">
        <a class="button button-secondary" href="/exports?scope=all">Exportar todo a Excel</a>
        ${canManage ? '<a class="button button-secondary" href="/imports">Importar Excel</a><a class="button button-primary" href="/products/new">Añadir repuesto</a>' : ''}
      </div>
    </div>
    <section class="inventory-panel" aria-label="Lista de repuestos">
      <div class="table-toolbar">
        <div>
          <h2>${headingTitle}</h2>
          <p>${products.length} ${products.length === 1 ? 'artículo' : 'artículos'}</p>
        </div>
        ${archivedView ? '' : `<form id="export-selection" method="post" action="/exports">
          <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
          <input type="hidden" name="scope" value="selected">
          <button class="button button-secondary" type="submit" ${products.length ? '' : 'disabled'}>Exportar selección a Excel</button>
        </form>`}
      </div>
      ${filterBar}
      ${archivedView ? '' : '<p class="export-hint">Para volver a importar: máximo 1000 filas y 2 MB por archivo. Divide exportaciones mayores en lotes conservando los encabezados.</p>'}
      ${products.length ? `
        <div class="table-scroll">
          <table>${header}<tbody>${rows}</tbody></table>
        </div>` : emptyState}
    </section>`;
  return page('Inventario', content, session);
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

export function productFormPage({ product = {}, error = '', isNew = true, ...session }) {
  const presentationOptions = `
    <option value="" disabled ${product.presentation ? '' : 'selected'}>Selecciona una presentación</option>
    ${PRESENTATIONS.map(([value, label]) => `<option value="${value}" ${product.presentation === value ? 'selected' : ''}>${label}</option>`).join('')}
  `;
  const action = isNew ? '/products' : `/products/${product.id}`;
  const title = isNew ? 'Añadir repuesto' : 'Editar repuesto';
  const content = `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span aria-hidden="true">/</span><span>${title}</span></div>
    <div class="page-heading form-heading">
      <div><p class="eyebrow">Ficha del artículo</p><h1>${title}</h1></div>
      ${!isNew ? `<div><a href="/products/${product.id}/stock">Ajustar existencias</a> · <a href="/products/${product.id}/history">Historial</a></div>` : ''}
    </div>
    <form class="product-form" method="post" action="${action}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
      ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
      <section class="form-section">
        <h2>Identificación</h2>
        <p class="form-hint">El P/N identifica una presentación vendible.</p>
        <div class="form-grid">
          <div class="field field-wide">
            <label for="partNumber">P/N <span class="required-mark">Obligatorio</span></label>
            <input id="partNumber" name="partNumber" value="${escapeHtml(product.part_number ?? '')}" maxlength="100" required>
          </div>
          <div class="field field-wide">
            <label for="description">Descripción <span class="required-mark">Obligatoria</span></label>
            <input id="description" name="description" value="${escapeHtml(product.description ?? '')}" maxlength="240" required>
          </div>
          <div class="field">
            <label for="presentation">Presentación</label>
            <select id="presentation" name="presentation" required>${presentationOptions}</select>
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
        </div>
      </section>
      <div class="form-actions">
        <a class="button button-quiet" href="/inventory">Cancelar</a>
        <button class="button button-primary" type="submit">Guardar repuesto</button>
      </div>
    </form>`;
  return page(title, content, { ...session, active: 'inventory' });
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
         <td>${movement.source === 'import' ? 'Importación Excel' : 'Manual'}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><p>Todavía no hay movimientos.</p></div>'}
    </section>`, session);
}

function importDetails(product) {
  if (!product) return 'Artículo nuevo';
  return `${escapeHtml(product.description)} · ${escapeHtml(product.presentation)}<br>
    Marca: ${escapeHtml(product.brand || '—')} · Ubicación: ${escapeHtml(product.location || '—')} · Mínimo: ${escapeHtml(product.minimumStock ?? product.minimum_stock ?? '—')}`;
}

export function importPage({ review, confirmationToken, error = '', ...session }) {
  const invalid = review?.rows.filter((row) => row.errors.length).length ?? 0;
  return page('Importar Excel', `
    <div class="breadcrumb"><a href="/inventory">Inventario</a><span>/</span><span>Importar Excel</span></div>
    <div class="page-heading"><div><p class="eyebrow">Carga revisada</p><h1>${review ? 'Revisar importación' : 'Importar Excel'}</h1>
      <p>Los cambios solo se guardan al confirmar el lote completo.</p></div></div>
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    ${review ? `
      <section class="inventory-panel" aria-label="Vista previa de importación">
        <div class="table-toolbar"><div><h2>${review.rows.filter((row) => !row.previous && !row.errors.length).length} altas · ${review.rows.filter((row) => row.previous && !row.errors.length).length} actualizaciones · ${invalid} filas con errores</h2>
          <p>Datos descriptivos: ${review.descriptions ? 'sí' : 'no'} · Existencias: ${review.stock ? (review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en') : 'sin cambios'}</p></div></div>
        <div class="table-scroll"><table><thead><tr><th>Fila</th><th>P/N</th><th>Resultado</th><th>Datos anteriores</th><th>Datos nuevos</th><th>Existencias</th><th>Errores</th></tr></thead>
          <tbody>${review.rows.map((row) => `<tr><td>${row.number}</td><td>${escapeHtml(row.partNumber)}</td>
            <td>${row.errors.length ? 'Error' : row.previous ? 'Actualización' : 'Alta'}</td>
            <td>${importDetails(row.previous)}</td><td>${row.product ? importDetails(row.product) : '—'}</td>
            <td>${row.change ? `${row.change.previousQuantity} → ${row.change.newQuantity} ${escapeHtml(row.change.presentation)}<br>${review.operation === 'adjust' ? 'Ajustar por' : 'Establecer en'} ${row.change.quantity}` : 'Sin cambios'}</td>
            <td>${row.errors.map(escapeHtml).join('<br>')}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      ${invalid ? '<p class="form-error" role="alert">Corrige todas las filas con errores y vuelve a cargar el archivo. No se aplicará ninguna fila.</p>' : `
        <form method="post" action="/imports/confirm" class="form-actions">
          <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
          <button class="button button-primary" type="submit">Confirmar importación</button>
        </form>`}
      <form method="post" action="/imports/cancel" class="form-actions">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <a class="button button-secondary" href="/imports">Cargar otro archivo</a>
        <button class="button button-quiet" type="submit">Cancelar importación</button>
      </form>` : `
      <form class="product-form" method="post" action="/imports" enctype="multipart/form-data">
        <input type="hidden" name="csrfToken" value="${escapeHtml(session.csrfToken)}">
        <section class="form-section"><h2>Archivo y opciones</h2>
          <p>Excel .xlsx, una sola hoja, hasta 2 MB y 1000 filas. Primera fila: encabezados.</p>
          <p>Columnas: <strong>P/N, Descripción, Presentación, Marca, Ubicación, Mínimo de stock, Cantidad</strong>.
            Guarda P/N como texto para conservar ceros iniciales. Presentación: SET, KIT o unidad. Usa valores, sin fórmulas.</p>
          <p>Para datos descriptivos se requieren P/N, Descripción y Presentación. Las columnas opcionales ausentes se conservan; las celdas vacías las borran.
            Para solo existencias se requieren P/N y Cantidad y el artículo debe existir. Las altas sin stock comienzan en cero.</p>
          <div class="field"><label for="file">Archivo Excel</label><input id="file" name="file" type="file" accept=".xlsx" required></div>
          <p><label><input type="checkbox" name="descriptions" checked> Importar datos descriptivos</label></p>
          <p><label><input type="checkbox" name="stock"> Importar existencias</label></p>
          <div class="field"><label for="operation">Operación para existencias</label><select id="operation" name="operation">
            <option value="">Selecciona si importas existencias</option>
            <option value="adjust">Ajustar por — sumar o restar la cantidad importada</option>
            <option value="set">Establecer en — total exacto indicado</option>
          </select></div>
        </section>
        <div class="form-actions"><a class="button button-quiet" href="/inventory">Volver al inventario</a>
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
  return `${articles} ${articles === 1 ? 'artículo' : 'artículos'} · ${movements} ${movements === 1 ? 'movimiento' : 'movimientos'}`;
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
        <p class="page-subtitle">Las copias se crean automáticamente. Restaurar una copia devuelve artículos, existencias e historial.</p></div>
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
