'use strict';

/* =========================================================
 * Outils
 * ========================================================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const money = cents => euro.format((cents || 0) / 100);

// "12,5" ou "12.50" ou "1 200" -> centimes (1250). Renvoie null si invalide.
function parseAmount(str) {
  const s = String(str || '').replace(/[\s €]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
const centsToInput = c => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

const PAYMENTS = ['CB', 'Espèces', 'Virement', 'Prélèvement'];
const INCOME_SUGGESTIONS = ['Remboursement', 'Aide', 'Prime', 'Allocations', 'Autre'];
const LOCK_AFTER_IDLE_MS = 5 * 60 * 1000; // 5 minutes sans toucher l'écran
const LOCK_AFTER_HIDDEN_MS = 30 * 1000;   // app quittée plus de 30 s = nouvelle ouverture

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => iso(new Date());
const currentMonthKey = () => todayISO().slice(0, 7);
function shiftMonth(mk, n) {
  const [y, m] = mk.split('-').map(Number);
  return iso(new Date(y, m - 1 + n, 1)).slice(0, 7);
}
function monthLabel(mk, withYear = true) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', withYear ? { month: 'long', year: 'numeric' } : { month: 'long' });
}
function dayLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
const de = mk => (/^[aeiou]/i.test(monthLabel(mk, false)) ? "d'" : 'de ') + monthLabel(mk, false);

/* =========================================================
 * Accès aux données
 * ========================================================= */
const D = () => Store.data;
const ui = { month: currentMonthKey(), tab: 'home', year: Number(currentMonthKey().slice(0, 4)), yearSel: null };
const lastChoice = { catId: null, pay: 'CB' };

function monthData(mk, create = false) {
  if (!D().months[mk] && create) D().months[mk] = { incomes: [] };
  return D().months[mk] || { incomes: [] };
}
const incomesOf = mk => monthData(mk).incomes;
const salaryOf = mk => incomesOf(mk).find(i => i.isSalary);
const totalIncome = mk => incomesOf(mk).reduce((s, i) => s + i.amount, 0);
const expensesOf = mk => D().expenses
  .filter(e => e.date.slice(0, 7) === mk)
  .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
const totalSpent = mk => expensesOf(mk).reduce((s, e) => s + e.amount, 0);
function savingsOf(mk) {
  const m = D().months[mk];
  return m && typeof m.savings === 'number' ? m.savings : D().settings.savings;
}
// Premier mois suivi : création de l'app, ou mois le plus ancien qui contient des données
function firstTrackedMonth() {
  const all = [
    (D().createdAt || new Date().toISOString()).slice(0, 7),
    ...Object.keys(D().months).filter(mk => monthData(mk).incomes.length),
    ...D().expenses.map(e => e.date.slice(0, 7))
  ];
  return all.sort()[0];
}
// Épargne cumulée du 1er janvier (ou du premier mois suivi) jusqu'au mois mk inclus
function savingsYTD(mk) {
  const jan = mk.slice(0, 4) + '-01';
  const first = firstTrackedMonth();
  let total = 0, months = 0;
  for (let m = first > jan ? first : jan; m <= mk; m = shiftMonth(m, 1)) {
    total += savingsOf(m);
    months++;
  }
  return { total, months };
}
const catById = id => D().categories.find(c => c.id === id);
const catName = id => (catById(id) || { name: 'Sans catégorie' }).name;

/* ---------- Budgets ---------- */
const catSpent = (mk, catId) => expensesOf(mk).filter(e => e.catId === catId).reduce((s, e) => s + e.amount, 0);
// Niveau d'alerte d'un budget : '' (ok), 'warn' (>= 80 %), 'over' (>= 100 %)
const budgetLevel = pct => (pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : '');
function budgetStatuses(mk) {
  return D().categories.filter(c => c.budget).map(c => {
    const spent = catSpent(mk, c.id);
    const pct = spent / c.budget;
    return { cat: c, spent, pct, level: budgetLevel(pct) };
  });
}
function budgetAlertText(s) {
  return s.level === 'over'
    ? `⛔ ${s.cat.name} : budget dépassé${s.spent > s.cat.budget ? ` de ${money(s.spent - s.cat.budget)}` : ' (100 %)'}`
    : `⚠️ ${s.cat.name} : ${Math.floor(s.pct * 100)} % du budget utilisé`;
}

/* ---------- Frais partagés ---------- */
const sharedDue = e => (e.shared ? Math.round(e.amount * (e.sharePct ?? 50) / 100) : 0);
function sharedSummary(mk) {
  const list = expensesOf(mk).filter(e => e.shared);
  return {
    list,
    total: list.reduce((s, e) => s + e.amount, 0),
    due: list.reduce((s, e) => s + sharedDue(e), 0),
    refund: incomesOf(mk).find(i => i.isSharedRefund)
  };
}

// Exécute une modification et renvoie un message si elle fait franchir le seuil de 80 % ou de 100 % du budget
function withBudgetCheck(date, catId, mutate) {
  const statusOf = () => budgetStatuses(date.slice(0, 7)).find(s => s.cat.id === catId);
  const rank = s => (!s ? 0 : s.level === 'over' ? 2 : s.level === 'warn' ? 1 : 0);
  const before = rank(statusOf());
  mutate();
  const after = statusOf();
  return rank(after) > before ? budgetAlertText(after) : null;
}

// Dernier salaire saisi avant ce mois (on remonte jusqu'à 12 mois)
function previousSalary(mk) {
  for (let i = 1; i <= 12; i++) {
    const p = shiftMonth(mk, -i);
    const s = salaryOf(p);
    if (s) return { month: p, amount: s.amount };
  }
  return null;
}

/* ---------- Dépenses récurrentes ---------- */
// Date du jour J dans le mois mk (le 31 devient le 30 ou le 28/29 si besoin)
function recurringDate(mk, day) {
  const [y, m] = mk.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${mk}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
const recurringInstance = (r, mk) => D().expenses.find(e => e.recurringId === r.id && e.date.slice(0, 7) === mk);

// Ajoute les dépenses fixes de chaque mois écoulé depuis leur création, jusqu'au mois en cours.
// Chaque mois retient celles déjà ajoutées (recGen) : une ligne supprimée à la main ne revient donc pas.
function generateRecurring() {
  const cur = currentMonthKey();
  let added = 0;
  D().recurring.forEach(r => {
    for (let mk = r.startMonth; mk <= cur; mk = shiftMonth(mk, 1)) {
      const m = monthData(mk, true);
      m.recGen ||= [];
      if (m.recGen.includes(r.id)) continue;
      m.recGen.push(r.id);
      D().expenses.push({
        id: Store.uid(), createdAt: new Date().toISOString(),
        date: recurringDate(mk, r.day), amount: r.amount, catId: r.catId, pay: r.pay,
        comment: r.label, recurringId: r.id,
        shared: !!r.shared, sharePct: r.shared ? r.sharePct : null
      });
      added++;
    }
  });
  return added;
}

async function commit(message) {
  try {
    await Store.save();
  } catch (e) {
    alert("Erreur d'enregistrement : " + e.message);
  }
  render();
  if (message) toast(message);
}

/* =========================================================
 * Écran du code d'accès
 * ========================================================= */
// mode : 'name' puis 'create' et 'confirm' (premier lancement), 'unlock',
// ou 'restore' (code d'un fichier de sauvegarde)
const lock = { mode: 'unlock', pin: '', first: '', name: '', busy: false, backup: null, prevMode: null };

function showLock(mode) {
  lock.mode = mode;
  lock.pin = '';
  lock.first = '';
  lock.backup = null;
  if (mode === 'name') lock.name = '';
  closeSheet();
  $('#app').hidden = true;
  $('#view').innerHTML = '';
  $('#lock').hidden = false;
  renderLock();
}

function renderLock(error = '') {
  const savedName = Store.vaultName();
  const texts = {
    name: ['Bienvenue', 'Comment vous appelez-vous ?'],
    create: [lock.name ? `Bonjour ${lock.name} !` : 'Bienvenue', 'Créez votre code secret (4 à 6 chiffres)'],
    confirm: ['Confirmation', 'Saisissez le même code une seconde fois'],
    unlock: [savedName ? `Bonjour ${savedName}` : 'Mon Budget', 'Entrez votre code'],
    restore: ['Restaurer', lock.backup ? `Code de la sauvegarde du ${backupDate(lock.backup)}` : '']
  };
  const [title, msg] = texts[lock.mode];
  $('#lock-title').textContent = title;
  $('#lock-msg').textContent = lock.busy ? 'Un instant…' : msg;
  $('#lock-error').textContent = error;
  const isName = lock.mode === 'name';
  $('#name-step').hidden = !isName;
  $('#pad').hidden = isName;
  $('#pin-dots').hidden = isName;
  const n = Math.max(4, lock.pin.length);
  $('#pin-dots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < lock.pin.length ? 'on' : ''}"></i>`).join('');
  const restoreBtn = $('#lock-restore');
  restoreBtn.hidden = lock.mode === 'confirm';
  restoreBtn.textContent = {
    name: "J'ai déjà une sauvegarde : la restaurer",
    create: "J'ai déjà une sauvegarde : la restaurer",
    unlock: 'Code oublié ? Restaurer une sauvegarde',
    restore: 'Annuler'
  }[lock.mode] || '';
  const w = $('#lock-warning');
  if (lock.mode === 'unlock') {
    w.hidden = true;
  } else if (isName) {
    w.hidden = false;
    w.innerHTML = 'Vos données restent <b>uniquement sur ce téléphone</b>, protégées par un code que vous allez choisir. ' +
      'Chaque membre de la famille installe l\'application sur son propre téléphone : personne ne voit le budget des autres.';
  } else if (lock.mode === 'restore') {
    w.hidden = false;
    w.innerHTML = (Store.hasVault() ? '<b>Attention :</b> les données actuelles de cet appareil seront <b>remplacées</b> par celles de la sauvegarde. ' : '') +
      'Le code de la sauvegarde deviendra votre code d\'accès.';
  } else {
    w.hidden = false;
    w.innerHTML = '<b>Important :</b> ce code chiffre vos données. ' +
      "Si vous l'oubliez, <b>personne ne pourra les récupérer</b>, sauf avec un fichier de sauvegarde. " +
      'Notez-le dans un endroit sûr.';
  }
}

async function submitPin() {
  if (lock.busy) return;
  const pin = lock.pin;
  if (pin.length < 4) return renderLock('Le code doit contenir 4 à 6 chiffres.');

  if (lock.mode === 'create') {
    lock.first = pin;
    lock.pin = '';
    lock.mode = 'confirm';
    return renderLock();
  }

  if (lock.mode === 'restore') {
    if (Store.hasVault() && !confirm('Remplacer toutes les données de cet appareil par celles de la sauvegarde ?')) return;
    lock.busy = true; renderLock();
    let ok = false, damaged = false;
    try { ok = await Store.installBackup(lock.backup, pin); } catch (e) { damaged = true; }
    lock.busy = false;
    lock.pin = '';
    if (ok) {
      enterApp();
      return toast('Sauvegarde restaurée');
    }
    return renderLock(damaged ? 'Ce fichier de sauvegarde est abîmé.' : 'Code incorrect pour cette sauvegarde.');
  }

  if (lock.mode === 'confirm') {
    if (pin !== lock.first) {
      lock.mode = 'create';
      lock.pin = '';
      lock.first = '';
      return renderLock('Les deux codes sont différents. Recommencez.');
    }
    lock.busy = true; renderLock();
    await Store.create(pin, lock.name);
    lock.busy = false;
    return enterApp();
  }

  // Déverrouillage
  const att = Store.getAttempts();
  if (att.until > Date.now()) {
    lock.pin = '';
    return renderLock(`Trop d'essais. Réessayez dans ${Math.ceil((att.until - Date.now()) / 1000)} s.`);
  }
  lock.busy = true; renderLock();
  const ok = await Store.unlock(pin);
  lock.busy = false;
  lock.pin = '';
  if (ok) {
    Store.resetAttempts();
    return enterApp();
  }
  att.n += 1;
  if (att.n >= 5) att.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (att.n - 5)) * 1000;
  Store.setAttempts(att);
  renderLock(att.n >= 5 ? `Code incorrect. Patientez ${Math.round((att.until - Date.now()) / 1000)} s.` : 'Code incorrect.');
}

function pressKey(k) {
  if (lock.busy) return;
  if (k === 'del') lock.pin = lock.pin.slice(0, -1);
  else if (k === 'ok') return submitPin();
  else if (/^\d$/.test(k) && lock.pin.length < 6) lock.pin += k;
  renderLock();
}

$('#name-step').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#name-input').value.trim().replace(/\s+/g, ' ');
  if (!name) return renderLock('Indiquez votre prénom.');
  lock.name = name.slice(0, 30);
  lock.mode = 'create';
  renderLock();
});

