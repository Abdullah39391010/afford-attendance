// Some Android keyboards (often Urdu ones) hold typed words "in progress" and never send the normal
// input event, so the app never sees the text and Save clears the box. Here we push the final text
// to the app when the keyboard finishes a word, when the box loses focus, and before any button tap.
export function setupTyping() {
  const isText = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color)$/i.test(el.type)));
  const push = (el) => {
    if (!isText(el)) return;
    if (el.__lastSent === el.value) return;
    el.__lastSent = el.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  document.addEventListener('input', (e) => { if (isText(e.target)) e.target.__lastSent = e.target.value; }, true);
  document.addEventListener('compositionend', (e) => setTimeout(() => push(e.target), 0), true);
  document.addEventListener('change', (e) => push(e.target), true);
  document.addEventListener('focusout', (e) => push(e.target), true);
  // Tapping Save: finish the open box first, so the app has the text before the click runs.
  document.addEventListener('pointerdown', (e) => {
    const a = document.activeElement;
    if (isText(a) && !a.contains(e.target) && e.target.closest && e.target.closest('button, .btn')) push(a);
  }, true);
}
