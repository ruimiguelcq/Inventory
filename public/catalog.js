const columnToggles = document.querySelectorAll('[data-column-toggle]');
const preferenceKey = 'taller-marino.inventory.columns';
let preferences = {};
try {
  const stored = JSON.parse(localStorage.getItem(preferenceKey));
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) preferences = stored;
} catch {
  // Storage can be unavailable or contain a stale value; the controls still work.
}

for (const toggle of columnToggles) {
  const column = toggle.dataset.columnToggle;
  const apply = () => {
    document.querySelectorAll(`[data-column="${column}"]`).forEach((cell) => {
      cell.hidden = !toggle.checked;
    });
  };
  toggle.checked = preferences[column] === true;
  apply();
  toggle.addEventListener('change', () => {
    apply();
    preferences[column] = toggle.checked;
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {
      // Keep the current view usable even when persistence is blocked.
    }
  });
}

const selectAll = document.querySelector('[data-select-all]');
const selections = [...document.querySelectorAll('[data-row-selection]')];
const updateSelection = () => {
  if (!selectAll) return;
  const count = selections.filter((input) => input.checked).length;
  selectAll.checked = count > 0 && count === selections.length;
  selectAll.indeterminate = count > 0 && count < selections.length;
  document.querySelectorAll('[data-requires-selection]').forEach((button) => { button.disabled = count === 0; });
  const counter = document.querySelector('[data-selection-count]');
  if (counter) counter.textContent = `${count} seleccionados`;
};
selectAll?.addEventListener('change', () => {
  selections.forEach((input) => { input.checked = selectAll.checked; });
  updateSelection();
});
selections.forEach((input) => input.addEventListener('change', updateSelection));
const clearSelection = () => {
  selections.forEach((input) => { input.checked = false; });
  updateSelection();
};
document.querySelector('.filter-bar')?.addEventListener('input', clearSelection);
document.querySelector('.filter-bar')?.addEventListener('change', clearSelection);
document.querySelectorAll('.pagination a').forEach((link) => link.addEventListener('click', clearSelection));
window.addEventListener('pageshow', clearSelection);