$('#lock-restore').addEventListener('click', () => {
  if (lock.mode === 'restore') return showLock(lock.prevMode);
  pickBackupFile(b => {
    lock.prevMode = lock.mode;
    lock.mode = 'restore';
    lock.backup = b;
    lock.pin = '';
    renderLock();
  });
});

$('#pad').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) pressKey(b.dataset.k);
});
document.addEventListener('keydown', e => {
  if ($('#lock').hidden || lock.mode === 'name') return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === 'Backspace') pressKey('del');
  else if (e.key === 'Enter') pressKey('ok');
});

function enterApp() {
  $('#lock').hidden = true;
  $('#app').hidden = false;
  ui.month = currentMonthKey();
  ui.tab = 'home';
  ui.search = null;
  ui.year = Number(ui.month.slice(0, 4));
  lastActivity = Date.now();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if (generateRecurring()) Store.save();
  render();
  setTimeout(openingReminders, 250);
}

function lockNow() {
  Store.lock();
  showLock('unlock');
}

/* Verrouillage automatique */
let lastActivity = Date.now();
let hiddenAt = null;
['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
  addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
setInterval(() => {
  if (Store.isUnlocked() && Date.now() - lastActivity > LOCK_AFTER_IDLE_MS) lockNow();
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!Store.isUnlocked() || !hiddenAt) return;
  const away = Date.now() - hiddenAt;
  if (away > LOCK_AFTER_HIDDEN_MS || Date.now() - lastActivity > LOCK_AFTER_IDLE_MS) return lockNow();
  // Retour rapide dans l'app : un nouveau mois a peut-être commencé
  if (generateRecurring()) commit();
});

/* =========================================================
 * Rappels à l'ouverture
 * ========================================================= */
function openingReminders() {
  const mk = currentMonthKey();
  if (!salaryOf(mk)) openSalarySheet(mk, true);
}

/* =========================================================
 * Affichage général
 * ========================================================= */
function render() {
  if (!Store.isUnlocked()) return;
  $('#month-label').textContent = ui.tab === 'year' ? `Année ${ui.year}` : monthLabel(ui.month);
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $('#fab').hidden = !(ui.tab === 'home' || ui.tab === 'expenses');
  $('#prev-month').style.visibility = $('#next-month').style.visibility = ui.tab === 'settings' ? 'hidden' : 'visible';
  renderBanners();
  renderFavbar();
  views[ui.tab]();
}

/* Barre des favoris (Accueil et Dépenses) : un appui = une dépense ajoutée */
function renderFavbar() {
  const bar = $('#favbar');
  const favs = D().favorites;
  bar.hidden = !favs.length || !(ui.tab === 'home' || ui.tab === 'expenses');
  if (bar.hidden) return;
  bar.innerHTML = favs.map(f => `<button class="fav" data-fav="${esc(f.id)}">
      <b>⭐ ${esc(f.label)}</b><span>${money(f.amount)}</span></button>`).join('') +
    '<button class="fav edit" data-fav-manage>✏️ Gérer</button>';
}
$('#favbar').addEventListener('click', e => {
  if (e.target.closest('[data-fav-manage]')) return openFavoritesSheet();
  const b = e.target.closest('[data-fav]');
  if (b) quickAdd(D().favorites.find(f => f.id === b.dataset.fav));
});

function quickAdd(fav) {
  if (!fav) return;
  const date = ui.month === currentMonthKey() ? todayISO() : ui.month + '-01';
  const exp = {
    id: Store.uid(), createdAt: new Date().toISOString(), date,
    amount: fav.amount, catId: catById(fav.catId) ? fav.catId : D().categories[0].id,
    pay: fav.pay, comment: fav.label,
    shared: !!fav.shared, sharePct: fav.shared ? fav.sharePct : null
  };
  const alertMsg = withBudgetCheck(date, exp.catId, () => D().expenses.push(exp));
  commit();
  toast(alertMsg || `${fav.label} : ${money(fav.amount)} ajouté`, 5000, {
    label: 'Annuler',
    fn: () => {
      D().expenses = D().expenses.filter(x => x !== exp);
      commit('Ajout annulé');
    }
  });
}

function renderBanners() {
  const box = $('#banners');
  box.innerHTML = '';
  if (ui.tab !== 'home') return;
  if (ui.month === currentMonthKey() && !salaryOf(ui.month)) {
    box.innerHTML += `<div class="banner"><b>Salaire ${esc(de(ui.month))} non saisi</b>
      Ajoutez-le pour voir ce qu'il vous reste.
      <button class="btn" data-act="salary">Saisir mon salaire</button></div>`;
  }
  const toExport = exportReminderMonth();
  if (toExport) {
    box.innerHTML += `<div class="banner"><b>📤 ${esc(capital(monthLabel(toExport)))} n'a pas encore été exporté</b>
      Gardez une copie Excel de votre mois terminé.
      <div class="btn-row"><button class="btn" data-act="export-prev">Exporter</button>
      <button class="btn secondary" data-act="export-later">Plus tard</button></div></div>`;
  }
  const backupMsg = backupReminder();
  if (backupMsg) {
    box.innerHTML += `<div class="banner"><b>💾 Pensez à faire une sauvegarde</b>
      ${esc(backupMsg)} Sans sauvegarde, vos données sont perdues si le téléphone l'est.
      <div class="btn-row"><button class="btn" data-act="backup-now">Sauvegarder</button>
      <button class="btn secondary" data-act="backup-later">Plus tard</button></div></div>`;
  }
  const alerts = budgetStatuses(ui.month).filter(s => s.level).sort((a, b) => b.pct - a.pct);
  if (alerts.length) {
    const over = alerts.some(s => s.level === 'over');
    box.innerHTML += `<div class="banner ${over ? 'banner-red' : ''}"><b>Alerte budget</b>
      ${alerts.map(s => esc(budgetAlertText(s))).join('<br>')}</div>`;
  }
}
$('#banners').addEventListener('click', e => {
  if (e.target.closest('[data-act="salary"]')) openSalarySheet(ui.month);
  if (e.target.closest('[data-act="export-prev"]')) openExportSheet(exportReminderMonth());
  if (e.target.closest('[data-act="export-later"]')) { ui.exportLater = true; render(); }
  if (e.target.closest('[data-act="backup-now"]')) createBackup();
  if (e.target.closest('[data-act="backup-later"]')) { ui.backupLater = true; render(); }
});

// Liste de dépenses regroupées par jour (dans l'ordre reçu, du plus récent au plus ancien)
function expenseListHTML(list, showYear = false) {
  const today = todayISO();
  let html = '<div class="card" style="padding-top:4px">';
  let day = null;
  list.forEach(e => {
    if (e.date !== day) {
      if (day) html += '</ul>';
      day = e.date;
      html += `<div class="day-head">${esc(dayLabel(day))}${showYear ? ' ' + day.slice(0, 4) : ''}</div><ul class="list">`;
    }
    html += `<li class="tap" data-id="${esc(e.id)}">
      <div class="grow"><div class="title">${esc(catName(e.catId))}</div>
      <div class="sub">${e.recurringId ? '🔁 ' : ''}${e.shared ? `<span class="tag">👨‍👧 ${e.sharePct} %</span> ` : ''}${esc(e.pay)}${e.comment ? ' · ' + esc(e.comment) : ''}${
        e.date > today ? ' · <span class="tag">à venir</span>' : ''}</div></div>
      <div class="amount">${money(e.amount)}</div></li>`;
  });
  return html + '</ul></div><p class="small muted" style="text-align:center">Touchez une dépense pour la modifier ou la supprimer.</p>';
}

