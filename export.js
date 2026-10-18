'use strict';

/*
 * Export Excel : prépare le contenu des classeurs (mois ou année) à partir des données,
 * puis Xlsx.build fabrique le fichier.
 * Les montants sont écrits en euros (pas en centimes).
 */
const E = c => (c == null ? null : Math.round(c) / 100);
const eur = c => ({ v: E(c), s: 'euro' });
const H = t => ({ v: t, s: 'header' });
const T = t => ({ v: t, s: 'title' });
const totalRow = (n, values) => Array.from({ length: n }, (_, i) =>
  (i in values ? (typeof values[i] === 'object' ? values[i] : { v: values[i], s: 'totalLabel' }) : { v: '', s: 'totalLabel' }));
const exportNote = () => ({
  v: `Exporté le ${new Date().toLocaleDateString('fr-FR')} depuis Mon Budget${D().settings.name ? ` — budget de ${D().settings.name}` : ''}`,
  s: 'note'
});
// « Budget-Marie » : début des noms de fichiers (prénom sans accents ni espaces)
function filePrefix() {
  const n = (D().settings.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return n ? `Budget-${n}` : 'Budget';
}
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

function expenseRows(list) {
  return list.map(e => [
    { v: e.date, s: 'date' },
    catName(e.catId),
    eur(e.amount),
    e.pay,
    e.comment || '',
    e.shared ? `Oui (${e.sharePct} %)` : 'Non'
  ]);
}
const ascending = list => list.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));

