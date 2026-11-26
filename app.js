import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, get, set, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  deleteUser,
  EmailAuthProvider,
  reauthenticateWithCredential
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD5cX7eb4c4KHxTkuauKtIIrtcM7fk8NAs",
  authDomain: "masvoorii-pk.firebaseapp.com",
  databaseURL: "https://masvoorii-pk-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "masvoorii-pk",
  storageBucket: "masvoorii-pk.firebasestorage.app",
  messagingSenderId: "390281515450",
  appId: "1:390281515450:web:fd8230f88885fcac414d83"
};
const DB_ROOT = 'masvoorii_pk/users';
const LEGACY_STORAGE_KEY = 'fachri_keuangan_profiles_v1';
const STORAGE_PREFIX = 'fachri_keuangan_uid_';
const THEME_KEY = 'fachri_keuangan_theme';
const WALLET_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-cyan-500', 'bg-pink-500', 'bg-indigo-500', 'bg-amber-500'];
const getToday = () => new Date().toLocaleDateString('en-CA');

const app = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(app);
const auth = getAuth(app);

// Map username -> internal email so users keep typing plain usernames
function usernameToEmail(uname) {
  const clean = uname.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return clean ? `${clean}@masvoorii-pk.local` : '';
}

function emailToUsername(email) {
  return String(email || '').split('@')[0] || 'User';
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createCustomEnvelopes(count = 4, amount = 100000) {
  const safeCount = Math.max(1, Math.min(8, Math.round(Number(count) || 4)));
  const safeAmt = Math.max(100, Math.round(Number(amount) || 100000));
  return Array.from({ length: safeCount }, (_, i) => ({
    id: i + 1,
    name: `Minggu ${i + 1}`,
    initial: safeAmt,
    balance: safeAmt,
    status: i === 0 ? 'active' : 'locked',
  }));
}

function getFachriState() {
  return {
    isCanvas: false,
    bluAccountMain: 0,
    activeEnvelopeIndex: 0,
    rolloverBalance: 0,
    envelopes: createCustomEnvelopes(4, 100000),
    accounts: {
      gopay: { id: 'gopay', name: 'GoPay', initial: 301419, balance: 301419, color: 'bg-emerald-500' },
      dana: { id: 'dana', name: 'DANA', initial: 119000, balance: 119000, color: 'bg-blue-500' },
      blu_ngedate: { id: 'blu_ngedate', name: 'bluSaving - Ngedate', initial: 225000, balance: 225000, color: 'bg-pink-500' },
      blu_nongki: { id: 'blu_nongki', name: 'bluSaving - Nongki', initial: 80000, balance: 80000, color: 'bg-cyan-500' },
      blu_hp: { id: 'blu_hp', name: 'bluSaving - HP Baru', initial: 100000, balance: 100000, color: 'bg-indigo-500' },
    },
    transactions: [],
  };
}

function getBlankCanvasState(initialBalance = 0) {
  const bal = Math.max(0, Math.round(Number(initialBalance) || 0));
  return {
    isCanvas: true,
    bluAccountMain: 0,
    activeEnvelopeIndex: 0,
    rolloverBalance: 0,
    envelopes: [],
    accounts: {
      utama: { id: 'utama', name: 'Wallet Utama', initial: bal, balance: bal, color: 'bg-blue-500' },
    },
    transactions: [],
  };
}

function normalizeProfile(raw, uid, fallbackName = 'User') {
  const base = raw && typeof raw === 'object' ? raw : {};
  const name = (base.name || fallbackName).trim() || 'User';
  const defaultData = name.toLowerCase() === 'fachri' ? getFachriState() : getBlankCanvasState(0);
  const data = { ...defaultData, ...(base.data || {}) };
  delete data.gopayCoins;
  if (!Array.isArray(data.transactions)) data.transactions = [];
  if (!Array.isArray(data.envelopes)) data.envelopes = [];
  if (!data.accounts || !Object.keys(data.accounts).length) {
    data.accounts = {
      utama: { id: 'utama', name: 'Wallet Utama', initial: 0, balance: 0, color: 'bg-blue-500' },
    };
  }
  return { uid, name, data };
}

// Find legacy profile in localStorage (returns { data, passwordHash } for verification)
function findLegacyLocalProfile(username) {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Object.values(parsed?.profiles || {}).find(
      (p) => p?.name?.trim().toLowerCase() === username.trim().toLowerCase()
    ) || null;
  } catch {
    return null;
  }
}

async function verifyLegacyPassword(expectedHash, newPw, legacyPw) {
  if (!expectedHash) return true;
  const candidates = [legacyPw, newPw].filter(Boolean);
  for (const pw of candidates) {
    if ((await hashPassword(pw)) === expectedHash) return true;
  }
  return false;
}

let currentUser = null;
let currentProfile = null;
let unsubscribeDb = null;
let isRegistering = false;

function getUserRef(uid) {
  return ref(db, `${DB_ROOT}/${uid}`);
}

function getActiveProfile() {
  return currentProfile;
}

function getCurrentData() {
  return currentProfile.data;
}

function isSessionUnlocked() {
  return Boolean(currentUser && currentProfile);
}

function ensureUnlocked() {
  if (isSessionUnlocked()) return true;
  updateScreenGate();
  showToast('Silakan login terlebih dahulu.', 'warning');
  return false;
}

function saveState() {
  if (!isSessionUnlocked()) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + currentUser.uid, JSON.stringify(currentProfile));
  } catch {}
  set(getUserRef(currentUser.uid), currentProfile).catch(() => showToast('Gagal sinkron ke cloud.', 'error'));
}

function updateScreenGate() {
  const unlocked = isSessionUnlocked();
  document.getElementById('welcome-screen').classList.toggle('hidden', unlocked);
  document.getElementById('app-shell').classList.toggle('hidden', !unlocked);
}