/* ---------- Recherche et filtres ---------- */
const newSearch = () => ({ q: '', period: 'all', from: '', to: '', cat: '', pay: '', shared: '', open: false });
// Minuscules et sans accents, pour que « sante » trouve « Santé »
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[  ]/g, ' ');

function searchRange(s) {
  const cur = currentMonthKey();
  if (s.period === 'month') return [ui.month + '-01', ui.month + '-31'];
  if (s.period === '3m') return [shiftMonth(cur, -2) + '-01', cur + '-31'];
  if (s.period === 'year') return [cur.slice(0, 4) + '-01-01', cur.slice(0, 4) + '-12-31'];
  if (s.period === 'custom') return [s.from || '0000-01-01', s.to || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}

function searchResults(s) {
  const [from, to] = searchRange(s);
  const words = norm(s.q).split(/\s+/).filter(Boolean);
  return D().expenses.filter(e => {
    if (e.date < from || e.date > to) return false;
    if (s.cat && e.catId !== s.cat) return false;
    if (s.pay && e.pay !== s.pay) return false;
    if (s.shared === 'yes' && !e.shared) return false;
    if (s.shared === 'no' && e.shared) return false;
    if (!words.length) return true;
    const text = norm([e.comment, catName(e.catId), e.pay, money(e.amount), (e.amount / 100).toFixed(2)].join(' '));
    return words.every(w => text.includes(w));
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function renderSearch() {
  const s = ui.search;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  $('#view').innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">🔍 Rechercher</h3>
        <button class="chip" data-act="search-close">✕ Fermer</button>
      </div>
      <label class="field"><span>Mot-clé (commentaire, catégorie, montant…)</span>
        <input id="s-q" type="search" value="${esc(s.q)}" placeholder="Ex. : pharmacie, cantine, 45" autocomplete="off"></label>
      <button class="btn secondary" id="s-toggle" style="min-height:44px;font-size:15px;margin-top:0"></button>
      <div id="s-filters" ${s.open ? '' : 'hidden'} style="margin-top:14px">
      <label class="field"><span>Période</span>
        <select id="s-period">
          ${opt('all', 'Toutes les dates', s.period)}
          ${opt('month', `Mois affiché (${monthLabel(ui.month)})`, s.period)}
          ${opt('3m', 'Les 3 derniers mois', s.period)}
          ${opt('year', `Année ${currentMonthKey().slice(0, 4)}`, s.period)}
          ${opt('custom', 'Choisir les dates…', s.period)}
        </select></label>
      <div id="s-custom" class="btn-row" ${s.period === 'custom' ? '' : 'hidden'}>
        <label class="field" style="flex:1"><span>Du</span><input id="s-from" type="date" value="${esc(s.from)}"></label>
        <label class="field" style="flex:1"><span>Au</span><input id="s-to" type="date" value="${esc(s.to)}"></label>
      </div>
      <label class="field"><span>Catégorie</span>
        <select id="s-cat">${opt('', 'Toutes les catégories', s.cat)}${D().categories.map(c => opt(c.id, c.name, s.cat)).join('')}</select></label>
      <label class="field"><span>Mode de paiement</span>
        <select id="s-pay">${opt('', 'Tous les modes', s.pay)}${PAYMENTS.map(p => opt(p, p, s.pay)).join('')}</select></label>
      <label class="field" style="margin-bottom:0"><span>Frais partagés</span>
        <select id="s-shared">${opt('', 'Toutes les dépenses', s.shared)}${opt('yes', 'Frais partagés uniquement', s.shared)}${opt('no', 'Sans les frais partagés', s.shared)}</select></label>
      <button class="btn ghost" data-act="search-reset" style="min-height:44px;margin-top:6px">Effacer les filtres</button>
      </div>
    </div>
    <div id="s-results"></div>`;

  const updateToggle = () => {
    const n = ['cat', 'pay', 'shared'].filter(k => s[k]).length + (s.period !== 'all' ? 1 : 0);
    $('#s-toggle').textContent = `${s.open ? '▴ Masquer' : '▾ Afficher'} les filtres${n ? ` (${n} actif${n > 1 ? 's' : ''})` : ''}`;
  };
  $('#s-toggle').onclick = () => {
    s.open = !s.open;
    $('#s-filters').hidden = !s.open;
    updateToggle();
  };
  const read = () => {
    Object.assign(s, {
      q: $('#s-q').value, period: $('#s-period').value, from: $('#s-from').value, to: $('#s-to').value,
      cat: $('#s-cat').value, pay: $('#s-pay').value, shared: $('#s-shared').value
    });
    $('#s-custom').hidden = s.period !== 'custom';
    updateToggle();
    renderSearchResults();
  };
  updateToggle();
  ['#s-q', '#s-period', '#s-from', '#s-to', '#s-cat', '#s-pay', '#s-shared'].forEach(id => {
    $(id).addEventListener('input', read);
    $(id).addEventListener('change', read);
  });
  renderSearchResults();
}

function renderSearchResults() {
  const list = searchResults(ui.search);
  const total = list.reduce((sum, e) => sum + e.amount, 0);
  const due = list.reduce((sum, e) => sum + sharedDue(e), 0);
  $('#s-results').innerHTML = `
    <div class="card"><b>${list.length} résultat${list.length > 1 ? 's' : ''}</b>
      <span class="muted"> · total ${money(total)}</span>
      ${due ? `<div class="small muted">dont part de l'autre parent : ${money(due)}</div>` : ''}</div>
    ${list.length ? expenseListHTML(list, true) : '<div class="card empty">Aucune dépense ne correspond à votre recherche.</div>'}`;
}

/* ---------- Vue annuelle ---------- */
const euro0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const moneyShort = cents => euro0.format(Math.round((cents || 0) / 100));
const MONTH_SHORT = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
// Version courte pour sous le graphique (la place est limitée sur un téléphone)
const MONTH_AXIS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

// Chiffres d'un mois. Un mois est « suivi » s'il est entre le premier mois utilisé et aujourd'hui,
// ou s'il contient des données ; sinon il est affiché vide (pas d'épargne comptée).
function monthStats(mk) {
  const inc = totalIncome(mk), spent = totalSpent(mk);
  const active = (mk >= firstTrackedMonth() && mk <= currentMonthKey()) || inc > 0 || spent > 0;
  const sav = active ? savingsOf(mk) : 0;
  return { mk, inc, spent, sav, rest: inc - spent - sav, active };
}
const yearMonths = y => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

// Barres groupées revenus / dépenses (un seul axe, en euros)
function yearChartSVG(stats) {
  const W = 340, H = 172, left = 34, right = 4, top = 8, bottom = 4;
  const plotW = W - left - right, plotH = H - top - bottom;
  const maxVal = Math.max(1, ...stats.flatMap(s => [s.inc, s.spent]));
  // Graduation « ronde » : 1, 2 ou 5 × 10^n
  const rawStep = maxVal / 3;
  const pow = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= rawStep);
  const top_ = step * Math.ceil(maxVal / step);
  const y = v => top + plotH - (v / top_) * plotH;
  const groupW = plotW / 12, barW = Math.min(10, (groupW - 6) / 2);
  const bar = (x, v, color) => {
    if (v <= 0) return '';
    const h = Math.max(2, (v / top_) * plotH), r = Math.min(3, barW / 2, h);
    const y0 = top + plotH;
    return `<path fill="${color}" d="M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barW - r} Q${x + barW},${y0 - h} ${x + barW},${y0 - h + r} V${y0} Z"/>`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenus et dépenses par mois">`;
  for (let v = 0; v <= top_; v += step) {
    svg += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${left - 4}" y="${y(v) + 3}" text-anchor="end">${v >= 100000 ? (v / 100000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k€' : Math.round(v / 100) + ' €'}</text>`;
  }
  stats.forEach((s, i) => {
    const gx = left + i * groupW, cx = gx + groupW / 2;
    svg += `<g class="col ${ui.yearSel === s.mk ? 'sel' : ''}" data-m="${s.mk}">
      <rect class="hit" x="${gx}" y="${top}" width="${groupW}" height="${plotH + bottom}" rx="4"/>
      ${bar(cx - barW - 1, s.inc, 'var(--series-1)')}${bar(cx + 1, s.spent, 'var(--series-2)')}</g>`;
  });
  // Noms des mois en texte normal sous le graphique : ils gardent une taille lisible sur petit écran
  const months = stats.map((s, i) => `<span class="${ui.yearSel === s.mk ? 'sel' : ''}" data-m="${s.mk}">${MONTH_AXIS[i]}</span>`).join('');
  return svg + `</svg><div class="axis-months" style="padding-left:${left / W * 100}%;padding-right:${right / W * 100}%">${months}</div>`;
}

function yearDetailText(mk) {
  if (!mk) return '<span class="muted">Touchez un mois du graphique pour voir ses chiffres.</span>';
  const s = monthStats(mk);
  return `<b>${esc(monthLabel(mk))}</b> · <i class="dot" style="background:var(--series-1)"></i>revenus ${money(s.inc)}
    · <i class="dot" style="background:var(--series-2)"></i>dépenses ${money(s.spent)}
    · reste <b class="${s.rest >= 0 ? 'pos' : 'neg'}">${money(s.rest)}</b>`;
}

const views = {
  /* ---------- Tableau de bord ---------- */
  home() {
    const mk = ui.month;
    const inc = totalIncome(mk), spent = totalSpent(mk), sav = savingsOf(mk);
    const rest = inc - spent - sav;
    const pct = inc > 0 ? spent / inc : (spent > 0 ? 1 : 0);
    const barClass = pct >= 1 ? 'over' : pct >= 0.8 ? 'warn' : '';
    const fixed = expensesOf(mk).filter(e => e.recurringId);
    const fixedTotal = fixed.reduce((s, e) => s + e.amount, 0);
    const fixedLater = fixed.filter(e => e.date > todayISO()).reduce((s, e) => s + e.amount, 0);

    const byCat = {};
    expensesOf(mk).forEach(e => { byCat[e.catId] = (byCat[e.catId] || 0) + e.amount; });
    const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 1;

    $('#view').innerHTML = `
      ${D().settings.name ? `<p class="hello">Bonjour ${esc(D().settings.name)} 👋</p>` : ''}
      <div class="card rest-card">
        <div class="rest-label">Reste du mois</div>
        <div class="rest-value ${rest >= 0 ? 'pos' : 'neg'}">${money(rest)}</div>
        <div class="small muted">Revenus − dépenses − épargne prévue</div>
        ${fixedTotal ? `<div class="small" style="margin-top:6px">🔁 dont dépenses fixes : <b>${money(fixedTotal)}</b>${
          fixedLater ? ` <span class="muted">(${money(fixedLater)} encore à venir)</span>` : ''}</div>` : ''}
      </div>
      <div class="kpis">
        <div class="kpi"><span>Revenus</span><b>${money(inc)}</b></div>
        <div class="kpi"><span>Dépensé</span><b>${money(spent)}</b></div>
        <div class="kpi tap" data-act="savings-month"><span>Épargne ✏️</span><b>${money(sav)}</b></div>
      </div>
      <div class="card">
        <h3>Part des revenus dépensée</h3>
        <div class="progress ${barClass}"><div style="width:${Math.min(100, pct * 100)}%"></div></div>
        <p class="small muted" style="margin:8px 0 0">${inc > 0
          ? `${Math.round(pct * 100)} % de vos revenus du mois sont déjà dépensés.`
          : 'Saisissez vos revenus pour voir cette barre.'}</p>
      </div>
      ${(() => {
        const ytd = savingsYTD(mk);
        const year = mk.slice(0, 4);
        if (!D().settings.savings && !ytd.total) {
          return `<div class="card"><h3>💰 Épargne</h3>
            <p class="muted" style="margin:0">Aucun objectif d'épargne pour l'instant.</p>
            <button class="btn secondary" data-act="savings-month">Fixer un objectif d'épargne</button></div>`;
        }
        const start = shiftMonth(mk, 1 - ytd.months);
        const since = `${ytd.months} mois, depuis ${monthLabel(start, false)}`;
        return `<div class="card">
          <h3>💰 Épargne</h3>
          <div class="cat-head" style="display:flex;justify-content:space-between"><span>Mise de côté ${esc(de(mk))}</span><b>${money(sav)}</b></div>
          <div class="cat-head" style="display:flex;justify-content:space-between;margin-top:6px"><span>Total épargné en ${year}</span>
            <b class="pos" style="font-size:20px">${money(ytd.total)}</b></div>
          <p class="small muted" style="margin:2px 0 0">${esc(since)} · objectif habituel ${money(D().settings.savings)} / mois</p>
          <button class="btn secondary" data-act="savings-month">Modifier l'épargne ${esc(de(mk))}</button>
        </div>`;
      })()}
      ${(() => {
        const sh = sharedSummary(mk);
        if (!sh.list.length) return '';
        return `<div class="card">
          <h3>👨‍👧 Frais partagés</h3>
          <div class="cat-head" style="display:flex;justify-content:space-between"><span>Total partagé (${sh.list.length})</span><b>${money(sh.total)}</b></div>
          <div class="cat-head" style="display:flex;justify-content:space-between;margin-top:6px"><span>Part due par l'autre parent</span>
            <b style="font-size:20px">${money(sh.due)}</b></div>
          ${sh.refund ? `<p class="small pos" style="margin:4px 0 0">✓ Remboursement de ${money(sh.refund.amount)} ajouté aux revenus</p>` : ''}
          <button class="btn secondary" data-act="shared">Voir le détail</button>
        </div>`;
      })()}
      ${(() => {
        const bs = budgetStatuses(mk);
        if (!bs.length) return '';
        return `<div class="card">
          <h3>Budgets</h3>
          ${bs.map(s => `
            <div class="cat-row">
              <div class="cat-head"><span>${s.level === 'over' ? '⛔ ' : s.level === 'warn' ? '⚠️ ' : ''}${esc(s.cat.name)}</span>
                <b class="${s.level === 'over' ? 'neg' : ''}">${money(s.spent)} <span class="muted small">/ ${money(s.cat.budget)}</span></b></div>
              <div class="progress ${s.level}"><div style="width:${Math.min(100, s.pct * 100)}%"></div></div>
              <div class="small ${s.level === 'over' ? 'neg' : 'muted'}" style="margin-top:2px">${s.spent <= s.cat.budget
                ? `Reste ${money(s.cat.budget - s.spent)} · ${Math.floor(s.pct * 100)} %`
                : `Dépassé de ${money(s.spent - s.cat.budget)}`}</div>
            </div>`).join('')}
        </div>`;
      })()}
      <div class="card">
        <h3>Dépenses par catégorie</h3>
        ${rows.length ? rows.map(([id, amt]) => `
          <div class="cat-row">
            <div class="cat-head"><span>${esc(catName(id))}</span>
              <b>${money(amt)} <span class="muted small">(${Math.round(amt / spent * 100)} %)</span></b></div>
            <div class="progress"><div style="width:${amt / max * 100}%"></div></div>
          </div>`).join('') : '<p class="empty">Aucune dépense ce mois-ci.<br>Appuyez sur <b>+</b> pour en ajouter une.</p>'}
      </div>`;
  },

  /* ---------- Liste des dépenses ---------- */
  expenses() {
    if (ui.search) return renderSearch();
    const list = expensesOf(ui.month);
    let html = `<div class="card"><b>${list.length} dépense${list.length > 1 ? 's' : ''}</b>
      <span class="muted"> · total ${money(list.reduce((s, e) => s + e.amount, 0))}</span>
      <div class="btn-row">
        <button class="btn secondary" data-act="search" style="min-height:44px;font-size:15px">🔍 Rechercher</button>
        <button class="btn secondary" data-act="recurring" style="min-height:44px;font-size:15px">🔁 Fixes</button>
      </div></div>`;
    html += list.length
      ? expenseListHTML(list)
      : '<div class="card empty">Aucune dépense ce mois-ci.<br>Appuyez sur <b>+</b> pour en ajouter une.</div>';
    $('#view').innerHTML = html;
  },

  /* ---------- Revenus ---------- */
  incomes() {
    const mk = ui.month;
    const sal = salaryOf(mk);
    const prev = previousSalary(mk);
    const others = incomesOf(mk).filter(i => !i.isSalary);
    $('#view').innerHTML = `
      <div class="card">
        <h3>Salaire ${esc(de(mk))}</h3>
        ${sal ? `
          <div class="rest-value" style="font-size:32px">${money(sal.amount)}</div>
          <button class="btn secondary" data-act="edit-salary">Modifier le salaire</button>` : `
          <p class="muted" style="margin:0">Pas encore saisi.</p>
          <button class="btn" data-act="edit-salary">Saisir le salaire</button>
          ${prev ? `<button class="btn secondary" data-act="copy-salary">Reprendre ${money(prev.amount)} (${esc(monthLabel(prev.month, false))})</button>` : ''}`}
      </div>
      <div class="card">
        <h3>Autres revenus</h3>
        ${others.length ? `<ul class="list">${others.map(i => `
          <li class="tap" data-id="${esc(i.id)}"><div class="grow"><div class="title">${esc(i.label)}</div></div>
          <div class="amount">${money(i.amount)}</div></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Aucun autre revenu ce mois-ci.</p>'}
        <button class="btn secondary" data-act="add-income">+ Ajouter un revenu</button>
      </div>
      <div class="card"><div class="cat-head" style="display:flex;justify-content:space-between">
        <b>Total des revenus</b><b>${money(totalIncome(mk))}</b></div></div>`;
  },

  /* ---------- Vue annuelle ---------- */
  year() {
    const stats = yearMonths(ui.year).map(monthStats);
    const sum = k => stats.reduce((s, m) => s + m[k], 0);
    const inc = sum('inc'), spent = sum('spent'), sav = sum('sav'), rest = sum('rest');
    const active = stats.filter(s => s.active);

    const byCat = {};
    D().expenses.filter(e => e.date.startsWith(ui.year + '-'))
      .forEach(e => { byCat[e.catId] = (byCat[e.catId] || 0) + e.amount; });
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const max = cats.length ? cats[0][1] : 1;

    if (!active.length) {
      $('#view').innerHTML = `<div class="card empty">Aucune donnée pour ${ui.year}.</div>`;
      return;
    }
    $('#view').innerHTML = `
      <div class="card rest-card">
        <div class="rest-label">Reste cumulé ${ui.year}</div>
        <div class="rest-value ${rest >= 0 ? 'pos' : 'neg'}">${money(rest)}</div>
        <div class="small muted">${active.length} mois suivi${active.length > 1 ? 's' : ''} · moyenne ${money(Math.round(rest / active.length))} / mois</div>
      </div>
      <div class="kpis two">
        <div class="kpi"><span>Revenus</span><b>${money(inc)}</b></div>
        <div class="kpi"><span>Dépenses</span><b>${money(spent)}</b></div>
        <div class="kpi"><span>Épargne</span><b>${money(sav)}</b></div>
        <div class="kpi"><span>Dépenses moy. / mois</span><b>${money(Math.round(spent / active.length))}</b></div>
      </div>
      <div class="card chart">
        <h3>Revenus et dépenses par mois</h3>
        <div class="legend"><span><i style="background:var(--series-1)"></i>Revenus</span><span><i style="background:var(--series-2)"></i>Dépenses</span></div>
        ${yearChartSVG(stats)}
        <div class="chart-detail" id="year-detail">${yearDetailText(ui.yearSel)}</div>
      </div>
      <div class="card">
        <h3>Mois par mois</h3>
        <table class="ytable">
          <thead><tr><th>Mois</th><th>Revenus</th><th>Dépenses</th><th>Épargne</th><th>Reste</th></tr></thead>
          <tbody>${stats.map((s, i) => s.active ? `
            <tr class="tap" data-goto="${s.mk}"><td>${MONTH_SHORT[i]}</td><td>${moneyShort(s.inc)}</td><td>${moneyShort(s.spent)}</td>
              <td>${moneyShort(s.sav)}</td><td class="${s.rest >= 0 ? 'pos' : 'neg'}">${moneyShort(s.rest)}</td></tr>` : `
            <tr class="off"><td>${MONTH_SHORT[i]}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td>${moneyShort(inc)}</td><td>${moneyShort(spent)}</td><td>${moneyShort(sav)}</td>
            <td class="${rest >= 0 ? 'pos' : 'neg'}">${moneyShort(rest)}</td></tr></tfoot>
        </table>
        <p class="small muted" style="margin:8px 0 0">Touchez un mois pour l'ouvrir.</p>
      </div>
      <div class="card">
        <h3>Dépenses par catégorie sur l'année</h3>
        ${cats.length ? cats.map(([id, amt]) => `
          <div class="cat-row">
            <div class="cat-head"><span>${esc(catName(id))}</span>
              <b>${money(amt)} <span class="muted small">(${Math.round(amt / spent * 100)} %)</span></b></div>
            <div class="progress"><div style="width:${amt / max * 100}%"></div></div>
            <div class="small muted" style="margin-top:2px">soit ${money(Math.round(amt / active.length))} / mois en moyenne</div>
          </div>`).join('') : '<p class="empty">Aucune dépense cette année.</p>'}
      </div>
      <button class="btn" data-act="export-year">📤 Exporter l'année ${ui.year} en Excel</button>`;
  },

  /* ---------- Réglages ---------- */
  settings() {
    const exp = Object.keys(D().settings.exported || {}).sort().pop();
    const lastBackup = D().settings.lastBackup;
    $('#view').innerHTML = `
      <div class="card">
        <h3>👤 Votre prénom</h3>
        <p class="muted" style="margin:0">${D().settings.name ? esc(D().settings.name) : 'Pas encore indiqué.'}</p>
        <button class="btn secondary" data-act="name">${D().settings.name ? 'Modifier le prénom' : 'Indiquer mon prénom'}</button>
      </div>
      <div class="card">
        <h3>💾 Sauvegarde</h3>
        <p class="muted" style="margin:0">${lastBackup
          ? `Dernière sauvegarde : ${esc(new Date(lastBackup).toLocaleDateString('fr-FR'))}`
          : 'Aucune sauvegarde pour l\'instant.'}</p>
        <button class="btn" data-act="backup">Sauvegarder / restaurer</button>
      </div>
      <div class="card">
        <h3>📤 Export Excel</h3>
        <p class="muted" style="margin:0">${exp ? `Dernier mois exporté : ${esc(monthLabel(exp))}` : 'Aucun export pour l\'instant.'}</p>
        <button class="btn" data-act="export">Exporter un mois ou l'année</button>
      </div>
      <div class="card">
        <h3>Épargne</h3>
        <p style="margin:0">Objectif mensuel : <b>${money(D().settings.savings)}</b></p>
        <p class="muted" style="margin:4px 0 0">Total épargné en ${currentMonthKey().slice(0, 4)} : ${money(savingsYTD(currentMonthKey()).total)}</p>
        <button class="btn secondary" data-act="savings">Modifier l'objectif d'épargne</button>
      </div>
      <div class="card">
        <h3>Dépenses fixes</h3>
        <p class="muted" style="margin:0">${D().recurring.length
          ? `${D().recurring.length} dépense(s) fixe(s) · ${money(D().recurring.reduce((s, r) => s + r.amount, 0))} / mois`
          : 'Loyer, assurances, abonnements… ajoutés automatiquement chaque mois.'}</p>
        <button class="btn secondary" data-act="recurring">Gérer les dépenses fixes</button>
      </div>
      <div class="card">
        <h3>Dépenses favorites</h3>
        <p class="muted" style="margin:0">${D().favorites.length
          ? `${D().favorites.length} favori(s)`
          : 'Vos dépenses fréquentes, à ajouter en un seul appui.'}</p>
        <button class="btn secondary" data-act="favorites">Gérer les favoris</button>
      </div>
      <div class="card">
        <h3>Frais partagés</h3>
        <p class="muted" style="margin:0">Part de l'autre parent par défaut : <b>${D().settings.sharePct} %</b></p>
        <button class="btn secondary" data-act="share-pct">Modifier le pourcentage</button>
      </div>
      <div class="card">
        <h3>Budgets par catégorie</h3>
        <p class="muted" style="margin:0">${(() => {
          const b = D().categories.filter(c => c.budget);
          return b.length ? `${b.length} budget(s) · ${money(b.reduce((s, c) => s + c.budget, 0))} / mois`
            : 'Fixez un plafond mensuel pour les catégories de votre choix.';
        })()}</p>
        <button class="btn secondary" data-act="budgets">Gérer les budgets</button>
      </div>
      <div class="card">
        <h3>Catégories</h3>
        <p class="muted" style="margin:0">${D().categories.length} catégories</p>
        <button class="btn secondary" data-act="categories">Gérer les catégories</button>
      </div>
      <div class="card">
        <h3>Sécurité</h3>
        <button class="btn secondary" data-act="change-pin">Changer le code</button>
        <button class="btn secondary" data-act="lock">Verrouiller maintenant</button>
        <div class="warn-box"><b>Si vous oubliez votre code</b>, vos données ne pourront pas être récupérées
          (elles sont chiffrées avec ce code). Seul un fichier de sauvegarde permettra de les retrouver.</div>
      </div>
      <p class="small muted" style="text-align:center">Vos données restent uniquement sur cet appareil.<br>Aucun compte, aucun serveur.</p>`;
  }
};

/* Clics dans les écrans */
$('#view').addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'edit-salary') openSalarySheet(ui.month);
    if (a === 'copy-salary') copyPreviousSalary(ui.month);
    if (a === 'add-income') openIncomeSheet();
    if (a === 'savings') openSavingsSheet();
    if (a === 'savings-month') openSavingsSheet(ui.month);
    if (a === 'categories') openCategoriesSheet();
    if (a === 'recurring') openRecurringListSheet();
    if (a === 'budgets') openBudgetsSheet();
    if (a === 'favorites') openFavoritesSheet();
    if (a === 'shared') openSharedSheet(ui.month);
    if (a === 'export') openExportSheet();
    if (a === 'backup') openBackupSheet();
    if (a === 'name') openNameSheet();
    if (a === 'export-year') deliverFile(yearWorkbook(String(ui.year)), `${filePrefix()}-annee-${ui.year}.xlsx`, { back: closeSheet, backLabel: 'Fermer' });
    if (a === 'search') { ui.search = newSearch(); render(); setTimeout(() => $('#s-q')?.focus(), 50); }
    if (a === 'search-close') { ui.search = null; render(); }
    if (a === 'search-reset') { ui.search = { ...newSearch(), open: true }; render(); }
    if (a === 'share-pct') openSharePctSheet();
    if (a === 'change-pin') openChangePinSheet();
    if (a === 'lock') lockNow();
    return;
  }
  // Vue annuelle : choix d'un mois dans le graphique, ou ouverture d'un mois depuis le tableau
  const col = e.target.closest('.col[data-m], .axis-months [data-m]');
  if (col) {
    ui.yearSel = ui.yearSel === col.dataset.m ? null : col.dataset.m;
    document.querySelectorAll('.chart [data-m]').forEach(c => c.classList.toggle('sel', c.dataset.m === ui.yearSel));
    $('#year-detail').innerHTML = yearDetailText(ui.yearSel);
    return;
  }
  const row = e.target.closest('tr[data-goto]');
  if (row) {
    ui.month = row.dataset.goto;
    ui.tab = 'home';
    render();
    scrollTo(0, 0);
    return;
  }
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (ui.tab === 'expenses') openExpenseSheet(D().expenses.find(x => x.id === li.dataset.id));
  if (ui.tab === 'incomes') openIncomeSheet(incomesOf(ui.month).find(x => x.id === li.dataset.id));
});

