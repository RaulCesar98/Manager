// Funções comuns às telas: chamada à API, tema claro/escuro, formatação.

// Aplica o tema salvo o quanto antes (este script fica no <head>).
try { const t = localStorage.getItem('tema'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** Escapa texto para colocar em HTML. */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Chamada à API. Lança Error com a mensagem do servidor (em português). */
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor. Ele está rodando?'), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.erro ?? `Erro ${res.status}`), { status: res.status });
  return data;
}

// ------------------------------------------------------------- formatação
const nf = new Intl.NumberFormat('pt-BR');
const fmtNum = (n) => nf.format(Math.round(n ?? 0));
/** centavos -> "R$ 1,2 mi" (compacto) */
function brl(cents, compact = true) {
  const v = (cents ?? 0) / 100;
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (!compact || a < 10_000) return s + 'R$ ' + nf.format(Math.round(a));
  if (a < 1_000_000) return s + 'R$ ' + (a / 1000).toFixed(a < 100_000 ? 1 : 0).replace('.', ',') + ' mil';
  return s + 'R$ ' + (a / 1_000_000).toFixed(a < 100_000_000 ? 1 : 0).replace('.', ',') + ' mi';
}
function fans(n) {
  if (n < 1_000_000) return nf.format(Math.round(n));
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace('.', ',') + ' mi';
}
function moodLabel(m) {
  return m >= 80 ? 'Empolgada' : m >= 65 ? 'Animada' : m >= 50 ? 'Tranquila' : m >= 35 ? 'Desconfiada' : m >= 20 ? 'Irritada' : 'Revoltada';
}

let toastTimer;
function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------------------------------------------------------- tema
const THEME_HTML = `
  <button type="button" data-t="auto" title="Seguir o sistema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Automático</span></button>
  <button type="button" data-t="light" title="Modo claro"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><span>Claro</span></button>
  <button type="button" data-t="dark" title="Modo escuro"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><span>Escuro</span></button>`;

function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  try { t === 'auto' ? localStorage.removeItem('tema') : localStorage.setItem('tema', t); } catch (e) {}
  $$('.theme button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
}
/** Coloca o seletor de tema dentro de `el`. */
function mountTheme(el) {
  el.className = 'theme'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Tema');
  el.innerHTML = THEME_HTML;
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.t); });
  applyTheme(document.documentElement.dataset.theme || 'auto');
}
