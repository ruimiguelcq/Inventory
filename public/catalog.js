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