/* ---------- Export d'un mois ---------- */
function monthWorkbook(mk) {
  const prev = shiftMonth(mk, -1);
  const label = capital(monthLabel(mk));
  const cur = monthStats(mk), before = monthStats(prev);
  const list = ascending(expensesOf(mk));

  // Onglet « Détail »
  const detail = {
    name: 'Détail', cols: [12, 22, 13, 15, 36, 16], freezeRow: 3,
    rows: [
      [T(`Dépenses — ${label}`)],
      [exportNote()],
      ['Date', 'Catégorie', 'Montant', 'Mode de paiement', 'Commentaire', 'Frais partagés'].map(H),
      ...expenseRows(list),
      totalRow(6, { 0: `Total (${list.length} dépense${list.length > 1 ? 's' : ''})`, 2: { v: E(cur.spent), s: 'totalEuro' } })
    ]
  };

  // Onglet « Synthèse »
  const rows = [[T(`Synthèse — ${label}`)], [exportNote()], []];
  const p = before.active;
  const diff = (a, b) => (p ? eur(a - b) : null);
  rows.push([H('Bilan du mois'), H(capital(monthLabel(mk))), H(capital(monthLabel(prev))), H('Variation')]);
  rows.push(['Revenus', eur(cur.inc), p ? eur(before.inc) : null, diff(cur.inc, before.inc)]);
  rows.push(['Total des dépenses', eur(cur.spent), p ? eur(before.spent) : null, diff(cur.spent, before.spent)]);
  rows.push(['Épargne', eur(cur.sav), p ? eur(before.sav) : null, diff(cur.sav, before.sav)]);
  rows.push(totalRow(4, { 0: 'Reste en fin de mois', 1: { v: E(cur.rest), s: 'totalEuro' },
    2: p ? { v: E(before.rest), s: 'totalEuro' } : undefined, 3: p ? { v: E(cur.rest - before.rest), s: 'totalEuro' } : undefined }));
  if (!p) rows.push([{ v: `Pas de données pour ${monthLabel(prev)} : comparaison impossible.`, s: 'note' }]);
  rows.push([]);

  rows.push([H('Revenus'), H('Montant')]);
  incomesOf(mk).forEach(i => rows.push([i.label, eur(i.amount)]));
  if (!incomesOf(mk).length) rows.push([{ v: 'Aucun revenu saisi', s: 'note' }]);
  rows.push(totalRow(2, { 0: 'Total des revenus', 1: { v: E(cur.inc), s: 'totalEuro' } }));
  rows.push([]);

  const spentBy = m => {
    const o = {};
    expensesOf(m).forEach(e => { o[e.catId] = (o[e.catId] || 0) + e.amount; });
    return o;
  };
  const now = spentBy(mk), old = spentBy(prev);
  const cats = D().categories
    .filter(c => now[c.id] || old[c.id] || c.budget)
    .sort((a, b) => (now[b.id] || 0) - (now[a.id] || 0));
  // Dépenses dont la catégorie n'existe plus
  const orphan = Object.keys(now).filter(id => !catById(id));

  rows.push(['Catégorie', 'Dépensé', 'Budget', 'Écart (budget − dépensé)', '% du budget', capital(monthLabel(prev)), 'Variation'].map(H));
  const catStart = rows.length + 1;
  cats.forEach(c => {
    const s = now[c.id] || 0, o = old[c.id] || 0;
    rows.push([
      c.name, eur(s),
      c.budget ? eur(c.budget) : null,
      c.budget ? eur(c.budget - s) : null,
      c.budget ? { v: Math.round(s / c.budget * 1000) / 1000, s: 'pct' } : null,
      p ? eur(o) : null,
      p ? eur(s - o) : null
    ]);
  });
  orphan.forEach(id => rows.push(['Sans catégorie', eur(now[id])]));
  const catEnd = rows.length;
  const budgetTotal = cats.reduce((sum, c) => sum + (c.budget || 0), 0);
  rows.push(totalRow(7, {
    0: 'Total', 1: { v: E(cur.spent), s: 'totalEuro' },
    2: budgetTotal ? { v: E(budgetTotal), s: 'totalEuro' } : undefined,
    5: p ? { v: E(before.spent), s: 'totalEuro' } : undefined,
    6: p ? { v: E(cur.spent - before.spent), s: 'totalEuro' } : undefined
  }));
  rows.push([{ v: 'Écart positif = il reste du budget ; négatif (en rouge) = budget dépassé.', s: 'note' }]);

  const catNames = rows.slice(catStart - 1, catEnd).map(r => r[0]);
  const catVals = rows.slice(catStart - 1, catEnd).map(r => r[1].v);
  const synth = {
    name: 'Synthèse', cols: [26, 15, 15, 22, 12, 15, 13], rows,
    chart: catNames.length ? {
      title: `Dépenses par catégorie — ${label}`,
      from: [8, 2], to: [16, 22],
      cats: { ref: Xlsx.ref('Synthèse', 0, catStart, catEnd), values: catNames },
      series: [{ name: 'Dépensé', ref: Xlsx.ref('Synthèse', 1, catStart, catEnd), values: catVals, color: '2A78D6' }]
    } : null
  };

  // Onglet « Frais partagés »
  const sh = sharedSummary(mk);
  const shared = {
    name: 'Frais partagés', cols: [12, 22, 30, 13, 22, 14], freezeRow: 3,
    rows: [
      [T(`Frais partagés — ${label}`)],
      [exportNote()],
      ['Date', 'Catégorie', 'Commentaire', 'Montant', "Part de l'autre parent", 'Montant dû'].map(H),
      ...ascending(sh.list).map(e => [
        { v: e.date, s: 'date' }, catName(e.catId), e.comment || '', eur(e.amount),
        { v: e.sharePct / 100, s: 'pct' }, eur(sharedDue(e))
      ]),
      totalRow(6, { 0: 'Total', 3: { v: E(sh.total), s: 'totalEuro' }, 5: { v: E(sh.due), s: 'totalEuro' } }),
      [],
      [{ v: "Part due par l'autre parent", s: 'bold' }, null, null, null, null, { v: E(sh.due), s: 'euro' }]
    ]
  };
  if (!sh.list.length) shared.rows.splice(3, 0, [{ v: 'Aucun frais partagé ce mois-ci.', s: 'note' }]);
  if (sh.refund) shared.rows.push([{ v: `Remboursement déjà enregistré dans les revenus : ${money(sh.refund.amount)}`, s: 'note' }]);

  return Xlsx.build([detail, synth, shared]);
}