function setSyncStatus(status) {
  const badges = [document.getElementById('sync-badge'), document.getElementById('welcome-sync-badge')];
  badges.forEach((b) => {
    if (!b) return;
    if (status === 'online') {
      b.textContent = 'Cloud Sync';
      b.className = 'px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300';
    } else if (status === 'offline') {
      b.textContent = 'Offline';
      b.className = 'px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
    } else {
      b.textContent = 'Auth Ready';
      b.className = 'px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-500';
    }
  });
}

function mapAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Username atau password salah.';
  }
  if (code === 'auth/email-already-in-use') return 'Username sudah dipakai.';
  if (code === 'auth/weak-password') return 'Password minimal 6 karakter.';
  if (code === 'auth/too-many-requests') return 'Terlalu banyak percobaan. Coba lagi nanti.';
  if (code === 'auth/network-request-failed') return 'Koneksi internet bermasalah.';
  return err?.message || 'Gagal autentikasi.';
}

async function lockAndLogout() {
  if (unsubscribeDb) {
    unsubscribeDb();
    unsubscribeDb = null;
  }
  await signOut(auth).catch(() => {});
  currentUser = null;
  currentProfile = null;
  document.getElementById('welcome-password-input').value = '';
  updateScreenGate();
  setSyncStatus('ready');
  showToast('Akun dikunci.');
}

document.getElementById('welcome-login-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const uname = document.getElementById('welcome-username-input').value.trim();
  const pw = document.getElementById('welcome-password-input').value;
  const email = usernameToEmail(uname);
  if (!email || !pw) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Memeriksa...';

  try {
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    document.getElementById('welcome-username-input').value = '';
    document.getElementById('welcome-password-input').value = '';
    showToast(`Selamat datang, ${cred.user.displayName || uname}.`);
  } catch (err) {
    showToast(mapAuthError(err), 'error');
    document.getElementById('welcome-password-input').value = '';
    document.getElementById('welcome-password-input').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Masuk';
  }
});

