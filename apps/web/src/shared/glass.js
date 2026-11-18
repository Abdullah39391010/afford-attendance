// Glass look: frosted top bar, floating bottom menu, glass pop-ups. Cards stay solid.
// Phones that can't blur, or are low-end, get the same shapes with plain white (no blur) so scrolling stays fast.
export function setupGlass() {
  const el = document.documentElement;
  el.classList.add('glass');
  let blur = false;
  try { blur = CSS.supports('backdrop-filter', 'blur(2px)') || CSS.supports('-webkit-backdrop-filter', 'blur(2px)'); } catch { /* old browser */ }
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (cores < 4 || mem < 3) blur = false;
  try { if (matchMedia('(prefers-reduced-transparency: reduce)').matches) blur = false; } catch { /* ignore */ }
  if (!blur) el.classList.add('noblur');
}
