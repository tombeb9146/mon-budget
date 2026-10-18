'use strict';

/*
 * Sauvegarde chiffrée : créer un fichier de sauvegarde, restaurer, et rappel mensuel.
 * Le fichier est chiffré avec le code de l'application : sans ce code, il est illisible.
 */
const BACKUP_EVERY_DAYS = 30;
const daysSince = isoDate => Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);

async function createBackup() {
  D().settings.lastBackup = new Date().toISOString();
  await Store.save();
  const file = await Store.backupFile();
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  render();
  deliverFile(blob, `${filePrefix()}-sauvegarde-${todayISO()}.json`, {
    hint: 'Ce fichier est chiffré avec votre code. Rangez-en une copie <b>en dehors du téléphone</b> ' +
      '(e-mail à vous-même, Google Drive…) : c\'est elle qui vous sauvera si le téléphone est perdu ou cassé.',
    back: openBackupSheet,
    backLabel: 'Retour'
  });
}

function openBackupSheet() {
  const last = D().settings.lastBackup;
  openSheet(`
    <h3>💾 Sauvegarde</h3>
    <p style="margin-top:-6px">${last
      ? `Dernière sauvegarde : <b>${esc(new Date(last).toLocaleDateString('fr-FR'))}</b> (il y a ${daysSince(last)} jour${daysSince(last) > 1 ? 's' : ''}).`
      : '<b>Aucune sauvegarde pour l\'instant.</b>'}</p>
    <div class="card">
      <b>Créer une sauvegarde</b>
      <p class="small muted" style="margin:6px 0 0">Un fichier contenant toutes vos données, chiffré avec votre code actuel.
        À faire au moins une fois par mois.</p>
      <button class="btn" id="b-create">Créer une sauvegarde</button>
    </div>
    <div class="card">
      <b>Restaurer une sauvegarde</b>
      <p class="small muted" style="margin:6px 0 0">Remplace <b>toutes</b> les données de cet appareil par celles du fichier.
        Sert aussi à passer d'un appareil à l'autre.</p>
      <button class="btn secondary" id="b-restore">Choisir un fichier de sauvegarde…</button>
    </div>
    <button class="btn ghost" data-close>Fermer</button>`);
  $('#b-create').onclick = createBackup;
  $('#b-restore').onclick = () => pickBackupFile(openRestoreSheet);
}

// Ouvre le sélecteur de fichiers, lit le fichier choisi et le passe à onFile
function pickBackupFile(onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    let b = null;
    try { b = JSON.parse(await f.text()); } catch (e) { /* pas du JSON */ }
    if (!b || b.app !== 'mon-budget') return toast("Ce fichier n'est pas une sauvegarde de Mon Budget.", 4000);
    onFile(b, f.name);
  };
  input.click();
}

const backupDate = b => (b.exportedAt ? new Date(b.exportedAt).toLocaleDateString('fr-FR') : 'date inconnue');

// Restauration depuis les réglages : le code actuel de l'appareil est conservé
function openRestoreSheet(b) {
  openSheet(`
    <h3>Restaurer la sauvegarde</h3>
    <p style="margin-top:-6px">Sauvegarde du <b>${esc(backupDate(b))}</b>.</p>
    <label class="field"><span>Code de cette sauvegarde</span>
      <input id="b-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" class="big"></label>
    <p class="small muted" style="margin-top:-6px">C'est le code que vous utilisiez quand la sauvegarde a été créée.</p>
    <div class="warn-box">Toutes les données actuelles de cet appareil seront <b>remplacées</b>.
      Votre code d'accès actuel reste le même.</div>
    <button class="btn" id="b-go">Restaurer</button>
    <button class="btn ghost" id="b-back">Annuler</button>`);
  $('#b-back').onclick = openBackupSheet;
  setTimeout(() => $('#b-pin')?.focus(), 50);
  $('#b-go').onclick = async () => {
    const btn = $('#b-go');
    btn.disabled = true;
    btn.textContent = 'Vérification…';
    let d;
    try { d = await Store.readBackup(b, $('#b-pin').value); } catch (e) { d = undefined; }
    btn.disabled = false;
    btn.textContent = 'Restaurer';
    if (d === undefined) return toast('Ce fichier de sauvegarde est abîmé ou incomplet.', 4000);
    if (!d) return toast('Code incorrect pour cette sauvegarde.');
    const months = new Set(d.expenses.map(e => e.date.slice(0, 7))).size;
    if (!confirm(`Sauvegarde du ${backupDate(b)} : ${d.expenses.length} dépense(s) sur ${months} mois.\n\n` +
      'Remplacer toutes les données actuelles par celles-ci ?')) return;
    await Store.replaceData(d);
    closeSheet();
    ui.month = currentMonthKey();
    ui.tab = 'home';
    if (generateRecurring()) await Store.save();
    render();
    toast('Sauvegarde restaurée');
  };
}

/* ---------- Rappel : au moins une sauvegarde par mois ---------- */
function backupReminder() {
  if (ui.backupLater) return null;
  const hasData = D().expenses.length || Object.values(D().months).some(m => m.incomes && m.incomes.length);
  if (!hasData) return null;
  const last = D().settings.lastBackup;
  // Jamais sauvegardé : on laisse une semaine de prise en main avant de le rappeler
  if (!last) return daysSince(D().createdAt) >= 7 ? 'Vous n\'avez encore jamais fait de sauvegarde.' : null;
  const days = daysSince(last);
  return days >= BACKUP_EVERY_DAYS ? `Dernière sauvegarde il y a ${days} jours.` : null;
}
