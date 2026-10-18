/*
 * Stockage chiffré des données.
 *
 * Toutes les données sont rangées dans UN SEUL "coffre" (localStorage, clé VAULT_KEY) :
 *   { v, salt, iter, iv, ct }
 * - la clé de chiffrement est dérivée du code avec PBKDF2-SHA-256 (sel aléatoire, 600 000 tours) ;
 * - les données sont chiffrées en AES-GCM 256 bits (un nouvel IV à chaque sauvegarde).
 * Le code et la clé ne sont jamais enregistrés : la clé n'existe qu'en mémoire tant que l'app est ouverte.
 * Un mauvais code fait échouer le déchiffrement AES-GCM : c'est ainsi qu'on le détecte.
 */
const Store = (() => {
  const VAULT_KEY = 'budget.vault';
  const ATTEMPTS_KEY = 'budget.attempts';
  const ITERATIONS = 600000;

  const DEFAULT_CATEGORIES = [
    'Courses', 'Logement', 'Carburant/Transport', 'Enfant', 'Santé',
    'Loisirs', 'Restaurants', 'Abonnements', 'Divers'
  ];

  let key = null;   // CryptoKey en mémoire uniquement
  let vault = null; // { v, salt, iter } du coffre ouvert
  let data = null;  // données déchiffrées
  let saving = Promise.resolve();

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  async function deriveKey(pin, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptWith(k, obj) {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
    return { iv: toB64(iv), ct: toB64(ct) };
  }

  async function decryptWith(k, box) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, k, fromB64(box.ct));
    return JSON.parse(dec.decode(plain));
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function defaultData() {
    return {
      v: 1,
      createdAt: new Date().toISOString(),
      categories: DEFAULT_CATEGORIES.map(name => ({ id: uid(), name, budget: null })),
      months: {},     // 'AAAA-MM' -> { incomes: [{ id, label, amount, isSalary }], recGen: [ids des récurrentes déjà ajoutées] }
      // shared : frais partagés ; sharePct : part (en %) payée par l'autre parent
      expenses: [],   // { id, date: 'AAAA-MM-JJ', amount (centimes), catId, pay, comment, recurringId?, shared?, sharePct? }
      recurring: [],  // { id, label, amount, catId, pay, day (1-31), startMonth: 'AAAA-MM' }
      favorites: [],  // { id, label, amount, catId, pay }
      settings: { savings: 0, sharePct: 50 }
    };
  }

  // Ajoute les champs manquants (utile quand l'application évolue)
  function migrate(d) {
    d.categories ||= [];
    d.months ||= {};
    d.expenses ||= [];
    d.recurring ||= [];
    d.favorites ||= [];
    d.settings ||= {};
    if (typeof d.settings.savings !== 'number') d.settings.savings = 0;
    if (typeof d.settings.sharePct !== 'number') d.settings.sharePct = 50;
    d.settings.exported ||= {}; // 'AAAA-MM' -> date du dernier export Excel de ce mois
    return d;
  }

  function readVault() {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  // On reçoit clé/coffre/données en paramètres : une sauvegarde lancée juste avant
  // un verrouillage se termine donc correctement.
  async function writeVault(k = key, v = vault, d = data) {
    const box = await encryptWith(k, d);
    localStorage.setItem(VAULT_KEY, JSON.stringify({ ...v, ...box }));
  }

  return {
    uid,

    hasVault() { return !!localStorage.getItem(VAULT_KEY); },
    isUnlocked() { return !!key; },
    get data() { return data; },

    // Le prénom est aussi rangé en clair à côté du coffre, uniquement pour dire « Bonjour … »
    // sur l'écran du code. Tout le reste est chiffré.
    vaultName() { const v = readVault(); return (v && v.name) || ''; },

    async create(pin, name = '') {
      const salt = randomBytes(16);
      key = await deriveKey(pin, salt, ITERATIONS);
      vault = { v: 1, salt: toB64(salt), iter: ITERATIONS, name };
      data = migrate(defaultData()); // migrate complète tous les champs récents
      data.settings.name = name;
      await writeVault();
    },

    setName(name) {
      data.settings.name = name;
      vault.name = name;
      return this.save();
    },

    // Renvoie true si le code est bon, false sinon.
    async unlock(pin) {
      const stored = readVault();
      if (!stored) return false;
      const k = await deriveKey(pin, fromB64(stored.salt), stored.iter);
      try {
        data = migrate(await decryptWith(k, stored));
      } catch (e) {
        return false;
      }
      key = k;
      const name = data.settings.name || stored.name || '';
      data.settings.name = name;
      vault = { v: stored.v, salt: stored.salt, iter: stored.iter, name };
      return true;
    },

    lock() { key = null; vault = null; data = null; },

    // Les sauvegardes sont mises en file pour ne jamais se chevaucher.
    save() {
      if (!key) return saving;
      const k = key, v = vault, snapshot = JSON.parse(JSON.stringify(data));
      saving = saving.catch(() => {}).then(() => writeVault(k, v, snapshot));
      return saving;
    },

    async changePin(oldPin, newPin) {
      await saving;
      const stored = readVault();
      const oldKey = await deriveKey(oldPin, fromB64(stored.salt), stored.iter);
      try { await decryptWith(oldKey, stored); } catch (e) { return false; }
      const salt = randomBytes(16);
      key = await deriveKey(newPin, salt, ITERATIONS);
      vault = { v: 1, salt: toB64(salt), iter: ITERATIONS, name: vault.name || '' };
      await writeVault();
      return true;
    },

    /* ---------- Sauvegarde ----------
     * Le fichier de sauvegarde est une copie du coffre chiffré (même code, même chiffrement),
     * avec une étiquette pour le reconnaître. Il est illisible sans le code. */
    async backupFile() {
      await saving;
      const stored = readVault();
      return { app: 'mon-budget', kind: 'sauvegarde', exportedAt: new Date().toISOString(), ...stored };
    },

    // Déchiffre un fichier de sauvegarde avec son code. Renvoie les données, null si mauvais code.
    // Lance une erreur si le fichier n'est pas une sauvegarde valide.
    async readBackup(b, pin) {
      const ok = b && b.app === 'mon-budget' && typeof b.salt === 'string' && typeof b.iv === 'string' &&
        typeof b.ct === 'string' && Number.isInteger(b.iter) && b.iter >= 100000 && b.iter <= 5000000;
      if (!ok) throw new Error('format');
      const k = await deriveKey(pin, fromB64(b.salt), b.iter);
      try { return migrate(await decryptWith(k, b)); } catch (e) { return null; }
    },

    // Depuis les réglages : remplace les données par celles d'une sauvegarde (le code actuel est conservé)
    async replaceData(newData) {
      data = newData;
      if (data.settings.name) vault.name = data.settings.name;
      else data.settings.name = vault.name || '';
      await this.save();
    },

    // Depuis l'écran du code : installe la sauvegarde telle quelle (son code devient le code de l'appareil)
    async installBackup(b, pin) {
      if (!(await this.readBackup(b, pin))) return false;
      await saving;
      localStorage.setItem(VAULT_KEY, JSON.stringify({ v: b.v || 1, salt: b.salt, iter: b.iter, iv: b.iv, ct: b.ct,
        name: typeof b.name === 'string' ? b.name.slice(0, 30) : '' }));
      this.resetAttempts();
      return this.unlock(pin);
    },

    // Compteur d'essais ratés (pour imposer une attente après plusieurs erreurs)
    getAttempts() {
      try { return JSON.parse(localStorage.getItem(ATTEMPTS_KEY)) || { n: 0, until: 0 }; }
      catch (e) { return { n: 0, until: 0 }; }
    },
    setAttempts(a) { localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(a)); },
    resetAttempts() { localStorage.removeItem(ATTEMPTS_KEY); }
  };
})();