/* ---------- Export de l'année ---------- */
function yearWorkbook(y) {
  const months = yearMonths(y);
  const stats = months.map(monthStats);
  const active = stats.filter(s => s.active);
  const sum = k => stats.reduce((s, m) => s + m[k], 0);

  // Onglet « Année »
  const rows = [[T(`Bilan de l'année ${y}`)], [exportNote()], []];
  rows.push(['Mois', 'Revenus', 'Dépenses', 'Épargne', 'Reste'].map(H));
  const first = rows.length + 1;
  stats.forEach(s => rows.push(s.active
    ? [capital(monthLabel(s.mk, false)), eur(s.inc), eur(s.spent), eur(s.sav), eur(s.rest)]
    : [capital(monthLabel(s.mk, false))]));
  const last = rows.length;
  rows.push(totalRow(5, { 0: 'Total', 1: { v: E(sum('inc')), s: 'totalEuro' }, 2: { v: E(sum('spent')), s: 'totalEuro' },
    3: { v: E(sum('sav')), s: 'totalEuro' }, 4: { v: E(sum('rest')), s: 'totalEuro' } }));
  if (active.length) {
    rows.push(['Moyenne par mois', eur(sum('inc') / active.length), eur(sum('spent') / active.length),
      eur(sum('sav') / active.length), eur(sum('rest') / active.length)]);
    rows.push([{ v: `Moyenne calculée sur ${active.length} mois suivi${active.length > 1 ? 's' : ''}.`, s: 'note' }]);
  }
  const names = stats.map(s => capital(monthLabel(s.mk, false)));
  const year = {
    name: 'Année', cols: [20, 14, 14, 14, 14], rows, freezeRow: 4,
    chart: {
      title: `Revenus et dépenses ${y}`, from: [6, 2], to: [16, 22], legend: true,
      cats: { ref: Xlsx.ref('Année', 0, first, last), values: names },
      series: [
        { name: 'Revenus', ref: Xlsx.ref('Année', 1, first, last), values: stats.map(s => (s.active ? E(s.inc) : null)), color: '2A78D6' },
        { name: 'Dépenses', ref: Xlsx.ref('Année', 2, first, last), values: stats.map(s => (s.active ? E(s.spent) : null)), color: 'EB6834' }
      ]
    }
  };

  // Onglet « Catégories » : une colonne par mois
  const yearExp = D().expenses.filter(e => e.date.startsWith(y + '-'));
  const grid = {};
  yearExp.forEach(e => {
    const row = grid[e.catId] ||= Array(12).fill(0);
    row[Number(e.date.slice(5, 7)) - 1] += e.amount;
  });
  const catRows = Object.entries(grid)
    .map(([id, vals]) => ({ name: catName(id), vals, total: vals.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const n = Math.max(1, active.length);
  const cats = {
    name: 'Catégories', cols: [22, ...Array(12).fill(11), 13, 14, 9], freezeRow: 3,
    rows: [
      [T(`Dépenses par catégorie — ${y}`)],
      [exportNote()],
      ['Catégorie', ...MONTH_SHORT, 'Total', 'Moyenne / mois', 'Part'].map(H),
      ...catRows.map(c => [c.name, ...c.vals.map(v => (v ? eur(v) : null)), { v: E(c.total), s: 'euro' },
        eur(c.total / n), { v: Math.round(c.total / Math.max(1, sum('spent')) * 1000) / 1000, s: 'pct' }]),
      totalRow(16, Object.assign({ 0: 'Total' },
        ...stats.map((s, i) => ({ [i + 1]: { v: E(s.spent), s: 'totalEuro' } })),
        { 13: { v: E(sum('spent')), s: 'totalEuro' }, 14: { v: E(sum('spent') / n), s: 'totalEuro' } }))
    ]
  };

  // Onglet « Détail » : toutes les dépenses de l'année
  const list = ascending(yearExp);
  const detail = {
    name: 'Détail', cols: [12, 22, 13, 15, 36, 16], freezeRow: 3,
    rows: [
      [T(`Toutes les dépenses — ${y}`)],
      [exportNote()],
      ['Date', 'Catégorie', 'Montant', 'Mode de paiement', 'Commentaire', 'Frais partagés'].map(H),
      ...expenseRows(list),
      totalRow(6, { 0: `Total (${list.length} dépenses)`, 2: { v: E(sum('spent')), s: 'totalEuro' } })
    ]
  };

  // Onglet « Frais partagés » : récapitulatif par mois
  const sharedByMonth = months.map(sharedSummary);
  const shared = {
    name: 'Frais partagés', cols: [16, 18, 22],
    rows: [
      [T(`Frais partagés — ${y}`)],
      [exportNote()],
      ['Mois', 'Total partagé', "Part de l'autre parent"].map(H),
      ...sharedByMonth.map((s, i) => [names[i], s.total ? eur(s.total) : null, s.due ? eur(s.due) : null]),
      totalRow(3, { 0: 'Total', 1: { v: E(sharedByMonth.reduce((a, s) => a + s.total, 0)), s: 'totalEuro' },
        2: { v: E(sharedByMonth.reduce((a, s) => a + s.due, 0)), s: 'totalEuro' } })
    ]
  };

  return Xlsx.build([year, cats, detail, shared]);
}

/* ---------- Écran d'export ---------- */
const monthsWithDataDesc = () => {
  const set = new Set(D().expenses.map(e => e.date.slice(0, 7)));
  Object.keys(D().months).forEach(mk => { if (monthData(mk).incomes.length) set.add(mk); });
  set.add(currentMonthKey());
  return [...set].filter(mk => mk <= currentMonthKey()).sort().reverse();
};

function openExportSheet(defaultMonth) {
  const months = monthsWithDataDesc();
  const sel = defaultMonth && months.includes(defaultMonth) ? defaultMonth : (months.includes(ui.month) ? ui.month : months[0]);
  const years = [...new Set(months.map(m => m.slice(0, 4)))];
  const exported = D().settings.exported || {};
  openSheet(`
    <h3>📤 Export Excel</h3>
    <div class="card">
      <b>Exporter un mois</b>
      <label class="field" style="margin:10px 0 0"><span>Mois</span>
        <select id="x-month">${months.map(m => `<option value="${m}" ${m === sel ? 'selected' : ''}>${esc(capital(monthLabel(m)))}${
          exported[m] ? ' ✓' : ''}</option>`).join('')}</select></label>
      <p class="small muted" id="x-month-info" style="margin:6px 0 0"></p>
      <button class="btn" id="x-do-month">Exporter le mois</button>
      <p class="small muted" style="margin:8px 0 0">Onglets : Détail · Synthèse (avec graphique) · Frais partagés</p>
    </div>
    <div class="card">
      <b>Exporter l'année</b>
      <label class="field" style="margin:10px 0 0"><span>Année</span>
        <select id="x-year">${years.map(y => `<option value="${y}" ${y === String(ui.year) ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <button class="btn" id="x-do-year">Exporter l'année</button>
      <p class="small muted" style="margin:8px 0 0">Onglets : Année (avec graphique) · Catégories · Détail · Frais partagés</p>
    </div>
    <button class="btn ghost" data-close>Fermer</button>`);
  const info = () => {
    const m = $('#x-month').value;
    $('#x-month-info').textContent = exported[m]
      ? `Déjà exporté le ${new Date(exported[m] + 'T12:00').toLocaleDateString('fr-FR')}.` : 'Pas encore exporté.';
  };
  $('#x-month').onchange = info;
  info();
  $('#x-do-month').onclick = () => {
    const m = $('#x-month').value;
    (D().settings.exported ||= {})[m] = todayISO();
    commit();
    deliverFile(monthWorkbook(m), `${filePrefix()}-${m}.xlsx`, { back: () => openExportSheet(m) });
  };
  $('#x-do-year').onclick = () => {
    const y = $('#x-year').value;
    deliverFile(yearWorkbook(y), `${filePrefix()}-annee-${y}.xlsx`);
  };
}

const EXCEL_HINT = 'Pour l\'ouvrir : application « Fichiers » → Téléchargements, avec Excel ou Google Sheets.';

// Télécharge le fichier, puis propose de le partager (e-mail, Drive…) si le téléphone le permet
// options : { hint, back (fonction du bouton Retour), backLabel }
function deliverFile(blob, filename, { hint = EXCEL_HINT, back = () => openExportSheet(), backLabel = 'Retour à l\'export' } = {}) {
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  download();
  let file = null;
  try { file = new File([blob], filename, { type: blob.type }); } catch (e) { /* ancien navigateur */ }
  const canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
  openSheet(`
    <h3>✅ Fichier prêt</h3>
    <p><b>${esc(filename)}</b> a été enregistré dans les <b>Téléchargements</b> de votre téléphone.</p>
    <p class="small muted">${hint}</p>
    ${canShare ? '<button class="btn" id="x-share">Partager / envoyer le fichier</button>' : ''}
    <button class="btn secondary" id="x-again">Télécharger à nouveau</button>
    <button class="btn ghost" id="x-back">${esc(backLabel)}</button>`);
  $('#x-again').onclick = download;
  $('#x-back').onclick = back;
  if (canShare) $('#x-share').onclick = () => navigator.share({ files: [file], title: filename }).catch(() => {});
}

/* ---------- Rappel : mois précédent pas encore exporté ---------- */
function exportReminderMonth() {
  const prev = shiftMonth(currentMonthKey(), -1);
  const exported = D().settings.exported || {};
  return monthStats(prev).active && !exported[prev] && !ui.exportLater ? prev : null;
}