document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
  scrollTo(0, 0);
});
function shiftPeriod(n) {
  if (ui.tab === 'year') { ui.year += n; ui.yearSel = null; }
  else ui.month = shiftMonth(ui.month, n);
  render();
}
$('#prev-month').addEventListener('click', () => shiftPeriod(-1));
$('#next-month').addEventListener('click', () => shiftPeriod(1));
$('#fab').addEventListener('click', () => openExpenseSheet());

/* =========================================================
 * Fenêtres (formulaires du bas de l'écran)
 * ========================================================= */
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet-backdrop').hidden = false;
  $('.sheet').scrollTop = 0;
  return $('#sheet-body');
}
function closeSheet() {
  $('#sheet-backdrop').hidden = true;
  $('#sheet-body').innerHTML = '';
}
$('#sheet-backdrop').addEventListener('click', e => {
  if (e.target.id === 'sheet-backdrop' || e.target.closest('[data-close]')) closeSheet();
  const chip = e.target.closest('.chip');
  if (chip && chip.parentElement.classList.contains('chips') && chip.parentElement.dataset.single !== undefined) {
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === chip));
    chip.parentElement.dataset.value = chip.dataset.v;
  }
});

function chips(items, selected) {
  return `<div class="chips" data-single data-value="${esc(selected)}">${items.map(([v, label]) =>
    `<button type="button" class="chip ${v === selected ? 'on' : ''}" data-v="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;
}

