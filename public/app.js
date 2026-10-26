// PBAT DOOR TO DOOR — shared browser code (used by every page)

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'No connection. Check your internet and try again.' } };
  }
}

export function setLoading(btn, on) { btn.disabled = on; btn.classList.toggle('loading', on); }

export function message(el, content, kind = 'err') {
  el.textContent = '';
  el.className = `msg ${kind}${content ? ' show' : ''}`;
  if (!content) return;
  if (typeof content === 'string') el.textContent = content; else el.append(content);
}

export function devCodeNote(el, code) {
  if (!code) return message(el, '');
  const span = document.createElement('span');
  span.append('Test mode (no email service set up yet): your code is ');
  const c = document.createElement('code'); c.textContent = code; span.append(c);
  message(el, span, 'dev');
}

export function showStep(id) { $$('.step').forEach((s) => s.classList.toggle('active', s.id === id)); }

// Swap the nav's "Log in" for "My account" when signed in. Returns the user (or null).
export async function initNav() {
  const { ok, data } = await api('/api/me');
  const user = ok ? data.user : null;
  const login = $('[data-nav="login"]');
  const join = $('[data-nav="join"]');
  if (user && login) { login.textContent = 'My account'; login.href = '/account'; }
  if (user && join) { join.textContent = 'My account'; join.href = '/account'; }
  return ok ? data : null;
}

// Images: try each source in data-sources ("a|b|c"); show initials if all fail.
export function loadImages(root = document) {
  $$('img[data-sources]', root).forEach((img) => {
    const sources = img.dataset.sources.split('|').filter(Boolean);
    let i = 0;
    const holder = img.closest('.ph');
    const next = () => {
      if (i >= sources.length) { holder?.classList.add('missing'); return; }
      img.src = sources[i++];
    };
    img.addEventListener('error', next);
    next();
  });
}

// ---- 6-digit code boxes -------------------------------------------------------
export function createOtp(container, onComplete) {
  container.innerHTML = '';
  const boxes = Array.from({ length: 6 }, (_, i) => {
    const inp = document.createElement('input');
    inp.inputMode = 'numeric'; inp.maxLength = 1;
    inp.autocomplete = i === 0 ? 'one-time-code' : 'off';
    inp.setAttribute('aria-label', `Digit ${i + 1}`);
    container.append(inp);
    return inp;
  });
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (str) => {
    const d = str.replace(/\D/g, '').slice(0, 6).split('');
    boxes.forEach((b, i) => (b.value = d[i] || ''));
    boxes[Math.min(d.length, 5)].focus();
    if (d.length === 6) onComplete(value());
  };
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      container.classList.remove('error');
      if (box.value.length > 1) return fill(box.value);
      box.value = box.value.replace(/\D/g, '');
      if (box.value && i < 5) boxes[i + 1].focus();
      if (value().length === 6) onComplete(value());
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => { e.preventDefault(); fill(e.clipboardData.getData('text')); });
    box.addEventListener('focus', () => box.select());
  });
  return {
    value,
    clear() { boxes.forEach((b) => (b.value = '')); boxes[0].focus(); },
    shake() { container.classList.remove('error'); void container.offsetWidth; container.classList.add('error'); },
    focus() { boxes[0].focus(); },
  };
}

// Countdown on a "Resend" button.
export function cooldown(btn, seconds, label = 'Resend code') {
  clearInterval(btn._timer);
  let left = seconds;
  const tick = () => {
    if (left <= 0) { clearInterval(btn._timer); btn.disabled = false; btn.textContent = label; return; }
    btn.disabled = true; btn.textContent = `Resend in ${left--}s`;
  };
  tick(); btn._timer = setInterval(tick, 1000);
}

// ---- Profile form (used by Join and by Edit details) ---------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Date of birth is typed as DD/MM/YYYY and sent to the server as YYYY-MM-DD.
const isoToDmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
export function dmyToIso(dmy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dmy).trim());
  if (!m) return '';
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function autoFormatDob(input) {
  input.addEventListener('input', (e) => {
    if (e.inputType && e.inputType.startsWith('delete')) return;   // let backspace work naturally
    const d = input.value.replace(/\D/g, '').slice(0, 8);
    input.value = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
      : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });
}

