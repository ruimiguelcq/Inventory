// Inline stock editing: the Disponible number opens a small editor in place. Without JavaScript the
// number remains a link to the full Ajustar existencias page. Events are delegated so the editor
// keeps working after an instant-search swap replaces the results.
const closeEditor = (form) => {
  form.hidden = true;
  form.closest('[data-stock-cell]')?.querySelector('[data-stock-open]')?.removeAttribute('hidden');
};
document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-stock-open]');
  if (open) {
    event.preventDefault();
    const form = open.closest('[data-stock-cell]')?.querySelector('[data-stock-form]');
    if (!form) return;
    form.hidden = false;
    open.hidden = true;
    form.querySelector('input[name="quantity"]')?.focus();
    return;
  }
  const cancel = event.target.closest('[data-stock-cancel]');
  if (cancel) closeEditor(cancel.closest('[data-stock-form]'));
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('[data-stock-form]:not([hidden])').forEach(closeEditor);
});
// "Fijar en" starts from the stored quantity for a recount; "Ajustar" is a signed delta, so it
// starts empty to avoid adding the current stock to itself.
document.addEventListener('change', (event) => {
  const select = event.target.closest('.stock-editor select[name="operation"]');
  if (!select) return;
  const input = select.closest('[data-stock-form]')?.querySelector('input[name="quantity"]');
  if (!input) return;
  input.value = select.value === 'adjust' ? '' : (input.dataset.current ?? '');
});

// Instant search: fetch the same server-rendered view and swap the results in place so the field
// keeps focus. The form's normal GET submission stays as the fallback when scripting fails.
const results = document.querySelector('[data-catalog-results]');
const exportLink = document.querySelector('.page-heading a[href^="/exports"]');
for (const form of document.querySelectorAll('[data-instant-search]')) {
  let timer;
  let currentUrl;
  const refresh = async () => {
    const url = `${form.action}?${new URLSearchParams(new FormData(form)).toString()}`;
    if (url === currentUrl) return;
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fresh = parsed.querySelector('[data-catalog-results]');
      if (!fresh || !results) return;
      results.replaceChildren(...fresh.childNodes);
      // The complete export follows the visible search, so it must track the swapped results too.
      const freshExport = parsed.querySelector('.page-heading a[href^="/exports"]');
      if (exportLink && freshExport) exportLink.setAttribute('href', freshExport.getAttribute('href'));
      currentUrl = url;
      history.replaceState(null, '', url);
    } catch {
      // Keep the current results; submitting the form still works.
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  form.addEventListener('input', (event) => {
    if (event.target.matches('input[type="search"]')) schedule();
  });
  form.addEventListener('change', (event) => {
    if (event.target.matches('select')) schedule();
  });
  form.addEventListener('submit', (event) => {
    if (!results) return;
    event.preventDefault();
    refresh();
  });
}

// Named-list combobox: each server-rendered <select> gains a searchable panel that can also
// create a value. Choosing writes the select value; creating writes the paired text input and
// clears the select, so the form keeps submitting the same fields (and still works without JS).
for (const combo of document.querySelectorAll('[data-combo]')) {
  const select = combo.querySelector('[data-combo-native]');
  const widget = combo.querySelector('[data-combo-widget]');
  const toggle = combo.querySelector('[data-combo-toggle]');
  const label = combo.querySelector('[data-combo-label]');
  const panel = combo.querySelector('[data-combo-panel]');
  const search = combo.querySelector('[data-combo-search]');
  const list = combo.querySelector('[data-combo-list]');
  const empty = combo.querySelector('[data-combo-empty]');
  const add = combo.querySelector('[data-combo-add]');
  const createWrap = combo.querySelector('[data-combo-create]');
  const createInput = createWrap ? createWrap.querySelector('input') : null;
  if (!select || !widget || !toggle || !label || !panel || !list || !empty || !add) continue;
  const options = [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() }));

  const syncLabel = () => {
    const created = createInput ? createInput.value.trim() : '';
    const current = options.find((option) => option.value === select.value);
    label.textContent = created && !select.value ? created : (current ? current.text : (options[0] ? options[0].text : ''));
  };
  const close = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  const render = (rawQuery) => {
    const query = rawQuery.trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const option of options) {
      if (query && !option.text.toLowerCase().includes(query)) continue;
      const item = document.createElement('li');
      item.textContent = option.text;
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      if (option.value === select.value) item.setAttribute('aria-selected', 'true');
      list.append(item);
      shown++;
    }
    empty.hidden = shown > 0;
    const exact = options.some((option) => option.text.toLowerCase() === query);
    if (createInput && query && !exact) {
      add.hidden = false;
      add.textContent = `Añadir «${rawQuery.trim()}»`;
    } else {
      add.hidden = true;
    }
  };
  const open = () => {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    search.value = '';
    render('');
    search.focus();
  };

  widget.hidden = false;
  combo.dataset.comboReady = 'true';
  syncLabel();

  toggle.addEventListener('click', () => (panel.hidden ? open() : close()));
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    close();
    toggle.focus();
  });
  list.addEventListener('click', (event) => {
    const item = event.target.closest('li[data-value]');
    if (!item) return;
    select.value = item.dataset.value;
    if (createInput) createInput.value = '';
    syncLabel();
    close();
  });
  add.addEventListener('click', () => {
    if (!createInput) return;
    createInput.value = search.value.trim();
    select.value = '';
    syncLabel();
    close();
  });
  document.addEventListener('click', (event) => {
    if (!combo.contains(event.target)) close();
  });
}

// Show the chosen file name inside the media box so the upload reads like Shopify's drop zone.
for (const input of document.querySelectorAll('.media-box__input')) {
  input.addEventListener('change', () => {
    const note = input.closest('.media-box') ? input.closest('.media-box').querySelector('[data-image-name]') : null;
    if (note) note.textContent = input.files && input.files[0] ? input.files[0].name : '';
  });
}

// Live margin: Ganancia follows Precio minus Precio de fábrica while the user types.
for (const card of document.querySelectorAll('.price-card')) {
  const price = card.querySelector('[data-price]');
  const cost = card.querySelector('[data-cost]');
  const profit = card.querySelector('[data-profit]');
  if (!price || !cost || !profit) continue;
  const amount = (value) => {
    const text = value.trim().replace(',', '.');
    return /^\d+(?:\.\d{1,2})?$/.test(text) ? Number(text) : null;
  };
  const update = () => {
    const sale = amount(price.value);
    const factory = amount(cost.value);
    if (sale === null || factory === null) {
      profit.textContent = '—';
      return;
    }
    const margin = sale - factory;
    profit.textContent = margin < 0 ? `-$${(-margin).toFixed(2)}` : `$${margin.toFixed(2)}`;
  };
  price.addEventListener('input', update);
  cost.addEventListener('input', update);
  update();
}
