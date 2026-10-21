/* ============================================================================
 * Offline support: service worker, IndexedDB upload queue, sync, status banner.
 *
 * A scan is queued locally before it is sent, so a dropped connection cannot
 * lose a photo. The queue is per-user and is only ever flushed for the user who
 * created it.
 * ========================================================================== */

const Net = (() => {
  const DB_NAME = 'agrisuri';
  const DB_VERSION = 2;
  const STORE = 'queue';

  let dbPromise = null;
  let syncing = false;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (idb.objectStoreNames.contains('queue')) {
          // v1 -> v2: the old store had no index; recreate it.
          idb.deleteObjectStore('queue');
        }
        const store = idb.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('user', 'userId', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const idb = await openDB();
    return new Promise((resolve, reject) => {
      const t = idb.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const enqueue = (record) => tx('readwrite', (s) => s.add(record));
  const all = () => tx('readonly', (s) => s.getAll());
  const remove = (id) => tx('readwrite', (s) => s.delete(id));

  async function countFor(userId) {
    try {
      const rows = await all();
      return rows.filter((r) => r.userId === userId).length;
    } catch (e) {
      return 0;
    }
  }

  /* ---------------- sync ---------------- */

  async function sync() {
    if (syncing || !navigator.onLine) return { sent: 0 };
    syncing = true;

    let sent = 0;
    try {
      const session = await Store.session();
      if (!session) return { sent: 0 };

      const rows = (await all()).filter((r) => r.userId === session.user.id);
      for (const row of rows) {
        try {
          let imagePath = null;
          if (row.blob) {
            imagePath = await Store.uploadImage(
              new File([row.blob], 'scan.jpg', { type: row.blob.type || 'image/jpeg' }),
              row.userId,
            );
          }

          await Store.createScan({
            ...row.payload,
            imagePath,
            consentTraining: row.payload.consentTraining,
          });

          await remove(row.id);
          sent++;
        } catch (err) {
          // Leave it queued. A permanent rejection (e.g. rejected scan with a
          // diagnosis) is dropped so it cannot block the queue forever.
          if (/rejected scan cannot|Unsupported crop|Unknown barangay|outside your jurisdiction/i.test(err.message || '')) {
            await remove(row.id);
          }
        }
      }

      if (sent) {
        window.dispatchEvent(new Event('agri-synced'));
        toast(`${sent} queued ${sent === 1 ? 'scan' : 'scans'} uploaded.`, 'success');
      }
    } catch (err) {
      console.warn('[AgriSuri] sync deferred:', err && err.message);
    } finally {
      syncing = false;
      paint();
    }

    return { sent };
  }

  /* ---------------- status banner ---------------- */

  function banner() {
    let el = document.getElementById('net-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'net-banner';
      el.className = 'net-banner';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    return el;
  }

  async function paint() {
    const el = banner();
    const session = await Store.session().catch(() => null);
    const pending = session ? await countFor(session.user.id) : 0;

    if (!navigator.onLine) {
      el.className = 'net-banner is-offline';
      el.innerHTML = `<span class="net-banner__dot"></span>Offline${pending ? ` · ${pending} scan${pending === 1 ? '' : 's'} waiting to upload` : ''}`;
      el.hidden = false;
    } else if (pending) {
      el.className = 'net-banner is-pending';
      el.innerHTML = `<span class="net-banner__dot"></span>${pending} scan${pending === 1 ? '' : 's'} waiting to upload`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* SW is optional */ });
    }

    window.addEventListener('online', () => { paint(); sync(); });
    window.addEventListener('offline', paint);

    paint();
    setTimeout(sync, 1800);

    // Retry whenever the tab regains focus; cheap and catches flaky networks.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) sync();
    });
  }

  return { init, sync, enqueue, all, remove, countFor, paint };
})();

/* Small localStorage helpers used for UI state only — never for authorisation. */
const cacheSet = (k, v) => { try { localStorage.setItem(`agri_${k}`, JSON.stringify(v)); } catch (e) { /* quota */ } };
const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(`agri_${k}`)); } catch (e) { return null; } };