// Petit message en bas de l'écran, avec un bouton facultatif (ex. : « Annuler »)
let toastTimer;
function toast(msg, ms = 2200, action = null) {
  const t = $('#toast'), btn = $('#toast-btn');
  $('#toast-msg').textContent = msg;
  btn.hidden = !action;
  btn.textContent = action ? action.label : '';
  btn.onclick = action ? () => { t.hidden = true; action.fn(); } : null;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* Champ « frais partagés » réutilisé dans les formulaires (dépense, dépense fixe, favori) */
function sharedField(obj) {
  const pct = obj.shared ? obj.sharePct : D().settings.sharePct;
  return `<label class="check"><input type="checkbox" id="f-shared" ${obj.shared ? 'checked' : ''}>
      <span>👨‍👧 Frais partagés avec l'autre parent</span></label>
    <div id="f-share-box" ${obj.shared ? '' : 'hidden'}>
      <label class="field"><span>Part payée par l'autre parent (%)</span>
        <input id="f-pct" type="number" inputmode="numeric" min="1" max="100" value="${pct}"></label>
      <p class="small" id="f-share-info" style="margin:-8px 0 14px"></p>
    </div>`;
}
function bindSharedField() {
  const update = () => {
    $('#f-share-box').hidden = !$('#f-shared').checked;
    const amount = parseAmount($('#f-amount').value);
    const pct = Number($('#f-pct').value);
    $('#f-share-info').textContent = amount && pct >= 1 && pct <= 100
      ? `Part due par l'autre parent : ${money(Math.round(amount * pct / 100))}` : '';
  };
  ['#f-shared', '#f-pct', '#f-amount'].forEach(s => $(s).addEventListener('input', update));
  update();
}
// Renvoie { shared, sharePct } ou null si le pourcentage est invalide
function readSharedField() {
  if (!$('#f-shared').checked) return { shared: false, sharePct: null };
  const pct = Number($('#f-pct').value);
  if (!(pct >= 1 && pct <= 100)) { toast('Le pourcentage doit être entre 1 et 100.'); return null; }
  return { shared: true, sharePct: Math.round(pct * 100) / 100 };
}

function amountField(id, cents, label = 'Montant (€)') {
  return `<label class="field"><span>${label}</span>
    <input id="${id}" class="big" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${centsToInput(cents)}"></label>`;
}

/* ---------- Dépense ---------- */
function openExpenseSheet(existing) {
  const cats = D().categories;
  const isNew = !existing;
  const defaultDate = ui.month === currentMonthKey() ? todayISO() : ui.month + '-01';
  const e = existing || {
    amount: null,
    catId: catById(lastChoice.catId) ? lastChoice.catId : cats[0].id,
    pay: lastChoice.pay,
    date: defaultDate,
    comment: ''
  };
  const body = openSheet(`
    <h3>${isNew ? 'Nouvelle dépense' : 'Modifier la dépense'}</h3>
    ${e.recurringId ? `<p class="small muted" style="margin-top:-6px">🔁 Dépense fixe ajoutée automatiquement.
      Les changements ici ne concernent que ${esc(monthLabel(e.date.slice(0, 7)))}.</p>` : ''}
    ${amountField('f-amount', e.amount)}
    <div class="field"><span>Catégorie</span>${chips(cats.map(c => [c.id, c.name]), e.catId)}</div>
    <div class="field"><span>Mode de paiement</span>${chips(PAYMENTS.map(p => [p, p]), e.pay)}</div>
    <label class="field"><span>Date</span><input id="f-date" type="date" value="${esc(e.date)}"></label>
    <label class="field"><span>Commentaire (facultatif)</span>
      <input id="f-comment" type="text" maxlength="120" value="${esc(e.comment)}" placeholder="Ex. : Leclerc, pharmacie…"></label>
    ${sharedField(e)}
    ${isNew ? `<label class="check"><input type="checkbox" id="f-fav">
      <span>⭐ Garder aussi comme favori (pour la rajouter en un appui)</span></label>` : ''}
    <button class="btn" id="f-save">Enregistrer</button>
    ${isNew ? '' : '<button class="btn danger" id="f-del">Supprimer cette dépense</button>'}
    <button class="btn ghost" data-close>Annuler</button>`);
  const [catBox, payBox] = body.querySelectorAll('.chips');
  bindSharedField();
  if (isNew) setTimeout(() => $('#f-amount')?.focus(), 50);

  $('#f-save').onclick = () => {
    const amount = parseAmount($('#f-amount').value);
    const date = $('#f-date').value;
    if (!amount) return toast('Indiquez un montant valide (ex. : 12,50).');
    if (!date) return toast('Indiquez une date.');
    const share = readSharedField();
    if (!share) return;
    const rec = {
      amount, date,
      catId: catBox.dataset.value,
      pay: payBox.dataset.value,
      comment: $('#f-comment').value.trim(),
      ...share
    };
    const alertMsg = withBudgetCheck(date, rec.catId, () => {
      if (isNew) D().expenses.push({ id: Store.uid(), createdAt: new Date().toISOString(), ...rec });
      else Object.assign(existing, rec);
    });
    if (isNew && $('#f-fav').checked) {
      D().favorites.push({ id: Store.uid(), label: rec.comment || catName(rec.catId),
        amount, catId: rec.catId, pay: rec.pay, shared: rec.shared, sharePct: rec.sharePct });
    }
    lastChoice.catId = rec.catId;
    lastChoice.pay = rec.pay;
    closeSheet();
    const other = date.slice(0, 7) !== ui.month;
    if (alertMsg) {
      commit();
      toast(alertMsg, 5000);
    } else {
      commit(other ? `Dépense enregistrée en ${monthLabel(date.slice(0, 7))}` : 'Dépense enregistrée');
    }
  };
  if (!isNew) $('#f-del').onclick = () => {
    if (!confirm(`Supprimer cette dépense de ${money(existing.amount)} ?`)) return;
    D().expenses = D().expenses.filter(x => x !== existing);
    closeSheet();
    commit('Dépense supprimée');
  };
}

/* ---------- Salaire ---------- */
function openSalarySheet(mk, reminder = false) {
  const sal = salaryOf(mk);
  const prev = previousSalary(mk);
  openSheet(`
    <h3>Salaire ${esc(de(mk))}</h3>
    ${reminder ? '<p style="margin-top:-6px">Vous n\'avez pas encore saisi votre salaire de ce mois-ci.</p>' : ''}
    ${amountField('f-amount', sal ? sal.amount : null, 'Montant net reçu (€)')}
    <button class="btn" id="f-save">Enregistrer</button>
    ${!sal && prev ? `<button class="btn secondary" id="f-copy">Reprendre ${money(prev.amount)} (${esc(monthLabel(prev.month, false))})</button>` : ''}
    ${sal ? '<button class="btn danger" id="f-del">Supprimer le salaire</button>' : ''}
    <button class="btn ghost" data-close>${reminder ? 'Plus tard' : 'Annuler'}</button>`);
  if (!reminder) setTimeout(() => $('#f-amount')?.focus(), 50);

  $('#f-save').onclick = () => {
    const amount = parseAmount($('#f-amount').value);
    if (!amount) return toast('Indiquez un montant valide.');
    setSalary(mk, amount);
    closeSheet();
    commit('Salaire enregistré');
  };
  if ($('#f-copy')) $('#f-copy').onclick = () => { closeSheet(); copyPreviousSalary(mk); };
  if ($('#f-del')) $('#f-del').onclick = () => {
    if (!confirm('Supprimer le salaire de ce mois ?')) return;
    const m = monthData(mk, true);
    m.incomes = m.incomes.filter(i => !i.isSalary);
    closeSheet();
    commit('Salaire supprimé');
  };
}

function setSalary(mk, amount) {
  const m = monthData(mk, true);
  const sal = m.incomes.find(i => i.isSalary);
  if (sal) sal.amount = amount;
  else m.incomes.unshift({ id: Store.uid(), label: 'Salaire', amount, isSalary: true });
}

function copyPreviousSalary(mk) {
  const prev = previousSalary(mk);
  if (!prev) return;
  setSalary(mk, prev.amount);
  commit(`Salaire de ${money(prev.amount)} repris`);
}

/* ---------- Autre revenu ---------- */
function openIncomeSheet(existing) {
  const isNew = !existing;
  openSheet(`
    <h3>${isNew ? 'Ajouter un revenu' : 'Modifier le revenu'}</h3>
    <label class="field"><span>Libellé</span>
      <input id="f-label" type="text" maxlength="60" value="${esc(existing ? existing.label : '')}" placeholder="Ex. : Remboursement mutuelle"></label>
    <div class="chips" id="f-sugg" style="margin:-6px 0 14px">${INCOME_SUGGESTIONS.map(s =>
      `<button type="button" class="chip" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    ${amountField('f-amount', existing ? existing.amount : null)}
    <button class="btn" id="f-save">Enregistrer</button>
    ${isNew ? '' : '<button class="btn danger" id="f-del">Supprimer ce revenu</button>'}
    <button class="btn ghost" data-close>Annuler</button>`);
  $('#f-sugg').onclick = e => {
    const c = e.target.closest('[data-s]');
    if (c) $('#f-label').value = c.dataset.s;
  };
  $('#f-save').onclick = () => {
    const label = $('#f-label').value.trim();
    const amount = parseAmount($('#f-amount').value);
    if (!label) return toast('Indiquez un libellé.');
    if (!amount) return toast('Indiquez un montant valide.');
    if (isNew) monthData(ui.month, true).incomes.push({ id: Store.uid(), label, amount, isSalary: false });
    else Object.assign(existing, { label, amount });
    closeSheet();
    commit('Revenu enregistré');
  };
  if (!isNew) $('#f-del').onclick = () => {
    if (!confirm(`Supprimer « ${existing.label} » ?`)) return;
    const m = monthData(ui.month, true);
    m.incomes = m.incomes.filter(i => i !== existing);
    closeSheet();
    commit('Revenu supprimé');
  };
}

/* ---------- Épargne ---------- */
// mk : le mois à partir duquel on modifie l'épargne
function openSavingsSheet(mk = currentMonthKey()) {
  const isOverride = typeof monthData(mk).savings === 'number' && monthData(mk).savings !== D().settings.savings;
  openSheet(`
    <h3>Épargne ${esc(de(mk))}</h3>
    <p class="muted" style="margin-top:-6px">Ce montant est mis de côté et déduit du « reste ».
      Objectif habituel : <b>${money(D().settings.savings)}</b> / mois.</p>
    ${amountField('f-amount', savingsOf(mk), 'Montant à épargner (€)')}
    <div class="field"><span>Ce changement s'applique…</span>
      ${chips([['all', `à ${monthLabel(mk, false)} et aux mois suivants`], ['one', `à ${monthLabel(mk, false)} uniquement`]], 'all')}</div>
    <p class="small muted">Les mois précédents ne changent pas.</p>
    <button class="btn" id="f-save">Enregistrer</button>
    ${isOverride ? `<button class="btn secondary" id="f-reset">Revenir à l'objectif habituel (${money(D().settings.savings)})</button>` : ''}
    <button class="btn ghost" data-close>Annuler</button>`);
  const scopeBox = $('#sheet-body .chips');

  $('#f-save').onclick = () => {
    const v = $('#f-amount').value.trim();
    const amount = v === '' ? 0 : parseAmount(v);
    if (amount == null) return toast('Indiquez un montant valide.');
    if (scopeBox.dataset.value === 'one') {
      monthData(mk, true).savings = amount;
    } else {
      // On fige l'ancien montant des mois précédents, puis on change l'objectif habituel
      const old = D().settings.savings;
      for (let m = firstTrackedMonth(); m < mk; m = shiftMonth(m, 1)) {
        if (typeof monthData(m).savings !== 'number') monthData(m, true).savings = old;
      }
      Object.keys(D().months).forEach(m => { if (m >= mk) delete D().months[m].savings; });
      D().settings.savings = amount;
    }
    closeSheet();
    commit('Épargne enregistrée');
  };
  if ($('#f-reset')) $('#f-reset').onclick = () => {
    delete D().months[mk].savings;
    closeSheet();
    commit('Épargne remise à l\'objectif habituel');
  };
}

/* ---------- Dépenses récurrentes ---------- */
function openRecurringListSheet() {
  const list = [...D().recurring].sort((a, b) => a.day - b.day);
  const total = list.reduce((s, r) => s + r.amount, 0);
  openSheet(`
    <h3>Dépenses fixes mensuelles</h3>
    <p class="muted" style="margin-top:-6px">Elles sont ajoutées automatiquement au début de chaque mois
      et comptent tout de suite dans le « reste ».</p>
    ${list.length ? `<ul class="list" id="rec-list">${list.map(r => `
      <li class="tap" data-id="${esc(r.id)}"><div class="grow"><div class="title">${esc(r.label)}</div>
        <div class="sub">le ${r.day} · ${esc(catName(r.catId))} · ${esc(r.pay)}</div></div>
        <div class="amount">${money(r.amount)}</div></li>`).join('')}</ul>
      <p style="text-align:right;margin:8px 4px"><b>Total : ${money(total)} / mois</b></p>`
      : '<p class="empty">Aucune dépense fixe pour l\'instant.<br>Exemples : loyer, assurance, forfait téléphone…</p>'}
    <button class="btn" id="f-add">+ Ajouter une dépense fixe</button>
    <button class="btn ghost" data-close>Fermer</button>`);
  $('#f-add').onclick = () => openRecurringSheet();
  if ($('#rec-list')) $('#rec-list').onclick = e => {
    const li = e.target.closest('li[data-id]');
    if (li) openRecurringSheet(D().recurring.find(r => r.id === li.dataset.id));
  };
}

function openRecurringSheet(existing) {
  const cats = D().categories;
  const isNew = !existing;
  const r = existing || { label: '', amount: null, catId: cats[0].id, pay: 'Prélèvement', day: 1 };
  openSheet(`
    <h3>${isNew ? 'Nouvelle dépense fixe' : 'Modifier la dépense fixe'}</h3>
    <label class="field"><span>Libellé</span>
      <input id="f-label" type="text" maxlength="60" value="${esc(r.label)}" placeholder="Ex. : Loyer, Assurance auto"></label>
    ${amountField('f-amount', r.amount, 'Montant mensuel (€)')}
    <div class="field"><span>Catégorie</span>${chips(cats.map(c => [c.id, c.name]), catById(r.catId) ? r.catId : cats[0].id)}</div>
    <div class="field"><span>Mode de paiement</span>${chips(PAYMENTS.map(p => [p, p]), r.pay)}</div>
    <label class="field"><span>Jour du mois (1 à 31)</span>
      <input id="f-day" type="number" inputmode="numeric" min="1" max="31" value="${r.day}"></label>
    ${sharedField(r)}
    ${isNew ? `<label class="check"><input type="checkbox" id="f-now" checked>
      <span>L'ajouter aussi au mois en cours (${esc(monthLabel(currentMonthKey(), false))})</span></label>` : `
      <p class="small muted">Les changements s'appliquent au mois en cours et aux mois suivants.
      Les mois passés ne changent pas.</p>`}
    <button class="btn" id="f-save">Enregistrer</button>
    ${isNew ? '' : '<button class="btn danger" id="f-del">Supprimer cette dépense fixe</button>'}
    <button class="btn ghost" id="f-back">Retour</button>`);
  const [catBox, payBox] = $('#sheet-body').querySelectorAll('.chips');
  $('#f-back').onclick = openRecurringListSheet;
  bindSharedField();

  $('#f-save').onclick = () => {
    const label = $('#f-label').value.trim();
    const amount = parseAmount($('#f-amount').value);
    const day = parseInt($('#f-day').value, 10);
    if (!label) return toast('Indiquez un libellé.');
    if (!amount) return toast('Indiquez un montant valide.');
    if (!(day >= 1 && day <= 31)) return toast('Le jour doit être entre 1 et 31.');
    const share = readSharedField();
    if (!share) return;
    const rec = { label, amount, day, catId: catBox.dataset.value, pay: payBox.dataset.value, ...share };
    const cur = currentMonthKey();
    if (isNew) {
      const startMonth = $('#f-now').checked ? cur : shiftMonth(cur, 1);
      D().recurring.push({ id: Store.uid(), startMonth, ...rec });
      generateRecurring();
    } else {
      Object.assign(existing, rec);
      // On met aussi à jour la ligne déjà ajoutée ce mois-ci
      const inst = recurringInstance(existing, cur);
      if (inst) Object.assign(inst, { amount, catId: rec.catId, pay: rec.pay, comment: label, date: recurringDate(cur, day),
        shared: rec.shared, sharePct: rec.sharePct });
    }
    commit('Dépense fixe enregistrée');
    openRecurringListSheet();
  };

  if (!isNew) $('#f-del').onclick = () => {
    if (!confirm(`Supprimer la dépense fixe « ${existing.label} » ?\n\nElle ne sera plus ajoutée les mois suivants.`)) return;
    const inst = recurringInstance(existing, currentMonthKey());
    if (inst && confirm(`Supprimer aussi la ligne de ${money(inst.amount)} déjà ajoutée ce mois-ci ?`)) {
      D().expenses = D().expenses.filter(e => e !== inst);
    }
    D().recurring = D().recurring.filter(x => x !== existing);
    commit('Dépense fixe supprimée');
    openRecurringListSheet();
  };
}

/* ---------- Frais partagés ---------- */
function openSharedSheet(mk) {
  const sh = sharedSummary(mk);
  openSheet(`
    <h3>Frais partagés ${esc(de(mk))}</h3>
    <ul class="list">${sh.list.map(e => `
      <li><div class="grow"><div class="title">${esc(e.comment || catName(e.catId))}</div>
        <div class="sub">${esc(new Date(e.date + 'T12:00').toLocaleDateString('fr-FR'))} · ${esc(catName(e.catId))} · ${money(e.amount)} × ${e.sharePct} %</div></div>
        <div class="amount">${money(sharedDue(e))}</div></li>`).join('')}
    </ul>
    <div class="card" style="margin-top:12px">
      <div style="display:flex;justify-content:space-between"><span>Total des frais partagés</span><b>${money(sh.total)}</b></div>
      <div style="display:flex;justify-content:space-between;margin-top:6px"><span>Part due par l'autre parent</span><b style="font-size:20px">${money(sh.due)}</b></div>
    </div>
    ${sh.refund
      ? `<p class="small pos">✓ Un remboursement de ${money(sh.refund.amount)} est déjà dans vos revenus ${esc(de(mk))}
         (modifiable dans l'onglet Revenus).</p>`
      : `<p class="small muted">Quand l'autre parent vous a remboursé, vous pouvez l'ajouter à vos revenus du mois en un appui.</p>
         <button class="btn secondary" id="f-refund">Ajouter ${money(sh.due)} aux revenus (remboursement reçu)</button>`}
    <button class="btn ghost" data-close>Fermer</button>`);
  if ($('#f-refund')) $('#f-refund').onclick = () => {
    monthData(mk, true).incomes.push({
      id: Store.uid(), label: 'Remboursement frais partagés', amount: sh.due, isSalary: false, isSharedRefund: true
    });
    closeSheet();
    commit('Remboursement ajouté aux revenus');
  };
}

function openSharePctSheet() {
  openSheet(`
    <h3>Frais partagés</h3>
    <p class="muted" style="margin-top:-6px">Pourcentage proposé par défaut quand vous cochez « frais partagés ».
      Vous pourrez toujours le changer dépense par dépense.</p>
    <label class="field"><span>Part payée par l'autre parent (%)</span>
      <input id="f-pct" type="number" inputmode="numeric" min="1" max="100" class="big" value="${D().settings.sharePct}"></label>
    <button class="btn" id="f-save">Enregistrer</button>
    <button class="btn ghost" data-close>Annuler</button>`);
  $('#f-save').onclick = () => {
    const pct = Number($('#f-pct').value);
    if (!(pct >= 1 && pct <= 100)) return toast('Le pourcentage doit être entre 1 et 100.');
    D().settings.sharePct = Math.round(pct * 100) / 100;
    closeSheet();
    commit('Pourcentage enregistré');
  };
}

/* ---------- Dépenses favorites ---------- */
function openFavoritesSheet() {
  const list = D().favorites;
  openSheet(`
    <h3>Dépenses favorites</h3>
    <p class="muted" style="margin-top:-6px">Elles apparaissent en haut de l'Accueil et des Dépenses.
      Un appui suffit pour les ajouter (à la date du jour).</p>
    ${list.length ? `<ul class="list" id="fav-list">${list.map(f => `
      <li class="tap" data-id="${esc(f.id)}"><div class="grow"><div class="title">⭐ ${esc(f.label)}</div>
        <div class="sub">${esc(catName(f.catId))} · ${esc(f.pay)}</div></div>
        <div class="amount">${money(f.amount)}</div></li>`).join('')}</ul>`
      : '<p class="empty">Aucun favori pour l\'instant.<br>Exemples : boulangerie, plein d\'essence, cantine…</p>'}
    <button class="btn" id="f-add">+ Ajouter un favori</button>
    <button class="btn ghost" data-close>Fermer</button>`);
  $('#f-add').onclick = () => openFavoriteSheet();
  if ($('#fav-list')) $('#fav-list').onclick = e => {
    const li = e.target.closest('li[data-id]');
    if (li) openFavoriteSheet(list.find(f => f.id === li.dataset.id));
  };
}

function openFavoriteSheet(existing) {
  const cats = D().categories;
  const isNew = !existing;
  const f = existing || { label: '', amount: null, catId: cats[0].id, pay: 'CB' };
  openSheet(`
    <h3>${isNew ? 'Nouveau favori' : 'Modifier le favori'}</h3>
    <label class="field"><span>Libellé</span>
      <input id="f-label" type="text" maxlength="40" value="${esc(f.label)}" placeholder="Ex. : Boulangerie"></label>
    ${amountField('f-amount', f.amount)}
    <div class="field"><span>Catégorie</span>${chips(cats.map(c => [c.id, c.name]), catById(f.catId) ? f.catId : cats[0].id)}</div>
    <div class="field"><span>Mode de paiement</span>${chips(PAYMENTS.map(p => [p, p]), f.pay)}</div>
    ${sharedField(f)}
    <button class="btn" id="f-save">Enregistrer</button>
    ${isNew ? '' : '<button class="btn danger" id="f-del">Supprimer ce favori</button>'}
    <button class="btn ghost" id="f-back">Retour</button>`);
  const [catBox, payBox] = $('#sheet-body').querySelectorAll('.chips');
  $('#f-back').onclick = openFavoritesSheet;
  bindSharedField();
  $('#f-save').onclick = () => {
    const label = $('#f-label').value.trim();
    const amount = parseAmount($('#f-amount').value);
    if (!label) return toast('Indiquez un libellé.');
    if (!amount) return toast('Indiquez un montant valide.');
    const share = readSharedField();
    if (!share) return;
    const rec = { label, amount, catId: catBox.dataset.value, pay: payBox.dataset.value, ...share };
    if (isNew) D().favorites.push({ id: Store.uid(), ...rec });
    else Object.assign(existing, rec);
    commit('Favori enregistré');
    openFavoritesSheet();
  };
  if (!isNew) $('#f-del').onclick = () => {
    if (!confirm(`Supprimer le favori « ${existing.label} » ?\n\nLes dépenses déjà ajoutées sont conservées.`)) return;
    D().favorites = D().favorites.filter(x => x !== existing);
    commit('Favori supprimé');
    openFavoritesSheet();
  };
}

/* ---------- Budgets par catégorie ---------- */
function openBudgetsSheet() {
  const cats = D().categories;
  openSheet(`
    <h3>Budgets par catégorie</h3>
    <p class="muted" style="margin-top:-6px">Montant maximum à dépenser chaque mois. Laissez vide pour ne pas fixer de budget.
      Vous serez alerté à 80 % et à 100 %.</p>
    <ul class="list">${cats.map(c => `
      <li><div class="grow"><div class="title">${esc(c.name)}</div></div>
        <input type="text" inputmode="decimal" autocomplete="off" data-bud="${esc(c.id)}" placeholder="Aucun"
          value="${centsToInput(c.budget)}" style="width:120px;text-align:right" aria-label="Budget ${esc(c.name)}"></li>`).join('')}
    </ul>
    <button class="btn" id="f-save">Enregistrer</button>
    <button class="btn ghost" data-close>Annuler</button>`);
  $('#f-save').onclick = () => {
    const inputs = [...document.querySelectorAll('#sheet-body [data-bud]')];
    const values = {};
    for (const i of inputs) {
      const v = i.value.trim();
      const amount = v === '' ? null : parseAmount(v);
      if (v !== '' && !amount) {
        i.focus();
        return toast(`Montant invalide pour « ${catName(i.dataset.bud)} ».`);
      }
      values[i.dataset.bud] = amount;
    }
    cats.forEach(c => { c.budget = values[c.id] ?? null; });
    closeSheet();
    commit('Budgets enregistrés');
  };
}

/* ---------- Catégories ---------- */
function openCategoriesSheet() {
  const cats = D().categories;
  openSheet(`
    <h3>Catégories</h3>
    <ul class="list">${cats.map(c => `
      <li><div class="grow"><div class="title">${esc(c.name)}</div></div>
        <button class="chip" data-ren="${esc(c.id)}">Renommer</button>
        <button class="chip" data-delc="${esc(c.id)}" aria-label="Supprimer ${esc(c.name)}">🗑</button></li>`).join('')}
    </ul>
    <label class="field" style="margin-top:14px"><span>Nouvelle catégorie</span>
      <input id="f-new" type="text" maxlength="40" placeholder="Ex. : Animaux"></label>
    <button class="btn" id="f-add">Ajouter</button>
    <button class="btn ghost" data-close>Fermer</button>`);

  $('#f-add').onclick = () => {
    const name = $('#f-new').value.trim();
    if (!name) return toast('Indiquez un nom.');
    if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) return toast('Cette catégorie existe déjà.');
    cats.push({ id: Store.uid(), name, budget: null });
    commit('Catégorie ajoutée');
    openCategoriesSheet();
  };
  $('#sheet-body').querySelector('.list').onclick = e => {
    const ren = e.target.closest('[data-ren]');
    const del = e.target.closest('[data-delc]');
    if (ren) openRenameCategorySheet(catById(ren.dataset.ren));
    if (del) deleteCategory(catById(del.dataset.delc));
  };
}

function openRenameCategorySheet(cat) {
  openSheet(`
    <h3>Renommer « ${esc(cat.name)} »</h3>
    <label class="field"><span>Nouveau nom</span>
      <input id="f-name" type="text" maxlength="40" value="${esc(cat.name)}"></label>
    <button class="btn" id="f-save">Enregistrer</button>
    <button class="btn ghost" id="f-back">Annuler</button>`);
  $('#f-back').onclick = openCategoriesSheet;
  $('#f-save').onclick = () => {
    const name = $('#f-name').value.trim();
    if (!name) return toast('Indiquez un nom.');
    if (D().categories.some(c => c !== cat && c.name.toLowerCase() === name.toLowerCase())) return toast('Ce nom existe déjà.');
    cat.name = name;
    commit('Catégorie renommée');
    openCategoriesSheet();
  };
}

function deleteCategory(cat) {
  const cats = D().categories;
  if (cats.length <= 1) return toast('Il faut garder au moins une catégorie.');
  const used = D().expenses.filter(e => e.catId === cat.id);
  const target = cats.find(c => c !== cat && c.name === 'Divers') || cats.find(c => c !== cat);
  const msg = used.length
    ? `Supprimer « ${cat.name} » ?\n\nSes ${used.length} dépense(s) seront déplacées dans « ${target.name} ».`
    : `Supprimer « ${cat.name} » ?`;
  if (!confirm(msg)) return;
  used.forEach(e => { e.catId = target.id; });
  [...D().recurring, ...D().favorites].forEach(r => { if (r.catId === cat.id) r.catId = target.id; });
  D().categories = cats.filter(c => c !== cat);
  commit('Catégorie supprimée');
  openCategoriesSheet();
}

/* ---------- Prénom ---------- */
function openNameSheet() {
  openSheet(`
    <h3>Votre prénom</h3>
    <label class="field"><span>Prénom</span>
      <input id="f-name" type="text" maxlength="30" autocomplete="given-name" value="${esc(D().settings.name)}"></label>
    <p class="small muted" style="margin-top:-6px">Il s'affiche sur l'écran du code et dans le nom des fichiers Excel et de sauvegarde.</p>
    <button class="btn" id="f-save">Enregistrer</button>
    <button class="btn ghost" data-close>Annuler</button>`);
  setTimeout(() => $('#f-name')?.focus(), 50);
  $('#f-save').onclick = async () => {
    const name = $('#f-name').value.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!name) return toast('Indiquez un prénom.');
    await Store.setName(name);
    closeSheet();
    render();
    toast('Prénom enregistré');
  };
}

/* ---------- Changer le code ---------- */
function openChangePinSheet() {
  const pinInput = (id, label) => `<label class="field"><span>${label}</span>
    <input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" class="big"></label>`;
  openSheet(`
    <h3>Changer le code</h3>
    ${pinInput('f-old', 'Code actuel')}
    ${pinInput('f-new1', 'Nouveau code (4 à 6 chiffres)')}
    ${pinInput('f-new2', 'Confirmez le nouveau code')}
    <div class="warn-box">Retenez bien le nouveau code : sans lui, vos données ne pourront pas être récupérées.</div>
    <button class="btn" id="f-save">Changer le code</button>
    <button class="btn ghost" data-close>Annuler</button>`);
  $('#f-save').onclick = async () => {
    const oldPin = $('#f-old').value, p1 = $('#f-new1').value, p2 = $('#f-new2').value;
    if (!/^\d{4,6}$/.test(p1)) return toast('Le nouveau code doit contenir 4 à 6 chiffres.');
    if (p1 !== p2) return toast('Les deux nouveaux codes sont différents.');
    const btn = $('#f-save');
    btn.disabled = true;
    btn.textContent = 'Un instant…';
    const ok = await Store.changePin(oldPin, p1);
    if (!ok) {
      btn.disabled = false;
      btn.textContent = 'Changer le code';
      return toast('Le code actuel est incorrect.');
    }
    closeSheet();
    toast('Code modifié');
  };
}

/* =========================================================
 * Démarrage
 * ========================================================= */
if (!window.crypto || !crypto.subtle) {
  document.body.innerHTML = '<p style="padding:24px">Cette application doit être ouverte depuis une adresse sécurisée (https).</p>';
} else {
  showLock(Store.hasVault() ? 'unlock' : 'name');
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}
