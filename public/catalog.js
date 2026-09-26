const columnToggles = document.querySelectorAll('[data-column-toggle]');
const preferenceKey = 'taller-marino.inventory.columns';
let preferences = {};
try {
  const stored = JSON.parse(localStorage.getItem(preferenceKey));
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) preferences = stored;
} catch {
  // Storage can be unavailable or contain a stale value; the controls still work.
}

// Optional columns only exist in Inventory today. The toggles read the live DOM so they would keep
// working if the table were ever swapped in place.
const applyColumns = () => {
  for (const toggle of columnToggles) {
    const column = toggle.dataset.columnToggle;
    document.querySelectorAll(`[data-column="${column}"]`).forEach((cell) => {
      cell.hidden = !toggle.checked;
    });
  }
};

for (const toggle of columnToggles) {
  toggle.checked = preferences[toggle.dataset.columnToggle] === true;
  toggle.addEventListener('change', () => {
    preferences[toggle.dataset.columnToggle] = toggle.checked;
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {
      // Keep the current view usable even when persistence is blocked.
    }
    applyColumns();
  });
}
applyColumns();

// Selection state is read from the live DOM, so delegated events keep working after a swap.
const updateSelection = () => {
  const selectAll = document.querySelector('[data-select-all]');
  const selections = [...document.querySelectorAll('[data-row-selection]')];
  const count = selections.filter((input) => input.checked).length;
  if (selectAll) {
    selectAll.checked = count > 0 && count === selections.length;
    selectAll.indeterminate = count > 0 && count < selections.length;
  }
  document.querySelectorAll('[data-requires-selection]').forEach((button) => { button.disabled = count === 0; });
  const counter = document.querySelector('[data-selection-count]');
  if (counter) counter.textContent = `${count} seleccionados`;
};
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-select-all]')) {
    document.querySelectorAll('[data-row-selection]').forEach((input) => { input.checked = target.checked; });
  }
  if (target.matches('[data-select-all], [data-row-selection]')) updateSelection();
});
const clearSelection = () => {
  document.querySelectorAll('[data-row-selection]').forEach((input) => { input.checked = false; });
  updateSelection();
};
document.querySelector('.filter-bar')?.addEventListener('input', clearSelection);
document.querySelector('.filter-bar')?.addEventListener('change', clearSelection);
document.querySelector('.catalog-toolbar')?.addEventListener('input', clearSelection);
document.querySelector('.catalog-toolbar')?.addEventListener('change', clearSelection);
document.querySelectorAll('.pagination a').forEach((link) => link.addEventListener('click', clearSelection));
window.addEventListener('pageshow', clearSelection);

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
      updateSelection();
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
