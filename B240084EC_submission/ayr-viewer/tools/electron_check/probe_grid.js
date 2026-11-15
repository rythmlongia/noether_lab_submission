(async () => {
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  $('btn-open').click();
  await sleep(1500);
  document.querySelector('[data-mode=temp]').click();
  const snap = Math.min(3, +$('snap-slider').max);
  $('snap-slider').value = snap; $('snap-slider').dispatchEvent(new Event('input'));
  await sleep(100);
  const c = $('gl').getBoundingClientRect(), out = [];
  for (let gy = 1; gy <= 4; gy++) for (let gx = 1; gx <= 5; gx++) {
    const o = { clientX: c.left + c.width * (0.25 + 0.5 * gx / 6), clientY: c.top + c.height * (0.2 + 0.6 * gy / 5), button: 0, pointerId: 1, bubbles: true };
    $('gl').dispatchEvent(new PointerEvent('pointerdown', o));
    $('gl').dispatchEvent(new PointerEvent('pointerup', o));
    const v = [...$('probe').querySelectorAll('.v')].map(e => e.textContent);
    if (v.length) out.push({ snap, index: +v[0], pos: v[1], solid: v[2], temp: v[3] });
  }
  return JSON.stringify(out);
})()
