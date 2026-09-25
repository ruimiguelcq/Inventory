const PRESENTATIONS = [
  ['SET', 'Set'],
  ['KIT', 'Kit'],
  ['unidad', 'Unidad'],
];

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function page(title, content, { active = 'inventory', username, csrfToken, message } = {}) {
  const navigation = username ? `
    <header class="topbar">
      <a class="brand" href="/inventory" aria-label="Taller Marino, inventario">
        <span class="brand-mark" aria-hidden="true">T</span>
        <span>Taller Marino</span>
      </a>
      <nav aria-label="Navegación principal">
        <a class="nav-link ${active === 'inventory' ? 'is-active' : ''}" href="/inventory">Inventario</a>
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

export function setupPage({ error = '' } = {}) {
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

export function inventoryPage({ products, username, csrfToken, message = '' }) {
  const rows = products.map((product) => `
    <tr>
      <td class="part-number"><a href="/products/${product.id}/edit">${escapeHtml(product.part_number)}</a></td>
      <td><span class="product-description">${escapeHtml(product.description)}</span></td>
      <td><span class="presentation-tag">${escapeHtml(product.presentation)}</span></td>
      <td>${product.brand ? escapeHtml(product.brand) : '<span class="muted">—</span>'}</td>
      <td>${product.location ? escapeHtml(product.location) : '<span class="muted">—</span>'}</td>
      <td class="quantity-cell">${product.available_quantity}</td>
      <td class="row-action"><a class="text-link" href="/products/${product.id}/edit">Editar</a></td>
    </tr>`).join('');

  const content = `
    <div class="page-heading">
      <div>
        <p class="eyebrow">Almacén · 1 ubicación</p>
        <h1>Inventario de repuestos</h1>
        <p class="page-subtitle">Consulta y mantén las piezas de tu almacén.</p>
      </div>
      <a class="button button-primary" href="/products/new">Añadir repuesto</a>
    </div>
    <section class="inventory-panel" aria-label="Lista de repuestos">
      <div class="table-toolbar">
        <div>
          <h2>Todos los repuestos</h2>
          <p>${products.length} ${products.length === 1 ? 'artículo' : 'artículos'}</p>
        </div>
        <span class="toolbar-note">V1 · Inventario interno</span>
      </div>
      ${products.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th scope="col">P/N</th>
              <th scope="col">Repuesto</th>
              <th scope="col">Presentación</th>
              <th scope="col">Marca</th>
              <th scope="col">Ubicación</th>
              <th scope="col" class="align-right">Disponible</th>
              <th scope="col"><span class="visually-hidden">Acciones</span></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `
        <div class="empty-state">
          <span class="empty-icon" aria-hidden="true">⌁</span>
          <h3>Tu inventario está listo para empezar</h3>
          <p>Añade el primer repuesto con su P/N y presentación.</p>
          <a class="button button-secondary" href="/products/new">Añadir primer repuesto</a>
        </div>`}
    </section>`;
  return page('Inventario', content, { username, csrfToken, message });
}

export function productFormPage({ product = {}, username, csrfToken, error = '', isNew = true }) {
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
    </div>
    <form class="product-form" method="post" action="${action}">
      <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
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
            <label for="location">Ubicación <span class="optional-mark">Opcional</span></label>
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
  return page(title, content, { active: 'inventory', username, csrfToken });
}

export function notFoundPage({ username, csrfToken } = {}) {
  return page('No encontrado', `
    <section class="empty-state not-found">
      <p class="eyebrow">404</p>
      <h1>No encontramos ese repuesto</h1>
      <p>Puede que el enlace ya no exista o que el artículo se haya eliminado.</p>
      <a class="button button-secondary" href="/inventory">Volver al inventario</a>
    </section>`, { username, csrfToken });
}

export function renderPresentations() {
  return PRESENTATIONS;
}
