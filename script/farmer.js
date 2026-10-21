/* ============================================================================
 * Farmer application: dashboard, scan, history.
 *
 * Every number comes from a SQL aggregate that RLS has already scoped to this
 * user. When the database has no scans yet, the UI falls back to clearly
 * labelled sample data (script/demo.js) instead of showing empty charts.
 * ========================================================================== */

const Farmer = (() => {
  const TZ = APP.timezone;

  const state = {
    me: null,
    view: 'home',
    range: 'week',
    historyRange: 'month',
    historyCrop: '',
    historyPage: 0,
    historyPageSize: 10,
    crop: null,
    result: null,
    busy: false,
    weather: null,
    barangays: [],
    previewUrl: null,
    demoHome: false,
  };

  const TITLE_KEYS = {
    home: ['view.home.title', 'view.home.sub'],
    scan: ['view.scan.title', 'view.scan.sub'],
    history: ['view.history.title', 'view.history.sub'],
  };

  const CONDITION = {
    0: ['weather.clear', 'sun'], 1: ['weather.clear', 'sun'], 2: ['weather.partly', 'cloud-sun'],
    3: ['weather.cloudy', 'cloud'], 45: ['weather.fog', 'fog'], 48: ['weather.fog', 'fog'],
    51: ['weather.drizzle', 'rain'], 53: ['weather.drizzle', 'rain'], 55: ['weather.drizzle', 'rain'],
    56: ['weather.drizzle', 'rain'], 57: ['weather.drizzle', 'rain'],
    61: ['weather.rainy', 'rain'], 63: ['weather.rainy', 'rain'], 65: ['weather.rainy', 'rain'],
    66: ['weather.rainy', 'rain'], 67: ['weather.rainy', 'rain'],
    71: ['weather.rainy', 'rain'], 73: ['weather.rainy', 'rain'], 75: ['weather.rainy', 'rain'],
    77: ['weather.rainy', 'rain'],
    80: ['weather.showers', 'rain'], 81: ['weather.showers', 'rain'], 82: ['weather.showers', 'rain'],
    85: ['weather.showers', 'rain'], 86: ['weather.showers', 'rain'],
    95: ['weather.storm', 'storm'], 96: ['weather.storm', 'storm'], 99: ['weather.storm', 'storm'],
  };

  const ICON = {
    sun: '<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    'cloud-sun': '<circle cx="8.5" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 2.2v1.6M2.2 8.5h1.6M4.3 4.3l1.1 1.1M12.7 4.3l-1.1 1.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7.5 18.5h9a3.5 3.5 0 0 0 .3-7 4.6 4.6 0 0 0-8.8 1.2 2.9 2.9 0 0 0-.5 5.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    cloud: '<path d="M7 18.5h9.5a3.6 3.6 0 0 0 .3-7.2 4.8 4.8 0 0 0-9.1 1.2A3 3 0 0 0 7 18.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    fog: '<path d="M7 12h9.5a3.6 3.6 0 0 0 .3-7.2A4.8 4.8 0 0 0 7.7 6A3 3 0 0 0 7 12Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 16h16M6 19.5h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    rain: '<path d="M7 14.5h9.5a3.6 3.6 0 0 0 .3-7.2 4.8 4.8 0 0 0-9.1 1.2A3 3 0 0 0 7 14.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.5 17.5 7.5 20M12 17.5 11 20M15.5 17.5 14.5 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    storm: '<path d="M7 14.5h9.5a3.6 3.6 0 0 0 .3-7.2 4.8 4.8 0 0 0-9.1 1.2A3 3 0 0 0 7 14.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m12.5 16.5-2 3h3l-1.5 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  /* ============================================================ boot */

  async function boot() {
    applyChartDefaults();

    const me = await Guard.require(['farmer']);
    if (!me) return;

    state.me = me;

    try {
      state.barangays = await Store.barangays();
    } catch (e) {
      state.barangays = [];
    }

    paintProfile();
    bindUI();
    updateCaptureButton();
    Net.init();
    Guard.reveal();

    await Promise.allSettled([loadWeather(), loadHome(), loadHistory()]);

    document.addEventListener('agri:lang', () => {
      paintProfile();
      renderModelStatus();
      paintWeather();
      loadHome();
      loadHistory();
    });
  }

  function setSampleBadge(on) {
    const badge = document.getElementById('sample-badge');
    if (!badge) return;
    badge.hidden = !on;
    badge.textContent = on ? DEMO_DATA.badge : '';
  }

  function paintProfile() {
    const me = state.me;
    const ini = initials(me.full_name);
    const role = t('acct.farmer');

    ['top-avatar', 'acct-avatar'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.textContent = ini;
    });

    const brandUser = document.getElementById('brand-user');
    if (brandUser) brandUser.textContent = me.full_name || role;
    document.getElementById('acct-name').textContent = me.full_name || role;
    document.getElementById('acct-email').textContent = me.email || '—';
    document.getElementById('acct-role').textContent = role;

    const brgyName = barangayName(me.barangay_id);
    document.getElementById('acct-barangay').textContent = brgyName || '—';
    const locMain = document.getElementById('loc-main');
    const locSub = document.getElementById('loc-sub');
    if (locMain && locSub) {
      if (brgyName) {
        locMain.textContent = 'Peñaranda, Nueva Ecija';
        locSub.textContent = brgyName;
      } else {
        locMain.textContent = t('common.locationNotSet');
        locSub.textContent = '';
      }
    }
    const locText = document.getElementById('loc-text');
    if (locText) locText.textContent = brgyName ? t('common.brgy', { name: brgyName }) : t('common.locationNotSet');

    document.getElementById('greet-eyebrow').textContent = t('dash.greeting');
    document.getElementById('greet-name').textContent = (me.full_name || role).split(' ')[0];
    document.getElementById('greet-sub').textContent = brgyName
      ? t('dash.farmSub', { brgy: brgyName })
      : t('dash.farmSubNoBrgy');

    document.getElementById('acct-consent').checked = !!me.consent_training;
    const langLabel = document.getElementById('lang-label');
    if (langLabel) langLabel.textContent = I18N.lang === 'en' ? 'FIL' : 'EN';

    paintBarangayPrompt();
  }

  function barangayName(id) {
    const b = state.barangays.find((x) => x.id === id);
    return b ? b.name : '';
  }

  /**
   * Accounts provisioned without a barangay cannot save scans until they claim
   * one. The RPC allows it exactly once and validates the barangay.
   */
  function paintBarangayPrompt() {
    const card = document.getElementById('barangay-card');
    const me = state.me;
    if (!card) return;

    if (me.barangay_id || me.role !== 'farmer') { card.hidden = true; return; }
    card.hidden = false;

    const select = document.getElementById('brgy-select');
    if (!select.options.length) {
      select.innerHTML = `<option value="">${t('brgy.choose')}</option>` +
        state.barangays.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
    }

    const btn = document.getElementById('brgy-save');
    btn.textContent = t('brgy.save');
    btn.onclick = async () => {
      const id = select.value;
      if (!id) { toast(t('brgy.pick'), 'warn'); return; }

      btn.disabled = true;
      btn.textContent = t('brgy.saving');

      try {
        const { error } = await db.rpc('set_my_barangay', { p_barangay: id });
        if (error) throw error;

        state.me = await Store.profile(true);
        paintProfile();
        toast(t('brgy.saved'), 'success');
        loadHome();
      } catch (err) {
        toast(err.message || 'Could not save your barangay.', 'error');
        btn.disabled = false;
        btn.textContent = t('brgy.save');
      }
    };
  }

  /* ============================================================ nav */

  function bindUI() {
    document.querySelectorAll('[data-view]').forEach((btn) => {
      if (btn.tagName === 'SECTION') return;
      btn.addEventListener('click', () => show(btn.dataset.view));
    });

    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => show(btn.dataset.goto));
    });

    document.getElementById('range-pills').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      state.range = btn.dataset.range;
      document.querySelectorAll('#range-pills button').forEach((b) => b.classList.toggle('is-active', b === btn));
      loadHome();
    });

    document.getElementById('history-range').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      state.historyRange = btn.dataset.range;
      state.historyPage = 0;
      document.querySelectorAll('#history-range button').forEach((b) => b.classList.toggle('is-active', b === btn));
      loadHistory();
    });

    document.getElementById('history-crop').addEventListener('change', (e) => {
      state.historyCrop = e.target.value;
      state.historyPage = 0;
      loadHistory();
    });

    document.getElementById('page-prev').addEventListener('click', () => {
      state.historyPage = Math.max(0, state.historyPage - 1);
      loadHistory();
    });
    document.getElementById('page-next').addEventListener('click', () => {
      state.historyPage += 1;
      loadHistory();
    });

    document.querySelectorAll('.crop-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.crop = btn.dataset.crop;
        document.querySelectorAll('.crop-option').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
        document.getElementById('capture-hint').textContent = state.crop === 'tomato'
          ? t('scan.tomatoHint')
          : t('scan.palayHint');
        updateCaptureButton();
      });
    });

    const fileUpload = document.getElementById('file-upload');
    const fileCamera = document.getElementById('file-camera');

    document.getElementById('btn-upload').addEventListener('click', () => {
      if (!state.crop || state.busy) return;
      fileUpload.value = '';
      fileUpload.click();
    });
    fileUpload.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) runScan(file);
    });

    /* Two ways in: upload from the device, or take a live photo.
     *
     * Phones get the native camera app (capture="environment"), which is
     * sharper and faster than getUserMedia. Desktop browsers ignore `capture`,
     * so they get an in-page live preview with a framing guide instead of a
     * file picker. If permission is denied we fall back to the picker. */
    const cam = document.getElementById('cam');
    const camVideo = document.getElementById('cam-video');
    let camStream = null;

    function closeCamera() {
      if (camStream) camStream.getTracks().forEach((track) => track.stop());
      camStream = null;
      camVideo.srcObject = null;
      cam.hidden = true;
    }

    async function openCamera() {
      if (!state.crop || state.busy) return;

      if (window.matchMedia('(pointer: coarse)').matches || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        fileCamera.value = '';
        fileCamera.click();
        return;
      }

      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
        });
        camVideo.srcObject = camStream;
        cam.hidden = false;
        await camVideo.play().catch(() => {});
      } catch (err) {
        closeCamera();
        fileCamera.value = '';
        fileCamera.click();
      }
    }

    function snapPhoto() {
      const w = camVideo.videoWidth;
      const h = camVideo.videoHeight;
      if (!w || !h) return;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(camVideo, 0, 0, w, h);
      canvas.toBlob((blob) => {
        closeCamera();
        if (blob) runScan(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.92);
    }

    document.getElementById('btn-camera').addEventListener('click', openCamera);
    document.getElementById('cam-cancel').addEventListener('click', closeCamera);
    document.getElementById('cam-snap').addEventListener('click', snapPhoto);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !cam.hidden) closeCamera();
    });

    fileCamera.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) runScan(file);
    });

    const menu = document.getElementById('acct-menu');
    const toggleMenu = (force) => {
      const open = force != null ? force : menu.hidden;
      menu.hidden = !open;
      const topAvatar = document.getElementById('top-avatar');
      if (topAvatar) topAvatar.setAttribute('aria-expanded', String(open));
    };
    const topAvatar = document.getElementById('top-avatar');
    if (topAvatar) topAvatar.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMenu(false); });

    document.getElementById('acct-logout').addEventListener('click', () => Guard.logout());

    document.getElementById('acct-consent').addEventListener('change', async (e) => {
      const next = e.target.checked;
      try {
        const { error } = await db.from('profiles')
          .update({ consent_training: next, consent_recorded_at: next ? new Date().toISOString() : null })
          .eq('id', state.me.id);
        if (error) throw error;
        state.me.consent_training = next;
        toast(next ? 'Photo use enabled for reviewed samples.' : 'Photo use disabled.', 'success');
      } catch (err) {
        e.target.checked = !next;
        toast('Could not update that setting.', 'error');
      }
    });

    document.getElementById('lang-btn').addEventListener('click', () => {
      I18N.toggle();
      paintProfile();
      show(state.view);
    });

    document.getElementById('weather-card').addEventListener('click', (e) => {
      if (e.target.closest('[data-retry-weather]')) loadWeather(true);
    });

    window.addEventListener('agri-synced', () => { loadHome(); loadHistory(); });
  }

  function show(view) {
    if (!TITLE_KEYS[view]) return;
    state.view = view;

    document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === view));
    document.querySelectorAll('.navlink, .tabbar__item').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });

    document.getElementById('view-title').textContent = t(TITLE_KEYS[view][0]);
    document.getElementById('view-sub').textContent = t(TITLE_KEYS[view][1]);
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });

    if (view === 'home') loadHome();
    if (view === 'history') loadHistory();
    if (view === 'scan') renderModelStatus();
  }

  /* ============================================================ weather */

  async function loadWeather(force) {
    const cached = cacheGet('weather');
    if (cached && !force && Date.now() - cached.at < 20 * 60 * 1000) {
      state.weather = cached;
      paintWeather();
      return;
    }

    const host = document.getElementById('weather-body');
    host.innerHTML = `
      <div class="weather__skeleton">
        <div class="skeleton skeleton--lg"></div>
        <div class="skeleton"></div>
        <div class="skeleton"></div>
      </div>`;

    let coords = null;
    let source = 'gps';

    try {
      coords = await getCoords();
    } catch (err) {
      coords = null;
    }

    if (!coords) {
      const geo = await geocode(`${APP.municipality}, ${APP.province}`);
      if (geo) { coords = geo; source = 'municipality'; }
    }

    if (!coords) {
      state.weather = null;
      paintWeather('no_location');
      return;
    }

    try {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${coords.lat}&longitude=${coords.lon}`
        + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
        + '&hourly=temperature_2m,weather_code,precipitation_probability'
        + '&forecast_days=2&timezone=auto';

      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather ${res.status}`);
      const body = await res.json();
      const c = body.current;
      if (!c) throw new Error('no current block');

      state.weather = {
        at: Date.now(),
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        code: c.weather_code,
        humidity: Math.round(c.relative_humidity_2m),
        wind: Math.round(c.wind_speed_10m),
        rain: c.precipitation,
        high: body.daily ? Math.round(body.daily.temperature_2m_max[0]) : null,
        low: body.daily ? Math.round(body.daily.temperature_2m_min[0]) : null,
        rainChance: body.daily ? body.daily.precipitation_probability_max[0] : null,
        hours: nextHours(body.hourly, c.time),
        source,
      };

      cacheSet('weather', state.weather);
      paintWeather();
    } catch (err) {
      const stale = cacheGet('weather');
      state.weather = stale ? { ...stale, stale: true } : null;
      paintWeather(stale ? 'stale' : 'error');
    }
  }

  /** Pick the six hours that follow the current local hour. */
  function nextHours(hourly, currentTime) {
    if (!hourly || !hourly.time || !hourly.time.length) return [];

    let start = hourly.time.findIndex((iso) => iso.slice(0, 13) === String(currentTime).slice(0, 13));
    if (start < 0) start = 0;

    const out = [];
    for (let i = start; i < Math.min(start + 6, hourly.time.length); i++) {
      out.push({
        time: hourly.time[i],
        temp: Math.round(hourly.temperature_2m[i]),
        code: hourly.weather_code[i],
        rain: hourly.precipitation_probability ? hourly.precipitation_probability[i] : null,
      });
    }
    return out;
  }

  function getCoords() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        (e) => reject(e),
        { timeout: 9000, maximumAge: 10 * 60 * 1000 },
      );
    });
  }

  async function geocode(place) {
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place.split(',')[0])}&count=1&language=en&format=json`,
      );
      if (!res.ok) return null;
      const body = await res.json();
      const hit = body.results && body.results[0];
      return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
    } catch (e) {
      return null;
    }
  }

  function paintWeather(mode) {
    const host = document.getElementById('weather-body');
    const loc = document.getElementById('weather-loc');
    const source = document.getElementById('weather-source');
    const w = state.weather;

    if (loc) {
      loc.textContent = w && w.source === 'gps' && barangayName(state.me.barangay_id)
        ? `${barangayName(state.me.barangay_id)}, ${APP.province}`
        : `${APP.municipality}, ${APP.province}`;
    }

    if (!w) {
      source.textContent = 'Open-Meteo';
      host.innerHTML = `
        <div class="weather weather--empty">
          <p class="weather__cond">${esc(t('weather.unavailable'))}</p>
          <p class="weather__note weather__note--warn">
            ${esc(mode === 'no_location' ? t('weather.denied') : t('weather.failed'))}
          </p>
          <button class="btn btn--ghost btn--sm" data-retry-weather type="button">${esc(t('weather.retry'))}</button>
        </div>`;
      return;
    }

    const [key, icon] = CONDITION[w.code] || ['weather.cloudy', 'cloud'];
    const age = Math.round((Date.now() - w.at) / 60000);
    const ageText = age < 1 ? 'just now' : age < 60 ? `${age} min` : `${Math.round(age / 60)} h`;

    const hours = (w.hours || []).map((h) => {
      const [, hIcon] = CONDITION[h.code] || ['weather.cloudy', 'cloud'];
      const label = new Date(h.time).toLocaleTimeString(I18N.locale(), { hour: 'numeric', timeZone: TZ });
      return `<li class="weather__hour">
        <span class="weather__hour-time">${esc(label)}</span>
        <svg class="weather__hour-icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[hIcon]}</svg>
        <b>${h.temp}°</b>
        <i>${h.rain != null ? `${h.rain}%` : '—'}</i>
      </li>`;
    }).join('');

    host.innerHTML = `
      <div class="weather">
        <div class="weather__hero">
          <svg class="weather__icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[icon]}</svg>
          <div class="weather__reading">
            <div class="weather__temp">${w.temp}°<span>C</span></div>
            <div class="weather__cond">
              ${esc(t(key))}
              <span class="weather__feels">${esc(t('weather.feels'))} ${w.feels}°</span>
            </div>
          </div>
          <div class="weather__range">
            <span><b>${w.high != null ? w.high + '°' : '—'}</b> ${esc(t('weather.high'))}</span>
            <span><b>${w.low != null ? w.low + '°' : '—'}</b> ${esc(t('weather.low'))}</span>
          </div>
        </div>

        ${hours ? `<ul class="weather__hours" aria-label="${esc(t('weather.next'))}">${hours}</ul>` : ''}

        <dl class="weather__grid">
          <div class="weather__cell"><dt>${esc(t('weather.humidity'))}</dt><dd>${w.humidity}%</dd></div>
          <div class="weather__cell"><dt>${esc(t('weather.wind'))}</dt><dd>${w.wind} km/h</dd></div>
          <div class="weather__cell"><dt>${esc(t('weather.rain'))}</dt><dd>${w.rainChance != null ? w.rainChance + '%' : w.rain + ' mm'}</dd></div>
        </dl>

        <p class="weather__note ${w.stale ? 'weather__note--warn' : ''}">
          ${esc(w.source === 'municipality' ? t('weather.atMunicipality') : t('weather.at'))}
          · ${esc(t('weather.updated', { when: ageText }))}
          ${w.stale ? ` · ${esc(t('weather.stale'))}` : ''}
        </p>
      </div>`;

    source.textContent = w.stale ? 'Open-Meteo · cached' : 'Open-Meteo';
  }

  /* ============================================================ dashboard */

  async function loadHome() {
    const now = new Date();
    const today = Core.rangeFor('today', now, TZ);
    const week = Core.rangeFor('week', now, TZ);
    const month = Core.rangeFor('month', now, TZ);

    try {
      const [dToday, dWeek, dMonth] = await Promise.all([
        Store.summary(today.from, today.to),
        Store.summary(week.from, week.to),
        Store.summary(month.from, month.to),
      ]);

      // Sample data only when the database is genuinely empty.
      const useDemo = Demo.on() && dMonth.scans === 0;
      state.demoHome = useDemo;
      setSampleBadge(useDemo);

      const todayRows = useDemo ? Demo.series(today) : null;
      const weekRows = useDemo ? Demo.series(week) : null;

      const todayCount = todayRows ? todayRows.reduce((s, r) => s + r.scans, 0) : dToday.scans;
      const weekCount = weekRows ? weekRows.reduce((s, r) => s + r.scans, 0) : dWeek.scans;
      const monthSummary = useDemo ? Demo.summary(month) : dMonth;

      animateCount(document.getElementById('stat-today'), todayCount);
      animateCount(document.getElementById('stat-week'), weekCount);
      animateCount(document.getElementById('stat-month'), monthSummary.scans);
      animateCount(document.getElementById('stat-flagged'), monthSummary.affected);

      const weekSummary = weekRows
        ? { scans: weekRows.reduce((a, r) => a + r.scans, 0), affected: weekRows.reduce((a, r) => a + r.affected, 0) }
        : dWeek;

      renderInsight(weekSummary, monthSummary);
    } catch (err) {
      toast(t('recent.checkConnection'), 'error');
    }

    await renderActivityChart();
    await renderRecent();
  }

  function renderInsight(week, month) {
    const host = document.getElementById('insight-body');
    const rate = Core.ratio(month.affected, month.scans);
    const weekRate = Core.ratio(week.affected, week.scans);

    if (!month.scans) {
      host.innerHTML = `
        <div class="insight">
          <p class="insight__note">${esc(t('week.noData'))}</p>
          <button class="btn btn--ghost btn--sm" data-goto="scan" type="button">${esc(t('week.firstScan'))}</button>
        </div>`;
      host.querySelector('[data-goto]').addEventListener('click', () => show('scan'));
      return;
    }

    const delta = weekRate != null && rate != null ? (weekRate - rate) * 100 : null;

    let note;
    if (delta == null) note = t('week.notEnough');
    else if (Math.abs(delta) < 0.5) note = t('week.same');
    else note = t(delta > 0 ? 'week.higher' : 'week.lower', { n: Math.abs(delta).toFixed(0) });

    host.innerHTML = `
      <div class="insight">
        <div class="insight__row"><span>${esc(t('week.flaggedWeek'))}</span><b>${week.affected} ${esc(t('week.of'))} ${week.scans}</b></div>
        <div class="insight__bar"><i style="width:${Math.round((weekRate || 0) * 100)}%"></i></div>
        <div class="insight__row"><span>${esc(t('week.flaggedMonth'))}</span><b>${month.affected} ${esc(t('week.of'))} ${month.scans}</b></div>
        <div class="insight__bar"><i style="width:${Math.round((rate || 0) * 100)}%"></i></div>
        <p class="insight__note">${esc(note)}</p>
        ${state.demoHome ? Demo.note() : ''}
      </div>`;
  }

  async function renderActivityChart() {
    const range = Core.rangeFor(state.range, new Date(), TZ);
    const canvas = document.getElementById('chart-activity');
    const empty = document.getElementById('chart-empty');

    try {
      const rows = await Store.series(range.from, range.to, range.bucket);
      const aligned = Core.alignSeries(rows, range, TZ);
      const realTotal = aligned.reduce((s, r) => s + r.scans, 0);

      const useDemo = Demo.on() && realTotal === 0;
      const data = useDemo ? Demo.series(range) : aligned;
      const total = data.reduce((s, r) => s + r.scans, 0);

      if (!total) {
        destroyChart('chart-activity');
        canvas.style.display = 'none';
        empty.hidden = false;
        return;
      }

      canvas.style.display = '';
      empty.hidden = true;

      renderChart('chart-activity', {
        type: 'bar',
        data: {
          labels: data.map((r) => formatBucket(r.bucket, range.bucket)),
          datasets: [{
            label: t('stats.scans'),
            data: data.map((r) => r.scans),
            backgroundColor: useDemo ? 'rgba(15, 122, 61, .42)' : CHART.green,
            hoverBackgroundColor: CHART.green,
            borderRadius: 5,
            maxBarThickness: 34,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: { label: (ctx) => ` ${ctx.parsed.y} ${t('stats.scans')}` },
            },
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: CHART.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
            y: { ...axis(), beginAtZero: true, ticks: { color: CHART.tick, precision: 0, maxTicksLimit: 5 } },
          },
        },
      });
    } catch (err) {
      canvas.style.display = 'none';
      empty.hidden = false;
      empty.innerHTML = `<p>${esc(t('chart.failed'))}</p>`;
    }
  }

  function formatBucket(date, bucket) {
    if (bucket === 'hour') return date.toLocaleTimeString(I18N.locale(), { hour: 'numeric', timeZone: TZ });
    if (bucket === 'month') return date.toLocaleDateString(I18N.locale(), { month: 'short', timeZone: TZ });
    return date.toLocaleDateString(I18N.locale(), { month: 'short', day: 'numeric', timeZone: TZ });
  }

  async function renderRecent() {
    const host = document.getElementById('recent-list');
    host.innerHTML = skeleton(3);

    try {
      const scans = await Store.myScans({ limit: 5 });
      const rows = scans.length ? scans : (Demo.on() ? Demo.scans(4) : []);

      if (!rows.length) {
        host.innerHTML = emptyState(
          t('recent.empty'),
          t('recent.emptyHint'),
          `<button class="btn btn--primary btn--sm" type="button" data-go>${esc(t('history.scanNow'))}</button>`,
        );
        host.querySelector('[data-go]').addEventListener('click', () => show('scan'));
        return;
      }

      host.innerHTML = rows.map(scanRow).join('');
      host.querySelectorAll('[data-scan]').forEach((node) => {
        node.addEventListener('click', () => openScanDetail(node.dataset.scan));
      });
    } catch (err) {
      host.innerHTML = emptyState(t('recent.loadFailed'), t('recent.checkConnection'));
    }
  }

  function scanRow(s) {
    const healthy = /healthy/i.test(s.top_label || '');
    const badge = !s.top_label
      ? `<span class="badge badge--muted">${esc(t('common.noResult'))}</span>`
      : healthy
        ? `<span class="badge badge--ok">${esc(t('history.healthy'))}</span>`
        : `<span class="badge badge--warn">${esc(t('common.disease'))}</span>`;

    return `
      <button class="row" type="button" data-scan="${esc(s.id)}">
        <span class="row__thumb">${cropIcon(s.crop_code)}</span>
        <span class="row__body">
          <span class="row__title">${esc(s.top_label || t('common.noResult'))}</span>
          <span class="row__meta">
            <span>${esc(cropLabel(s.crop_code))}</span>
            <span>·</span>
            <span>${esc(relativeTime(s.created_at))}</span>
            ${s.demo ? `<span>·</span><span class="sample-inline">${esc(DEMO_DATA.badge)}</span>` : ''}
          </span>
        </span>
        <span class="row__badge">${badge}</span>
      </button>`;
  }

  function cropIcon(code) {
    if (code === 'tomato') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="14" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7c-1.6-2.2-3.8-2.6-5.4-2.2 1.1 1.5 2.3 2.6 3.9 3.2M12 7c1.6-2.2 3.8-2.6 5.4-2.2-1.1 1.5-2.3 2.6-3.9 3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21V7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 9c-2.2-.8-3.7-2.3-4-4.5 2.2.4 3.7 1.9 4 4.5ZM12 13c-2.2-.8-3.7-2.3-4-4.5 2.2.4 3.7 1.9 4 4.5ZM12 17c-2.2-.8-3.7-2.3-4-4.5 2.2.4 3.7 1.9 4 4.5ZM12 9c2.2-.8 3.7-2.3 4-4.5-2.2.4-3.7 1.9-4 4.5ZM12 13c2.2-.8 3.7-2.3 4-4.5-2.2.4-3.7 1.9-4 4.5ZM12 17c2.2-.8 3.7-2.3 4-4.5-2.2.4-3.7 1.9-4 4.5Z" fill="currentColor"/></svg>';
  }

  const cropLabel = (code) => (code === 'tomato' ? t('scan.tomato') : code === 'palay' ? t('scan.palay') : t('common.crop'));

  /* ============================================================ scan */

  function updateCaptureButton() {
    const upload = document.getElementById('btn-upload');
    const camera = document.getElementById('btn-camera');
    const disabled = !state.crop || state.busy;
    upload.disabled = disabled;
    camera.disabled = disabled;
  }

  function stageLine(stage, stateName) {
    const host = document.getElementById('stage-log');
    const key = {
      prepare: 'scan.prepare',
      quality: 'scan.quality',
      shape: 'scan.shapeGate',
      texture: 'scan.textureGate',
      disease: 'scan.disease',
    }[stage];
    if (!key) return;

    let row = host.querySelector(`[data-stage="${stage}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'stage-log__item';
      row.dataset.stage = stage;
      row.innerHTML = `<span class="stage-log__dot"></span><span>${esc(t(key))}</span>`;
      host.appendChild(row);
    }
    row.classList.toggle('is-active', stateName === 'active');
    row.classList.toggle('is-done', stateName === 'done');
    row.classList.toggle('is-fail', stateName === 'fail');
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runScan(file) {
    if (state.busy) return;
    state.busy = true;
    state.result = null;
    updateCaptureButton();

    const host = document.getElementById('result-host');
    const viewport = document.getElementById('viewport');
    const preview = document.getElementById('preview');
    const scanline = document.getElementById('scanline');
    const guide = document.getElementById('viewport-guide');
    const stageLog = document.getElementById('stage-log');

    host.hidden = true;
    host.innerHTML = '';
    stageLog.innerHTML = '';
    viewport.classList.add('has-photo');
    scanline.hidden = false;
    guide.hidden = true;

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(file);
    preview.src = state.previewUrl;
    preview.hidden = false;

    try {
      const ORDER = ['prepare', 'quality', 'shape', 'texture', 'disease'];
      const demoMode = Demo.on() && !ScanPipeline.canRunDisease(state.crop);

      let result;

      if (demoMode) {
        // Real quality check, sample prediction. The UI is fully exercised and
        // the result is labelled as sample data everywhere it appears.
        const prepared = await ImageQuality.prepare(file);
        const metrics = ImageQuality.measure(prepared.analysis);
        stageLine('prepare', 'done');

        const quality = Core.evaluateQuality(metrics);
        stageLine('quality', quality.ok ? 'done' : 'fail');

        if (!quality.ok) {
          result = { status: 'retake', reason: quality.issues[0], issues: quality.issues, prepared };
        } else if (!Core.evaluateFraming(metrics).ok) {
          result = { status: 'retake', reason: 'off_center', issues: ['off_center'], prepared };
        } else {
          await wait(320);
          stageLine('shape', 'done');
          await wait(320);
          stageLine('texture', 'done');
          await wait(420);
          stageLine('disease', 'done');

          const distribution = Core.normalizePercentages(Demo.predictions(state.crop));
          const top = distribution[0];

          result = {
            status: 'ok',
            demo: true,
            crop: state.crop,
            quality: { ok: true, metrics },
            gate: { pass: true, provenance: 'sample', score: 1, threshold: 0.55, reasons: [] },
            predictions: distribution.map((p) => ({
              label: p.label, rawLabel: p.label, code: null, raw: p.raw, pct: p.pct, rank: p.rank,
            })),
            top: { label: top.label },
            topConfidence: top.raw,
            band: Core.confidenceBand(top.raw, AI_CONFIG),
            disease: null,
            model: { id: 'sample', version: 'demo', mode: 'offline' },
            prepared,
          };
        }
      } else {
        result = await ScanPipeline.run(file, state.crop, (stage) => {
          const idx = ORDER.indexOf(stage);
          if (idx < 0) return;
          ORDER.forEach((s, i) => {
            if (i < idx) stageLine(s, 'done');
            else if (i === idx) stageLine(s, 'active');
          });
        });

        const failedStage = result.status === 'rejected'
          ? (result.reason === 'not_leaf_texture' ? 'texture' : 'shape')
          : {
            prepare: 'prepare',
            quality: 'quality',
            unconfigured: 'shape',
            uncertain: 'disease',
          }[result.status];

        if (failedStage) {
          ORDER.slice(0, ORDER.indexOf(failedStage)).forEach((s) => stageLine(s, 'done'));
          stageLine(failedStage, 'fail');
        } else {
          ORDER.forEach((s) => stageLine(s, 'done'));
        }
      }

      state.result = result;
      renderResult(result, file);
    } catch (err) {
      stageLine('disease', 'fail');
      host.hidden = false;
      host.innerHTML = `
        <div class="result">
          <div class="result__banner result__banner--bad">
            <div><b>${esc(t('scan.failed'))}</b>${esc(err.message || '')}</div>
          </div>
          <div class="result__actions">
            <button class="btn btn--primary" type="button" data-retry>${esc(t('scan.tryAnother'))}</button>
          </div>
        </div>`;
      host.querySelector('[data-retry]').addEventListener('click', resetScan);
    } finally {
      state.busy = false;
      scanline.hidden = true;
      updateCaptureButton();
    }
  }

  function resetScan() {
    state.result = null;
    const host = document.getElementById('result-host');
    host.hidden = true;
    host.innerHTML = '';
    document.getElementById('stage-log').innerHTML = '';
    document.getElementById('preview').hidden = true;
    document.getElementById('preview').removeAttribute('src');
    document.getElementById('viewport').classList.remove('has-photo');
    document.getElementById('viewport-guide').hidden = false;
    if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
    updateCaptureButton();
  }

  function renderResult(result, file) {
    const host = document.getElementById('result-host');
    host.hidden = false;

    if (result.status === 'retake') {
      host.innerHTML = retakeMarkup(result);
      host.querySelector('[data-retry]').addEventListener('click', resetScan);
      return;
    }

    if (result.status === 'rejected') {
      host.innerHTML = rejectedMarkup(result);
      host.querySelector('[data-retry]').addEventListener('click', resetScan);
      return;
    }

    if (result.status === 'unconfigured') {
      host.innerHTML = unconfiguredMarkup();
      host.querySelector('[data-retry]').addEventListener('click', resetScan);
      return;
    }

    if (result.status === 'uncertain') {
      host.innerHTML = uncertainMarkup(result);
      host.querySelector('[data-retry]').addEventListener('click', resetScan);
      return;
    }

    host.innerHTML = okMarkup(result);
    host.querySelector('[data-again]').addEventListener('click', resetScan);
    host.querySelector('[data-home]').addEventListener('click', () => show('home'));

    const save = host.querySelector('[data-save]');
    if (save) save.addEventListener('click', (e) => saveResult(result, file, e.currentTarget));

    requestAnimationFrame(() => {
      host.querySelectorAll('.dist__fill').forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
    });
  }

  const RETAKE_KEYS = {
    dark: ['retake.dark', 'retake.darkBody'],
    bright: ['retake.bright', 'retake.brightBody'],
    overexposed: ['retake.overexposed', 'retake.overexposedBody'],
    blur: ['retake.blur', 'retake.blurBody'],
    flat: ['retake.flat', 'retake.flatBody'],
    off_center: ['retake.offCenter', 'retake.offCenterBody'],
    unreadable: ['retake.unreadable', 'retake.unreadableBody'],
  };

  function retakeMarkup(result) {
    const issues = result.issues || [result.reason];
    const rows = issues.map((code) => {
      const keys = RETAKE_KEYS[code] || ['retake.unreadable', 'retake.unreadableBody'];
      return `<div class="result__banner result__banner--warn">
        <div><b>${esc(t(keys[0]))}</b>${esc(t(keys[1]))}</div>
      </div>`;
    }).join('');

    return `
      <div class="result">
        ${rows}
        <div class="result__actions">
          <button class="btn btn--primary" type="button" data-retry>${esc(t('scan.tryAnother'))}</button>
        </div>
      </div>`;
  }

  function rejectedMarkup(result) {
    const gate = result.gate || {};
    const textureReject = result.reason === 'not_leaf_texture';

    const reasons = (gate.reasons || []).map((r) => t({
      center_not_vegetation: 'reject.whyCenter',
      too_little_vegetation: 'reject.whyLittle',
      not_green_foliage: 'reject.whyColour',
      model_says_not_plant: 'reject.whyModel',
      below_threshold: 'reject.whyThreshold',
      texture_not_leaf: 'reject.whyTexture',
    }[r] || r)).join('; ') || t('reject.whyThreshold');

    const title = textureReject ? t('reject.textureTitle') : t('reject.title');
    const body = textureReject
      ? t('reject.textureBody', { why: reasons })
      : t('reject.body', { why: reasons });

    return `
      <div class="result">
        <div class="result__banner result__banner--bad">
          <div>
            <b>${esc(title)}</b>
            ${esc(body)}
          </div>
        </div>
        <p class="disclaimer">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8h.01M11 12h1v4h1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          ${esc(t('reject.method'))}: ${esc(gate.provenance === 'model' ? t('reject.model') : t('reject.heuristic'))}.
        </p>
        <div class="result__actions">
          <button class="btn btn--primary" type="button" data-retry>${esc(t('scan.tryAnother'))}</button>
        </div>
      </div>`;
  }

  function unconfiguredMarkup() {
    return `
      <div class="result">
        <div class="result__banner result__banner--warn">
          <div><b>${esc(t('unconf.title'))}</b>${esc(t('unconf.body'))}</div>
        </div>
        <div class="setup">
          <p><b>${esc(t('unconf.optionA'))}</b></p>
          <ol>
            <li>Deploy <code>supabase/functions/infer</code> and set <code>ROBOFLOW_API_KEY</code> plus the model ids as secrets.</li>
            <li>Put the function URL in <code>AI_CONFIG.gatewayUrl</code> in <code>script/config.js</code>.</li>
          </ol>
          <p><b>${esc(t('unconf.optionB'))}</b></p>
          <ol>
            <li>Export a shape gate, a texture gate, and a disease model from Teachable Machine.</li>
            <li>Set <code>AI_CONFIG.tmShapeGate</code>, <code>tmTextureGate</code>, <code>tmDiseaseTomato</code> and <code>tmDiseasePalay</code>.</li>
          </ol>
        </div>
        <div class="result__actions">
          <button class="btn btn--primary" type="button" data-retry>${esc(t('scan.tryAnother'))}</button>
        </div>
      </div>`;
  }

  function uncertainMarkup(result) {
    return `
      <div class="result">
        <div class="result__banner result__banner--warn">
          <div>
            <b>${esc(t('unsure.title'))}</b>
            ${esc(t('unsure.body', {
              score: Math.round(result.topConfidence * 100),
              threshold: Math.round(AI_CONFIG.mediumConfidence * 100),
            }))}
          </div>
        </div>
        <div class="dist">
          ${result.predictions.map((p) => `
            <div class="dist__row">
              <div class="dist__head"><span>${esc(p.label)}</span><span>${p.pct}%</span></div>
              <div class="dist__track"><span class="dist__fill" style="width:${p.pct}%"></span></div>
            </div>`).join('')}
        </div>
        <p class="disclaimer">${esc(t('unsure.hint'))}</p>
        <div class="result__actions">
          <button class="btn btn--primary" type="button" data-retry>${esc(t('scan.tryAnother'))}</button>
        </div>
      </div>`;
  }

  function okMarkup(result) {
    const d = result.disease;
    const healthy = !!(d && d.is_healthy);
    const bandText = { high: 'High', medium: 'Moderate', low: 'Low' }[result.band] || '—';
    const bandClass = { high: 'badge--ok', medium: 'badge--info', low: 'badge--warn' }[result.band] || 'badge--muted';

    const blocks = [];
    if (d && d.symptoms) blocks.push(block(t('result.whatToLookFor'), d.symptoms, false));
    if (d && d.treatment) blocks.push(block(t('result.whatToDo'), d.treatment, false));
    if (d && d.prevention) blocks.push(block(t('result.prevent'), d.prevention, false));
    if (d && d.safety) blocks.push(block(t('result.safety'), d.safety, true));
    if (!blocks.length) blocks.push(block(t('result.noGuidance'), t('result.noGuidanceBody'), false));

    return `
      <div class="result">
        ${result.demo ? `
          <div class="result__banner result__banner--sample">
            <div><b>${esc(t('result.sample'))}</b>${esc(t('result.sampleBody'))}</div>
          </div>` : ''}

        <div class="result__banner ${healthy ? 'result__banner--ok' : 'result__banner--warn'}">
          <div>
            <b>${esc(healthy ? t('result.healthy') : t('result.diseaseFound'))}</b>
            ${esc(healthy ? t('result.healthyBody') : t('result.diseaseFoundBody'))}
          </div>
        </div>

        <div class="result__hero">
          <div>
            <p class="result__label">${esc(t('result.leading'))}</p>
            <p class="result__name">${esc(result.top.label)}</p>
            <p class="result__crop">
              ${esc(cropLabel(result.crop))} ·
              ${esc(result.model.mode === 'offline' ? t('result.offlineModel') : t('result.onlineModel'))}
            </p>
          </div>
          <div class="confidence">
            <p class="confidence__value">${Math.round(result.topConfidence * 100)}%</p>
            <p class="confidence__label">${esc(t('result.confidence'))}</p>
            <span class="badge ${bandClass}" style="margin-top:.3rem">${bandText}</span>
          </div>
        </div>

        <p class="result__label" style="margin-bottom:.45rem">${esc(t('result.classes'))}</p>
        <div class="dist">
          ${result.predictions.map((p) => `
            <div class="dist__row">
              <div class="dist__head"><span>${esc(p.label)}</span><span>${p.pct}%</span></div>
              <div class="dist__track"><span class="dist__fill" data-pct="${p.pct}" style="width:0"></span></div>
            </div>`).join('')}
        </div>

        <div class="guidance">${blocks.join('')}</div>

        <p class="disclaimer">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9.5v4M12 16.5h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          ${esc(t('result.disclaimer'))} ${esc(t('result.disclaimerTail'))}
        </p>

        <div class="result__actions">
          ${result.demo
            ? `<span class="result__disabled-note">${esc(t('result.sampleNoSave'))}</span>`
            : `<button class="btn btn--primary" type="button" data-save>${esc(t('result.save'))}</button>`}
          <button class="btn btn--ghost" type="button" data-again>${esc(t('scan.another'))}</button>
          <button class="btn btn--text" type="button" data-home>${esc(t('result.backHome'))}</button>
        </div>
      </div>`;
  }

  function block(title, body, warn) {
    return `<div class="guidance__block ${warn ? 'guidance__block--warn' : ''}">
      <h4>${esc(title)}</h4><p>${esc(body)}</p>
    </div>`;
  }

  async function saveResult(result, file, btn) {
    btn.disabled = true;
    btn.textContent = t('result.saving');

    const blob = await ImageQuality.toBlob(result.prepared.upload, 0.86);
    const coords = await getCoords().catch(() => null);

    const payload = {
      cropCode: result.crop,
      status: 'validated',
      topLabel: result.top.label,
      topCode: result.top.code || null,
      topConfidence: Number(result.topConfidence.toFixed(4)),
      confidenceBand: result.band,
      imageQuality: { ok: true, metrics: result.quality.metrics },
      validation: { gate: result.gate },
      modelId: result.model.id,
      modelVersion: result.model.version,
      inferenceMode: result.model.mode,
      normalized: result.predictions.map((p) => ({ label: p.label, pct: p.pct })),
      predictions: result.predictions.map((p) => ({
        code: p.code, label: p.label, raw: Number(p.raw.toFixed(5)), pct: p.pct, rank: p.rank,
      })),
      lat: coords ? Core.roundCoord(coords.lat, APP.coordPrecision) : null,
      lng: coords ? Core.roundCoord(coords.lon, APP.coordPrecision) : null,
      locationSource: coords ? 'gps' : 'profile',
      barangayId: state.me.barangay_id,
      consentTraining: !!state.me.consent_training,
    };

    try {
      if (navigator.onLine) {
        const path = await Store.uploadImage(new File([blob], 'scan.jpg', { type: 'image/jpeg' }), state.me.id);
        await Store.createScan({ ...payload, imagePath: path });
        toast(t('result.saved'), 'success');
      } else {
        await Net.enqueue({ userId: state.me.id, blob, payload, createdAt: Date.now() });
        Net.paint();
        toast('Saved on this device. It will upload when you are back online.', 'warn', 5200);
      }
      btn.textContent = t('result.saved');
      await loadHome();
      if (state.view === 'history') loadHistory();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t('result.save');
      toast(`Could not save: ${err.message || 'unknown error'}`, 'error');
    }
  }

  function renderModelStatus() {
    const host = document.getElementById('ai-status');
    const online = ScanPipeline.gatewayReady();

    const rows = [[t('model.gateway'), online]];

    /*
     * The offline (Teachable Machine) runtime is a fallback for when no gateway
     * is configured. Listing it as "Not set" beside a working gateway reads
     * like a fault when nothing is actually missing.
     */
    if (!online) {
      rows.push([t('model.offlineShape'), ScanPipeline.tmReady('shape')]);
      rows.push([t('model.offlineTexture'), ScanPipeline.tmReady('texture')]);
    }

    rows.push([t('model.tomato'), ScanPipeline.canRunDisease('tomato')]);
    rows.push([t('model.palay'), ScanPipeline.canRunDisease('palay')]);

    /*
     * Sample results are only produced when a crop has no model to call
     * (`demoMode` in runScan uses the same condition). Claiming "no model is
     * connected" while the gateway is answering would simply be false.
     */
    const sampleScans =
      Demo.on() && (!ScanPipeline.canRunDisease('tomato') || !ScanPipeline.canRunDisease('palay'));

    host.innerHTML = `
      <div class="insight">
        ${rows.map(([label, ok]) => `
          <div class="insight__row">
            <span>${esc(label)}</span>
            <b><span class="badge ${ok ? 'badge--ok' : 'badge--muted'}">${esc(ok ? t('model.configured') : t('model.notSet'))}</span></b>
          </div>`).join('')}
        <p class="insight__note">${esc(online ? t('model.noteOnline') : t('model.note'))}</p>
        ${sampleScans ? `<p class="insight__note">${esc(t('result.sampleBody'))}</p>` : ''}
      </div>`;
  }

  /* ============================================================ history */

  async function loadHistory() {
    const range = Core.rangeFor(state.historyRange, new Date(), TZ);
    const crop = state.historyCrop;

    const listHost = document.getElementById('history-list');
    listHost.innerHTML = skeleton(4);

    try {
      const [summary, diseases, crops] = await Promise.all([
        Store.summary(range.from, range.to),
        Store.diseaseBreakdown(range.from, range.to, null, 8),
        Store.cropBreakdown(range.from, range.to),
      ]);

      const useDemo = Demo.on() && summary.scans === 0;
      setSampleBadge(useDemo);

      const sum = useDemo ? Demo.summary(range) : summary;
      const dis = useDemo ? Demo.diseases(range) : diseases;
      const crp = useDemo ? Demo.crops(range) : crops;

      document.getElementById('h-total').textContent = fmtInt(sum.scans);
      document.getElementById('h-healthy').textContent = sum.scans
        ? `${Math.round(((sum.scans - sum.affected) / sum.scans) * 100)}%`
        : '—';

      const top = topEntry(dis.filter((d) => !d.is_healthy));
      document.getElementById('h-top').textContent = top ? top.label : t('common.none');
      document.getElementById('h-crops').textContent = crp.length
        ? crp.map((c) => c.crop_name).join(', ')
        : '—';

      renderCropChart(crp);
      renderDiseaseChart(dis);
    } catch (err) {
      toast(t('history.loadAnalyticsFailed'), 'error');
    }

    await renderHistoryList(range, crop);
  }

  function renderCropChart(crops) {
    const empty = document.getElementById('crop-empty');
    const canvas = document.getElementById('chart-crop');
    const total = crops.reduce((s, c) => s + Number(c.scans), 0);

    if (!total) {
      destroyChart('chart-crop');
      canvas.style.display = 'none';
      empty.hidden = false;
      return;
    }
    canvas.style.display = '';
    empty.hidden = true;

    renderChart('chart-crop', {
      type: 'doughnut',
      data: {
        labels: crops.map((c) => c.crop_name),
        datasets: [{
          data: crops.map((c) => Number(c.scans)),
          backgroundColor: [CHART.green, CHART.lime, CHART.slate, CHART.amber],
          borderWidth: 0,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${ctx.parsed} (${Math.round((ctx.parsed / total) * 100)}%)`,
            },
          },
        },
      },
    });
  }

  function renderDiseaseChart(diseases) {
    const empty = document.getElementById('disease-empty');
    const canvas = document.getElementById('chart-disease');
    const rows = diseases.filter((d) => !d.is_healthy);
    const total = rows.reduce((s, d) => s + Number(d.scans), 0);

    if (!total) {
      destroyChart('chart-disease');
      canvas.style.display = 'none';
      empty.hidden = false;
      empty.innerHTML = `<p>${esc(t('history.noDisease'))}</p>`;
      return;
    }
    canvas.style.display = '';
    empty.hidden = true;

    renderChart('chart-disease', {
      type: 'bar',
      data: {
        labels: rows.map((d) => shorten(d.label, 26)),
        datasets: [{
          label: t('stats.scans'),
          data: rows.map((d) => Number(d.scans)),
          backgroundColor: CHART.palette,
          borderRadius: 5,
          maxBarThickness: 26,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.parsed.x} (${Math.round((ctx.parsed.x / total) * 100)}%)`,
            },
          },
        },
        scales: {
          x: { ...axis(), beginAtZero: true, ticks: { color: CHART.tick, precision: 0, maxTicksLimit: 5 } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: CHART.tick, font: { size: 10 } } },
        },
      },
    });
  }

  function shorten(s, n) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  async function renderHistoryList(range, crop) {
    const host = document.getElementById('history-list');
    const pager = document.getElementById('history-pager');

    try {
      const all = await Store.myScans({ from: range.from, to: range.to, limit: 500 });
      const source = all.length ? all : (Demo.on() ? Demo.scans(14) : []);
      const filtered = crop ? source.filter((s) => s.crop_code === crop) : source;

      document.getElementById('history-count').textContent = !filtered.length
        ? t('history.countNone')
        : filtered.length === 1
          ? t('history.countOne')
          : t('history.countMany', { n: filtered.length });

      if (!filtered.length) {
        pager.hidden = true;
        host.innerHTML = emptyState(
          t('history.none'),
          t('history.noneHint'),
          `<button class="btn btn--primary btn--sm" type="button" data-go>${esc(t('history.scanNow'))}</button>`,
        );
        host.querySelector('[data-go]').addEventListener('click', () => show('scan'));
        return;
      }

      const pages = Math.ceil(filtered.length / state.historyPageSize);
      state.historyPage = Math.min(state.historyPage, pages - 1);
      const slice = filtered.slice(
        state.historyPage * state.historyPageSize,
        (state.historyPage + 1) * state.historyPageSize,
      );

      host.innerHTML = slice.map(scanRow).join('');
      host.querySelectorAll('[data-scan]').forEach((node) => {
        node.addEventListener('click', () => openScanDetail(node.dataset.scan));
      });

      pager.hidden = pages <= 1;
      document.getElementById('page-label').textContent = t('history.page', { n: state.historyPage + 1, total: pages });
      document.getElementById('page-prev').disabled = state.historyPage === 0;
      document.getElementById('page-next').disabled = state.historyPage >= pages - 1;
    } catch (err) {
      host.innerHTML = emptyState(t('history.loadFailed'), t('recent.checkConnection'));
    }
  }

  async function openScanDetail(scanId) {
    // Sample rows are not in the database, so render them from memory.
    if (String(scanId).startsWith('demo-scan-')) {
      const row = Demo.scans(14).find((s) => s.id === scanId);
      const body = document.createElement('div');
      body.innerHTML = `
        <div class="result__hero">
          <div>
            <p class="result__label">${esc(t('history.detailResult'))}</p>
            <p class="result__name">${esc(row ? row.top_label : t('common.noResult'))}</p>
            <p class="result__crop">${esc(cropLabel(row && row.crop_code))} · ${esc(fmtDateTime(row && row.created_at))}</p>
          </div>
        </div>
        <p class="disclaimer">${esc(t('result.sampleBody'))}</p>`;
      openModal({ title: t('history.detail'), body });
      return;
    }

    const body = document.createElement('div');
    body.innerHTML = skeleton(4);
    openModal({ title: t('history.detail'), body, wide: true });

    try {
      const { data: scan, error } = await db
        .from('scans')
        .select('id, crop_code, status, top_label, top_confidence, confidence_band, normalized, created_at, image_path, model_id, inference_mode, validation, image_quality, lat, lng, location_source, barangays(name)')
        .eq('id', scanId)
        .single();
      if (error) throw error;

      const predictions = await Store.scanPredictions([scanId]);
      const rows = predictions[scanId] || [];
      const url = scan.image_path ? await Store.signedUrl(scan.image_path, 1800) : null;
      const healthy = /healthy/i.test(scan.top_label || '');

      body.innerHTML = `
        ${url ? `<img src="${esc(url)}" alt="Scanned leaf" style="width:100%;border-radius:12px;margin-bottom:1rem;max-height:280px;object-fit:cover">` : ''}
        <div class="result__hero">
          <div>
            <p class="result__label">${esc(t('history.detailResult'))}</p>
            <p class="result__name">${esc(scan.top_label || t('common.noResult'))}</p>
            <p class="result__crop">${esc(cropLabel(scan.crop_code))} · ${esc(fmtDateTime(scan.created_at))}</p>
          </div>
          <div class="confidence">
            <p class="confidence__value">${scan.top_confidence != null ? Math.round(scan.top_confidence * 100) + '%' : '—'}</p>
            <p class="confidence__label">${esc(t('result.confidence'))}</p>
          </div>
        </div>

        ${rows.length ? `
          <p class="result__label" style="margin-bottom:.45rem">${esc(t('history.detailClasses'))}</p>
          <div class="dist">
            ${rows.map((r) => `
              <div class="dist__row">
                <div class="dist__head"><span>${esc(r.label)}</span><span>${r.normalized_pct != null ? Math.round(r.normalized_pct) + '%' : '—'}</span></div>
                <div class="dist__track"><span class="dist__fill" style="width:${r.normalized_pct || 0}%"></span></div>
              </div>`).join('')}
          </div>` : ''}

        <dl class="acct-menu__rows" style="border:0">
          <div><dt>${esc(t('acct.barangay'))}</dt><dd>${esc((scan.barangays && scan.barangays.name) || '—')}</dd></div>
          <div><dt>${esc(t('history.detailLocation'))}</dt><dd>${esc(scan.location_source || '—')}</dd></div>
          <div><dt>${esc(t('history.detailModel'))}</dt><dd>${esc(scan.model_id || '—')}</dd></div>
          <div><dt>${esc(t('history.detailInference'))}</dt><dd>${esc(scan.inference_mode || '—')}</dd></div>
          <div><dt>${esc(t('history.detailStatus'))}</dt><dd>${esc(scan.status)}</dd></div>
        </dl>

        ${!healthy && scan.top_label ? `<p class="disclaimer" style="margin-top:.8rem">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          ${esc(t('history.preliminary'))}
        </p>` : ''}
      `;
    } catch (err) {
      body.innerHTML = `<p class="modal__text">Could not load this scan: ${esc(err.message || 'unknown error')}</p>`;
    }
  }

  return { boot, show };
})();

document.addEventListener('DOMContentLoaded', () => Farmer.boot());