function enableWeeklyEnvelopes() {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  if (data.envelopes && data.envelopes.length) return;
  document.getElementById('env-setup-count').value = '4';
  document.getElementById('env-setup-amount').value = formatDotNumber(100000);
  const modal = document.getElementById('envelope-setup-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('env-setup-count').focus();
}

function deleteWeeklyEnvelopes() {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  if (!data.envelopes || !data.envelopes.length) return;

  openConfirmModal(
    'Hapus Amplop Mingguan?',
    'Seluruh amplop mingguan dan saldo Rollover akun ini akan dihapus. Riwayat transaksi lama tetap tersimpan.',
    () => {
      data.envelopes = [];
      data.activeEnvelopeIndex = 0;
      data.rolloverBalance = 0;
      saveState();
      renderAll();
      showToast('Amplop mingguan dihapus.');
    }
  );
}

function openEnvelopeReconfigureModal() {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const count = (data.envelopes && data.envelopes.length) || 4;
  const amount = (data.envelopes && data.envelopes[0]?.initial) || 100000;
  document.getElementById('env-setup-count').value = String(count);
  document.getElementById('env-setup-amount').value = formatDotNumber(amount);
  const modal = document.getElementById('envelope-setup-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('env-setup-count').focus();
}

function closeEnvelopeSetupModal() {
  const modal = document.getElementById('envelope-setup-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('envelope-setup-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const count = parseInt(document.getElementById('env-setup-count').value, 10);
  const amount = parseRupiahInput(document.getElementById('env-setup-amount').value);
  if (!count || count < 1 || count > 8 || !amount || amount < 100) return;

  const wasActive = Boolean(data.envelopes && data.envelopes.length);
  data.activeEnvelopeIndex = 0;
  data.rolloverBalance = 0;
  data.envelopes = createCustomEnvelopes(count, amount);
  saveState();
  closeEnvelopeSetupModal();
  renderAll();
  showToast(
    wasActive
      ? `Amplop dijadwalkan ulang: ${count} minggu @${formatRupiah(amount)}.`
      : `${count} amplop mingguan @${formatRupiah(amount)} aktif.`
  );
});

function openWalletModal(walletId = null) {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const editInput = document.getElementById('wallet-edit-id');
  const nameInput = document.getElementById('wallet-name');
  const initInput = document.getElementById('wallet-initial');
  const balInput = document.getElementById('wallet-balance');
  const syncTxCheckbox = document.getElementById('wallet-sync-tx');
  const titleEl = document.getElementById('wallet-modal-title');
  const submitBtn = document.getElementById('wallet-submit-btn');

  if (walletId && data.accounts[walletId]) {
    const w = data.accounts[walletId];
    editInput.value = w.id;
    nameInput.value = w.name;
    initInput.value = formatDotNumber(w.initial);
    balInput.value = formatDotNumber(w.balance);
    syncTxCheckbox.checked = true;
    titleEl.textContent = 'Edit Wallet';
    submitBtn.textContent = 'Simpan';
  } else {
    editInput.value = '';
    nameInput.value = '';
    initInput.value = '0';
    balInput.value = '0';
    syncTxCheckbox.checked = false;
    titleEl.textContent = 'Tambah Wallet';
    submitBtn.textContent = 'Tambah';
  }

  const modal = document.getElementById('wallet-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  nameInput.focus();
}

function closeWalletModal() {
  const modal = document.getElementById('wallet-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('wallet-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const editId = document.getElementById('wallet-edit-id').value;
  const name = document.getElementById('wallet-name').value.trim();
  const initial = Math.max(0, parseRupiahInput(document.getElementById('wallet-initial').value) || 0);
  const balance = parseRupiahInput(document.getElementById('wallet-balance').value);
  const syncTx = document.getElementById('wallet-sync-tx').checked;
  if (!name || Number.isNaN(balance)) return;

  const duplicate = Object.values(data.accounts).some(
    (a) => a.id !== editId && a.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    showToast('Nama wallet sudah ada.', 'error');
    return;
  }

  if (editId && data.accounts[editId]) {
    const w = data.accounts[editId];
    const diff = balance - w.balance;
    w.name = name;
    w.initial = initial;
    w.balance = balance;

    if (syncTx && diff !== 0) {
      const syncNote = diff < 0
        ? `Penyesuaian saldo ${name} (-${formatRupiah(Math.abs(diff))})`
        : `Penambahan saldo ${name} (+${formatRupiah(diff)})`;
      data.transactions.unshift({
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        accountKey: w.id,
        accountLabel: name,
        envelopeIndex: null,
        amount: Math.abs(diff),
        date: getToday(),
        note: syncNote,
        isBalanceSync: true,
        signedDelta: diff,
      });
    }

    saveState();
    closeWalletModal();
    renderAll();
    showToast(`Wallet "${name}" diperbarui.`);
    return;
  }

  const id = 'w_' + Date.now().toString(36);
  const color = WALLET_COLORS[Object.keys(data.accounts).length % WALLET_COLORS.length];
  data.accounts[id] = { id, name, initial, balance, color };
  saveState();
  closeWalletModal();
  renderAll();
  showToast(`Wallet "${name}" ditambahkan.`);
});

function deleteWallet(walletId) {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const keys = Object.keys(data.accounts);
  const wallet = data.accounts[walletId];
  if (!wallet) return;

  if (keys.length <= 1 && !data.envelopes.length) {
    showToast('Minimal harus ada 1 wallet aktif.', 'warning');
    return;
  }

  openConfirmModal(
    `Hapus Wallet "${wallet.name}"?`,
    `Wallet "${wallet.name}" (saldo ${formatRupiah(wallet.balance)}) akan dihapus. Riwayat transaksi lama tetap tersimpan.`,
    () => {
      delete data.accounts[walletId];
      saveState();
      renderAll();
      showToast(`Wallet "${wallet.name}" dihapus.`);
    }
  );
}

function openSetPasswordModal() {
  if (!ensureUnlocked()) return;
  const profile = getActiveProfile();
  document.getElementById('password-modal-title').textContent = `Ganti Password: ${profile.name}`;
  document.getElementById('password-modal-desc').textContent = 'Masukkan password lama dan password baru (min. 6 karakter).';
  document.getElementById('old-password-input').value = '';
  document.getElementById('password-input').value = '';
  const modal = document.getElementById('password-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('old-password-input').focus();
}

function closePasswordModal() {
  const modal = document.getElementById('password-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('password-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  if (!ensureUnlocked()) return;
  const oldPw = document.getElementById('old-password-input').value;
  const newPw = document.getElementById('password-input').value;
  if (newPw.length < 6) {
    showToast('Password minimal 6 karakter.', 'error');
    return;
  }
  try {
    const cred = EmailAuthProvider.credential(currentUser.email, oldPw);
    await reauthenticateWithCredential(currentUser, cred);
    await updatePassword(currentUser, newPw);
    closePasswordModal();
    showToast(`Password akun ${currentProfile.name} diperbarui.`);
  } catch (err) {
    showToast(mapAuthError(err), 'error');
  }
});

function openNewAccountModal() {
  document.getElementById('new-acc-name').value = '';
  document.getElementById('new-acc-balance').value = '0';
  document.getElementById('new-acc-password').value = '';
  document.getElementById('new-acc-legacy-password').value = '';
  const modal = document.getElementById('new-account-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('new-acc-name').focus();
}

function closeNewAccountModal() {
  const modal = document.getElementById('new-account-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('new-account-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const name = document.getElementById('new-acc-name').value.trim();
  const bal = parseRupiahInput(document.getElementById('new-acc-balance').value) || 0;
  const pw = document.getElementById('new-acc-password').value;
  const legacyPw = document.getElementById('new-acc-legacy-password').value;
  const email = usernameToEmail(name);
  if (!name || !email || pw.length < 6) {
    showToast('Username dan password (min. 6 karakter) wajib diisi.', 'error');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Membuat...';
  isRegistering = true;

  let createdUser = null;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    createdUser = cred.user;

    // Check cloud legacy profiles first, then localStorage fallback, verifying old password hash
    let legacyData = null;
    let legacyCloudKey = null;
    let cloudChecked = false;
    try {
      const snap = await get(ref(db, 'masvoorii_pk/profiles'));
      const legacyProfiles = snap.val();
      if (legacyProfiles && typeof legacyProfiles === 'object') {
        cloudChecked = true;
        const entry = Object.entries(legacyProfiles).find(
          ([, p]) => p?.name?.trim().toLowerCase() === name.toLowerCase()
        );
        if (entry) {
          const [oldKey, oldProfile] = entry;
          const ok = await verifyLegacyPassword(oldProfile?.passwordHash, pw, legacyPw);
          if (!ok) {
            await deleteUser(createdUser).catch(() => signOut(auth));
            createdUser = null;
            showToast('Akun lama ditemukan. Masukkan Password Lama yang benar untuk migrasi.', 'error');
            document.getElementById('new-acc-legacy-password').focus();
            return;
          }
          legacyData = oldProfile?.data || null;
          legacyCloudKey = oldKey;
        }
      }
    } catch {}

    if (!legacyData && !cloudChecked) {
      const localLegacy = findLegacyLocalProfile(name);
      if (localLegacy) {
        const ok = await verifyLegacyPassword(localLegacy.passwordHash, pw, legacyPw);
        if (!ok) {
          await deleteUser(createdUser).catch(() => signOut(auth));
          createdUser = null;
          showToast('Data lokal lama ditemukan. Masukkan Password Lama yang benar untuk migrasi.', 'error');
          document.getElementById('new-acc-legacy-password').focus();
          return;
        }
        legacyData = localLegacy.data || null;
      }
    }

    const initialData = legacyData
      ? normalizeProfile({ name, data: legacyData }, createdUser.uid, name).data
      : name.toLowerCase() === 'fachri'
      ? getFachriState()
      : getBlankCanvasState(bal);

    const freshProfile = { uid: createdUser.uid, name, data: initialData };
    await set(getUserRef(createdUser.uid), freshProfile);
    if (legacyCloudKey) {
      await remove(ref(db, `masvoorii_pk/profiles/${legacyCloudKey}`)).catch(() => {});
    }
    try {
      localStorage.setItem(STORAGE_PREFIX + createdUser.uid, JSON.stringify(freshProfile));
    } catch {}

    isRegistering = false;
    attachUserSession(createdUser, freshProfile);
    closeNewAccountModal();
    showToast(legacyData ? `Akun "${name}" dibuat & data lama berhasil dimigrasi.` : `Akun "${name}" dibuat.`);
  } catch (err) {
    if (createdUser) await deleteUser(createdUser).catch(() => signOut(auth));
    showToast(mapAuthError(err), 'error');
  } finally {
    isRegistering = false;
    btn.disabled = false;
    btn.textContent = 'Buat';
  }
});

function confirmDeleteAccount() {
  if (!ensureUnlocked()) return;
  const target = getActiveProfile();
  if (!target) return;

  openConfirmModal(
    `Hapus Akun "${target.name}"?`,
    `Seluruh transaksi, saldo, dan login akun "${target.name}" akan dihapus permanen. Masukkan password untuk konfirmasi.`,
    async (pw) => {
      if (!pw) {
        showToast('Password wajib diisi untuk menghapus akun.', 'error');
        return false;
      }
      const uid = currentUser.uid;
      try {
        const cred = EmailAuthProvider.credential(currentUser.email, pw);
        await reauthenticateWithCredential(currentUser, cred);
        await remove(getUserRef(uid));
        localStorage.removeItem(STORAGE_PREFIX + uid);
        await deleteUser(currentUser);
        showToast(`Akun "${target.name}" dihapus.`);
        return true;
      } catch (err) {
        showToast(mapAuthError(err), 'error');
        return false;
      }
    },
    { requirePassword: true }
  );
}

function parseRupiahInput(val) {
  const digits = String(val || '').replace(/[^0-9-]/g, '');
  if (!digits || digits === '-') return NaN;
  return parseInt(digits, 10);
}

function formatDotNumber(num) {
  const n = Math.round(Number(num) || 0);
  return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('id-ID');
}

function attachAutoDotFormat(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.addEventListener('input', () => {
    const raw = el.value;
    const isNeg = raw.trim().startsWith('-');
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) {
      el.value = isNeg ? '-' : '';
      return;
    }
    el.value = (isNeg ? '-' : '') + Number(digits).toLocaleString('id-ID');
  });
}

function formatRupiah(num) {
  const n = Math.round(Number(num) || 0);
  return (n < 0 ? '-Rp' : 'Rp') + Math.abs(n).toLocaleString('id-ID');
}

function formatDateIndo(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1] || m} ${y}`;
}

function getAccountLabel(accountKey, envelopeWeek, fallbackLabel) {
  const data = getCurrentData();
  if (accountKey === 'amplop_aktif') return envelopeWeek ? `Amplop Minggu ${envelopeWeek}` : 'Amplop Tunai';
  if (accountKey === 'rollover') return 'Rollover';
  return data.accounts[accountKey]?.name || fallbackLabel || accountKey;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  const bg = type === 'error' ? 'bg-rose-600' : type === 'warning' ? 'bg-amber-600' : 'bg-slate-900 dark:bg-blue-600';
  toast.className = `${bg} text-white px-3.5 py-2.5 rounded-xl shadow-lg text-xs font-medium flex items-center justify-between gap-2 pointer-events-auto`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span><button onclick="this.parentElement.remove()">✕</button>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

let confirmCallback = null;
let confirmNeedsPw = false;
function openConfirmModal(title, message, onConfirm, opts = {}) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = onConfirm;
  confirmNeedsPw = Boolean(opts.requirePassword);
  const pwWrap = document.getElementById('confirm-password-wrap');
  const pwInput = document.getElementById('confirm-password-input');
  pwWrap.classList.toggle('hidden', !confirmNeedsPw);
  pwInput.value = '';
  const modal = document.getElementById('confirm-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (confirmNeedsPw) pwInput.focus();
}

function closeConfirmModal() {
  const modal = document.getElementById('confirm-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  confirmCallback = null;
  confirmNeedsPw = false;
}

document.getElementById('confirm-cancel').addEventListener('click', closeConfirmModal);
document.getElementById('confirm-ok').addEventListener('click', async () => {
  if (!confirmCallback) return closeConfirmModal();
  const pw = confirmNeedsPw ? document.getElementById('confirm-password-input').value : undefined;
  const result = await confirmCallback(pw);
  if (result !== false) closeConfirmModal();
});

function syncThemeIcons(isDark) {
  document.querySelectorAll('.theme-icon-dark').forEach((el) => el.classList.toggle('hidden', !isDark));
  document.querySelectorAll('.theme-icon-light').forEach((el) => el.classList.toggle('hidden', isDark));
}

function initTheme() {
  const isDark = localStorage.getItem(THEME_KEY) === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  syncThemeIcons(isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  syncThemeIcons(isDark);
}

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('welcome-theme-toggle').addEventListener('click', toggleTheme);

function applyPreset(account, amount, note) {
  document.getElementById('input-account').value = account;
  document.getElementById('input-amount').value = formatDotNumber(amount);
  document.getElementById('input-note').value = note;
  document.getElementById('input-amount').focus();
}

function updateBalance(accountKey, delta, envelopeIndex = null) {
  const data = getCurrentData();
  if (accountKey === 'amplop_aktif' && data.envelopes.length) {
    const idx = envelopeIndex !== null ? envelopeIndex : data.activeEnvelopeIndex;
    data.envelopes[idx].balance += delta;
  } else if (accountKey === 'rollover') {
    data.rolloverBalance += delta;
  } else if (data.accounts[accountKey]) {
    data.accounts[accountKey].balance += delta;
  }
}

document.getElementById('expense-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!ensureUnlocked()) return;

  const data = getCurrentData();
  const accountKey = document.getElementById('input-account').value;
  const amount = parseRupiahInput(document.getElementById('input-amount').value);
  const date = document.getElementById('input-date').value;
  const note = document.getElementById('input-note').value.trim();

  if (!amount || amount <= 0 || !note) return;

  const envIdx = accountKey === 'amplop_aktif' ? data.activeEnvelopeIndex : null;
  const currentBal =
    accountKey === 'amplop_aktif'
      ? data.envelopes[envIdx].balance
      : accountKey === 'rollover'
      ? data.rolloverBalance
      : data.accounts[accountKey]?.balance ?? 0;

  data.transactions.unshift({
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    accountKey,
    accountLabel: getAccountLabel(accountKey, envIdx !== null ? envIdx + 1 : null),
    envelopeIndex: envIdx,
    amount,
    date,
    note,
  });

  updateBalance(accountKey, -amount, envIdx);
  saveState();
  renderAll();

  document.getElementById('input-amount').value = '';
  document.getElementById('input-note').value = '';

  if (currentBal - amount < 0) {
    showToast(`Tercatat (saldo ${getAccountLabel(accountKey)} minus ${formatRupiah(Math.abs(currentBal - amount))}).`, 'warning');
  } else {
    showToast(`${formatRupiah(amount)} dicatat.`);
  }
});

function handleNextEnvelope() {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const idx = data.activeEnvelopeIndex;
  const lastIdx = data.envelopes.length - 1;
  const currentEnv = data.envelopes[idx];
  if (!currentEnv || lastIdx < 0) return;

  if (idx >= lastIdx) {
    if (currentEnv.balance <= 0) {
      showToast(`Sudah di ${currentEnv.name} dan saldo Rp0.`, 'warning');
      return;
    }
    openConfirmModal(`Rollover Sisa ${currentEnv.name}?`, `Pindahkan sisa ${formatRupiah(currentEnv.balance)} ke Rollover?`, () => {
      data.rolloverBalance += currentEnv.balance;
      currentEnv.balance = 0;
      currentEnv.status = 'completed';
      saveState();
      renderAll();
      showToast(`Sisa ${currentEnv.name} masuk Rollover.`);
    });
    return;
  }

  const nextEnv = data.envelopes[idx + 1];
  const leftover = Math.max(0, currentEnv.balance);
  const msg =
    leftover > 0
      ? `Sisa ${currentEnv.name} (${formatRupiah(leftover)}) masuk Rollover, lalu ${nextEnv.name} dibuka.`
      : `Tutup ${currentEnv.name} dan buka ${nextEnv.name}?`;

  openConfirmModal('Pindah Minggu Berikutnya?', msg, () => {
    if (leftover > 0) data.rolloverBalance += leftover;
    currentEnv.balance = 0;
    currentEnv.status = 'completed';
    nextEnv.status = 'active';
    data.activeEnvelopeIndex = idx + 1;
    saveState();
    renderAll();
    showToast(`${nextEnv.name} aktif.`);
  });
}

function transferRolloverToDate() {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  if (data.rolloverBalance <= 0) {
    showToast('Saldo Rollover masih Rp0.', 'warning');
    return;
  }
  const amount = data.rolloverBalance;
  const dateWallet = data.accounts.blu_ngedate || Object.values(data.accounts)[0];
  if (!dateWallet) {
    showToast('Belum ada wallet tujuan.', 'warning');
    return;
  }
  openConfirmModal('Pindahkan ke Wallet?', `Pindahkan ${formatRupiah(amount)} dari Rollover ke ${dateWallet.name}?`, () => {
    dateWallet.balance += amount;
    dateWallet.initial += amount;
    data.rolloverBalance = 0;
    saveState();
    renderAll();
    showToast(`+${formatRupiah(amount)} masuk ke ${dateWallet.name}.`);
  });
}

function deleteTransaction(txId) {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const tx = data.transactions.find((t) => t.id === txId);
  if (!tx) return;
  openConfirmModal('Hapus Transaksi?', `Hapus "${tx.note}" (${formatRupiah(tx.amount)}) dan kembalikan saldonya?`, () => {
    const restoreDelta = tx.isBalanceSync && typeof tx.signedDelta === 'number' ? -tx.signedDelta : tx.amount;
    updateBalance(tx.accountKey, restoreDelta, tx.envelopeIndex);
    data.transactions = data.transactions.filter((t) => t.id !== txId);
    saveState();
    renderAll();
    showToast('Transaksi dihapus.');
  });
}

function openEditModal(txId) {
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const tx = data.transactions.find((t) => t.id === txId);
  if (!tx) return;
  populateAccountSelects(document.getElementById('edit-account'), false);
  document.getElementById('edit-id').value = tx.id;
  document.getElementById('edit-account').value = tx.accountKey;
  document.getElementById('edit-amount').value = formatDotNumber(tx.amount);
  document.getElementById('edit-date').value = tx.date;
  document.getElementById('edit-note').value = tx.note;

  const modal = document.getElementById('edit-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeEditModal() {
  const modal = document.getElementById('edit-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

document.getElementById('edit-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!ensureUnlocked()) return;
  const data = getCurrentData();
  const txId = document.getElementById('edit-id').value;
  const idx = data.transactions.findIndex((t) => t.id === txId);
  if (idx === -1) return;

  const oldTx = data.transactions[idx];
  const newAccountKey = document.getElementById('edit-account').value;
  const newAmount = parseRupiahInput(document.getElementById('edit-amount').value);
  const newDate = document.getElementById('edit-date').value;
  const newNote = document.getElementById('edit-note').value.trim();

  if (!newAmount || newAmount <= 0 || !newNote) return;

  const oldDelta = oldTx.isBalanceSync && typeof oldTx.signedDelta === 'number' ? oldTx.signedDelta : -oldTx.amount;
  updateBalance(oldTx.accountKey, -oldDelta, oldTx.envelopeIndex);
  const newEnvIndex = newAccountKey === 'amplop_aktif' ? (oldTx.envelopeIndex ?? data.activeEnvelopeIndex) : null;
  updateBalance(newAccountKey, -newAmount, newEnvIndex);

  data.transactions[idx] = {
    ...oldTx,
    isBalanceSync: false,
    signedDelta: undefined,
    accountKey: newAccountKey,
    accountLabel: getAccountLabel(newAccountKey, newEnvIndex !== null ? newEnvIndex + 1 : null),
    envelopeIndex: newEnvIndex,
    amount: newAmount,
    date: newDate,
    note: newNote,
  };
  saveState();
  closeEditModal();
  renderAll();
  showToast('Transaksi diperbarui.');
});

function exportData() {
  if (!ensureUnlocked()) return;
  const blob = new Blob([JSON.stringify(currentProfile, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `catatan-keuangan-${currentProfile.name.toLowerCase()}-${getToday()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup akun diunduh.');
}

function importData(event) {
  if (!ensureUnlocked()) return;
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      // Support both new single-profile backup and legacy multi-profile backup
      const rawProfile = imported?.profiles
        ? Object.values(imported.profiles).find(
            (p) => p.name?.trim().toLowerCase() === currentProfile.name.trim().toLowerCase()
          ) || Object.values(imported.profiles)[0]
        : imported?.accounts && imported?.envelopes
        ? { name: currentProfile.name, data: imported }
        : imported;

      currentProfile = normalizeProfile(
        { ...rawProfile, name: currentProfile.name },
        currentUser.uid,
        currentProfile.name
      );
      saveState();
      renderAll();
      showToast('Data akun dipulihkan.');
    } catch {
      showToast('File JSON tidak valid.', 'error');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function confirmResetMonth() {
  if (!ensureUnlocked()) return;
  const profile = getActiveProfile();
  const isFachri = profile.name.trim().toLowerCase() === 'fachri';
  openConfirmModal(
    `Reset ${profile.name}?`,
    isFachri
      ? 'Semua transaksi akun Fachri dihapus dan saldo kembali ke setup awal.'
      : `Kosongkan transaksi dan kembalikan saldo awal wallet akun ${profile.name}?`,
    () => {
      if (isFachri) {
        profile.data = getFachriState();
      } else {
        Object.values(profile.data.accounts).forEach((w) => {
          w.balance = w.initial;
        });
        profile.data.transactions = [];
        if (profile.data.envelopes && profile.data.envelopes.length) {
          const c = profile.data.envelopes.length;
          const amt = profile.data.envelopes[0]?.initial || 100000;
          profile.data.envelopes = createCustomEnvelopes(c, amt);
          profile.data.activeEnvelopeIndex = 0;
          profile.data.rolloverBalance = 0;
        }
      }
      saveState();
      renderAll();
      showToast('Data di-reset.');
    }
  );
}

function populateAccountSelects(selectEl, includeAllOption) {
  const data = getCurrentData();
  const opts = [];
  if (includeAllOption) opts.push('<option value="all">Semua Wallet</option>');
  if (data.envelopes && data.envelopes.length) {
    const activeEnv = data.envelopes[data.activeEnvelopeIndex] || data.envelopes[0];
    opts.push(`<option value="amplop_aktif">Amplop Tunai (${activeEnv.name} • ${formatRupiah(activeEnv.balance)})</option>`);
    opts.push('<option value="rollover">Rollover</option>');
  }
  Object.values(data.accounts).forEach((acc) => {
    opts.push(`<option value="${escapeHtml(acc.id)}">${escapeHtml(acc.name)}</option>`);
  });
  selectEl.innerHTML = opts.join('');
}

function renderProfileUI() {
  const profile = getActiveProfile();
  const data = profile.data;
  const walletCount = Object.keys(data.accounts).length;
  const hasEnvelopes = Boolean(data.envelopes && data.envelopes.length);

  document.getElementById('profile-subtitle').textContent = data.isCanvas
    ? `Akun: ${profile.name} • ${walletCount} Wallet${hasEnvelopes ? ` • ${data.envelopes.length} Amplop` : ''}`
    : `${profile.name} • Nov 2026 • Budget Rp1.200.000`;

  if (hasEnvelopes) {
    const totalEnv = data.envelopes.reduce((s, e) => s + (e.initial || 0), 0);
    document.getElementById('envelope-section-title').textContent = `Amplop Tunai (${formatRupiah(totalEnv)})`;
  }

  const presetBar = document.getElementById('preset-bar');
  if (data.isCanvas) {
    const firstWalletId = Object.keys(data.accounts)[0] || 'utama';
    const presetTarget = hasEnvelopes ? 'amplop_aktif' : firstWalletId;
    presetBar.innerHTML = `<button type="button" onclick="applyPreset('${presetTarget}', 15000, 'Pengeluaran')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">15rb</button>`;
  } else {
    presetBar.innerHTML = `
      <button type="button" onclick="applyPreset('amplop_aktif', 2000, 'Parkir')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">Parkir 2rb</button>
      <button type="button" onclick="applyPreset('amplop_aktif', 15000, 'Makan')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">Makan 15rb</button>
      <button type="button" onclick="applyPreset('gopay', 35000, 'Pertalite')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">Bensin 35rb</button>
      <button type="button" onclick="applyPreset('blu_nongki', 20000, 'Kopi')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">Kopi 20rb</button>
      <button type="button" onclick="applyPreset('blu_ngedate', 50000, 'Ngedate')" class="px-2.5 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">Date 50rb</button>
    `;
  }

  populateAccountSelects(document.getElementById('input-account'), false);
  populateAccountSelects(document.getElementById('filter-account'), true);
  document.getElementById('envelope-section').classList.toggle('hidden', !hasEnvelopes);
  document.getElementById('setup-envelopes-btn').classList.toggle('hidden', !data.isCanvas || hasEnvelopes);
}

function renderDashboard() {
  const data = getCurrentData();
  const acc = data.accounts;
  const walletList = Object.values(acc);
  const totalAccounts = walletList.reduce((s, a) => s + a.balance, 0);
  const totalInitial = walletList.reduce((s, a) => s + a.initial, 0);
  const totalEnvelopes = data.envelopes.reduce((s, e) => s + e.balance, 0);
  const totalAll = totalAccounts + totalEnvelopes + data.rolloverBalance + (data.bluAccountMain || 0);
  const totalSpent = data.transactions
    .filter((t) => !t.isBalanceSync || (t.signedDelta ?? -t.amount) < 0)
    .reduce((s, t) => s + t.amount, 0);

  document.getElementById('stat-total-all').textContent = formatRupiah(totalAll);
  document.getElementById('stat-total-spent').textContent = `Terpakai: ${formatRupiah(totalSpent)}`;

  if (data.isCanvas) {
    document.getElementById('stat-card2-label').textContent = 'Saldo Awal';
    document.getElementById('stat-blusaving').textContent = formatRupiah(totalInitial);
    document.getElementById('stat-card2-sub').textContent = `${walletList.length} wallet`;

    document.getElementById('stat-card3-label').textContent = 'Total Keluar';
    document.getElementById('stat-gopay').textContent = formatRupiah(totalSpent);
    document.getElementById('stat-gopay-detail').textContent = `${data.transactions.length} transaksi`;

    if (data.envelopes.length) {
      const activeEnv = data.envelopes[data.activeEnvelopeIndex] || data.envelopes[0];
      document.getElementById('stat-envelope-label').textContent = `Amplop ${activeEnv.name}`;
      document.getElementById('stat-envelope').textContent = formatRupiah(activeEnv.balance);
      document.getElementById('stat-envelope-sub').textContent = `Rollover: ${formatRupiah(data.rolloverBalance)}`;
    } else {
      const topWallet = walletList[0] || { name: 'Wallet', balance: 0 };
      document.getElementById('stat-envelope-label').textContent = topWallet.name;
      document.getElementById('stat-envelope').textContent = formatRupiah(topWallet.balance);
      document.getElementById('stat-envelope-sub').textContent = 'Wallet utama';
    }
    return;
  }

  const totalBluSaving = (acc.blu_ngedate?.balance || 0) + (acc.blu_nongki?.balance || 0) + (acc.blu_hp?.balance || 0);
  document.getElementById('stat-card2-label').textContent = 'bluSaving';
  document.getElementById('stat-blusaving').textContent = formatRupiah(totalBluSaving);
  document.getElementById('stat-card2-sub').textContent = 'bluAccount: Rp0';

  document.getElementById('stat-card3-label').textContent = 'GoPay';
  document.getElementById('stat-gopay').textContent = formatRupiah(acc.gopay?.balance || 0);
  document.getElementById('stat-gopay-detail').textContent = 'Saldo aktif';

  const activeEnv = data.envelopes[data.activeEnvelopeIndex] || data.envelopes[0];
  document.getElementById('stat-envelope-label').textContent = `Amplop ${activeEnv.name}`;
  document.getElementById('stat-envelope').textContent = formatRupiah(activeEnv.balance);
  document.getElementById('stat-envelope-sub').textContent = `Rollover: ${formatRupiah(data.rolloverBalance)}`;
}

function renderEnvelopes() {
  const data = getCurrentData();
  if (!data.envelopes.length) return;

  const grid = document.getElementById('envelopes-grid');
  grid.innerHTML = data.envelopes
    .map((env) => {
      const isActive = env.status === 'active';
      const isCompleted = env.status === 'completed';
      const style = isActive
        ? 'border-amber-400 bg-amber-50/70 dark:bg-amber-950/30'
        : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 opacity-80';
      const statusText = isActive ? 'Aktif' : isCompleted ? 'Selesai' : 'Terkunci';

      return `
        <div class="rounded-xl border p-3 ${style}">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span class="font-semibold">${escapeHtml(env.name)}</span>
            <span class="text-slate-500">${statusText}</span>
          </div>
          <div class="text-sm font-bold ${env.balance < 0 ? 'text-rose-600' : ''}">${formatRupiah(env.balance)}</div>
        </div>
      `;
    })
    .join('');

  document.getElementById('rollover-balance').textContent = formatRupiah(data.rolloverBalance);
}

function renderAccounts() {
  const data = getCurrentData();
  const container = document.getElementById('accounts-list');
  const wallets = Object.values(data.accounts);
  const canDelete = wallets.length > 1 || data.envelopes.length > 0;

  container.innerHTML = wallets
    .map((acc) => {
      const pct = acc.initial > 0 ? Math.max(0, Math.min(100, Math.round((acc.balance / acc.initial) * 100))) : 0;
      const deleteBtn = canDelete
        ? `<button type="button" onclick="deleteWallet('${acc.id}')" class="text-[11px] text-slate-400 hover:text-rose-600" title="Hapus Wallet">✕</button>`
        : '';
      return `
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 p-3.5">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-semibold">${escapeHtml(acc.name)}</span>
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-slate-400">${pct}%</span>
              <button type="button" onclick="openWalletModal('${acc.id}')" class="text-[11px] text-slate-400 hover:text-blue-600" title="Edit Wallet">Edit</button>
              ${deleteBtn}
            </div>
          </div>
          <div class="text-base font-bold mb-2 ${acc.balance < 0 ? 'text-rose-600' : ''}">
            ${formatRupiah(acc.balance)} <span class="text-[11px] font-normal text-slate-400">/ ${formatRupiah(acc.initial)}</span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
            <div class="h-full rounded-full ${acc.color || 'bg-blue-500'}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderTransactions() {
  const data = getCurrentData();
  const container = document.getElementById('transactions-container');
  const filterAcc = document.getElementById('filter-account').value;
  const query = document.getElementById('search-note').value.trim().toLowerCase();

  const filtered = data.transactions.filter((tx) => {
    const matchAcc = filterAcc === 'all' || tx.accountKey === filterAcc;
    const matchQuery = !query || tx.note.toLowerCase().includes(query);
    return matchAcc && matchQuery;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p class="text-center py-8 text-xs text-slate-400">Belum ada catatan pengeluaran.</p>`;
    return;
  }

  container.innerHTML = `
    <table class="w-full text-left border-collapse">
      <thead>
        <tr class="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-400">
          <th class="py-2.5 px-2">Tanggal</th>
          <th class="py-2.5 px-2">Catatan</th>
          <th class="py-2.5 px-2">Wallet</th>
          <th class="py-2.5 px-2 text-right">Nominal</th>
          <th class="py-2.5 px-2 text-right">Aksi</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
        ${filtered
          .map((tx) => {
            const envNum = tx.envelopeIndex !== null ? tx.envelopeIndex + 1 : null;
            const isPositiveSync = tx.isBalanceSync && (tx.signedDelta ?? 0) > 0;
            const amtClass = isPositiveSync
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-rose-600 dark:text-rose-400';
            const amtPrefix = isPositiveSync ? '+' : '-';
            return `
              <tr>
                <td class="py-2.5 px-2 whitespace-nowrap text-slate-500">${formatDateIndo(tx.date)}</td>
                <td class="py-2.5 px-2 font-medium">${escapeHtml(tx.note)}</td>
                <td class="py-2.5 px-2 whitespace-nowrap text-slate-500">${escapeHtml(getAccountLabel(tx.accountKey, envNum, tx.accountLabel))}</td>
                <td class="py-2.5 px-2 whitespace-nowrap text-right font-semibold ${amtClass}">${amtPrefix}${formatRupiah(tx.amount)}</td>
                <td class="py-2.5 px-2 whitespace-nowrap text-right">
                  <button onclick="openEditModal('${tx.id}')" class="px-1.5 py-1 text-slate-500 hover:text-blue-600" title="Edit">Edit</button>
                  <button onclick="deleteTransaction('${tx.id}')" class="px-1.5 py-1 text-slate-500 hover:text-rose-600" title="Hapus">Hapus</button>
                </td>
              </tr>
            `;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

function renderAll() {
  updateScreenGate();
  if (!isSessionUnlocked()) return;
  renderProfileUI();
  renderDashboard();
  renderEnvelopes();
  renderAccounts();
  renderTransactions();
}

Object.assign(window, {
  toggleTheme,
  lockAndLogout,
  openNewAccountModal,
  closeNewAccountModal,
  enableWeeklyEnvelopes,
  openEnvelopeReconfigureModal,
  deleteWeeklyEnvelopes,
  closeEnvelopeSetupModal,
  openWalletModal,
  closeWalletModal,
  deleteWallet,
  openSetPasswordModal,
  closePasswordModal,
  confirmDeleteAccount,
  applyPreset,
  handleNextEnvelope,
  transferRolloverToDate,
  deleteTransaction,
  openEditModal,
  closeEditModal,
  exportData,
  importData,
  confirmResetMonth,
  renderTransactions,
});

function loadCachedProfile(uid, fallbackName) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + uid);
    if (raw) return normalizeProfile(JSON.parse(raw), uid, fallbackName);
  } catch {}
  return normalizeProfile(null, uid, fallbackName);
}

function attachUserSession(user, preloadedProfile = null) {
  if (unsubscribeDb) {
    unsubscribeDb();
    unsubscribeDb = null;
  }
  currentUser = user;
  const uname = preloadedProfile?.name || user.displayName || emailToUsername(user.email);
  currentProfile = preloadedProfile || loadCachedProfile(user.uid, uname);
  document.getElementById('input-date').value = getToday();
  renderAll();

  const userRef = getUserRef(user.uid);
  unsubscribeDb = onValue(userRef, (snapshot) => {
    const val = snapshot.val();
    if (val) {
      currentProfile = normalizeProfile(val, user.uid, uname);
      try {
        localStorage.setItem(STORAGE_PREFIX + user.uid, JSON.stringify(currentProfile));
      } catch {}
      renderAll();
    } else {
      set(userRef, currentProfile);
    }
    setSyncStatus('online');
  }, () => {
    setSyncStatus('offline');
  });
}

window.addEventListener('DOMContentLoaded', () => {
  ['input-amount', 'edit-amount', 'new-acc-balance', 'env-setup-amount', 'wallet-initial', 'wallet-balance'].forEach(attachAutoDotFormat);
  document.getElementById('input-date').value = getToday();
  initTheme();
  updateScreenGate();

  // Auto-close mobile sandwich menu on outside tap or Escape
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('mobile-menu');
    if (menu?.open && !menu.contains(e.target)) menu.removeAttribute('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('mobile-menu')?.removeAttribute('open');
  });

  onAuthStateChanged(auth, (user) => {
    if (isRegistering) return;
    if (!user) {
      if (unsubscribeDb) {
        unsubscribeDb();
        unsubscribeDb = null;
      }
      currentUser = null;
      currentProfile = null;
      updateScreenGate();
      setSyncStatus('ready');
      return;
    }
    attachUserSession(user);
  });
});