export function renderProfileFields(container, opts, v = {}, { withEmail = true, emailReadonly = false } = {}) {
  const field = (name, label, input, { full = false, optional = false } = {}) => `
    <div class="field${full ? ' full' : ''}" data-field="${name}">
      <label for="f-${name}">${label}${optional ? ' <span class="opt">(optional)</span>' : ''}</label>
      ${input}
      <div class="err"></div>
    </div>`;
  const text = (name, attrs = '') => `<input id="f-${name}" name="${name}" value="${esc(v[name])}" ${attrs}>`;
  const select = (name, list, placeholder) => `
    <select id="f-${name}" name="${name}">
      <option value="">${placeholder}</option>
      ${list.map((o) => `<option${o === v[name] ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select>`;
  const chosen = new Set(v.interests || []);

  container.innerHTML = `
    <fieldset>
      <legend>Your details</legend>
      <div class="grid">
        ${field('full_name', 'Full name', text('full_name', 'autocomplete="name" placeholder="e.g. Amina Bello"'), { full: true })}
        ${withEmail ? field('email', 'Email address', text('email', `type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"${emailReadonly ? ' readonly' : ''}`)) : ''}
        ${field('phone', 'Phone number', text('phone', 'type="tel" autocomplete="tel" inputmode="tel" placeholder="0803 123 4567"'), { full: !withEmail })}
        ${field('gender', 'Gender', select('gender', opts.genders, 'Select…'), { optional: true })}
        ${field('date_of_birth', 'Date of birth', `<input id="f-date_of_birth" name="date_of_birth" inputmode="numeric" autocomplete="bday" placeholder="DD / MM / YYYY" maxlength="10" value="${esc(isoToDmy(v.date_of_birth))}">`)}
      </div>
    </fieldset>
    <fieldset>
      <legend>Where you are</legend>
      <div class="grid">
        ${field('state', 'State', select('state', opts.states, 'Select your state…'))}
        ${field('lga', 'Local government area (LGA)', text('lga', 'placeholder="e.g. Bwari"'))}
        ${field('ward', 'Ward', text('ward', 'placeholder="e.g. Kubwa"'), { optional: true })}
        ${field('polling_unit', 'Polling unit', text('polling_unit', 'placeholder="Name or code"'), { optional: true })}
        ${field('address', 'Address', text('address', 'autocomplete="street-address"'), { full: true, optional: true })}
      </div>
    </fieldset>
    <fieldset>
      <legend>How you'd like to help</legend>
      <div class="grid">
        ${field('occupation', 'Occupation', text('occupation', 'placeholder="e.g. Teacher, trader, student"'), { full: true, optional: true })}
        <div class="field full" data-field="interests">
          <label>Areas you can help with <span class="opt">(choose any)</span></label>
          <div class="chips">
            ${opts.interests.map((i) => `<label><input type="checkbox" name="interests" value="${esc(i)}"${chosen.has(i) ? ' checked' : ''}> ${esc(i)}</label>`).join('')}
          </div>
        </div>
      </div>
    </fieldset>`;
  if (withEmail && v.email) $('#f-email', container).value = v.email;
  autoFormatDob($('#f-date_of_birth', container));
  enhanceSelects(container);
}

export function readProfileFields(container) {
  const get = (n) => $(`[name="${n}"]`, container)?.value ?? '';
  return {
    email: get('email'),
    full_name: get('full_name'), phone: get('phone'), gender: get('gender'), date_of_birth: dmyToIso(get('date_of_birth')) || (get('date_of_birth') ? 'invalid' : ''),
    state: get('state'), lga: get('lga'), ward: get('ward'), polling_unit: get('polling_unit'),
    address: get('address'), occupation: get('occupation'),
    interests: $$('[name="interests"]:checked', container).map((c) => c.value),
  };
}

// Mirrors the server's rules so people get instant feedback.
export function checkProfile(p, { withEmail = true } = {}) {
  const e = {};
  if (p.full_name.trim().split(/\s+/).filter(Boolean).length < 2) e.full_name = 'Enter your first and last name.';
  if (withEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email.trim())) e.email = 'Enter a valid email address.';
  const digits = p.phone.replace(/[^\d+]/g, '');
  if (!/^(\+?234|0)[789]\d{9}$/.test(digits)) e.phone = 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
  if (!p.date_of_birth) e.date_of_birth = 'Enter your date of birth.';
  else if (p.date_of_birth === 'invalid') e.date_of_birth = 'Enter a real date as DD/MM/YYYY, e.g. 28/11/2000.';
  else {
    const dob = new Date(p.date_of_birth + 'T00:00:00'); const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
    if (age < 18) e.date_of_birth = 'You must be 18 or older to join.';
    else if (age > 120) e.date_of_birth = 'Check the year of your date of birth.';
  }
  if (!p.state) e.state = 'Choose your state.';
  if (p.lga.trim().length < 2) e.lga = 'Enter your local government area.';
  return e;
}

export function showFieldErrors(container, errors = {}) {
  $$('.field', container).forEach((f) => {
    const msg = errors[f.dataset.field];
    f.classList.toggle('invalid', Boolean(msg));
    const el = $('.err', f); if (el) el.textContent = msg || '';
  });
  const first = $('.field.invalid input:not([type=checkbox]), .field.invalid select', container);
  if (first) first.focus();
  return Object.keys(errors).length === 0;
}

// ---- Custom dropdowns -------------------------------------------------------
// Turns every <select> in `root` into a styled, keyboard-friendly dropdown.
// The real <select> stays in the page (hidden) and keeps the value, so forms work as before.
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
let openDd = null;
document.addEventListener('mousedown', (e) => { if (openDd && !openDd.wrap.contains(e.target)) openDd.close(); });

export function enhanceSelects(root = document) {
  $$('select', root).forEach((select) => {
    if (select.closest('.dd')) return;
    const options = [...select.options];
    const placeholder = options.find((o) => o.value === '')?.textContent || 'Select…';
    const items = options.filter((o) => o.value !== '');
    const searchable = items.length > 8;
    const id = `${select.id || 'dd'}-list`;

    const wrap = document.createElement('div'); wrap.className = 'dd';
    select.parentNode.insertBefore(wrap, select); wrap.append(select);
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id);
    const label = select.id && $(`label[for="${select.id}"]`, root);
    if (label) { label.htmlFor = ''; label.addEventListener('click', () => btn.focus()); btn.setAttribute('aria-label', label.textContent.trim()); }

    const pop = document.createElement('div'); pop.className = 'dd-pop';
    const search = searchable ? Object.assign(document.createElement('input'), { className: 'dd-search', placeholder: 'Search…', type: 'text', autocomplete: 'off' }) : null;
    const list = document.createElement('ul'); list.className = 'dd-list'; list.id = id; list.setAttribute('role', 'listbox');
    if (search) pop.append(search);
    pop.append(list); wrap.append(btn, pop);

    let visible = items, active = -1;
    const paintButton = () => {
      const cur = select.selectedOptions[0];
      btn.innerHTML = '';
      const span = document.createElement('span');
      if (cur && cur.value) span.textContent = cur.textContent; else { span.textContent = placeholder; span.className = 'ph-text'; }
      btn.append(span); btn.insertAdjacentHTML('beforeend', CHEVRON);
    };
    const paintList = () => {
      list.innerHTML = '';
      if (!visible.length) { list.innerHTML = '<li class="empty">No matches</li>'; return; }
      visible.forEach((o, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option'); li.textContent = o.textContent;
        li.setAttribute('aria-selected', String(o.value === select.value));
        if (i === active) li.classList.add('active');
        li.addEventListener('mousemove', () => { if (active !== i) { active = i; highlight(); } });
        li.addEventListener('click', () => choose(o));
        list.append(li);
      });
    };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
      const li = list.children[active];   // scroll only the list, never the page
      if (li) {
        if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
        else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
      }
    };
    const choose = (o) => {
      select.value = o.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      wrap.closest('.field')?.classList.remove('invalid');
      paintButton(); close(); btn.focus({ preventScroll: true });
    };
    const open = () => {
      if (openDd && openDd.wrap !== wrap) openDd.close();
      visible = items; active = Math.max(0, items.findIndex((o) => o.value === select.value));
      if (search) search.value = '';
      paintList();
      const below = window.innerHeight - btn.getBoundingClientRect().bottom;
      wrap.classList.toggle('up', below < 320 && btn.getBoundingClientRect().top > below);
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      openDd = { wrap, close };
      highlight();
      if (search) search.focus({ preventScroll: true });
    };
    function close() {
      wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
      if (openDd?.wrap === wrap) openDd = null;
    }
    const onKey = (e) => {
      const isOpen = wrap.classList.contains('open');
      if (!isOpen && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); return open(); }
      if (!isOpen) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (visible[active]) choose(visible[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'Tab') close();
      else if (!search && e.key.length === 1) {   // type-to-jump for short lists
        const i = visible.findIndex((o) => o.textContent.toLowerCase().startsWith(e.key.toLowerCase()));
        if (i >= 0) { active = i; highlight(); }
      }
    };
    btn.addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
    btn.addEventListener('keydown', onKey);
    if (search) {
      search.addEventListener('keydown', onKey);
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        visible = items.filter((o) => o.textContent.toLowerCase().includes(q));
        active = visible.length ? 0 : -1; paintList();
      });
    }
    // Let showFieldErrors focus the dropdown like any other field.
    select.focus = () => btn.focus();
    paintButton();
  });
}
