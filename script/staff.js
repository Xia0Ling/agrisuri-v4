/* ============================================================================
 * Staff console (Admin + DA Officer).
 *
 * Every query here is scoped by RLS. A DA Officer sees only their jurisdiction
 * because the database refuses to return anything else — not because this file
 * remembers to filter.
 * ========================================================================== */

const Staff = (() => {
  const TZ = APP.timezone;

  const state = {
    me: null,
    role: 'da',
    view: 'overview',
    range: 'month',
    barangayFilter: '',
    scanPage: 0,
    scanPageSize: 20,
    scanLayout: 'table',
    scanSearch: '',
    scanCrop: '',
    scanStatus: '',
    scanBarangay: '',
    jurisdictions: [],
    barangays: [],
    accounts: { farmers: 0, admins: 0, officers: 0 },
  };

  const PAGE_META = {
    overview: ['Overview', 'Platform activity'],
    barangays: ['Barangays', 'Disease pressure by administrative area'],
    scans: ['Scan records', 'Individual scans inside your scope'],
    farmers: ['Farmers', 'Registered farmer accounts'],
    accounts: ['Accounts', 'Staff access and role assignment'],
    training: ['Training data', 'Farmer verdicts on past diagnoses'],
    audit: ['Audit log', 'Account and scan events'],
  };

  const ADMIN_ONLY = new Set(['accounts', 'training', 'audit']);

  /* ============================================================ boot */

  async function boot() {
    applyChartDefaults();

    const me = await Guard.require(['admin', 'da']);
    if (!me) return;

    state.me = me;
    state.role = me.role;

    try {
      const [jurisdictions, barangays] = await Promise.all([Store.jurisdictions(), Store.barangays()]);
      state.jurisdictions = jurisdictions;
      state.barangays = barangays;
    } catch (e) {
      state.jurisdictions = [];
      state.barangays = [];
    }

    paintChrome();
    bind();
    Net.init();
    Guard.reveal();

    await loadOverview();
  }

  function paintChrome() {
    const me = state.me;
    document.getElementById('rail-avatar').textContent = initials(me.full_name);
    document.getElementById('rail-name').textContent = me.full_name || 'Officer';
    document.getElementById('rail-role').textContent = me.role === 'admin' ? 'Administrator' : 'DA Officer';

    const isAdmin = me.role === 'admin';
    document.getElementById('rail-admin-section').hidden = !isAdmin;
    document.getElementById('rail-admin-nav').hidden = !isAdmin;

    if (isAdmin) {
      document.getElementById('scope-text').textContent = 'All jurisdictions';
    } else {
      const j = state.jurisdictions.find((x) => x.id === me.jurisdiction_id);
      document.getElementById('scope-text').textContent = j ? j.name : 'Your jurisdiction';
    }

    const select = document.getElementById('scan-barangay');
    select.innerHTML = '<option value="">All barangays</option>' +
      state.barangays.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  }

  function bind() {
    document.querySelectorAll('.rail__link').forEach((btn) => {
      btn.addEventListener('click', () => show(btn.dataset.view));
    });

    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => show(btn.dataset.goto));
    });

    document.getElementById('global-range').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-range]');
      if (!btn) return;
      state.range = btn.dataset.range;
      document.querySelectorAll('#global-range button').forEach((b) => b.classList.toggle('is-active', b === btn));
      reload();
    });

    document.getElementById('logout-btn').addEventListener('click', () => Guard.logout());

    /* scans */
    const debouncedSearch = debounce(() => {
      state.scanSearch = document.getElementById('scan-search').value.trim();
      state.scanPage = 0;
      loadScans();
    }, 320);

    document.getElementById('scan-search').addEventListener('input', debouncedSearch);
    ['scan-crop', 'scan-status', 'scan-barangay'].forEach((id) => {
      document.getElementById(id).addEventListener('change', (e) => {
        state[id === 'scan-crop' ? 'scanCrop' : id === 'scan-status' ? 'scanStatus' : 'scanBarangay'] = e.target.value;
        state.scanPage = 0;
        loadScans();
      });
    });

    document.getElementById('scan-layout').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-layout]');
      if (!btn) return;
      state.scanLayout = btn.dataset.layout;
      document.querySelectorAll('#scan-layout button').forEach((b) => b.classList.toggle('is-active', b === btn));
      loadScans();
    });

    document.getElementById('scan-prev').addEventListener('click', () => {
      state.scanPage = Math.max(0, state.scanPage - 1);
      loadScans();
    });
    document.getElementById('scan-next').addEventListener('click', () => {
      state.scanPage += 1;
      loadScans();
    });

    /* farmers */
    document.getElementById('farmer-search').addEventListener('input', debounce(loadFarmers, 320));

    /* accounts */
    const inviteForm = document.getElementById('invite-form');
    if (inviteForm) {
      const jurSelect = document.getElementById('invite-jurisdiction');
      jurSelect.innerHTML = state.jurisdictions.map((j) => `<option value="${j.id}">${esc(j.name)}</option>`).join('');
      inviteForm.addEventListener('submit', createInvite);
    }

    /* training data */
    const csvBtn = document.getElementById('btn-export-csv');
    if (csvBtn) csvBtn.addEventListener('click', exportTrainingCsv);
    const zipBtn = document.getElementById('btn-export-zip');
    if (zipBtn) zipBtn.addEventListener('click', exportTrainingZip);
  }

  function show(view) {
    if (!PAGE_META[view]) return;
    if (ADMIN_ONLY.has(view) && state.role !== 'admin') {
      toast('That section is restricted to administrators.', 'warn');
      return;
    }

    state.view = view;
    document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-active', s.dataset.view === view));
    document.querySelectorAll('.rail__link').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    document.getElementById('page-title').textContent = PAGE_META[view][0];
    document.getElementById('page-sub').textContent = PAGE_META[view][1];

    if (view === 'overview') loadOverview();
    if (view === 'barangays') loadBarangays();
    if (view === 'scans') loadScans();
    if (view === 'farmers') loadFarmers();
    if (view === 'accounts') loadAccounts();
    if (view === 'training') loadTraining();
    if (view === 'audit') loadAudit();
  }

  function reload() {
    const fn = {
      overview: loadOverview,
      barangays: loadBarangays,
      scans: loadScans,
      farmers: loadFarmers,
      accounts: loadAccounts,
      training: loadTraining,
      audit: loadAudit,
    }[state.view];
    if (fn) fn();
  }

  /** Clear any "no data" overlay left by a previous render before drawing. */
  function readyCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const box = canvas.parentElement;
    box.querySelectorAll('.chart-empty').forEach((n) => n.remove());
    canvas.style.display = '';
    return canvas;
  }

  function currentRange() {
    return Core.rangeFor(state.range, new Date(), TZ);
  }

  function previousRange(range) {
    const span = range.to.getTime() - range.from.getTime();
    return { from: new Date(range.from.getTime() - span), to: new Date(range.from.getTime()), bucket: range.bucket };
  }

  /* ============================================================ overview */

  async function loadOverview() {
    const range = currentRange();
    const prev = previousRange(range);

    setKpiLoading(true);

    try {
      const [real, realBefore, realSeries, realDiseases, realBarangays] = await Promise.all([
        Store.summary(range.from, range.to),
        Store.summary(prev.from, prev.to),
        Store.series(range.from, range.to, range.bucket),
        Store.diseaseBreakdown(range.from, range.to, null, 10),
        Store.barangayBreakdown(range.from, range.to),
      ]);

      // Sample data only when the database is genuinely empty, and it is badged.
      const useDemo = Demo.on() && real.scans === 0;
      setSampleBadge(useDemo);

      const cur = useDemo ? Demo.summary(range) : real;
      const before = useDemo ? Demo.summary(prev) : realBefore;
      const series = useDemo ? Demo.series(range) : realSeries;
      const diseases = useDemo ? Demo.diseases(range) : realDiseases;
      const barangays = useDemo ? Demo.barangays(range) : realBarangays;

      paintKpis(cur, before, diseases);
      paintTrend(series, range);
      paintDiseaseChart(diseases);
      paintBarangayChart(barangays);
      await paintFeed();
    } catch (err) {
      toast(`Could not load analytics: ${err.message || 'unknown error'}`, 'error');
      setKpiLoading(false);
    }
  }

  function setKpiLoading(on) {
    if (!on) return;
    ['kpi-scans', 'kpi-farmers', 'kpi-rate', 'kpi-top'].forEach((id) => {
      document.getElementById(id).textContent = '—';
    });
  }

  function paintKpis(cur, before, diseases) {
    animateCount(document.getElementById('kpi-scans'), cur.scans);
    animateCount(document.getElementById('kpi-farmers'), cur.farmers);

    const rate = Core.ratio(cur.affected, cur.scans);
    document.getElementById('kpi-rate').textContent = rate == null ? '—' : `${Math.round(rate * 100)}%`;

    const top = topEntry(diseases.filter((d) => !d.is_healthy));
    document.getElementById('kpi-top').textContent = top ? top.label : 'None detected';
    document.getElementById('kpi-top-sub').textContent = top ? `${fmtInt(top.scans)} scans` : 'No disease in range';

    setDelta('kpi-scans-delta', Core.pctChange(cur.scans, before.scans), 'vs previous period', false);
    setDelta('kpi-farmers-delta', Core.pctChange(cur.farmers, before.farmers), 'vs previous period', false);

    const beforeRate = Core.ratio(before.affected, before.scans);
    const rateDelta = rate != null && beforeRate != null ? (rate - beforeRate) * 100 : null;
    setDelta('kpi-rate-delta', rateDelta, 'points vs previous', true, 'pp');
  }

  function setDelta(id, value, suffix, higherIsBad, unit) {
    const el = document.getElementById(id);
    if (value == null || !isFinite(value)) {
      el.textContent = `No baseline — ${suffix}`;
      el.className = 'kpi__delta kpi__delta--muted';
      return;
    }
    const arrow = value > 0.05 ? '▲' : value < -0.05 ? '▼' : '■';
    const text = unit === 'pp' ? `${Math.abs(value).toFixed(1)} pp` : `${Math.abs(value).toFixed(1)}%`;
    el.textContent = `${arrow} ${text} ${suffix}`;
    const bad = higherIsBad ? value > 0.05 : value < -0.05;
    const good = higherIsBad ? value < -0.05 : value > 0.05;
    el.className = `kpi__delta ${bad ? 'is-down' : good ? 'is-up' : ''}`;
  }

  function paintTrend(rows, range) {
    const aligned = Core.alignSeries(rows, range, TZ);
    const labels = aligned.map((r) => bucketLabel(r.bucket, range.bucket));

    readyCanvas('ch-trend');

    renderChart('ch-trend', {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Scans',
            data: aligned.map((r) => r.scans),
            borderColor: CHART.green,
            backgroundColor: CHART.greenSoft,
            fill: true,
            tension: 0.32,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 2,
          },
          {
            label: 'Suspected disease',
            data: aligned.map((r) => r.affected),
            borderColor: CHART.amber,
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            fill: false,
            tension: 0.32,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderWidth: 1.6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: CHART.tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } },
          y: { ...axis(), beginAtZero: true, ticks: { color: CHART.tick, precision: 0, maxTicksLimit: 5 } },
        },
      },
    });
  }

  function bucketLabel(date, bucket) {
    if (bucket === 'hour') return date.toLocaleTimeString('en-PH', { hour: 'numeric', timeZone: TZ });
    if (bucket === 'month') return date.toLocaleDateString('en-PH', { month: 'short', timeZone: TZ });
    return date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: TZ });
  }

  function paintDiseaseChart(diseases) {
    const rows = diseases.filter((d) => !d.is_healthy);
    const total = rows.reduce((s, d) => s + Number(d.scans), 0);

    if (!total) {
      destroyChart('ch-disease');
      return emptyCanvas('ch-disease', 'No disease detected in this period.');
    }

    readyCanvas('ch-disease');

    renderChart('ch-disease', {
      type: 'doughnut',
      data: {
        labels: rows.map((d) => d.label),
        datasets: [{
          data: rows.map((d) => Number(d.scans)),
          backgroundColor: CHART.palette,
          borderWidth: 0,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 8, padding: 10, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${ctx.parsed} scans (${Math.round((ctx.parsed / total) * 100)}%)`,
            },
          },
        },
      },
    });
  }

  function paintBarangayChart(barangays) {
    const rows = barangays.filter((b) => Number(b.affected) > 0).slice(0, 8).reverse();

    if (!rows.length) {
      destroyChart('ch-barangay');
      return emptyCanvas('ch-barangay', 'No suspected cases in this period.');
    }

    readyCanvas('ch-barangay');

    renderChart('ch-barangay', {
      type: 'bar',
      data: {
        labels: rows.map((b) => b.barangay),
        datasets: [{
          label: 'Suspected',
          data: rows.map((b) => Number(b.affected)),
          backgroundColor: rows.map((b) => {
            const rate = b.scans ? b.affected / b.scans : 0;
            return rate >= 0.6 ? CHART.red : rate >= 0.35 ? CHART.amber : CHART.green;
          }),
          borderRadius: 5,
          maxBarThickness: 22,
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
              label: (ctx) => {
                const b = rows[ctx.dataIndex];
                const rate = b.scans ? Math.round((b.affected / b.scans) * 100) : 0;
                return ` ${b.affected} of ${b.scans} scans (${rate}%)`;
              },
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

  function emptyCanvas(id, message) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const box = canvas.parentElement;
    canvas.style.display = 'none';
    if (!box.querySelector('.chart-empty')) {
      const div = document.createElement('div');
      div.className = 'empty-state chart-empty';
      div.innerHTML = `<p class="empty-state__hint">${esc(message)}</p>`;
      box.appendChild(div);
    }
  }

  async function paintFeed() {
    const host = document.getElementById('recent-feed');
    host.innerHTML = '<div class="skeleton-stack"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';

    const range = currentRange();
    try {
      const { rows } = await Store.pagedScans({ from: range.from, to: range.to, limit: 8, offset: 0 });
      if (!rows.length) {
        host.innerHTML = `<p class="empty-state__hint" style="padding:1rem 0">No scans in this period.</p>`;
        return;
      }

      host.innerHTML = rows.map((r) => {
        const healthy = /healthy/i.test(r.top_label || '');
        return `<div class="feed__item">
          <span class="feed__dot ${healthy ? '' : 'feed__dot--warn'}"></span>
          <span class="feed__body">
            <span class="feed__title">${esc(r.top_label || 'No result')} · ${esc(cropName(r.crop_code))}</span>
            <span class="feed__meta">${esc((r.profiles && r.profiles.full_name) || 'Farmer')} · ${esc((r.barangays && r.barangays.name) || '—')}</span>
          </span>
          <span class="feed__time">${esc(relativeTime(r.created_at))}</span>
        </div>`;
      }).join('');
    } catch (err) {
      host.innerHTML = `<p class="empty-state__hint" style="padding:1rem 0">Could not load activity.</p>`;
    }
  }

  const cropName = (c) => (c === 'tomato' ? 'Tomato' : c === 'palay' ? 'Palay' : '—');

  function setSampleBadge(on) {
    const badge = document.getElementById('staff-sample-badge');
    if (!badge) return;
    badge.hidden = !on;
    badge.textContent = on ? DEMO_DATA.badge : '';
  }

  /* ============================================================ barangays */

  async function loadBarangays() {
    const range = currentRange();

    try {
      const [realRows, realMatrix] = await Promise.all([
        Store.barangayBreakdown(range.from, range.to),
        Store.barangayDiseaseMatrix(range.from, range.to, 8),
      ]);

      const useDemo = Demo.on() && realRows.length === 0;
      setSampleBadge(useDemo);

      const rows = useDemo ? Demo.barangays(range) : realRows;
      const matrix = useDemo ? Demo.barangayDisease(range) : realMatrix;

      paintStack(matrix);

      const tbody = document.querySelector('#tbl-barangay tbody');
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
          <p class="empty-state__title">No scans in this period</p>
          <p class="empty-state__hint">Widen the date range, or wait for farmers to scan.</p>
        </div></td></tr>`;
        return;
      }

      tbody.innerHTML = rows.map((r) => {
        const rate = r.scans ? r.affected / r.scans : 0;
        const signal = rate >= 0.6 ? ['bad', 'High'] : rate >= 0.35 ? ['warn', 'Watch'] : ['ok', 'Low'];
        return `<tr>
          <td class="strong">${esc(r.barangay)}</td>
          <td class="num">${fmtInt(r.scans)}</td>
          <td class="num">${fmtInt(r.affected)}</td>
          <td class="num">${Math.round(rate * 100)}%</td>
          <td class="num">${fmtInt(r.farmers)}</td>
          <td><span class="badge badge--${signal[0]}">${signal[1]}</span></td>
        </tr>`;
      }).join('');
    } catch (err) {
      toast(`Could not load barangay data: ${err.message || 'unknown error'}`, 'error');
    }
  }

  function paintStack(matrix) {
    if (!matrix.length) {
      destroyChart('ch-stack');
      return emptyCanvas('ch-stack', 'No data to plot.');
    }

    readyCanvas('ch-stack');

    const barangays = [...new Set(matrix.map((r) => r.barangay))];
    const diseases = [...new Set(matrix.map((r) => r.disease))];

    renderChart('ch-stack', {
      type: 'bar',
      data: {
        labels: barangays,
        datasets: diseases.map((d, i) => ({
          label: d,
          backgroundColor: CHART.palette[i % CHART.palette.length],
          borderRadius: 3,
          data: barangays.map((b) => {
            const hit = matrix.find((r) => r.barangay === b && r.disease === d);
            return hit ? Number(hit.scans) : 0;
          }),
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 8, padding: 10, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}`,
              footer: (items) => {
                const total = items.reduce((s, i) => s + i.parsed.y, 0);
                return `Total: ${total} scans`;
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { color: CHART.tick, font: { size: 10 }, maxRotation: 40 } },
          y: { stacked: true, ...axis(), beginAtZero: true, ticks: { color: CHART.tick, precision: 0, maxTicksLimit: 5 } },
        },
      },
    });
  }

  /* ============================================================ scans */

  async function loadScans() {
    const range = currentRange();
    const tbody = document.querySelector('#tbl-scans tbody');
    const wrap = document.getElementById('scan-table-wrap');
    const gallery = document.getElementById('scan-gallery');

    wrap.hidden = state.scanLayout !== 'table';
    gallery.hidden = state.scanLayout !== 'gallery';

    try {
      const { rows, count } = await Store.pagedScans({
        from: range.from,
        to: range.to,
        limit: state.scanPageSize,
        offset: state.scanPage * state.scanPageSize,
        crop: state.scanCrop || undefined,
        status: state.scanStatus || undefined,
        barangayId: state.scanBarangay || undefined,
      });

      const filtered = state.scanSearch
        ? rows.filter((r) => ((r.profiles && r.profiles.full_name) || '').toLowerCase().includes(state.scanSearch.toLowerCase()))
        : rows;

      document.getElementById('scan-count').textContent = count
        ? `${fmtInt(count)} record${count === 1 ? '' : 's'}${state.scanSearch ? ' (name filter applies to this page only)' : ''}`
        : 'No records';

      const pages = Math.max(1, Math.ceil(count / state.scanPageSize));
      document.getElementById('scan-page').textContent = `${state.scanPage + 1} / ${pages}`;
      document.getElementById('scan-prev').disabled = state.scanPage === 0;
      document.getElementById('scan-next').disabled = state.scanPage >= pages - 1;

      if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
          <p class="empty-state__title">No scan records</p>
          <p class="empty-state__hint">Nothing matches these filters in the selected period.</p>
        </div></td></tr>`;
        gallery.innerHTML = `<div class="empty-state"><p class="empty-state__hint">No records to display.</p></div>`;
        return;
      }

      tbody.innerHTML = filtered.map(scanTableRow).join('');
      tbody.querySelectorAll('[data-detail]').forEach((b) => {
        b.addEventListener('click', () => openScanDetail(b.dataset.detail));
      });

      await paintGallery(filtered, gallery);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
        <p class="empty-state__title">Could not load records</p>
        <p class="empty-state__hint">${esc(err.message || 'Unknown error')}</p>
      </div></td></tr>`;
    }
  }

  function scanTableRow(r) {
    const healthy = /healthy/i.test(r.top_label || '');
    const statusBadge = r.status === 'rejected'
      ? '<span class="badge badge--muted">Rejected</span>'
      : r.status === 'confirmed'
        ? '<span class="badge badge--ok">Confirmed</span>'
        : '<span class="badge badge--info">Analysed</span>';

    return `<tr>
      <td class="muted">${esc(fmtDateTime(r.created_at))}</td>
      <td class="strong">${esc((r.profiles && r.profiles.full_name) || '—')}</td>
      <td>${esc((r.barangays && r.barangays.name) || '—')}</td>
      <td>${esc(cropName(r.crop_code))}</td>
      <td>${r.top_label
        ? `<span class="badge ${healthy ? 'badge--ok' : 'badge--warn'}">${esc(r.top_label)}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="num">${r.top_confidence != null ? Math.round(r.top_confidence * 100) + '%' : '—'}</td>
      <td>${statusBadge}</td>
      <td><button class="link" type="button" data-detail="${esc(r.id)}">View</button></td>
    </tr>`;
  }

  async function paintGallery(rows, host) {
    const withImage = rows.filter((r) => r.image_path);
    if (!withImage.length) {
      host.innerHTML = `<div class="empty-state"><p class="empty-state__hint">No images on this page.</p></div>`;
      return;
    }

    const urls = await Store.signedUrls(withImage.map((r) => r.image_path), 1800);

    host.innerHTML = withImage.map((r) => `
      <figure data-detail="${esc(r.id)}">
        ${urls[r.image_path]
          ? `<img src="${esc(urls[r.image_path])}" alt="Crop scan" loading="lazy">`
          : '<div style="aspect-ratio:1;background:var(--surface-2)"></div>'}
        <figcaption>
          <b>${esc(r.top_label || 'No result')}</b>
          ${esc((r.profiles && r.profiles.full_name) || '—')} · ${esc((r.barangays && r.barangays.name) || '—')}<br>
          ${esc(fmtDate(r.created_at))}
        </figcaption>
      </figure>`).join('');

    host.querySelectorAll('[data-detail]').forEach((f) => {
      f.addEventListener('click', () => openScanDetail(f.dataset.detail));
    });
  }

  async function openScanDetail(id) {
    const body = document.createElement('div');
    body.innerHTML = '<div class="skeleton-stack"><div class="skeleton skeleton--lg"></div><div class="skeleton"></div></div>';
    openModal({ title: 'Scan record', body, wide: true });

    try {
      const { data: scan, error } = await db
        .from('scans')
        .select('id, crop_code, status, top_label, top_confidence, confidence_band, normalized, created_at, image_path, model_id, model_version, inference_mode, image_quality, validation, lat, lng, location_source, profiles(full_name), barangays(name)')
        .eq('id', id)
        .single();
      if (error) throw error;

      const preds = await Store.scanPredictions([id]);
      const rows = preds[id] || [];
      const url = scan.image_path ? await Store.signedUrl(scan.image_path, 1800) : null;
      const q = scan.image_quality && scan.image_quality.metrics ? scan.image_quality.metrics : null;
      const gate = scan.validation && scan.validation.gate ? scan.validation.gate : null;

      body.innerHTML = `
        <div class="detail-grid">
          <div>
            ${url ? `<img src="${esc(url)}" alt="Scanned leaf" class="detail-grid__image">` : '<div class="detail-grid__placeholder"></div>'}
          </div>
          <div>
            <p class="kpi__label">Leading prediction</p>
            <p style="font-size:1.1rem;font-weight:750;color:var(--green-900);margin:.1rem 0 .35rem">${esc(scan.top_label || 'No result')}</p>
            <p style="font-size:.8rem;color:var(--ink-3);margin-bottom:.7rem">
              ${esc(cropName(scan.crop_code))} · ${esc(fmtDateTime(scan.created_at))}
            </p>
            <table class="table" style="font-size:.78rem">
              <tbody>
                <tr><td class="muted">Farmer</td><td class="strong">${esc((scan.profiles && scan.profiles.full_name) || '—')}</td></tr>
                <tr><td class="muted">Barangay</td><td>${esc((scan.barangays && scan.barangays.name) || '—')}</td></tr>
                <tr><td class="muted">Confidence</td><td>${scan.top_confidence != null ? Math.round(scan.top_confidence * 100) + '%' : '—'} ${scan.confidence_band ? `<span class="badge badge--muted">${esc(scan.confidence_band)}</span>` : ''}</td></tr>
                <tr><td class="muted">Status</td><td>${esc(scan.status)}</td></tr>
                <tr><td class="muted">Model</td><td>${esc(scan.model_id || '—')}</td></tr>
                <tr><td class="muted">Mode</td><td>${esc(scan.inference_mode || '—')}</td></tr>
                <tr><td class="muted">Location</td><td>${esc(scan.location_source || '—')}${scan.lat != null ? ` · ${scan.lat.toFixed(3)}, ${scan.lng.toFixed(3)}` : ''}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        ${rows.length ? `
          <p class="kpi__label" style="margin:1rem 0 .4rem">All classes</p>
          <div style="display:grid;gap:.4rem">
            ${rows.map((r) => `
              <div>
                <div style="display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:.15rem">
                  <span>${esc(r.label)}</span><span style="color:var(--ink-3)">${r.normalized_pct != null ? Math.round(r.normalized_pct) + '%' : '—'}</span>
                </div>
                <div style="height:6px;border-radius:4px;background:var(--surface-2);overflow:hidden">
                  <span style="display:block;height:100%;background:var(--green-600);width:${r.normalized_pct || 0}%"></span>
                </div>
              </div>`).join('')}
          </div>` : ''}

        ${q ? `<p class="kpi__label" style="margin:1rem 0 .4rem">Image measurements</p>
          <p style="font-size:.78rem;color:var(--ink-3)">
            Mean luminance ${q.mean}, clipping ${(q.brightRatio * 100).toFixed(1)}%,
            focus variance ${q.laplacianVar}, edge density ${q.edgeDensity}
          </p>` : ''}

        ${gate ? `<p style="font-size:.76rem;color:var(--ink-4);margin-top:.7rem">
          Crop validation: ${esc(gate.provenance || '—')} · score ${gate.score} · threshold ${gate.threshold}
        </p>` : ''}
      `;
    } catch (err) {
      body.innerHTML = `<p class="modal__text">Could not load this record: ${esc(err.message || 'unknown error')}</p>`;
    }
  }

  /* ============================================================ farmers */

  async function loadFarmers() {
    const tbody = document.querySelector('#tbl-farmers tbody');
    tbody.innerHTML = '<tr><td colspan="6"><div class="skeleton-stack"><div class="skeleton"></div><div class="skeleton"></div></div></td></tr>';

    try {
      const search = document.getElementById('farmer-search').value.trim();
      const range = currentRange();

      const [{ rows, count }, stats] = await Promise.all([
        Store.listProfiles({ role: 'farmer', search: search || undefined, limit: 100 }),
        Store.farmerStats(range.from, range.to),
      ]);

      const byFarmer = Object.fromEntries(stats.map((s) => [s.user_id, s]));
      document.getElementById('farmer-count').textContent = `${fmtInt(count)} farmer${count === 1 ? '' : 's'} in scope`;

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
          <p class="empty-state__title">No farmers found</p>
          <p class="empty-state__hint">${search ? 'Nothing matches that name.' : 'No farmer accounts in your jurisdiction yet.'}</p>
        </div></td></tr>`;
        return;
      }

      const brgyMap = Object.fromEntries(state.barangays.map((b) => [b.id, b.name]));

      tbody.innerHTML = rows.map((p) => {
        const s = byFarmer[p.id];
        return `<tr>
          <td class="strong">${esc(p.full_name || '—')}</td>
          <td>${esc(brgyMap[p.barangay_id] || '—')}</td>
          <td class="num">${s ? fmtInt(s.scans) : '0'}</td>
          <td class="muted">${s && s.last_scan ? esc(relativeTime(s.last_scan)) : 'No scans in range'}</td>
          <td>${p.consent_training ? '<span class="badge badge--ok">Opted in</span>' : '<span class="badge badge--muted">Not opted in</span>'}</td>
          <td class="muted">${esc(fmtDate(p.created_at))}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
        <p class="empty-state__title">Could not load farmers</p>
        <p class="empty-state__hint">${esc(err.message || 'Unknown error')}</p>
      </div></td></tr>`;
    }
  }

  /* ============================================================ accounts */

  async function loadAccounts() {
    if (state.role !== 'admin') return;

    try {
      const counts = await Store.accountCounts();
      state.accounts = counts;
      const caps = APP.accountCaps;
      document.getElementById('cap-text').textContent =
        `${counts.farmers} of ${caps.farmer} farmer accounts used · ` +
        `${counts.admins} of ${caps.admin} admin accounts used · ` +
        `${counts.officers} of ${caps.da} DA Officer accounts used. ` +
        'Limits are enforced in the database, not in this screen.';

      const { rows } = await Store.listProfiles({ limit: 200 });
      const staff = rows.filter((p) => p.role !== 'farmer');
      const jurMap = Object.fromEntries(state.jurisdictions.map((j) => [j.id, j.name]));
      const tbody = document.querySelector('#tbl-staff tbody');

      if (!staff.length) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><p class="empty-state__hint">No staff accounts yet.</p></div></td></tr>';
        return;
      }

      tbody.innerHTML = staff.map((p) => `
        <tr>
          <td class="strong">${esc(p.full_name || '—')}</td>
          <td><span class="badge ${p.role === 'admin' ? 'badge--info' : 'badge--muted'}">${p.role === 'admin' ? 'Admin' : 'DA Officer'}</span></td>
          <td>${esc(jurMap[p.jurisdiction_id] || '—')}</td>
          <td>${p.is_active ? '<span class="badge badge--ok">Active</span>' : '<span class="badge badge--bad">Disabled</span>'}</td>
          <td style="white-space:nowrap">
            <button class="link" type="button" data-role="${esc(p.id)}">Role</button>
            <button class="link" type="button" data-active="${esc(p.id)}" data-current="${p.is_active}">${p.is_active ? 'Disable' : 'Enable'}</button>
          </td>
        </tr>`).join('');

      tbody.querySelectorAll('[data-role]').forEach((b) => {
        b.addEventListener('click', () => openRoleDialog(b.dataset.role));
      });
      tbody.querySelectorAll('[data-active]').forEach((b) => {
        b.addEventListener('click', () => toggleActive(b.dataset.active, b.dataset.current === 'true'));
      });
    } catch (err) {
      toast(`Could not load accounts: ${err.message || 'unknown error'}`, 'error');
    }
  }

  function openRoleDialog(profileId) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="form" style="padding:0">
        <label>Role
          <select id="dlg-role">
            <option value="farmer">Farmer</option>
            <option value="da">DA Officer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>Jurisdiction (required for DA Officer)
          <select id="dlg-jur">
            <option value="">—</option>
            ${state.jurisdictions.map((j) => `<option value="${j.id}">${esc(j.name)}</option>`).join('')}
          </select>
        </label>
        <p style="font-size:.75rem;color:var(--ink-4)">
          The database rejects a change that would exceed 6 admins or 5 DA Officers, and an
          administrator cannot change their own role.
        </p>
      </div>`;

    openModal({
      title: 'Change role',
      body: wrap,
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: closeModal },
        {
          label: 'Apply',
          variant: 'primary',
          onClick: async (overlay) => {
            const role = document.getElementById('dlg-role').value;
            const jur = document.getElementById('dlg-jur').value || null;
            try {
              await Store.setRole(profileId, role, jur);
              closeModal();
              toast('Role updated.', 'success');
              loadAccounts();
            } catch (err) {
              toast(err.message || 'Could not update the role.', 'error');
            }
          },
        },
      ],
    });
  }

  async function toggleActive(profileId, currentlyActive) {
    const ok = await confirmDialog(
      currentlyActive ? 'Disable this account?' : 'Enable this account?',
      currentlyActive
        ? 'The person will be signed out and cannot sign back in until re-enabled.'
        : 'The person will be able to sign in again.',
      currentlyActive ? 'Disable' : 'Enable',
    );
    if (!ok) return;

    try {
      await Store.setActive(profileId, !currentlyActive);
      toast(currentlyActive ? 'Account disabled.' : 'Account enabled.', 'success');
      loadAccounts();
    } catch (err) {
      toast(err.message || 'Could not update the account.', 'error');
    }
  }

  async function createInvite(e) {
    e.preventDefault();
    const role = document.getElementById('invite-role').value;
    const jur = document.getElementById('invite-jurisdiction').value || null;
    const days = Number(document.getElementById('invite-days').value);

    if (role === 'da' && !jur) {
      toast('Pick a jurisdiction for a DA Officer invite.', 'error');
      return;
    }

    try {
      const code = await Store.createInvite(role, jur, days);
      const box = document.getElementById('invite-result');
      box.hidden = false;
      box.innerHTML = `
        <small>${role === 'admin' ? 'Admin' : 'DA Officer'} invite, valid ${days} days. This is the only time it is shown.</small>
        <code>${esc(code)}</code>
        <small>Send it to the person directly. They enter it on the sign-up page under “Staff”.</small>`;
      toast('Invite created.', 'success');
      loadAccounts();
    } catch (err) {
      toast(err.message || 'Could not create the invite.', 'error');
    }
  }

  /* ============================================================ training data */

  let trainingRows = [];

  /**
   * The only ground truth in the system. A farmer marks a diagnosis right or
   * wrong; wrong ones carry the true class and become a retraining candidate.
   *
   * Nothing here retrains anything. Roboflow retraining is a manual trigger and
   * Teachable Machine has no API at all — what this view produces is the
   * labelled dataset both tools accept.
   */
  async function loadTraining() {
    if (state.role !== 'admin') return;

    const tbody = document.querySelector('#tbl-training tbody');
    const summary = document.getElementById('train-summary');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p class="empty-state__hint">Loading…</p></div></td></tr>';

    try {
      const rows = await Store.feedback(300);
      trainingRows = rows.filter((r) => r.scans);

      const wrong = trainingRows.filter((r) => r.verdict === 'wrong').length;
      const right = trainingRows.filter((r) => r.verdict === 'correct').length;
      const total = trainingRows.length;

      summary.textContent = total
        ? `${total} verdict${total === 1 ? '' : 's'} · ${right} correct · ${wrong} wrong · ` +
          `${Math.round((wrong / total) * 100)}% error rate`
        : 'No feedback yet. Farmers see the prompt after they save a scan.';

      if (!total) {
        tbody.innerHTML =
          '<tr><td colspan="6"><div class="empty-state"><p class="empty-state__title">Nothing to review yet</p>' +
          '<p class="empty-state__hint">Save a scan as a farmer and answer the "Was this reading right?" prompt.</p></div></td></tr>';
        return;
      }

      let names = {};
      try {
        const { rows: people } = await Store.listProfiles({ limit: 200 });
        names = Object.fromEntries(people.map((p) => [p.id, p.full_name]));
      } catch (e) {
        /* the farmer column degrades to a dash; the verdicts still render */
      }

      tbody.innerHTML = trainingRows
        .map((r) => {
          const s = r.scans;
          const badge =
            r.verdict === 'wrong'
              ? '<span class="badge badge--bad">Wrong</span>'
              : r.verdict === 'correct'
                ? '<span class="badge badge--ok">Correct</span>'
                : '<span class="badge badge--muted">Unsure</span>';
          return `<tr>
            <td class="muted">${esc(fmtDate(r.created_at))}</td>
            <td class="strong">${esc(names[s.user_id] || '—')}</td>
            <td>${esc(cropName(s.crop_code))}</td>
            <td>${esc(s.top_label || '—')}</td>
            <td>${badge}</td>
            <td>${esc(r.corrected_code || '—')}</td>
          </tr>`;
        })
        .join('');
    } catch (err) {
      tbody.innerHTML =
        '<tr><td colspan="6"><div class="empty-state"><p class="empty-state__title">Could not load feedback</p>' +
        `<p class="empty-state__hint">${esc(err.message || 'Unknown error')}</p></div></td></tr>`;
    }
  }

  const wrongRows = () =>
    trainingRows.filter((r) => r.verdict === 'wrong' && r.scans && r.scans.image_path);

  function exportTrainingCsv() {
    const rows = wrongRows();
    if (!rows.length) {
      toast('No wrong verdicts to export yet.', 'warn');
      return;
    }

    const header = 'scan_id,crop,predicted,corrected,image_path,created_at';
    const body = rows.map((r) =>
      [
        r.scan_id,
        r.scans.crop_code,
        r.scans.top_label || '',
        r.corrected_code || '',
        r.scans.image_path || '',
        r.created_at,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );

    downloadBlob(
      new Blob([[header, ...body].join('\n')], { type: 'text/csv;charset=utf-8' }),
      `agrisuri-labels-${today()}.csv`,
    );
  }

  /**
   * Builds the folder layout both trainers expect:
   *   <label>/<scan_id>.jpg  +  labels.csv
   * Roboflow accepts a zip of class folders; Teachable Machine accepts the same
   * structure through its uploader. That is why this beats a pile of links.
   */
  async function exportTrainingZip() {
    const rows = wrongRows();
    if (!rows.length) {
      toast('No wrong verdicts to export yet.', 'warn');
      return;
    }

    const btn = document.getElementById('btn-export-zip');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building…';

    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const root = zip.folder('agrisuri-dataset');
      const lines = ['image,label,crop,predicted,scan_id,created_at'];

      const urls = await Store.signedUrls(rows.map((r) => r.scans.image_path));
      const byPath = Object.fromEntries((urls || []).map((u) => [u.path, u.signedUrl]));

      let added = 0;
      for (const r of rows) {
        const url = byPath[r.scans.image_path];
        if (!url) continue;

        const res = await fetch(url);
        if (!res.ok) continue;

        const label2 = r.corrected_code || 'unlabeled';
        const file = `${label2}/${r.scan_id}.jpg`;
        root.file(file, await res.arrayBuffer());
        lines.push(
          [file, label2, r.scans.crop_code, r.scans.top_label || '', r.scan_id, r.created_at]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(','),
        );
        added++;
      }

      if (!added) {
        toast('The images could not be fetched. Try again.', 'error');
        return;
      }

      root.file('labels.csv', lines.join('\n'));
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `agrisuri-dataset-${today()}.zip`);
      toast(`${added} image${added === 1 ? '' : 's'} exported.`, 'success');
    } catch (err) {
      toast(err.message || 'Could not build the dataset.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** ~100 KB, admin-only, so it is loaded on demand rather than shipped. */
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('Could not load the zip library.'));
      document.head.appendChild(s);
    });
  }

  /* ============================================================ audit */

  async function loadAudit() {
    if (state.role !== 'admin') return;
    const tbody = document.querySelector('#tbl-audit tbody');
    tbody.innerHTML = '<tr><td colspan="5"><div class="skeleton-stack"><div class="skeleton"></div><div class="skeleton"></div></div></td></tr>';

    try {
      const rows = await Store.auditEvents(100);
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><p class="empty-state__hint">No events recorded yet.</p></div></td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((r) => `
        <tr>
          <td class="muted">${esc(fmtDateTime(r.created_at))}</td>
          <td class="strong">${esc((r.profiles && r.profiles.full_name) || 'System')}</td>
          <td>${esc(r.actor_role || '—')}</td>
          <td>${esc(r.action)}</td>
          <td class="muted">${esc(r.target_type || '—')}${r.target_id ? ` · ${esc(String(r.target_id).slice(0, 8))}` : ''}</td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">
        <p class="empty-state__title">Could not load the audit log</p>
        <p class="empty-state__hint">${esc(err.message || 'Unknown error')}</p>
      </div></td></tr>`;
    }
  }

  return { boot };
})();

document.addEventListener('DOMContentLoaded', () => Staff.boot());
