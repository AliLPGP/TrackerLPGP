// ─── THEME (data-theme system) — dark is the default brand experience ─────────
(function applyStoredTheme() {
  const saved = localStorage.getItem('emptracker-theme');
  if (saved !== 'light') {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => _updateThemeBtn('dark'));
  }
})();
let currentUser = null;
let employees = [];
let allEmployeesData = [];
let currentAdjRecord = null;

const SHIFT_MINS = 480;
const ALLOWED_BREAK = 40;
const MONTHS = ['','January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function currencySymbol(c) { return c === 'AED' ? 'AED ' : c === 'PHP' ? '₱' : '£'; }

/**
 * How an event's date reads, honestly. A confirmed day prints as a day; a
 * month with the day still to be confirmed prints as the month; no date at
 * all prints as the programme year with "date TBC". The 1st of the month is
 * how a TBC month is stored, never how it is shown.
 *   opts.long  -> "25 Feb 2027" / "Sep 2027 · day TBC" / "2027 · date TBC"
 *   default    -> "Feb 27" / "Sep 27 · TBC" / "2027 TBC"
 */
const EVENT_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtEventDate(ev, opts = {}) {
  const tbc  = ev.date_tbc || '';
  const year = ev.programme_year || (ev.event_date ? String(ev.event_date).slice(0, 4) : '');
  // "date TBC" means the stored date, if any, is a placeholder: show the year only.
  if (!ev.event_date || tbc === 'date') {
    return year ? `${year}${opts.long ? ' \u00b7 date TBC' : ' TBC'}` : (opts.long ? 'Date TBC' : 'TBC');
  }
  const m = String(ev.event_date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return opts.long ? 'Date TBC' : 'TBC';
  const y = m[1], mon = EVENT_MONTHS_SHORT[parseInt(m[2], 10) - 1] || '', day = parseInt(m[3], 10);
  if (tbc === 'day') return opts.long ? `${mon} ${y} \u00b7 day TBC` : `${mon} ${y.slice(2)} \u00b7 TBC`;
  return opts.long ? `${day} ${mon} ${y}` : `${mon} ${y.slice(2)}`;
}

// Salary FX. One table, used by both the overview band and the summary table
// below it, so the two can never quote different rates for the same money.
const SAL_FX = { GBP: 1, AED: 1 / 4.67, PHP: 0.0138 };
const salFxToGBP = (v, c) => v * (SAL_FX[c] || 1);

/**
 * What a person should have been paid by now, in their own currency.
 *
 * Salaries land monthly, so this counts whole months rather than days -- on
 * the 21st of September, September's payment is due, and someone who has had
 * it is not "behind" just because the month has nine days left. The window is
 * the person's own: a mid-year starter is measured from their start month, so
 * they are never shown as behind for months they did not work.
 */
function salaryExpectedByNow(row, year, now) {
  const effective = (parseFloat(row.net_remaining) || 0) + (parseFloat(row.total_paid) || 0);
  if (effective <= 0) return 0;
  const y = parseInt(year, 10);
  const curY = now.getFullYear();
  if (y < curY) return effective;   // the year is over; all of it fell due
  if (y > curY) return 0;           // hasn't started

  const inYear = (d) => d && String(d).slice(0, 4) === String(y);
  const startM = inYear(row.start_date)       ? parseInt(String(row.start_date).slice(5, 7), 10) : 1;
  const endM   = inYear(row.termination_date) ? parseInt(String(row.termination_date).slice(5, 7), 10) : 12;
  const span   = Math.max(1, endM - startM + 1);
  const due    = Math.min(span, Math.max(0, (now.getMonth() + 1) - startM + 1));
  return effective * (due / span);
}
function fmtMoney(amount, currency) { return currencySymbol(currency) + Number(amount || 0).toLocaleString('en-GB', {minimumFractionDigits:2}); }
function fmt(n) { return Number(n||0).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2}); }

// ─── THEME ───────────────────────────────────────────────────────────────────
(function applyStoredTheme() {
  const saved = localStorage.getItem('emptracker-theme');
  if (saved !== 'light') {
    document.documentElement.setAttribute('data-theme', 'dark');
    // update button once DOM is ready
    document.addEventListener('DOMContentLoaded', () => _updateThemeBtn('dark'));
  }
})();

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  if (next === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('emptracker-theme', next);
  _updateThemeBtn(next);
}

function _updateThemeBtn(theme) {
  const icon  = document.getElementById('themeToggleIcon');
  const label = document.getElementById('themeToggleLabel');
  if (!icon || !label) return;
  if (theme === 'dark') {
    icon.textContent  = '☀️';
    label.textContent = 'Light Mode';
  } else {
    icon.textContent  = '🌙';
    label.textContent = 'Dark Mode';
  }
}

// ─── SIDEBAR COLLAPSE ─────────────────────────────────────────────────────────
function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0');
}
(function applySidebarState() {
  if (localStorage.getItem('sidebar-collapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
  }
})();

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/me');
  if (!res.ok) { window.location.href = '/login.html'; return; }
  currentUser = await res.json();
  window.currentUser = currentUser;

  // Check user role before initializing
  if (currentUser.role === 'employee') {
    await initEmployeePortal(currentUser);
    return;
  }
  const initials = currentUser.username.slice(0,2).toUpperCase();
  document.getElementById('userLabel').innerHTML = `<div class="sidebar-user-pill"><div class="sidebar-user-avatar">${esc(initials)}</div><span class="sidebar-user-name">${esc(currentUser.username)}</span><span class="sidebar-user-role">${esc(currentUser.role)}</span></div>`;
  document.getElementById('todayDate').textContent = formatDate(today());

  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }
  if (currentUser.role === 'admin' || currentUser.role === 'manager' || currentUser.role === 'accounts') {
    document.querySelectorAll('.admin-manager-only').forEach(el => el.classList.remove('hidden'));
  }

  const m = thisMonth();
  document.getElementById('repFrom').value = m.from;
  document.getElementById('repTo').value = m.to;
  document.getElementById('trackMonth').value = m.from.slice(0, 7);

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => { navigate(el.dataset.page); closeMobileNav(); });
  });

  // Mobile bottom nav
  document.querySelectorAll('.bottom-nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  // Hamburger / drawer
  document.getElementById('hamburgerBtn')?.addEventListener('click', toggleMobileNav);
  document.getElementById('navOverlay')?.addEventListener('click', closeMobileNav);
  initSidebarCollapse();

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  await loadEmployees().catch(err => console.error('loadEmployees failed:', err));
  loadDashboard();
  refreshCalendarBadge();

  // Deep-link / PWA shortcut support: /?page=salary opens that page directly
  try {
    const startPage = new URLSearchParams(window.location.search).get('page');
    const validPages = ['dashboard','tracking','salary','employees','reports','calendar','admins','hotels','expenses','subscriptions','portfolio','deals','eventkit'];
    if (startPage && validPages.includes(startPage)) {
      navigate(startPage);
      // tidy the URL so a manual refresh doesn't re-trigger
      window.history.replaceState({}, '', '/');
    }
  } catch (e) { /* no-op */ }

  // Notification bell — admin only
  if (currentUser.role === 'admin') {
    document.getElementById('notifBellWrap').style.display = 'block';
    refreshNotifBadge();
    setInterval(refreshNotifBadge, 60000);
  }

  // Initial badge — silent, non-blocking
  fetch(`/api/salary-overview?year=${new Date().getFullYear()}`)
    .then(r => r.ok ? r.json() : [])
    .then(data => {
      const now = new Date();
      updateSalaryBadge(getUnpaidThisMonth(data, now.getFullYear(), now.getMonth() + 1).length);
    }).catch(() => {});
});

function toggleMobileNav() {
  const open = document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('hamburgerBtn').classList.toggle('open', open);
  document.getElementById('navOverlay').classList.toggle('open', open);
}
function closeMobileNav() {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('hamburgerBtn').classList.remove('open');
  document.getElementById('navOverlay').classList.remove('open');
}

// ─── SIDEBAR COLLAPSE ─────────────────────────────────────────────────────────
function initSidebarCollapse() {
  const sidebar = document.querySelector('.sidebar');
  const btn = document.getElementById('sidebarCollapseBtn');
  if (!sidebar || !btn) return;
  const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
  if (collapsed) sidebar.classList.add('collapsed');
  btn.addEventListener('click', () => {
    const isNowCollapsed = sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', isNowCollapsed ? '1' : '0');
  });
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────
function navigate(page) {
  // Salary and Employees sections are admin-only
  if ((page === 'salary' || page === 'employees') && currentUser?.role !== 'admin') return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.bottom-nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelector(`.bottom-nav-item[data-page="${page}"]`)?.classList.add('active');
  const titles = { dashboard:'Dashboard', tracking:'Daily Tracking', salary:'Salary Tracker', employees:'Employees', reports:'Reports', calendar:'Calendar', admins:'Admin Users', hotels:'Hotel Expenses', expenses:'Expenses', subscriptions:'Subscriptions', portfolio:'Portfolio', deals:'Deal Tracker', eventkit:'Event Kit' };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  if (page === 'employees') loadEmpTable();
  if (page === 'admins') loadAdmins();
  if (page === 'calendar') loadCalendar();
  if (page === 'salary') { loadSalaryPage(); }
  if (page === 'hotels') loadHotelExpenses();
  if (page === 'expenses') loadExpenses();
  if (page === 'subscriptions') loadSubscriptions();
  if (page === 'portfolio') { loadPortfolio(); }
  if (page === 'deals') { loadDeals(); }
  if (page === 'eventkit') loadEventKitPage();
}

// ─── EMPLOYEES ───────────────────────────────────────────────────────────────
async function loadEmployees() {
  const res = await fetch('/api/employees');
  const raw = await res.json();
  employees = Array.isArray(raw) ? raw : [];
  ['trackEmp', 'repEmp', 'calEmpFilter', 'salaryEmpFilter'].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    if (id === 'trackEmp') sel.innerHTML = '<option value="">-- Select Employee --</option>';
    else sel.innerHTML = '<option value="">All Employees</option>';
    employees.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id; opt.textContent = e.name; sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  });
}

// Employees page filters: department chip, type and status switches, search.
const _empFilter = { dept: '', type: '', status: 'active' };

async function loadEmpTable() {
  const res = await fetch('/api/employees/all');
  allEmployeesData = await res.json();
  const active = allEmployeesData.filter(e => e.active);
  const payroll = active.filter(e => e.employment_type === 'payroll').length;
  const sub = document.getElementById('empSub');
  if (sub) sub.innerHTML = `<strong>${active.length}</strong> active · ${payroll} payroll · ${active.length - payroll} self-employed` +
    (allEmployeesData.length > active.length ? ` · ${allEmployeesData.length - active.length} left` : '');
  renderEmpTable();
}

function setEmpFilter(key, value) {
  _empFilter[key] = value;
  renderEmpTable();
}

function filterEmpTable() {
  renderEmpTable();
}

function renderEmpTable() {
  const search = (document.getElementById('empSearch')?.value || '').trim().toLowerCase();
  const byStatus = e => !_empFilter.status || (_empFilter.status === 'active' ? e.active : !e.active);
  const byType = e => !_empFilter.type || e.employment_type === _empFilter.type;
  const bySearch = e => !search || [e.name, e.job_title, e.department, e.email].some(v => (v || '').toLowerCase().includes(search));
  const base = (allEmployeesData || []).filter(e => byStatus(e) && byType(e) && bySearch(e));

  // Department chips count what the other filters leave.
  const counts = {};
  base.forEach(e => { const d = e.department || 'No department'; counts[d] = (counts[d] || 0) + 1; });
  if (_empFilter.dept && !counts[_empFilter.dept]) _empFilter.dept = '';
  const chips = document.getElementById('empDeptChips');
  if (chips) chips.innerHTML = [['', 'All departments', base.length], ...Object.keys(counts).sort().map(d => [d, d, counts[d]])]
    .map(([v, label, n]) => `<button type="button" class="emp-chip${_empFilter.dept === v ? ' active' : ''}" data-dept="${esc(v)}" onclick="setEmpFilter('dept', this.dataset.dept)">${esc(label)}<span>${n}</span></button>`).join('');
  document.querySelectorAll('#empTypeSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === _empFilter.type));
  document.querySelectorAll('#empStatusSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === _empFilter.status));

  const list = base.filter(e => !_empFilter.dept || (e.department || 'No department') === _empFilter.dept)
    .sort((a, b) => (a.department || '~').localeCompare(b.department || '~') || a.name.localeCompare(b.name));
  const tbody = document.getElementById('empTable');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="emp-empty">${search || _empFilter.dept || _empFilter.type ? 'Nobody matches these filters.' : 'No employees yet.'}</div></td></tr>`;
    return;
  }
  const isAdmin = currentUser && currentUser.role === 'admin';
  let lastDept = null;
  tbody.innerHTML = list.map(emp => {
    const dept = emp.department || 'No department';
    const groupRow = !_empFilter.dept && dept !== lastDept
      ? `<tr class="emp-group"><td colspan="7">${esc(dept)}<span>${counts[dept] || ''}</span></td></tr>` : '';
    lastDept = dept;
    const status = emp.active
      ? '<span class="emp-dot emp-dot--on"></span>Active'
      : `<span class="emp-dot"></span>${emp.termination_date ? 'Left ' + fmtDateShort(emp.termination_date) : 'Inactive'}`;
    return groupRow + `<tr class="emp-row${emp.active ? '' : ' is-left'}" onclick="openEmployeeProfile(${emp.id})">
      <td>
        <div class="emp-name-cell">
          <span class="emp-avatar">${esc(empInitials(emp.name))}</span>
          <span><span class="emp-name">${esc(emp.name)}</span><small>${esc(emp.job_title || emp.email || '')}</small></span>
        </div>
      </td>
      <td>${esc(emp.department || '—')}</td>
      <td>${emp.employment_type === 'self_employed' ? 'Self-employed' : 'Payroll'}${emp.currency && emp.currency !== 'GBP' ? ` <span class="es-cur">${esc(emp.currency)}</span>` : ''}</td>
      <td class="dt-r">${isAdmin && emp.annual_salary > 0 ? fmtMoney(emp.annual_salary, emp.currency).replace(/\.00$/, '') : '—'}</td>
      <td>${emp.start_date ? fmtDateShort(emp.start_date) : '—'}</td>
      <td class="emp-status">${status}</td>
      <td class="emp-act"><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();epEdit(${emp.id})">Edit</button></td>
    </tr>`;
  }).join('');
}

function openEmpModal(emp = null) {
  document.getElementById('empId').value = emp ? emp.id : '';
  document.getElementById('empName').value = emp ? emp.name : '';
  document.getElementById('empStartDate').value = emp ? (emp.start_date || '') : today();
  document.getElementById('empType').value = emp ? (emp.employment_type || 'payroll') : 'payroll';
  document.getElementById('empCurrency').value = emp ? (emp.currency || 'GBP') : 'GBP';
  document.getElementById('empAnnualSalary').value = emp ? emp.annual_salary : 0;
  document.getElementById('empPensionRate').value = emp && emp.pension_rate != null ? emp.pension_rate : '';
  document.getElementById('empJobTitle').value = emp ? (emp.job_title || '') : '';
  document.getElementById('empDepartment').value = emp ? (emp.department || '') : '';
  document.getElementById('empPhone').value = emp ? (emp.phone || '') : '';
  document.getElementById('empEmail').value = emp ? (emp.email || '') : '';
  document.getElementById('empContractEnd').value = emp ? (emp.contract_end_date || '') : '';
  document.getElementById('empSalaryEffective').value = today();
  document.getElementById('empSalaryReason').value = '';
  // Don't prefill a legacy bcrypt-hashed PIN (starts with $2) — would mangle on save
  document.getElementById('empPin').value = (emp && emp.portal_pin && !String(emp.portal_pin).startsWith('$2')) ? emp.portal_pin : '';
  document.getElementById('salaryChangeFields').classList.add('hidden');
  document.getElementById('empModalTitle').textContent = emp ? 'Edit Employee' : 'Add Employee';
  const prWrap = document.getElementById('empPortfolioWrap');
  if (prWrap) {
    const canSee = emp && ['admin', 'manager'].includes(currentUser && currentUser.role);
    prWrap.classList.toggle('hidden', !canSee);
    if (canSee) loadEmpPortfolioRoles(emp.id);
  }

  const togglePensionField = () => {
    const isPayroll = document.getElementById('empType').value === 'payroll';
    document.getElementById('pensionRateField').style.display = isPayroll ? '' : 'none';
  };
  document.getElementById('empType').onchange = togglePensionField;
  togglePensionField();

  // Show raise fields when salary value changes
  const salaryInput = document.getElementById('empAnnualSalary');
  const originalSalary = emp ? parseFloat(emp.annual_salary) : 0;
  salaryInput.oninput = () => {
    const changed = parseFloat(salaryInput.value) !== originalSalary && !!emp;
    document.getElementById('salaryChangeFields').classList.toggle('hidden', !changed);
  };
  openModal('empModal');
}

async function saveEmployee() {
  const id = document.getElementById('empId').value;
  const name = document.getElementById('empName').value.trim();
  const start_date = document.getElementById('empStartDate').value || null;
  const employment_type = document.getElementById('empType').value;
  const currency = document.getElementById('empCurrency').value;
  const annual_salary = parseFloat(document.getElementById('empAnnualSalary').value) || 0;
  const salary_reason = document.getElementById('empSalaryReason').value.trim();
  const salary_effective = document.getElementById('empSalaryEffective').value;
  const pensionRateVal = document.getElementById('empPensionRate').value;
  const pension_rate = employment_type === 'payroll' && pensionRateVal !== '' ? parseFloat(pensionRateVal) : 0;
  const job_title = document.getElementById('empJobTitle').value.trim();
  const department = document.getElementById('empDepartment').value.trim();
  const phone = document.getElementById('empPhone').value.trim();
  const email = document.getElementById('empEmail').value.trim();
  const contract_end_date = document.getElementById('empContractEnd').value || null;
  const portal_pin = document.getElementById('empPin').value.replace(/\D/g,'').slice(0,6) || null;
  if (!name) return showToast('Name is required', 'error');

  const payload = { name, employment_type, annual_salary, currency, start_date, pension_rate,
                    job_title, department, phone, email, contract_end_date, portal_pin };
  if (id) {
    await fetch(`/api/employees/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, active: 1, salary_reason, salary_effective })
    });
  } else {
    await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
  closeModal('empModal');
  await loadEmployees();
  loadEmpTable();
}

function openTerminateModal(id, name) {
  document.getElementById('termEmpId').value = id;
  document.getElementById('termEmpName').textContent = name;
  document.getElementById('termDate').value = today();
  document.getElementById('termReason').value = 'Resigned';
  document.getElementById('termNotes').value = '';
  openModal('terminateModal');
}

async function confirmTerminate() {
  const id     = document.getElementById('termEmpId').value;
  const date   = document.getElementById('termDate').value;
  const reason = document.getElementById('termReason').value;
  const notes  = document.getElementById('termNotes').value.trim();
  if (!date) return showToast('Please select a termination date', 'error');
  const fullReason = notes ? `${reason} — ${notes}` : reason;
  const res = await fetch(`/api/employees/${id}/terminate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termination_date: date, termination_reason: fullReason })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('terminateModal');
  await loadEmployees();
  loadEmpTable();
}

async function openAddPinModal(id, name) {
  const pin = prompt(`Set portal PIN for ${name} (4–6 digits):`);
  if (pin === null) return;
  const cleaned = pin.replace(/\D/g,'').slice(0,6);
  if (cleaned.length < 4) { showToast('PIN must be 4–6 digits', 'error'); return; }
  const res = await fetch(`/api/employees/${id}/portal-pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: cleaned })
  });
  if (!res.ok) { showToast('Failed to set PIN', 'error'); return; }
  showToast(`PIN set for ${name}`, 'success');
  await loadEmployees();
  loadEmpTable();
}

async function reactivateEmployee(id) {
  if (!await showConfirm('Reactivate this employee? This clears the termination date.')) return;
  await fetch(`/api/employees/${id}/reactivate`, { method: 'POST' });
  await loadEmployees();
  loadEmpTable();
}

async function hardDeleteEmployee(id, name) {
  if (!await showConfirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/employees/${id}/hard`, { method: 'DELETE' });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Delete failed', 'error'); return; }
  showToast('Employee deleted', 'success');
  await loadEmployees();
  loadEmpTable();
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
  const year = new Date().getFullYear();
  const now = new Date();
  const month = now.getMonth() + 1;

  document.getElementById('dashStats').innerHTML = `
    <div class="db-kpis">${'<div class="skeleton db-skel"></div>'.repeat(4)}</div>`;

  const [summaryRes, salaryRes, upcomingRes, expiringRes, allEmpRes, hotelRes, dealsRes, evtRevRes, calCurRes, calNextRes] = await Promise.all([
    fetch(`/api/summary?from=${year}-01-01&to=${year}-12-31`),
    fetch(`/api/salary-overview?year=${year}`),
    fetch(`/api/calendar-reminders/upcoming?days=30`),
    fetch(`/api/contracts/expiring?days=60`),
    fetch(`/api/employees/all`),
    fetch(`/api/hotel-expenses`),
    fetch(`/api/deals`),
    fetch(`/api/deals/revenue-by-event`),
    fetch(`/api/calendar?year=${year}&month=${month}`),
    fetch(`/api/calendar?year=${month === 12 ? year + 1 : year}&month=${month === 12 ? 1 : month + 1}`)
  ]);

  const summary       = summaryRes.ok   ? await summaryRes.json()   : [];
  const salaryData    = salaryRes.ok    ? await salaryRes.json()    : [];
  const upcoming      = upcomingRes.ok  ? await upcomingRes.json()  : [];
  const expiring      = expiringRes.ok  ? await expiringRes.json()  : [];
  const allEmps       = allEmpRes.ok    ? await allEmpRes.json()    : [];
  const dashDeals     = dealsRes.ok     ? await dealsRes.json()     : [];
  const hotelData     = hotelRes.ok     ? await hotelRes.json()     : [];
  const evtRevData    = evtRevRes.ok    ? await evtRevRes.json()    : [];
  const calCur        = calCurRes.ok    ? await calCurRes.json()    : [];
  const calNext       = calNextRes.ok   ? await calNextRes.json()   : [];
  const todayStr      = now.toISOString().slice(0,10);
  const upcomingDayOffs = [...(Array.isArray(calCur) ? calCur : []), ...(Array.isArray(calNext) ? calNext : [])]
    .filter(r => r.record_date >= todayStr && parseFloat(r.is_day_off) > 0)
    .sort((a,b) => a.record_date.localeCompare(b.record_date));

  const activeEmps    = allEmps.filter(e => e.active);
  const unpaidCount   = getUnpaidThisMonth(salaryData, year, month).length;
  updateSalaryBadge(unpaidCount);

  const totalHeadcount  = activeEmps.length;
  const payrollCount    = activeEmps.filter(e => e.employment_type === 'payroll').length;
  const seCount         = activeEmps.filter(e => e.employment_type === 'self_employed').length;

  // Total salary remaining to pay this year — all currencies converted to GBP
  const SALARY_FX = { GBP: 1, AED: 1/4.67, PHP: 0.0138 };
  const salToGBP = (v, c) => v * (SALARY_FX[c] || 1);
  const totalGBPRemaining = salaryData
    .filter(e => !e.is_terminated)
    .reduce((a, e) => {
      const r = Math.max(0, parseFloat(e.net_remaining) || 0);
      return a + salToGBP(r, e.currency || 'GBP');
    }, 0);

  renderDashOverview({ year, activeEmps, totalHeadcount, payrollCount, seCount, unpaidCount,
    totalGBPRemaining, deals: dashDeals, evtRevData, hotelData, expiring,
    upcoming, dayOffs: upcomingDayOffs });

  // Activity feed
  renderDashActivity(summary, expiring, hotelData, salaryData);

  const tbody = document.getElementById('dashTable');
  tbody.innerHTML = '';
  const salById = {};
  salaryData.forEach(s => { salById[s.employee_id] = s; });
  const esCounts = { all: 0, se: 0, payroll: 0, intl: 0 };

  summary.forEach(row => {
    const emp = allEmps.find(e => e.id === row.employee_id);
    const sal = salById[row.employee_id] || {};
    const currency = sal.currency || emp?.currency || 'GBP';
    const isIntl   = currency !== 'GBP';
    // Mutually exclusive grouping: international takes precedence, else by employment type
    const group = isIntl ? 'intl' : (row.employment_type === 'self_employed' ? 'se' : 'payroll');
    esCounts.all++; esCounts[group]++;

    const typeLabel = row.employment_type === 'self_employed' ? 'Self-employed' : 'Payroll';
    // Red only when the excess actually costs them — days over the allowance that
    // are all marked "no deduct" are approved leave, not an overrun
    const daysColor = (parseFloat(row.excess_day_deduction) || 0) > 0 ? 'text-danger fw-bold' : '';
    const exemptTip = (parseFloat(row.exempt_days) || 0) > 0
      ? ` title="${row.exempt_days} day(s) marked 'no deduct' — logged but never charged"` : '';
    const typeCell  = `<span class="es-type">${typeLabel}</span>` +
      (isIntl ? ` <span class="es-cur">${esc(currency)}</span>` : '');

    // Annual salary left to pay (net of deductions) + % paid bar
    const annual    = parseFloat(sal.annual_salary != null ? sal.annual_salary : row.annual_salary) || 0;
    const remaining = sal.net_remaining != null ? parseFloat(sal.net_remaining) : null;
    const pctPaid   = sal.pct_paid != null ? Math.min(100, Math.round(parseFloat(sal.pct_paid))) : null;
    let annualCell;
    if (annual <= 0 || remaining === null) {
      annualCell = '<span style="color:var(--muted)">—</span>';
    } else if (remaining <= 0) {
      annualCell = `<div class="es-left es-left--done">${remaining < 0 ? 'Overpaid' : 'Fully paid'}</div>
        <div class="es-prog"><div class="es-prog-fill" style="width:100%"></div></div>`;
    } else {
      annualCell = `<div class="es-left">${fmtMoney(remaining, currency)}</div>
        <div class="es-prog"><div class="es-prog-fill" style="width:${pctPaid || 0}%"></div></div>
        <div class="es-prog-lbl">${pctPaid != null ? pctPaid : 0}% paid</div>`;
    }

    // Last payment recorded (most recent by year+month)
    const pays = Array.isArray(sal.payments) ? sal.payments : [];
    let lastCell = '<span style="color:var(--muted)">—</span>';
    if (pays.length) {
      const last = pays.reduce((a, b) => {
        const aKey = (Number(a.payment_year) || 0) * 100 + (Number(a.payment_month) || 0);
        const bKey = (Number(b.payment_year) || 0) * 100 + (Number(b.payment_month) || 0);
        return bKey > aKey ? b : a;
      }, pays[0]);
      const m = MONTHS[Number(last.payment_month)] || '';
      const yr = last.payment_year ? ` ${last.payment_year}` : '';
      lastCell = `<div class="es-last-pay">
        <span class="es-last-pay-amt">${fmtMoney(last.amount, currency)}</span>
        <span class="es-last-pay-date">${m}${yr}</span>
      </div>`;
    }

    const tr = document.createElement('tr');
    tr.dataset.group = group;
    tr.dataset.name = `${row.name || ''} ${emp?.department || ''} ${emp?.job_title || ''}`.toLowerCase();
    tr.innerHTML = `
      <td>
        <div style="font-weight:600">${empLink(row.employee_id, row.name)}</div>
        ${emp?.job_title ? `<div style="font-size:0.73rem;color:var(--muted)">${esc(emp.job_title)}</div>` : ''}
      </td>
      <td>${emp?.department ? `<span style="font-size:0.82rem;font-weight:600">${esc(emp.department)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${typeCell}</td>
      <td class="${daysColor}"${exemptTip}>${row.year_days_off} / ${row.allowance_days}${(parseFloat(row.exempt_days)||0) > 0 ? ` <span class="badge badge-green" style="font-size:0.62rem">${row.exempt_days} free</span>` : ''}</td>
      <td class="${row.total_deduction > 0 ? 'text-danger fw-bold' : ''}">${row.total_deduction > 0 ? fmtMoney(row.total_deduction, currency) : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${annualCell}</td>
      <td>${lastCell}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="goToTracking(${row.employee_id})">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  // Update tab counts and re-apply the active filter
  document.querySelectorAll('#esTabs .es-tab-count').forEach(el => {
    el.textContent = esCounts[el.dataset.count] || 0;
  });
  filterEmpSummary(window._esFilter || 'all');
  } catch(e) {
    console.error('loadDashboard error:', e);
    const el = document.getElementById('dashStats');
    if (el) el.innerHTML = `<div style="padding:20px;color:var(--negative);font-family:var(--font-mono);font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">Dashboard error: ${e.message}</div>`;
  }
}

// Tab filter for the dashboard Employee Summary table (all / se / payroll / intl)
function filterEmpSummary(tab, btn) {
  if (tab) window._esFilter = tab;
  applyEmpSummaryFilters();
}

function searchEmpSummary() {
  applyEmpSummaryFilters();
}

function applyEmpSummaryFilters() {
  const tab = window._esFilter || 'all';
  const q = (document.getElementById('esSearch')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#esTabs .es-tab').forEach(t =>
    t.classList.toggle('es-tab--active', t.dataset.tab === tab));
  let visible = 0;
  document.querySelectorAll('#dashTable tr').forEach(r => {
    const matchTab = tab === 'all' || r.dataset.group === tab;
    const matchSearch = !q || (r.dataset.name || '').includes(q);
    const show = matchTab && matchSearch;
    r.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const empty = document.getElementById('dashTableEmpty');
  if (empty) {
    empty.style.display = visible === 0 ? '' : 'none';
    empty.textContent = q ? 'No employees match your search.' : 'No employees in this group.';
  }
}

// ─── DASHBOARD OVERVIEW ─────────────────────────────────────────────────────
// Four headline figures, then a chart and a few short lists. Each card answers
// one question and links to the page that holds the detail.

// What a deal has brought in, net of the VAT on what was paid.
function dashDealMoney(d) {
  const amount = parseFloat(d.amount) || 0;
  const paid   = parseFloat(d.paid_inc_vat) || 0;
  const vat    = paid > 0 ? (parseFloat(d.tax_vat) || 0) : 0;
  const paidEx = Math.max(0, paid - vat);
  return { amount, paid, paidEx, out: Math.max(0, amount - paidEx) };
}

function dashDealStatus(d) {
  const { amount, paid } = dashDealMoney(d);
  if (paid <= 0) return 'unpaid';
  return paid >= amount ? 'paid' : 'partial';
}

// Round a chart maximum up to 1, 2, 2.5 or 5 × a power of ten.
function dashNiceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const step = [1, 2, 2.5, 5, 10].find(s => s * p >= v);
  return step * p;
}

// £1.2k / £150k / £2.5M: a short amount for axes and headline figures.
function dashMoneyShort(v) {
  if (v >= 1_000_000) return '£' + +(v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1000) return '£' + +(v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return '£' + Math.round(v).toLocaleString('en-GB');
}

function dashCard(title, link, body, extra) {
  const linkHtml = link ? `<button type="button" class="db-card-link" onclick="navigate('${link.page}')">${link.label}</button>` : '';
  return `<section class="db-card ${extra || ''}">
    <header class="db-card-hd"><h3>${title}</h3>${linkHtml}</header>
    ${body}
  </section>`;
}

function dashEmpty(text) {
  return `<div class="db-empty">${text}</div>`;
}

function renderDashOverview(o) {
  const el = document.getElementById('dashStats');
  if (!el) return;
  const now = new Date();
  const monthName = MONTHS[now.getMonth() + 1];
  const deals = Array.isArray(o.deals) ? o.deals : [];

  // ── Headline figures
  const totals = deals.reduce((t, d) => {
    const m = dashDealMoney(d);
    t.amount += m.amount; t.paid += m.paid; t.paidEx += m.paidEx; t.out += m.out;
    return t;
  }, { amount: 0, paid: 0, paidEx: 0, out: 0 });
  const pctCollected = totals.amount > 0 ? Math.round(totals.paidEx / totals.amount * 100) : 0;
  const pounds = v => '£' + Math.round(v).toLocaleString('en-GB');

  const kpi = (label, value, sub, page, tone) => `
    <button type="button" class="db-kpi" onclick="navigate('${page}')">
      <span class="db-kpi-label">${label}</span>
      <span class="db-kpi-value">${value}</span>
      <span class="db-kpi-sub ${tone || ''}">${sub}</span>
    </button>`;

  const kpis = `<div class="db-kpis">
    ${kpi('Active staff', o.totalHeadcount, `${o.payrollCount} payroll · ${o.seCount} self-employed`, 'employees')}
    ${kpi(`Unpaid for ${monthName}`, o.unpaidCount,
          o.unpaidCount > 0 ? `${o.unpaidCount === 1 ? '1 person' : o.unpaidCount + ' people'} still to pay` : 'Everyone is paid',
          'salary', o.unpaidCount > 0 ? 'is-alert' : 'is-good')}
    ${kpi(`Salary left in ${o.year}`, pounds(o.totalGBPRemaining), 'All currencies, in GBP', 'salary')}
    ${kpi('Deals to collect', pounds(totals.out), `of ${pounds(totals.amount)} · ${pctCollected}% collected`, 'deals')}
  </div>`;

  // ── Deals signed, by month (last 12 months)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: dt.getMonth() + 1, year: dt.getFullYear(), total: 0, count: 0 });
  }
  deals.forEach(d => {
    const p = parseDealMonth(d.deal_month);
    if (!p) return;
    const slot = months.find(m => m.month === p.month && m.year === p.year);
    if (slot) { slot.total += parseFloat(d.amount) || 0; slot.count++; }
  });
  const maxVal = dashNiceMax(Math.max(...months.map(m => m.total)));
  const thisMonth = months[months.length - 1];
  const ticks = [maxVal, maxVal / 2, 0];
  const chartBody = months.some(m => m.total > 0) ? `
    <div class="db-chart" role="img" aria-label="Deal value signed per month, last 12 months">
      <div class="db-chart-grid">${ticks.map(t => `<div class="db-chart-line"><span>${dashMoneyShort(t)}</span></div>`).join('')}</div>
      <div class="db-chart-bars">
        ${months.map(m => {
          const label = `${DEAL_MONTHS[m.month - 1]} ${String(m.year).slice(2)}`;
          const h = m.total > 0 ? Math.max(1.5, m.total / maxVal * 100) : 0;
          return `<div class="db-bar-col" tabindex="0">
            <div class="db-bar" style="height:${h}%"></div>
            <div class="db-bar-tip"><span>${label}</span><strong>£${fmt(m.total)}</strong><span>${m.count} deal${m.count === 1 ? '' : 's'}</span></div>
            <div class="db-bar-x">${DEAL_MONTHS[m.month - 1]}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : dashEmpty('No deals signed in the last 12 months.');
  const chartCard = dashCard('Deals signed', null,
    `<div class="db-card-meta">This month: £${fmt(thisMonth.total)}</div>${chartBody}`, 'db-span-2');

  // ── Collections: how many deals are paid, part paid, not paid
  const counts = { paid: 0, partial: 0, unpaid: 0 };
  deals.forEach(d => { counts[dashDealStatus(d)]++; });
  const maxCount = Math.max(1, counts.paid, counts.partial, counts.unpaid);
  const hbar = (label, n, shade) => `<div class="db-hbar">
      <span class="db-hbar-label">${label}</span>
      <span class="db-hbar-track"><span class="db-hbar-fill" style="width:${n / maxCount * 100}%;opacity:${shade}"></span></span>
      <span class="db-hbar-n">${n}</span>
    </div>`;
  const collectCard = dashCard('Collections', { page: 'deals', label: 'View all' }, deals.length ? `
    <div class="db-hbars">
      ${hbar('Paid in full', counts.paid, 1)}
      ${hbar('Part paid', counts.partial, 0.65)}
      ${hbar('Not paid yet', counts.unpaid, 0.35)}
    </div>
    <div class="db-foot-figures">
      <div><span>Received</span><strong>£${fmtK(totals.paid)}</strong><small>inc VAT</small></div>
      <div><span>Outstanding</span><strong>£${fmtK(totals.out)}</strong><small>ex VAT</small></div>
    </div>` : dashEmpty('No deals yet.'));

  // ── Team by department: donut + legend
  const depts = {};
  o.activeEmps.forEach(e => { const d = e.department || 'Unassigned'; depts[d] = (depts[d] || 0) + 1; });
  let deptRows = Object.entries(depts).sort((a, b) => b[1] - a[1]);
  if (deptRows.length > 7) {
    const other = deptRows.slice(6).reduce((s, r) => s + r[1], 0);
    deptRows = deptRows.slice(0, 6).concat([['Other', other]]);
  }
  // A department keeps its colour whatever its rank: colours go by name.
  const byName = deptRows.map(r => r[0]).filter(n => n !== 'Other').sort();
  const deptColour = name => name === 'Other' ? 'var(--dim)' : `var(--chart-${byName.indexOf(name) + 1})`;
  const R = 15.915, totalStaff = o.activeEmps.length || 1;
  let offset = 25;
  const arcs = deptRows.map(([name, n]) => {
    const len = n / totalStaff * 100;
    const gap = deptRows.length > 1 ? Math.min(1.2, len / 3) : 0;
    const arc = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="${deptColour(name)}" stroke-width="5"
      stroke-dasharray="${Math.max(0, len - gap)} ${100 - Math.max(0, len - gap)}" stroke-dashoffset="${offset}"><title>${esc(name)}: ${n}</title></circle>`;
    offset -= len;
    return arc;
  }).join('');
  const teamCard = dashCard('Team by department', { page: 'employees', label: 'Employees' }, deptRows.length ? `
    <div class="db-donut-wrap">
      <div class="db-donut">
        <svg viewBox="0 0 42 42" aria-hidden="true">${arcs}</svg>
        <div class="db-donut-c"><strong>${o.activeEmps.length}</strong><span>people</span></div>
      </div>
      <ul class="db-legend">
        ${deptRows.map(([name, n]) => `<li><i style="background:${deptColour(name)}"></i><span>${esc(name)}</span><b>${n}</b></li>`).join('')}
      </ul>
    </div>` : dashEmpty('No active staff.'));

  // ── Events by revenue
  const evRows = (o.evtRevData || []).filter(ev => Number(ev.deal_count) > 0).map(ev => {
    const amt = parseFloat(ev.total_amount) || 0;
    const paidEx = Math.max(0, (parseFloat(ev.total_paid) || 0) - (parseFloat(ev.total_vat_collected) || 0));
    return { ev, amt, paidEx, pct: amt > 0 ? Math.min(100, Math.round(paidEx / amt * 100)) : 0 };
  }).sort((a, b) => b.amt - a.amt);
  const eventsCard = dashCard('Revenue by event', { page: 'portfolio', label: 'Portfolio' }, evRows.length ? `
    <ul class="db-list">
      ${evRows.slice(0, 5).map(r => `<li class="db-ev">
        <div class="db-ev-top"><span class="db-list-name">${esc(r.ev.event_name)}</span><span class="db-list-amt">£${fmtK(r.amt)}</span></div>
        <div class="db-ev-bar"><span style="width:${r.pct}%"></span></div>
        <div class="db-ev-sub">${(r.ev.event_date || r.ev.programme_year) ? fmtEventDate(r.ev) + ' · ' : ''}${r.pct}% collected</div>
      </li>`).join('')}
    </ul>` : dashEmpty('No deals linked to events yet.'));

  // ── Deals still to collect
  const owing = deals.map(d => ({ d, m: dashDealMoney(d), status: dashDealStatus(d) }))
    .filter(x => x.m.out > 0.5).sort((a, b) => b.m.out - a.m.out);
  const owingCard = dashCard('Still to collect', { page: 'deals', label: 'Deal Tracker' }, owing.length ? `
    <ul class="db-list">
      ${owing.slice(0, 5).map(x => `<li class="db-row">
        <span class="db-list-name">${esc(x.d.company || x.d.title || 'Deal')}</span>
        <span class="db-list-amt">£${fmt(x.m.out)}</span>
        <span class="db-tag ${x.status === 'partial' ? 'is-warn' : ''}">${x.status === 'partial' ? 'Part paid' : 'Unpaid'}</span>
      </li>`).join('')}
    </ul>` : dashEmpty('Every deal is paid.'));

  // ── Hotels still to pay, and contracts ending
  const hotelsOpen = (o.hotelData || []).filter(h => h.status !== 'paid');
  const hotelsCard = dashCard('Hotels to pay', { page: 'hotels', label: 'Hotel Expenses' }, hotelsOpen.length ? `
    <ul class="db-list">
      ${hotelsOpen.slice(0, 5).map(h => `<li class="db-row">
        <span class="db-list-name">${esc(h.event_name || '')}<small>${esc(h.hotel || '')}</small></span>
        <span class="db-tag ${h.status === 'partial' ? 'is-warn' : ''}">${h.status === 'partial' ? 'Part paid' : 'Pending'}</span>
      </li>`).join('')}
    </ul>` : dashEmpty('All hotel bills are settled.'));

  const today = now.toISOString().slice(0, 10);
  const expiring = Array.isArray(o.expiring) ? o.expiring : [];
  const contractsCard = expiring.length ? dashCard('Contracts ending', { page: 'employees', label: 'Employees' }, `
    <ul class="db-list">
      ${expiring.slice(0, 5).map(e => {
        const expired = e.contract_end_date < today;
        return `<li class="db-row">
          <span class="db-list-name">${empLink(e.id, e.name)}${(e.job_title || e.department) ? `<small>${esc(e.job_title || e.department)}</small>` : ''}</span>
          <span class="db-tag ${expired ? 'is-alert' : 'is-warn'}">${expired ? 'Expired' : 'Ends ' + fmtDateShort(e.contract_end_date)}</span>
        </li>`;
      }).join('')}
    </ul>`) : '';

  // ── Coming up: reminders and days off in the next 30 days
  const soon = [
    ...(o.upcoming || []).map(r => ({ date: String(r.virtual_date || '').slice(0, 10), name: r.title || '', note: r.category || 'Reminder' })),
    ...(o.dayOffs || []).map(r => ({ date: r.record_date || '', name: r.employee_name || 'Employee', empId: r.employee_id,
      note: parseFloat(r.is_day_off) === 0.5 ? 'Half day off' : 'Day off' })),
  ].filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
  const soonCard = dashCard('Coming up', { page: 'calendar', label: 'Calendar' }, soon.length ? `
    <ul class="db-list">
      ${soon.slice(0, 5).map(x => {
        const d = new Date(x.date + 'T00:00:00');
        return `<li class="db-row">
          <span class="db-date"><b>${d.getDate()}</b>${DEAL_MONTHS[d.getMonth()]}</span>
          <span class="db-list-name">${x.empId ? empLink(x.empId, x.name) : esc(x.name)}<small>${esc(x.note)}</small></span>
        </li>`;
      }).join('')}
    </ul>` : dashEmpty('Nothing in the next 30 days.'));

  el.innerHTML = `${kpis}
    <div class="db-grid db-grid-3">${chartCard}${collectCard}</div>
    <div class="db-grid db-grid-3">${teamCard}${eventsCard}${owingCard}</div>
    <div class="db-grid ${contractsCard ? 'db-grid-3' : 'db-grid-2'}">${hotelsCard}${soonCard}${contractsCard}</div>`;
}

function fmtDateShort(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderDashActivity(summary, expiring, hotelData, salaryData) {
  const el = document.getElementById('activityPanel');
  if (!el) return;

  const items = [];
  const ICONS = {
    pay:     '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    breach:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    hotel:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    expiry:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    deduct:  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  };

  // Salary payments from salaryData
  salaryData.filter(e => !e.is_terminated && (e.payments||[]).length).slice(0,2).forEach(e => {
    const last = e.payments[e.payments.length - 1];
    const sym = e.currency === 'AED' ? 'AED ' : '£';
    items.push({ icon: ICONS.pay, tone: 'pos', title: 'Logged payment', detail: sym + parseFloat(last.amount||0).toLocaleString('en-GB') + ' &rarr; ' + esc(e.name) });
  });

  // Allowance breaches — only when it actually costs money. Days over the
  // allowance that are all marked "no deduct" are approved leave, not a breach.
  summary.filter(r => (parseFloat(r.excess_day_deduction)||0) > 0).slice(0,2).forEach(r => {
    items.push({ icon: ICONS.breach, tone: 'neg', title: 'Allowance breach', detail: esc(r.name) + ' &middot; ' + r.year_days_off + '/' + r.allowance_days + ' days &middot; &pound;' + parseFloat(r.excess_day_deduction||0).toFixed(2) + ' deduct' });
  });

  // Contract expiring
  expiring.slice(0,2).forEach(e => {
    const days = Math.floor((new Date(e.contract_end_date) - new Date()) / 86400000);
    items.push({ icon: ICONS.expiry, tone: 'warn', title: 'Contract expiring', detail: esc(e.name) + ' &middot; ' + e.contract_end_date + ' &middot; ' + Math.abs(days) + 'd' });
  });

  // Hotel events
  hotelData.filter(h => h.status !== 'paid').slice(0,2).forEach(h => {
    const sym = hotelCurrencySymbol(h.currency || h.paid_currency || 'USD');
    const amtStr = h.paid_amount ? sym + parseFloat(h.paid_amount).toLocaleString('en-GB') + ' &middot; ' : '';
    items.push({ icon: ICONS.hotel, tone: 'info', title: 'Hotel expense', detail: esc(h.event_name) + ' &middot; ' + amtStr + h.status });
  });

  if (!items.length) { el.innerHTML = ''; return; }

  const TONE_COLOR = { pos:'var(--positive)', neg:'var(--negative)', warn:'var(--warning)', info:'var(--info)' };
  const rows = items.slice(0,5).map(it =>
    '<div style="display:flex;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);align-items:flex-start">' +
      '<div style="width:28px;height:28px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border);display:grid;place-items:center;flex-shrink:0;color:' + TONE_COLOR[it.tone] + '">' + it.icon + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font:600 12.5px/1.3 var(--font-sans);color:var(--text)">' + it.title + '</div>' +
        '<div style="font:400 11px/1.4 var(--font-mono);color:var(--muted);margin-top:3px">' + it.detail + '</div>' +
      '</div>' +
    '</div>'
  ).join('');

  el.innerHTML = '<div class="card" style="margin-bottom:0">' +
    '<div class="card-header" style="padding:12px 16px">' +
      '<span class="card-title" style="display:flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Activity</span>' +
      '<span style="font-size:0.72rem;color:var(--muted);font-family:var(--font-mono)">last 24h</span>' +
    '</div>' +
    '<div style="padding:0">' + rows + '</div>' +
  '</div>';
}

function goToTracking(empId) {
  navigate('tracking');
  document.getElementById('trackEmp').value = empId;
  loadEmployeeRecords();
}

// Open the Employees page and pop the clicked employee's record
// Clicking an employee's name anywhere opens their profile.
function goToEmployee(empId) {
  openEmployeeProfile(empId);
}

// A name that opens the employee's profile. Plain text when there is no id.
function empLink(id, name, cls = '') {
  if (!id) return esc(name || '');
  return `<button type="button" class="emp-link ${cls}" onclick="event.stopPropagation();openEmployeeProfile(${Number(id)})">${esc(name || '')}</button>`;
}

// ─── EMPLOYEE PROFILE (slide-in panel) ───────────────────────────────────────
// Everything about one person in one place: who they are, how to reach them,
// this year's pay and days off, their portfolio roles and events. Opens over
// any page, so a name can link to it wherever it appears.
let _profileEmpId = null;

function empInitials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function ensureProfileDrawer() {
  let el = document.getElementById('empDrawer');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'empDrawer';
  el.className = 'ep-overlay';
  el.innerHTML = '<aside class="ep-panel" role="dialog" aria-modal="true" aria-labelledby="epName"><div id="epBody"></div></aside>';
  el.addEventListener('click', e => { if (e.target === el) closeEmployeeProfile(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open') && !document.querySelector('.modal-overlay.open')) closeEmployeeProfile();
  });
  document.body.appendChild(el);
  return el;
}

function closeEmployeeProfile() {
  document.getElementById('empDrawer')?.classList.remove('open');
  _profileEmpId = null;
}

async function openEmployeeProfile(empId) {
  empId = Number(empId);
  if (!empId) return;
  const drawer = ensureProfileDrawer();
  const body = document.getElementById('epBody');
  _profileEmpId = empId;
  if (!(allEmployeesData || []).some(e => e.id === empId)) {
    try { const r = await fetch('/api/employees/all'); if (r.ok) allEmployeesData = await r.json(); } catch {}
  }
  const emp = (allEmployeesData || []).find(e => e.id === empId);
  if (!emp) { showToast('Employee not found', 'error'); return; }
  const isAdmin = currentUser && currentUser.role === 'admin';
  const canManage = currentUser && ['admin', 'manager'].includes(currentUser.role);
  const year = new Date().getFullYear();
  const typeLabel = emp.employment_type === 'self_employed' ? 'Self-employed' : 'Payroll';
  const status = emp.active
    ? '<span class="ep-status ep-status--on">Active</span>'
    : `<span class="ep-status">${emp.termination_date ? 'Left ' + fmtDateShort(emp.termination_date) : 'Inactive'}</span>`;
  const detail = (label, value) => `<div class="ep-detail"><span>${label}</span><strong>${value || '<em>—</em>'}</strong></div>`;

  body.innerHTML = `
    <header class="ep-head">
      <div class="ep-avatar">${esc(empInitials(emp.name))}</div>
      <div class="ep-who">
        <h2 id="epName">${esc(emp.name)}</h2>
        <p>${esc([emp.job_title, emp.department].filter(Boolean).join(' · ') || 'No role set')}</p>
        <div class="ep-chips">${status}<span class="ep-chip">${typeLabel}</span>${emp.currency && emp.currency !== 'GBP' ? `<span class="ep-chip">${esc(emp.currency)}</span>` : ''}</div>
      </div>
      <button class="modal-close ep-close" onclick="closeEmployeeProfile()" aria-label="Close">✕</button>
    </header>
    ${canManage ? `<div class="ep-actions">
      <button class="btn btn-sm" onclick="epEdit(${emp.id})">Edit details</button>
      ${isAdmin ? `<button class="btn btn-sm" onclick="closeEmployeeProfile();openAddPinModal(${emp.id}, ${esc(JSON.stringify(emp.name))})">${emp.portal_pin ? 'Change PIN' : 'Add portal PIN'}</button>` : ''}
      ${isAdmin ? (emp.active
        ? `<button class="btn btn-sm ep-danger" onclick="closeEmployeeProfile();openTerminateModal(${emp.id}, ${esc(JSON.stringify(emp.name))})">Terminate</button>`
        : `<button class="btn btn-sm" onclick="closeEmployeeProfile();reactivateEmployee(${emp.id})">Reactivate</button>`) : ''}
    </div>` : ''}

    <section class="ep-sec">
      <h3>Details</h3>
      <div class="ep-details">
        ${detail('Email', emp.email ? `<a href="mailto:${esc(emp.email)}">${esc(emp.email)}</a>` : '')}
        ${detail('Phone', emp.phone ? `<a href="tel:${esc(emp.phone)}">${esc(emp.phone)}</a>` : '')}
        ${detail('Started', emp.start_date ? fmtDateShort(emp.start_date) : '')}
        ${detail('Contract ends', emp.contract_end_date ? fmtDateShort(emp.contract_end_date) : (emp.active ? 'Permanent' : ''))}
        ${isAdmin ? detail('Annual salary', emp.annual_salary > 0 ? fmtMoney(emp.annual_salary, emp.currency) : '') : ''}
        ${isAdmin && emp.employment_type === 'payroll' ? detail('Pension', emp.pension_rate ? emp.pension_rate + '%' : 'None') : ''}
      </div>
    </section>

    <section class="ep-sec">
      <h3>${year} so far</h3>
      <div class="ep-tiles" id="epTiles"><div class="ep-loading">Loading…</div></div>
    </section>

    ${isAdmin ? `<section class="ep-sec">
      <h3>Recent payments</h3>
      <div id="epPayments" class="ep-list"><div class="ep-loading">Loading…</div></div>
    </section>` : ''}

    ${canManage ? `<section class="ep-sec">
      <h3>Events</h3>
      <div id="epEvents" class="ep-list"><div class="ep-loading">Loading…</div></div>
    </section>
    <section class="ep-sec">
      <h3>Portfolio roles</h3>
      <div id="epPortfolio" class="epr-list"></div>
    </section>` : ''}`;
  drawer.classList.add('open');

  // Figures that need their own calls; each fills its section when ready.
  const [statsRes, payRes] = await Promise.all([
    fetch(`/api/employees/${empId}/year-stats?year=${year}`).catch(() => null),
    isAdmin ? fetch(`/api/payments/${empId}`).catch(() => null) : null,
  ]);
  if (_profileEmpId !== empId) return;
  const stats = statsRes && statsRes.ok ? await statsRes.json() : null;
  const pays = payRes && payRes.ok ? await payRes.json() : [];
  const paidYear = pays.filter(p => Number(p.payment_year) === year).reduce((a, p) => a + (parseFloat(p.amount) || 0), 0);
  const last = pays[0];
  const tile = (label, value, sub) => `<div class="ep-tile"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
  document.getElementById('epTiles').innerHTML =
    (isAdmin ? tile('Paid', fmtMoney(paidYear, emp.currency), `${pays.filter(p => Number(p.payment_year) === year).length} payments`) : '') +
    (isAdmin ? tile('Last payment', last ? fmtMoney(last.amount, last.currency || emp.currency) : '—', last ? `${MONTHS[Number(last.payment_month)]} ${last.payment_year}` : 'None yet') : '') +
    (stats ? tile('Days off', `${stats.total_days_off} / ${stats.allowance_days}`, stats.excess_days > 0 ? `${stats.excess_days} over allowance` : `${stats.remaining_allowance} left`) : '') +
    (stats && isAdmin ? tile('Day-off deductions', stats.excess_deduction > 0 ? fmtMoney(stats.excess_deduction, emp.currency) : 'None', '') : '');
  const payEl = document.getElementById('epPayments');
  if (payEl) payEl.innerHTML = pays.length
    ? pays.slice(0, 6).map(p => `<div class="ep-row"><span>${MONTHS[Number(p.payment_month)]} ${p.payment_year}${p.notes ? `<small>${esc(p.notes)}</small>` : ''}</span><strong>${fmtMoney(p.amount, p.currency || emp.currency)}</strong></div>`).join('')
    : '<div class="ep-empty">No payments recorded.</div>';
  if (canManage) {
    loadEmpPortfolioRoles(empId, 'epPortfolio');
    loadEmpEvents(empId, 'epEvents');
  }
}

function epEdit(empId) {
  const emp = (allEmployeesData || []).find(e => e.id === empId);
  closeEmployeeProfile();
  if (emp) openEmpModal(emp);
}

// Events this person is on the team for (producer, delegates or sales).
async function loadEmpEvents(empId, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  try {
    const res = await fetch('/api/event-kits');
    const kits = res.ok ? await res.json() : [];
    const roleOf = k => [k.producer_id === empId && 'Producer', k.delegates_id === empId && 'Delegates', k.sales_id === empId && 'Sales'].filter(Boolean);
    const mine = kits.filter(k => roleOf(k).length);
    box.innerHTML = mine.length ? mine.map(k => `<div class="ep-row">
        <span>${esc(k.event_name)}<small>${(k.event_date || k.programme_year) ? esc(fmtEventDate(k, { long: true })) : 'Date TBC'}</small></span>
        <span class="epr-roles">${roleOf(k).join(' · ')}</span>
      </div>`).join('')
      : '<div class="ep-empty">Not on any event team yet. Teams are set in Event Kit.</div>';
  } catch { box.innerHTML = '<div class="ep-empty">Could not load events.</div>'; }
}

// ─── TRACKING ────────────────────────────────────────────────────────────────
async function loadEmployeeRecords() {
  const empId = document.getElementById('trackEmp').value;
  if (!empId) return;

  const month = document.getElementById('trackMonth').value;
  let from = '', to = '';
  if (month) {
    from = month + '-01';
    const d = new Date(month + '-01');
    d.setMonth(d.getMonth() + 1); d.setDate(0);
    to = d.toISOString().slice(0, 10);
  }

  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);

  const [recRes, yearStatsRes] = await Promise.all([
    fetch(`/api/records/${empId}?${params}`),
    fetch(`/api/employees/${empId}/year-stats?year=${(from || today()).slice(0,4)}`)
  ]);
  const records = await recRes.json();
  const yearStats = await yearStatsRes.json();
  const emp = employees.find(e => e.id === parseInt(empId));

  document.getElementById('trackTableTitle').textContent =
    emp ? `${emp.name} – ${month || 'All'}` : 'Records';

  // Days-off allowance banner
  const banner = document.getElementById('daysOffBanner');
  if (emp) {
    const allowance  = yearStats.allowance_days;
    const used       = yearStats.total_days_off;
    const remaining  = yearStats.remaining_allowance;
    const excess     = yearStats.excess_days;
    const dailyRate  = yearStats.daily_rate || emp.daily_rate || 0;
    const deduction  = yearStats.excess_deduction || 0;
    const exemptDays = yearStats.exempt_days || 0;
    const chargedDays = yearStats.charged_days != null ? yearStats.charged_days : excess;
    const waived     = yearStats.waived_deduction || 0;
    const typeLabel  = emp.employment_type === 'self_employed' ? 'Self-Employed' : 'Payroll';
    const exemptNote = exemptDays > 0
      ? `<span style="opacity:0.4">·</span><span style="color:var(--positive)">${exemptDays} day(s) marked <strong>no deduct</strong></span>`
      : '';

    if (excess > 0) {
      // Excess days that are all exempt cost nothing — don't shout about them
      banner.className = deduction > 0 ? 'alert alert-error' : 'alert alert-success';
      const breakdown = yearStats.breakdown || [];
      const breakdownHtml = breakdown.map(b => {
        const exemptPart = b.exempt_days > 0
          ? ` <small style="opacity:0.85;color:var(--positive)">+${b.exempt_days}d no deduct</small>`
          : '';
        return `<span>${MONTHS[b.month]}: ${b.days}d × £${parseFloat(b.rate).toFixed(2)} = <strong>£${b.deduction.toFixed(2)}</strong>${exemptPart}
         <small style="opacity:0.7">(${b.working_days} working days)</small></span>`;
      }).join('<span style="opacity:0.4">·</span>');
      banner.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;width:100%">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
            <span><strong>${typeLabel} — Days Off ${yearStats.year}:</strong>
              ${used} used / ${allowance} allowed &nbsp;·&nbsp;
              <strong>${excess} excess day(s)</strong>
              ${exemptNote}
            </span>
            <span style="font-size:1rem;font-weight:800;color:${deduction > 0 ? 'var(--danger)' : 'var(--positive)'}">
              ${deduction > 0 ? `−£${deduction.toFixed(2)} deduction` : 'No deduction'}
            </span>
          </div>
          <div style="font-size:0.78rem;background:var(--surface-2);border-radius:6px;padding:6px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span>📐</span>
            <span>${used} used − ${allowance} free = <strong>${excess} excess</strong>${chargedDays !== excess ? `, <strong>${chargedDays}</strong> chargeable` : ''}</span>
            ${waived > 0 ? `<span style="opacity:0.4">·</span><span style="color:var(--positive)">£${waived.toFixed(2)} waived on no-deduct days</span>` : ''}
            <span style="opacity:0.4">·</span>
            <span>Rate = annual ÷ 12 ÷ working days in month</span>
            <span style="opacity:0.4">·</span>
            ${breakdownHtml}
          </div>
        </div>`;
    } else {
      banner.className = 'alert alert-success';
      banner.innerHTML = `<strong>${typeLabel} — Days Off ${yearStats.year}:</strong>
        ${used} used / ${allowance} allowed &nbsp;|&nbsp; <strong>${remaining} day(s) remaining</strong>
        ${exemptDays > 0 ? `&nbsp;|&nbsp; <span style="color:var(--positive)">${exemptDays} marked no deduct</span>` : ''}`;
    }
    banner.classList.remove('hidden');
  }

  // Stats bar
  const statsBar = document.getElementById('empStatsBar');
  if (records.length && emp) {
    const refTotal = records.reduce((a, b) => a + (b.ref_amount || 0), 0);
    const fullDays = records.filter(r => r.is_day_off === 1).length;
    const halfDays = records.filter(r => r.is_day_off === 0.5).length;
    statsBar.innerHTML = `
      <div class="stat-card"><div class="stat-label">Break (total)</div><div class="stat-value">${records.filter(r=>!r.is_day_off).reduce((a,b)=>a+b.break_minutes,0)}m</div></div>
      <div class="stat-card yellow"><div class="stat-label">Phone Time</div><div class="stat-value">${records.reduce((a,b)=>a+b.phone_minutes,0)}m</div></div>
      <div class="stat-card yellow"><div class="stat-label">Wasted Time</div><div class="stat-value">${records.reduce((a,b)=>a+b.wasted_minutes,0)}m</div></div>
      <div class="stat-card yellow"><div class="stat-label">Late Arrivals</div><div class="stat-value">${records.reduce((a,b)=>a+b.late_minutes,0)}m</div></div>
      <div class="stat-card red"><div class="stat-label">Full Days Off</div><div class="stat-value">${fullDays}</div></div>
      <div class="stat-card red"><div class="stat-label">Half Days Off</div><div class="stat-value">${halfDays}</div></div>
      <div class="stat-card blue"><div class="stat-label">Ref. Potential (not deducted)</div><div class="stat-value" style="font-size:1.3rem">£${refTotal.toFixed(2)}</div></div>
    `;
    statsBar.classList.remove('hidden');
  } else {
    statsBar.classList.add('hidden');
  }

  // Records table
  const tbody = document.getElementById('trackTable');
  const empty = document.getElementById('trackEmpty');
  tbody.innerHTML = '';
  if (!records.length) { empty.classList.remove('hidden'); }
  else {
    empty.classList.add('hidden');
    records.forEach(r => {
      const tr = document.createElement('tr');
      if (r.is_day_off > 0) tr.classList.add('day-off-row');
      const excessBreak = Math.max(0, r.break_minutes - ALLOWED_BREAK);
      const adjSign = r.manual_adj_minutes > 0 ? '+' : '';
      const dayOffLabel = r.is_day_off === 1 ? '<span class="badge badge-red">Full Day</span>'
                        : r.is_day_off === 0.5 ? '<span class="badge badge-yellow">Half Day</span>'
                        : '—';
      const noDeductBadge = r.is_day_off > 0 && r.no_deduction
        ? ' <span class="badge badge-green" title="Logged as a day off, but never deducted from salary">No deduct</span>'
        : '';
      tr.innerHTML = `
        <td><strong>${r.record_date}</strong></td>
        <td>${r.break_minutes}m ${excessBreak > 0 ? `<span class="badge badge-red">+${excessBreak}m</span>` : '<span class="badge badge-green">OK</span>'}</td>
        <td>${r.phone_minutes > 0 ? `<span class="badge badge-yellow">${r.phone_minutes}m</span>` : '—'}</td>
        <td>${r.wasted_minutes > 0 ? `<span class="badge badge-yellow">${r.wasted_minutes}m</span>` : '—'}</td>
        <td>${r.late_minutes > 0 ? `<span class="badge badge-red">${r.late_minutes}m</span>` : '—'}</td>
        <td>${dayOffLabel}${noDeductBadge}</td>
        <td>
          ${r.manual_adj_minutes !== 0 ? `<span class="badge ${r.manual_adj_minutes > 0 ? 'badge-red' : 'badge-green'}">${adjSign}${r.manual_adj_minutes}m</span>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openAdjModal(${r.employee_id},'${r.record_date}')">Adj</button>
        </td>
        <td style="color:var(--muted)">${r.ref_minutes || 0}m</td>
        <td style="color:var(--primary);font-size:0.8rem" title="Reference only — not deducted from salary">£${(r.ref_amount||0).toFixed(2)} <span style="opacity:0.5;font-size:0.68rem">ref</span></td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.notes||'')}">${esc(r.notes||'')||'—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="openEditRecord(${r.id},${r.employee_id},'${r.record_date}',${r.break_minutes},${r.phone_minutes},${r.wasted_minutes},${r.late_minutes},${r.is_day_off},\`${esc(r.notes||'')}\`,${!!r.no_deduction})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteRecord(${r.id})">Del</button>
        </td>`;
      tbody.appendChild(tr);
    });
  }

  // Payments section kept hidden — salary management is in the Salary page
  document.getElementById('paymentsSection')?.classList.add('hidden');
}

// ─── RECORD MODAL ────────────────────────────────────────────────────────────
function openRecordModal() {
  const empId = document.getElementById('trackEmp').value;
  if (!empId) return showToast('Please select an employee first', 'info');
  document.getElementById('recId').value = '';
  document.getElementById('recEmpId').value = empId;
  document.getElementById('recEmpRow').classList.add('hidden');
  document.getElementById('recDate').value = today();
  document.getElementById('recBreak').value = 40;
  document.getElementById('recPhone').value = 0;
  document.getElementById('recWasted').value = 0;
  document.getElementById('recLate').value = 0;
  document.getElementById('recDayOff').value = '0';
  document.getElementById('recNoDeduction').checked = false;
  document.getElementById('recNotes').value = '';
  document.getElementById('recFields').style.display = '';
  document.getElementById('recNoDeductRow').style.display = 'none';
  document.getElementById('recordModalTitle').textContent = 'Add Daily Record';
  document.getElementById('recPreview').classList.add('hidden');
  updatePreview();
  openModal('recordModal');
}

function openEditRecord(id, empId, date, brk, phone, wasted, late, dayOff, notes, noDeduction) {
  document.getElementById('recId').value = id;
  document.getElementById('recEmpId').value = empId;
  document.getElementById('recEmpRow').classList.add('hidden');
  document.getElementById('recDate').value = date;
  document.getElementById('recBreak').value = brk;
  document.getElementById('recPhone').value = phone;
  document.getElementById('recWasted').value = wasted;
  document.getElementById('recLate').value = late;
  document.getElementById('recDayOff').value = String(dayOff);
  document.getElementById('recNoDeduction').checked = !!noDeduction;
  document.getElementById('recNotes').value = notes;
  document.getElementById('recFields').style.display = dayOff > 0 ? 'none' : '';
  document.getElementById('recNoDeductRow').style.display = dayOff > 0 ? '' : 'none';
  document.getElementById('recordModalTitle').textContent = 'Edit Record';
  updatePreview();
  openModal('recordModal');
}

function toggleDayOff() {
  const dayOff = parseFloat(document.getElementById('recDayOff').value);
  document.getElementById('recFields').style.display = dayOff > 0 ? 'none' : '';
  // The exemption only means anything for a day off
  document.getElementById('recNoDeductRow').style.display = dayOff > 0 ? '' : 'none';
  if (!(dayOff > 0)) document.getElementById('recNoDeduction').checked = false;
  updatePreview();
}

function updatePreview() {
  const empId = document.getElementById('recEmpId').value;
  const emp = employees.find(e => e.id === parseInt(empId));
  const dayOff = parseFloat(document.getElementById('recDayOff').value) || 0;
  const box = document.getElementById('recPreview');
  if (!emp) { box.classList.add('hidden'); return; }

  const rate = emp.daily_rate;
  const ratePerMin = rate / SHIFT_MINS;

  let html = '';
  if (dayOff > 0) {
    const label = dayOff === 1 ? 'Full day off' : 'Half day off';
    const typeNote = emp.employment_type === 'self_employed'
      ? ' (check year allowance — self-employed: 5 days free)'
      : ' (check year allowance — payroll: 20 days free)';
    const noDeduct = document.getElementById('recNoDeduction')?.checked;
    html = `<h3>Day Off Note</h3>
      <div class="deduction-row"><span>${label}${typeNote}</span></div>
      <div class="deduction-row" style="font-size:0.8rem;color:var(--muted)">Day-off deductions are calculated at year level based on your allowance.</div>
      ${noDeduct ? `<div class="deduction-row" style="font-size:0.8rem;color:var(--positive);font-weight:600">✓ Marked "doesn't count" — this day is logged and counts in the days-used total, but will never be deducted from salary.</div>` : ''}`;
  } else {
    const brk = parseInt(document.getElementById('recBreak').value) || 0;
    const phone = parseInt(document.getElementById('recPhone').value) || 0;
    const wasted = parseInt(document.getElementById('recWasted').value) || 0;
    const late = parseInt(document.getElementById('recLate').value) || 0;
    const excessBreak = Math.max(0, brk - ALLOWED_BREAK);
    const total = excessBreak + phone + wasted + late;
    if (total === 0) { box.classList.add('hidden'); return; }

    html = `<h3>Reference Preview <span style="font-size:0.72rem;font-weight:500;opacity:0.7">(for your records — not deducted from salary)</span></h3>`;
    if (excessBreak > 0) html += `<div class="deduction-row"><span>Excess break (${brk}m – ${ALLOWED_BREAK}m)</span><span>${excessBreak}m / £${(excessBreak*ratePerMin).toFixed(2)}</span></div>`;
    if (phone > 0)  html += `<div class="deduction-row"><span>Phone time</span><span>${phone}m / £${(phone*ratePerMin).toFixed(2)}</span></div>`;
    if (wasted > 0) html += `<div class="deduction-row"><span>Wasted time</span><span>${wasted}m / £${(wasted*ratePerMin).toFixed(2)}</span></div>`;
    if (late > 0)   html += `<div class="deduction-row"><span>Late arrival</span><span>${late}m / £${(late*ratePerMin).toFixed(2)}</span></div>`;
    html += `<div class="deduction-row total"><span>Total (reference only)</span><span>${total}m / £${(total*ratePerMin).toFixed(2)}</span></div>`;
  }
  box.innerHTML = html;
  box.classList.remove('hidden');
}

async function saveRecord() {
  const id = document.getElementById('recId').value;
  const body = {
    employee_id: parseInt(document.getElementById('recEmpId').value),
    record_date: document.getElementById('recDate').value,
    break_minutes: parseInt(document.getElementById('recBreak').value) || 0,
    phone_minutes: parseInt(document.getElementById('recPhone').value) || 0,
    wasted_minutes: parseInt(document.getElementById('recWasted').value) || 0,
    late_minutes: parseInt(document.getElementById('recLate').value) || 0,
    is_day_off: parseFloat(document.getElementById('recDayOff').value) || 0,
    no_deduction: document.getElementById('recNoDeduction').checked,
    notes: document.getElementById('recNotes').value
  };
  const res = await fetch(id ? `/api/records/${id}` : '/api/records', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  showToast('Record saved', 'success');
  closeModal('recordModal');
  const calPage = document.getElementById('page-calendar');
  if (calPage && calPage.classList.contains('active')) loadCalendar();
  else loadEmployeeRecords();
}

async function deleteRecord(id) {
  if (!await showConfirm('Delete this record?')) return;
  await fetch(`/api/records/${id}`, { method: 'DELETE' });
  const calPage = document.getElementById('page-calendar');
  if (calPage && calPage.classList.contains('active')) loadCalendar();
  else loadEmployeeRecords();
}

// ─── ADJUSTMENTS ─────────────────────────────────────────────────────────────
async function openAdjModal(empId, date) {
  currentAdjRecord = { empId, date };
  document.getElementById('adjModalSubtitle').textContent =
    `${employees.find(e=>e.id===parseInt(empId))?.name || 'Employee'} – ${date}`;
  document.getElementById('adjMinutes').value = '';
  document.getElementById('adjReason').value = '';
  await loadAdjList();
  openModal('adjModal');
}

async function loadAdjList() {
  if (!currentAdjRecord) return;
  const { empId, date } = currentAdjRecord;
  const res = await fetch(`/api/adjustments/${empId}?date=${date}`);
  const adjs = await res.json();
  const list = document.getElementById('adjList');
  if (!adjs.length) { list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">No adjustments yet.</div>'; return; }
  list.innerHTML = adjs.map(a => `
    <div class="adj-item">
      <div>
        <span class="adj-amount ${a.adjustment_minutes > 0 ? 'positive' : 'negative'}">${a.adjustment_minutes > 0 ? '+' : ''}${a.adjustment_minutes}m</span>
        &nbsp;${esc(a.reason)}
        <small style="color:var(--muted)"> – by ${esc(a.username||'unknown')} on ${a.created_at.slice(0,10)}</small>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteAdj(${a.id})">✕</button>
    </div>`).join('');
}

async function saveAdjustment() {
  const mins = parseInt(document.getElementById('adjMinutes').value);
  const reason = document.getElementById('adjReason').value.trim();
  if (isNaN(mins)) return showToast('Enter a number of minutes', 'error');
  if (!reason) return showToast('Reason is required', 'error');
  await fetch('/api/adjustments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: currentAdjRecord.empId, record_date: currentAdjRecord.date, adjustment_minutes: mins, reason })
  });
  document.getElementById('adjMinutes').value = '';
  document.getElementById('adjReason').value = '';
  await loadAdjList();
  loadEmployeeRecords();
}

async function deleteAdj(id) {
  if (!await showConfirm('Remove this adjustment?')) return;
  await fetch(`/api/adjustments/${id}`, { method: 'DELETE' });
  await loadAdjList();
  loadEmployeeRecords();
}

// ─── MONTHLY PAYMENTS ────────────────────────────────────────────────────────
async function loadPaymentsSection(empId, emp) {
  const section = document.getElementById('paymentsSection');
  if (!emp || emp.annual_salary <= 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const year = new Date().getFullYear();
  const sym  = currencySymbol(emp.currency || 'GBP');

  // Fetch payments, year-stats (day-off deductions), and office deductions in parallel
  const [paymentsRes, yearStatsRes, officeRes] = await Promise.all([
    fetch(`/api/payments/${empId}?year=${year}`),
    fetch(`/api/employees/${empId}/year-stats?year=${year}`),
    fetch(`/api/office-deductions/${empId}`)
  ]);
  const payments   = paymentsRes.ok   ? await paymentsRes.json()   : [];
  const yearStats  = yearStatsRes.ok  ? await yearStatsRes.json()  : {};
  const officeRows = officeRes.ok     ? await officeRes.json()     : [];

  const annual       = parseFloat(emp.annual_salary) || 0;
  const totalPaid    = payments.reduce((a, b) => a + parseFloat(b.amount || 0), 0);
  const dayOffDeduct = parseFloat(yearStats.excess_deduction) || 0;
  const officeDeduct = officeRows.reduce((a, b) => a + parseFloat(b.amount || 0), 0);

  // Pro-rated only applies if employee started this year — fetch from overview to get salary_target
  const startDate = emp.start_date ? emp.start_date.slice(0,10) : null;
  const startedThisYear = startDate && startDate.startsWith(String(year));
  let proRatedHtml = '';
  let salaryTargetForYear = annual; // default to full annual
  if (startedThisYear) {
    const res2 = await fetch(`/api/salary-overview?year=${year}`);
    if (res2.ok) {
      const overview = await res2.json();
      const empData = Array.isArray(overview) ? overview.find(e => e.employee_id === parseInt(empId)) : null;
      if (empData) {
        // Use the server-computed salary_target (pro-rated to Dec 31)
        salaryTargetForYear = parseFloat(empData.salary_target ?? empData.annual_salary) || annual;
        const pr = empData.pro_rated;
        if (pr) {
          proRatedHtml = `
          <div style="margin-top:14px;background:var(--positive-soft);border:1px solid rgba(22,163,74,0.30);border-radius:10px;padding:14px 16px">
            <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--positive);margin-bottom:8px">Pro-Rated Reference · Started ${pr.start_date}</div>
            <div style="font-size:0.85rem;display:flex;justify-content:space-between;font-weight:600">
              <span style="color:var(--muted)">Expected to date</span>
              <span style="color:#059669;font-weight:800">${sym}${pr.total_expected.toLocaleString('en-GB',{minimumFractionDigits:2})}</span>
            </div>
          </div>`;
        }
      }
    }
  }

  const remaining = salaryTargetForYear - totalPaid - dayOffDeduct - officeDeduct;

  document.getElementById('salaryInfo').innerHTML = `
    <div class="stat-card blue"><div class="stat-label">Annual Salary</div><div class="stat-value">${sym}${annual.toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>
    ${startedThisYear ? `<div class="stat-card yellow"><div class="stat-label">Target for ${year}</div><div class="stat-value">${sym}${salaryTargetForYear.toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>` : ''}
    ${startDate ? `<div class="stat-card blue"><div class="stat-label">Start Date</div><div class="stat-value" style="font-size:1.1rem">${startDate}</div></div>` : ''}
    <div class="stat-card green"><div class="stat-label">Paid This Year</div><div class="stat-value">${sym}${totalPaid.toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>
    ${dayOffDeduct > 0 ? `<div class="stat-card red"><div class="stat-label">Day-Off Deductions</div><div class="stat-value">−${sym}${dayOffDeduct.toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>` : ''}
    ${officeDeduct > 0 ? `<div class="stat-card red"><div class="stat-label">Office Items</div><div class="stat-value">−${sym}${officeDeduct.toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>` : ''}
    <div class="stat-card ${remaining < 0 ? 'green' : 'red'}"><div class="stat-label">Remaining to Pay</div><div class="stat-value">${remaining < 0 ? '+' : ''}${sym}${Math.abs(remaining).toLocaleString('en-GB',{minimumFractionDigits:2})}</div></div>
  `;

  // Append pro-rated block below stats
  if (proRatedHtml) document.getElementById('salaryInfo').insertAdjacentHTML('afterend', proRatedHtml);

  const tbody = document.getElementById('paymentsTable');
  const empty = document.getElementById('paymentsEmpty');
  tbody.innerHTML = '';
  if (!payments.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  payments.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${MONTHS[p.payment_month]} ${p.payment_year}</td>
      <td class="fw-bold">${sym}${parseFloat(p.amount).toLocaleString('en-GB',{minimumFractionDigits:2})}</td>
      <td>${esc(p.notes || '') || '—'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deletePayment(${p.id})">Del</button></td>`;
    tbody.appendChild(tr);
  });
}

function openPaymentModal() {
  const empId = document.getElementById('trackEmp').value;
  if (!empId) return;
  const now = new Date();
  document.getElementById('payEmpId').value = empId;
  document.getElementById('payYear').value = now.getFullYear();
  document.getElementById('payMonth').value = now.getMonth() + 1;
  document.getElementById('payAmount').value = '';
  document.getElementById('payNotes').value = '';
  openModal('paymentModal');
}

async function savePayment() {
  const employee_id = document.getElementById('payEmpId').value;
  const payment_year = document.getElementById('payYear').value;
  const payment_month = document.getElementById('payMonth').value;
  const amount = document.getElementById('payAmount').value;
  const notes = document.getElementById('payNotes').value;
  if (!amount) return showToast('Amount is required', 'error');
  const res = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id, payment_year, payment_month, amount, notes })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('paymentModal');
  loadEmployeeRecords();
}

async function deletePayment(id) {
  if (!await showConfirm('Delete this payment record?')) return;
  await fetch(`/api/payments/${id}`, { method: 'DELETE' });
  loadEmployeeRecords();
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────
function _repTile(label, value, sub, color) {
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;display:flex;flex-direction:column;gap:8px">' +
    '<div style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1.2px;color:var(--muted)">' + label + '</div>' +
    '<div style="font:700 30px/1 var(--font-mono);color:' + color + ';letter-spacing:-1px">' + value + '</div>' +
    '<div style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + sub + '</div>' +
  '</div>';
}

async function loadReport() {
  const from    = document.getElementById('repFrom').value;
  const to      = document.getElementById('repTo').value;
  const empId   = document.getElementById('repEmp').value;
  const container = document.getElementById('reportContent');

  if (!from || !to) return showToast('Please select a date range', 'info');

  container.innerHTML = '<div class="empty-state"><div class="icon">⏳</div><div>Generating report…</div></div>';

  try {
    const params = new URLSearchParams({ from, to });
    const year   = new Date(from).getFullYear();

    const [summaryRes, salaryRes] = await Promise.all([
      fetch('/api/summary?' + params),
      fetch('/api/salary-overview?year=' + year)
    ]);

    if (!summaryRes.ok) throw new Error('Server error ' + summaryRes.status);
    const summary = await summaryRes.json();
    if (!Array.isArray(summary)) throw new Error(summary.error || 'Unexpected response');

    const salaryData = salaryRes.ok ? await salaryRes.json() : [];
    const filtered   = empId ? summary.filter(e => e.employee_id === parseInt(empId)) : summary;

    if (!filtered.length) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📋</div><div>No records found for the selected range.</div></div>';
      return;
    }

    // ── Period stats ──────────────────────────────────────────────────────────
    const fromDate   = new Date(from);
    const toDate     = new Date(to);
    const periodDays = Math.ceil((toDate - fromDate) / 86400000) + 1;
    const dateLabel  = fromDate.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
                     + ' – ' + toDate.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

    const filteredIds = new Set(filtered.map(e => e.employee_id));
    const relSalary   = salaryData.filter(e => !empId || filteredIds.has(e.employee_id));

    // Total payroll paid in period (use payment_month/payment_year to bucket)
    const fromYM = year * 100 + fromDate.getMonth() + 1;
    const toYM   = new Date(to).getFullYear() * 100 + new Date(to).getMonth() + 1;
    let totalPayrollPaid = 0;
    relSalary.forEach(e => {
      (e.payments || []).forEach(p => {
        const ym = (parseInt(p.payment_year) || 0) * 100 + (parseInt(p.payment_month) || 0);
        if (ym >= fromYM && ym <= toYM) totalPayrollPaid += parseFloat(p.amount || 0);
      });
    });

    const totalDeduct  = filtered.reduce((a, b) => a + (parseFloat(b.total_deduction) || 0), 0);
    const timeDeduct   = filtered.reduce((a, b) => a + (parseFloat(b.total_time_deduction) || 0), 0);
    const dayDeduct    = filtered.reduce((a, b) => a + (parseFloat(b.excess_day_deduction) || 0), 0);
    const deductPct    = totalPayrollPaid > 0 ? ((totalDeduct / totalPayrollPaid) * 100).toFixed(1) : '0.0';
    const activeCount  = filtered.length;

    // ── Monthly trend data ────────────────────────────────────────────────────
    const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const curMonth     = new Date().getMonth();
    const monthlyTotals = new Array(12).fill(0);
    relSalary.forEach(e => {
      (e.payments || []).forEach(p => {
        const m = parseInt(p.payment_month) - 1;
        const y = parseInt(p.payment_year);
        if (!isNaN(m) && y === year && m >= 0 && m < 12) monthlyTotals[m] += parseFloat(p.amount || 0);
      });
    });

    const chartLabels = MONTHS_SHORT.slice(0, curMonth + 1);
    const chartVals   = monthlyTotals.slice(0, curMonth + 1);
    const maxVal      = Math.max(...chartVals, 1);

    // ── Build HTML ────────────────────────────────────────────────────────────
    let html = '';

    // Stat tiles
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">';
    html += _repTile('Period', periodDays + ' days', dateLabel, 'var(--text)');
    html += _repTile('Total Payroll', '£' + Math.round(totalPayrollPaid).toLocaleString('en-GB'), 'paid this period', 'var(--positive)');
    html += _repTile('Total Deductions', '£' + Math.round(totalDeduct).toLocaleString('en-GB'), deductPct + '% of gross', 'var(--negative)');
    html += _repTile('Active Records', String(activeCount), 'across ' + activeCount + ' staff', 'var(--primary)');
    html += '</div>';

    // Chart + breakdown row
    html += '<div style="display:grid;grid-template-columns:3fr 2fr;gap:16px;margin-bottom:20px">';

    // Payroll trend chart
    html += '<div class="card">';
    html += '<div class="card-header"><span class="card-title">Payroll Trend</span>' +
            '<span style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + year + ' · monthly</span></div>';
    html += '<div style="display:flex;align-items:flex-end;gap:6px;height:150px;padding:4px 4px 0">';
    chartLabels.forEach(function(m, i) {
      var val  = chartVals[i];
      var barH = val > 0 ? Math.max(10, Math.round((val / maxVal) * 110)) : 4;
      var lbl  = val > 0 ? (val >= 1000 ? '£' + (val/1000).toFixed(1) + 'k' : '£' + Math.round(val)) : '';
      var isNow = (i === curMonth);
      var barBg = isNow ? 'var(--primary)' : 'var(--surface-3)';
      html += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">';
      html += '<div style="font:600 9px/1 var(--font-mono);color:' + (isNow ? 'var(--primary)' : 'var(--muted)') + ';text-align:center;white-space:nowrap">' + lbl + '</div>';
      html += '<div style="background:' + barBg + ';border-radius:3px 3px 0 0;width:100%;height:' + barH + 'px"></div>';
      html += '<div style="font:500 9px/1 var(--font-mono);color:' + (isNow ? 'var(--text)' : 'var(--muted)') + '">' + m + '</div>';
      html += '</div>';
    });
    html += '</div></div>';

    // Deductions breakdown
    html += '<div class="card">';
    html += '<div class="card-header"><span class="card-title">Deductions Breakdown</span></div>';
    var deductBase = timeDeduct + dayDeduct || 1;
    var cats = [
      { label: 'Time deductions', val: timeDeduct, color: 'var(--primary)' },
      { label: 'Day-off overage', val: dayDeduct, color: 'var(--negative)' }
    ];
    cats.forEach(function(c) {
      var pct = Math.round((c.val / deductBase) * 100);
      html += '<div style="margin-bottom:16px">';
      html += '<div style="display:flex;justify-content:space-between;font:500 11px/1 var(--font-mono);color:var(--muted);margin-bottom:7px">';
      html += '<span>' + c.label + '</span><span>£' + c.val.toFixed(0) + ' &middot; ' + pct + '%</span></div>';
      html += '<div style="height:6px;background:var(--border);border-radius:3px">';
      html += '<div style="height:100%;width:' + pct + '%;background:' + c.color + ';border-radius:3px"></div>';
      html += '</div></div>';
    });
    html += '</div>';
    html += '</div>'; // end 2-col row

    // Payroll ledger table
    html += '<div class="card">';
    html += '<div class="card-header"><span class="card-title">Payroll Ledger YTD</span>' +
            '<span style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + year + '</span></div>';
    html += '<div class="table-wrap"><table><thead><tr>';
    html += '<th>Employee</th><th>Type</th>';
    chartLabels.forEach(function(m) { html += '<th style="text-align:right">' + m + '</th>'; });
    html += '<th style="text-align:right;color:var(--primary)">YTD Total</th>';
    html += '</tr></thead><tbody>';

    relSalary.forEach(function(emp) {
      var initials = (emp.name || '').split(' ').map(function(w){ return w[0]||''; }).join('').slice(0,2).toUpperCase();
      var typeLabel = emp.employment_type === 'self_employed' ? 'SE' : 'PR';
      var typeCls   = emp.employment_type === 'self_employed' ? 'badge-yellow' : 'badge-blue';
      var empMonthly = new Array(12).fill(0);
      (emp.payments || []).forEach(function(p) {
        var m = parseInt(p.payment_month) - 1;
        var y = parseInt(p.payment_year);
        if (!isNaN(m) && y === year && m >= 0 && m < 12) empMonthly[m] += parseFloat(p.amount || 0);
      });
      var ytd = empMonthly.slice(0, curMonth + 1).reduce(function(a,b){ return a+b; }, 0);

      html += '<tr>';
      html += '<td><div style="display:flex;align-items:center;gap:10px">';
      html += '<div style="width:30px;height:30px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font:700 10px/1 var(--font-mono);color:#000;flex-shrink:0">' + initials + '</div>';
      html += '<div><div style="font-weight:700;font-size:0.84rem">' + esc(emp.name || '') + '</div>';
      html += '<div style="font-size:0.71rem;color:var(--muted)">' + esc(emp.job_title || '') + '</div></div></div></td>';
      html += '<td><span class="badge ' + typeCls + '">' + typeLabel + '</span></td>';
      chartLabels.forEach(function(m, i) {
        var v = empMonthly[i];
        html += '<td style="text-align:right;font:500 12px/1 var(--font-mono);color:' + (v > 0 ? 'var(--text)' : 'var(--dim)') + '">' +
                (v > 0 ? '£' + v.toLocaleString('en-GB',{maximumFractionDigits:0}) : '&mdash;') + '</td>';
      });
      html += '<td style="text-align:right;font:700 13px/1 var(--font-mono);color:var(--primary)">' +
              (ytd > 0 ? '£' + ytd.toLocaleString('en-GB') : '&mdash;') + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div></div>';

    container.innerHTML = html;

  } catch (e) {
    container.innerHTML = '<div class="alert alert-error">Failed to generate report: ' + esc(e.message) + '</div>';
  }
}

// ─── ADMINS ──────────────────────────────────────────────────────────────────
async function loadAdmins() {
  const res = await fetch('/api/admins');
  if (!res.ok) return;
  const admins = await res.json();

  // Update adminSub
  const adminCount = admins.length;
  const adminRoleCount = admins.filter(a => a.role === 'admin').length;
  const managerCount = admins.filter(a => a.role === 'manager').length;
  const accountsCount = admins.filter(a => a.role === 'accounts').length;
  const adminSub = document.getElementById('adminSub');
  if (adminSub) adminSub.textContent = `// ${adminCount} account${adminCount !== 1 ? 's' : ''} · ${adminRoleCount} admin · ${managerCount} manager` + (accountsCount ? ` · ${accountsCount} accounts` : '');

  const tbody = document.getElementById('adminTable');
  tbody.innerHTML = '';
  admins.forEach(a => {
    const initials = (a.username || '?').slice(0, 2).toUpperCase();
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:28px;height:28px;border-radius:7px;background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent);font:700 10px/1 var(--font-mono);display:grid;place-items:center;flex-shrink:0">${initials}</div>
          <strong>${esc(a.username)}</strong>
        </div>
      </td>
      <td><span class="badge ${a.role==='admin'?'badge-green':a.role==='accounts'?'badge-teal':'badge-blue'}">${a.role.toUpperCase()}</span></td>
      <td>${a.created_at.slice(0,10)}</td>
      <td style="text-align:right">
        <button class="btn btn-ghost btn-sm" onclick="resetPw(${a.id})">Reset PW</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAdmin(${a.id})">Remove</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Append roles + recent sign-ins section (remove old one if present)
  const oldExtra = document.getElementById('adminExtraSection');
  if (oldExtra) oldExtra.remove();

  const signinRows = admins.map(a => {
    const initials = (a.username || '?').slice(0, 2).toUpperCase();
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border)">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--positive);flex-shrink:0"></span>
        <div style="width:28px;height:28px;border-radius:7px;background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent);font:700 10px/1 var(--font-mono);display:grid;place-items:center;flex-shrink:0">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font:600 12.5px/1 var(--font-mono);color:var(--text)">${esc(a.username)}</div>
          <div style="font:400 10.5px/1 var(--font-mono);color:var(--muted);margin-top:3px">${a.created_at.slice(0,10)}</div>
        </div>
        <span class="badge ${a.role==='admin'?'badge-green':'badge-blue'}" style="font-size:0.65rem">${a.role.toUpperCase()}</span>
      </div>`;
  }).join('');

  const extraSection = document.createElement('div');
  extraSection.id = 'adminExtraSection';
  extraSection.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      <div class="card" style="margin-bottom:0">
        <div class="card-header">
          <span class="card-title">Roles</span>
        </div>
        <div style="padding:16px">
          <div style="margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span class="badge badge-green">ADMIN</span>
              <span style="font:600 12.5px/1 var(--font-sans);color:var(--text)">Full access</span>
            </div>
            <div style="font:400 11.5px/1.5 var(--font-mono);color:var(--muted)">Manage admins, delete records, terminate employees, all exports.</div>
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span class="badge badge-blue">MANAGER</span>
              <span style="font:600 12.5px/1 var(--font-sans);color:var(--text)">Day-to-day</span>
            </div>
            <div style="font:400 11.5px/1.5 var(--font-mono);color:var(--muted)">Add records, log payments, edit employees · no admin or termination.</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-bottom:0">
        <div class="card-header">
          <span class="card-title">Recent sign-ins</span>
          <span style="font:600 10px/1 var(--font-mono);color:var(--muted);text-transform:uppercase;letter-spacing:0.6px">Last 7 days</span>
        </div>
        <div id="adminSignins">${signinRows || '<div style="padding:16px;color:var(--muted);font-size:0.85rem">No accounts yet.</div>'}</div>
      </div>
    </div>`;

  const adminPage = document.getElementById('page-admins');
  if (adminPage) adminPage.appendChild(extraSection);
}

function openAdminModal() { openModal('adminModal'); }

async function saveAdmin() {
  const username = document.getElementById('newAdminUser').value.trim();
  const password = document.getElementById('newAdminPass').value;
  const role = document.getElementById('newAdminRole').value;
  if (!username || !password) return showToast('Username and password required', 'error');
  const res = await fetch('/api/admins', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('adminModal');
  loadAdmins();
}

async function deleteAdmin(id) {
  if (!await showConfirm('Remove this user?')) return;
  const res = await fetch(`/api/admins/${id}`, { method: 'DELETE' });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  loadAdmins();
}

async function resetPw(id) {
  const pw = await showPrompt('New password:', 'Enter new password');
  if (!pw) return;
  await fetch(`/api/admins/${id}/password`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  showToast('Password updated', 'success');
}

// ─── SALARY PAGE ─────────────────────────────────────────────────────────────

function setSalaryTab(btn) {
  document.querySelectorAll('.salary-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadSalaryPage();
}

function pbFilter(btn, filter) {
  document.querySelectorAll('.pb-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#pbList .pb-row').forEach(row => {
    row.style.display = (filter === 'unpaid' && row.classList.contains('pb-row--settled')) ? 'none' : '';
  });
  // Hide section headers if all their rows are hidden
  document.querySelectorAll('#pbList .pb-section').forEach(sec => {
    const visible = [...sec.querySelectorAll('.pb-row')].some(r => r.style.display !== 'none');
    sec.style.display = visible ? '' : 'none';
  });
}

function activeSalaryTab() {
  return document.querySelector('.salary-tab.active')?.dataset.tab || 'all';
}

function initSalaryYearSelect() {
  const sel = document.getElementById('salaryYear');
  if (sel.options.length > 1) return;
  const now = new Date().getFullYear();
  for (let y = now; y >= now - 4; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  }
  sel.value = now;
}

async function loadSalaryPage() {
  const container = document.getElementById('salaryCards');
  try {
    initSalaryYearSelect();
    const year       = document.getElementById('salaryYear').value || new Date().getFullYear();
    const empFilter  = document.getElementById('salaryEmpFilter').value;
    const searchTerm = (document.getElementById('salarySearch')?.value || '').trim().toLowerCase();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(`/api/salary-overview?year=${year}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let errMsg = `Server error ${res.status}`;
      try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
      throw new Error(errMsg);
    }
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Unexpected response from server');

    // Unpaid-this-month set (current year only) — powers the expandable "to pay"
    // lists inside the summary table, replacing the standalone reminder panel.
    const _now = new Date();
    const curY = _now.getFullYear(), curM = _now.getMonth() + 1;
    const isCurrentYear = parseInt(year) === curY;
    const unpaidList = isCurrentYear ? getUnpaidThisMonth(data, curY, curM) : [];
    const unpaidSet  = new Set(unpaidList.map(e => e.employee_id));
    const monthShort = MONTHS[curM].slice(0, 3);
    updateSalaryBadge(unpaidList.length);

    // Update tab counts
    const base = empFilter ? data.filter(e => String(e.employee_id) === empFilter) : data;
    const searched = searchTerm
      ? base.filter(e => (e.name || '').toLowerCase().includes(searchTerm))
      : base;
    const counts = {
      all:          searched.filter(e => !e.is_terminated).length,
      payroll:      searched.filter(e => !e.is_terminated && e.employment_type === 'payroll').length,
      self_employed:searched.filter(e => !e.is_terminated && e.employment_type === 'self_employed').length,
      terminated:   searched.filter(e => e.is_terminated).length
    };
    document.querySelectorAll('.salary-tab').forEach(t => {
      const key = t.dataset.tab;
      const labels = { all:'All', payroll:'Payroll', self_employed:'Self-Employed', terminated:'Terminated' };
      t.textContent = `${labels[key]} (${counts[key]})`;
    });

    // Update salary page tag and sub
    const salaryPageTag = document.getElementById('salaryPageTag');
    if (salaryPageTag) salaryPageTag.textContent = year;
    const salarySub = document.getElementById('salarySub');
    if (salarySub) {
      const activeCount = searched.filter(e => !e.is_terminated).length;
      const flagged = searched.filter(e => !e.is_terminated && (parseFloat(e.excess_days) || 0) > 0).length;
      salarySub.textContent = `// ${activeCount} account${activeCount !== 1 ? 's' : ''} · ${flagged > 0 ? flagged + ' flagged' : 'all clear'}`;
    }

    const tab = activeSalaryTab();
    let rows = [...searched];
    if (tab === 'terminated')        rows = rows.filter(e => e.is_terminated);
    else if (tab === 'payroll')      rows = rows.filter(e => !e.is_terminated && e.employment_type === 'payroll');
    else if (tab === 'self_employed')rows = rows.filter(e => !e.is_terminated && e.employment_type === 'self_employed');
    else                             rows = rows.filter(e => !e.is_terminated);

    // ── Totals strip: grouped by employment_type × currency (active only) ──
    const activeRows = rows.filter(r => !r.is_terminated);
    const TYPE_ORDER = ['payroll', 'self_employed'];
    const groups = [];
    TYPE_ORDER.forEach(type => {
      const ofType = activeRows.filter(r => r.employment_type === type);
      if (!ofType.length) return;
      const curs = [...new Set(ofType.map(r => r.currency || 'GBP'))];
      curs.forEach(c => {
        groups.push({ type, currency: c, rows: ofType.filter(r => (r.currency || 'GBP') === c) });
      });
    });
    const TYPE_LABEL = { payroll: 'Payroll', self_employed: 'Self-Employed' };
    const TYPE_CLASS  = { payroll: 'payroll', self_employed: 'self-employed' };

    // ── Summary table ──
    const allActive = activeRows;
    const gtTarget  = allActive.reduce((s, e) => s + salFxToGBP(parseFloat(e.salary_target ?? e.annual_salary) || 0, e.currency || 'GBP'), 0);
    const gtPaid    = allActive.reduce((s, e) => s + salFxToGBP(parseFloat(e.total_paid)    || 0, e.currency || 'GBP'), 0);
    const gtDeduct  = allActive.reduce((s, e) => s + salFxToGBP((parseFloat(e.excess_deduction)||0)+(parseFloat(e.total_office_deductions)||0), e.currency || 'GBP'), 0);
    const gtRemain  = allActive.reduce((s, e) => s + Math.max(0, salFxToGBP(parseFloat(e.net_remaining) || 0, e.currency || 'GBP')), 0);
    const hasMultiCurrency = groups.some(g => g.currency !== 'GBP');
    const gtPaidPct = (gtTarget - gtDeduct) > 0 ? Math.min(100, Math.round(gtPaid / (gtTarget - gtDeduct) * 100)) : 0;
    const fmtN = (v, sym) => sym + v.toLocaleString('en-GB', {maximumFractionDigits:0});
    const fmtGBP = v => '£' + v.toLocaleString('en-GB', {maximumFractionDigits:0});

    // ── Overview: what is still to pay, per group ──────────────────────────
    // Not filtered by the type tab on purpose. An overview that changed every
    // time you clicked a tab would not be an overview; this answers "what is
    // left across the whole team" whichever tab is open. The year, employee
    // and search filters do apply, because those narrow who you are asking
    // about rather than which slice of them you are looking at.
    const ovRows = searched.filter(e => !e.is_terminated);
    const ovNow  = new Date();

    // Fixed list, fixed order. Payroll appears even when nobody is on it, so
    // "nothing owed on payroll" is a visible answer rather than a missing
    // tile. Anyone the list does not claim -- a currency we have not seen
    // before -- still gets a tile rather than being dropped.
    const OV_DEFS = [
      { key: 'payroll', label: 'Payroll',
        match: r => r.employment_type === 'payroll' },
      { key: 'se_gbp',  label: 'Self-Employed',
        match: r => r.employment_type === 'self_employed' && (r.currency || 'GBP') === 'GBP' },
      { key: 'se_php',  label: 'Self-Employed · PHP',
        match: r => r.employment_type === 'self_employed' && r.currency === 'PHP' },
    ];
    const ovClaimed = new Set();
    const ovGroups = OV_DEFS.map(d => {
      const rows = ovRows.filter(d.match);
      rows.forEach(r => ovClaimed.add(r.employee_id));
      return { key: d.key, label: d.label, rows };
    });
    const ovExtra = {};
    ovRows.filter(r => !ovClaimed.has(r.employee_id)).forEach(r => {
      const cur = r.currency || 'GBP';
      const k = `${r.employment_type}_${cur}`;
      (ovExtra[k] = ovExtra[k] || {
        key: k,
        label: `${TYPE_LABEL[r.employment_type] || r.employment_type}${cur !== 'GBP' ? ' · ' + cur : ''}`,
        rows: []
      }).rows.push(r);
    });
    Object.values(ovExtra).forEach(g => ovGroups.push(g));

    // Each person's effective target is rebuilt as remaining + paid, so it is
    // the server's own figure rather than a second formula that could drift.
    const ovEffective = r => (parseFloat(r.net_remaining) || 0) + (parseFloat(r.total_paid) || 0);
    // Owed counts only the people who are actually behind. Overpaying one
    // person is not cash you get to hold back from another, so overpayment is
    // reported on its own line instead of quietly shrinking the bill.
    const ovOwedOf  = r => Math.max(0, parseFloat(r.net_remaining) || 0);
    const ovOverOf  = r => Math.max(0, -(parseFloat(r.net_remaining) || 0));
    const ovPaidOf  = r => parseFloat(r.total_paid) || 0;

    const ovMonth = MONTHS[ovNow.getMonth() + 1].slice(0, 3);
    const ovTiles = ovGroups.map(g => {
      const curs  = [...new Set(g.rows.map(r => r.currency || 'GBP'))];
      // A group in one currency is reported in it. A group spanning several
      // can only be added up in GBP, and says so.
      const mixed = curs.length > 1;
      const cur   = mixed ? 'GBP' : (curs[0] || 'GBP');
      const sym   = currencySymbol(cur);
      const sum   = pick => g.rows.reduce(
        (a, r) => a + (mixed ? salFxToGBP(pick(r), r.currency || 'GBP') : pick(r)), 0);

      const owed = sum(ovOwedOf);
      const over = sum(ovOverOf);
      const eff  = sum(ovEffective);
      const paid = sum(ovPaidOf);
      const exp  = sum(r => salaryExpectedByNow(r, year, ovNow));

      const pctPaid = eff > 0 ? Math.min(100, Math.round(paid / eff * 100)) : 0;
      const pctExp  = eff > 0 ? Math.min(100, Math.round(exp  / eff * 100)) : 0;
      const due     = g.rows.filter(r => unpaidSet.has(r.employee_id)).length;
      const showGBP = !mixed && cur !== 'GBP' && owed > 0;
      const money   = v => sym + Math.round(v).toLocaleString('en-GB');

      if (!g.rows.length) {
        return `<article class="sal-ov-tile sal-ov-tile--empty">
          <div class="sal-ov-t-head">
            <span class="sal-ov-t-name">${esc(g.label)}</span>
            <span class="sal-ov-t-count">none</span>
          </div>
          <div class="sal-ov-t-owed sal-ov-t-owed--none">Nobody on this group</div>
        </article>`;
      }

      return `<article class="sal-ov-tile">
        <div class="sal-ov-t-head">
          <span class="sal-ov-t-name">${esc(g.label)}</span>
          <span class="sal-ov-t-count">${g.rows.length} ${g.rows.length === 1 ? 'person' : 'people'}</span>
        </div>
        <div class="sal-ov-t-owed${owed <= 0 ? ' sal-ov-t-owed--done' : ''}">${owed > 0 ? money(owed) : 'Fully paid'}</div>
        <div class="sal-ov-t-alt">${
          owed <= 0 ? 'nothing outstanding'
          : showGBP ? `${fmtGBP(salFxToGBP(owed, cur))} still owed`
          : mixed ? 'still owed this year, mixed currencies in GBP'
          : 'still owed this year'
        }</div>
        <div class="sal-ov-meter" role="img"
             aria-label="${pctPaid}% paid, ${pctExp}% expected by the end of ${ovMonth}">
          <span class="sal-ov-meter-fill" style="width:${pctPaid}%"></span>
          <span class="sal-ov-meter-mark" style="left:${pctExp}%"></span>
        </div>
        <div class="sal-ov-t-foot">
          <span class="sal-ov-t-pace">${pctPaid}% paid<span class="sal-ov-t-exp"> · ${pctExp}% expected by ${ovMonth}</span></span>
          ${due > 0 ? `<span class="sal-ov-chip">${due} to pay</span>` : ''}
        </div>
        ${over > 0 ? `<div class="sal-ov-t-over">${money(over)} overpaid, kept separate</div>` : ''}
      </article>`;
    }).join('');

    // Whole-team totals. GBP, because that is the only way to add them up.
    const ovGbp     = pick => ovRows.reduce((a, r) => a + salFxToGBP(pick(r), r.currency || 'GBP'), 0);
    const ovOwedGBP = ovGbp(ovOwedOf);
    const ovOverGBP = ovGbp(ovOverOf);
    const ovEffGBP  = ovGbp(ovEffective);
    const ovPaidGBP = ovGbp(ovPaidOf);
    const ovPct     = ovEffGBP > 0 ? Math.min(100, Math.round(ovPaidGBP / ovEffGBP * 100)) : 0;
    const ovNonGBP  = [...new Set(ovRows.map(r => r.currency || 'GBP'))].filter(c => c !== 'GBP');

    // Guard: a stale cached index.html would not have this element, and losing
    // the overview must not take the rest of the salary page down with it.
    const ovEl = document.getElementById('salaryOverview');
    if (ovEl) ovEl.innerHTML = ovRows.length ? `
      <section class="sal-ov">
        <header class="sal-ov-head">
          <div>
            <div class="sal-ov-eyebrow">Overview</div>
            <h3 class="sal-ov-title">Still to pay in ${year}</h3>
            <p class="sal-ov-note">${ovRows.length} active ${ovRows.length === 1 ? 'person' : 'people'}${
              ovOverGBP > 0 ? ` · ${fmtGBP(ovOverGBP)} overpaid elsewhere, not netted off` : ''}</p>
          </div>
          <div class="sal-ov-total">
            <div class="sal-ov-total-label">All groups, in GBP</div>
            <div class="sal-ov-total-value">${fmtGBP(ovOwedGBP)}</div>
            <div class="sal-ov-total-note">${ovPaidGBP > ovEffGBP
              ? `${fmtGBP(ovPaidGBP)} paid, ${fmtGBP(ovPaidGBP - ovEffGBP)} ahead of what is owed`
              : `${fmtGBP(ovPaidGBP)} of ${fmtGBP(ovEffGBP)} paid · ${ovPct}%`}</div>
          </div>
        </header>
        <div class="sal-ov-grid">${ovTiles}</div>
        <p class="sal-ov-fx">
          The bar fills to what has been paid; the notch is where the year says you should be by the end of ${ovMonth}.${
          ovNonGBP.length ? ` GBP conversions use ${ovNonGBP.map(c => `1 ${c} = £${SAL_FX[c]}`).join(', ')}.` : ''}
        </p>
      </section>` : '';

    window._salGrpOpen = window._salGrpOpen || {};
    const tableRows = groups.map(g => {
      const s       = currencySymbol(g.currency);
      const tTarget = g.rows.reduce((a, b) => a + (parseFloat(b.salary_target ?? b.annual_salary) || 0), 0);
      const tPaid   = g.rows.reduce((a, b) => a + (parseFloat(b.total_paid) || 0), 0);
      const tDeduct = g.rows.reduce((a, b) => a + (parseFloat(b.excess_deduction)||0) + (parseFloat(b.total_office_deductions)||0), 0);
      const tRemain = g.rows.reduce((a, b) => a + (parseFloat(b.net_remaining) || 0), 0);
      const tEffective = tTarget - tDeduct;   // what is actually owed, after deductions
      const pct     = tEffective > 0 ? Math.min(100, Math.round(tPaid / tEffective * 100)) : 0;
      const isNonGBP = g.currency !== 'GBP';
      const groupLabel = `${TYPE_LABEL[g.type]}${g.currency !== 'GBP' ? ' · ' + g.currency : ''}`;

      // Employees in this group still needing payment this month
      const groupUnpaid = g.rows.filter(r => unpaidSet.has(r.employee_id));
      const key = `${g.type}_${g.currency}`;
      const canExpand = groupUnpaid.length > 0;
      const isOpen = canExpand && !!window._salGrpOpen[key];

      const detailRows = canExpand ? groupUnpaid.map(r => {
        const sym = currencySymbol(r.currency || 'GBP');
        const grossMo = (parseFloat(r.annual_salary) || 0) / 12;
        const netMo = r.net_monthly ? parseFloat(r.net_monthly) : null;
        const amt = netMo ?? grossMo;
        const remain = parseFloat(r.net_remaining);
        const remainHtml = isFinite(remain)
          ? (remain > 0
              ? `<span class="sal-grp-payleft">${sym}${remain.toLocaleString('en-GB',{maximumFractionDigits:0})} left this year</span>`
              : `<span class="sal-grp-payleft sal-grp-payleft--done">Fully paid</span>`)
          : '';
        return `<div class="sal-grp-payitem">
          <span class="sal-grp-payname">${empLink(r.employee_id, r.name)}${remainHtml}</span>
          <span class="sal-grp-payamt">${sym}${amt.toLocaleString('en-GB',{minimumFractionDigits:2})}/mo${netMo ? '<span class="srr-net">net</span>' : ''}</span>
          <span class="sal-grp-payactions">
            <button class="srr-skip" onclick="skipGroupReminder(${r.employee_id})">Skip ${monthShort}</button>
            <button class="srr-pay" onclick="openSalaryPaymentModal(${r.employee_id})">Log Payment</button>
          </span>
        </div>`;
      }).join('') : '';

      const headRow = `<tr class="sal-grp-row${canExpand ? ' sal-grp-clickable' : ''}${isOpen ? ' sal-grp-open' : ''}" id="salgrp-head-${key}"${canExpand ? ` onclick="toggleSalaryGroup('${key}')"` : ''}>
        <td>
          <div class="sal-grp-label">
            <span class="sal-grp-chevron">${canExpand ? (isOpen ? '▼' : '▶') : ''}</span>
            <div>
              <div style="font-weight:600;font-size:0.85rem">${groupLabel}</div>
              <div style="font-size:0.72rem;color:var(--muted)">${g.rows.length} employee${g.rows.length !== 1 ? 's' : ''}</div>
            </div>
            ${canExpand ? `<span class="sal-grp-topay">${groupUnpaid.length} to pay</span>` : ''}
          </div>
        </td>
        <td>
          <div>${fmtN(tTarget, s)}</div>
          ${isNonGBP ? `<div class="sal-tbl-sub">${fmtGBP(salFxToGBP(tTarget,g.currency))}</div>` : ''}
        </td>
        <td>
          <div>${fmtN(tPaid, s)}</div>
          ${isNonGBP ? `<div class="sal-tbl-sub">${fmtGBP(salFxToGBP(tPaid,g.currency))}</div>` : ''}
        </td>
        <td>${tDeduct > 0 ? `<div style="color:var(--warning)">−${fmtN(tDeduct,s)}</div>` : '<span style="color:var(--muted)">—</span>'}</td>
        <td>
          <div style="color:${tRemain < 0 ? 'var(--positive)' : tRemain === 0 ? 'var(--muted)' : 'var(--text)'};font-weight:600">${tRemain < 0 ? 'Overpaid' : fmtN(Math.abs(tRemain),s)}</div>
          ${isNonGBP && tRemain > 0 ? `<div class="sal-tbl-sub">${fmtGBP(salFxToGBP(tRemain,g.currency))}</div>` : ''}
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:var(--border);border-radius:3px;min-width:48px">
              <div style="height:100%;width:${pct}%;background:var(--primary);border-radius:3px"></div>
            </div>
            <span style="font-size:0.78rem;font-weight:600;color:var(--muted);min-width:30px">${pct}%</span>
          </div>
        </td>
      </tr>`;

      const detailRow = canExpand ? `<tr class="sal-grp-detail" id="salgrp-detail-${key}" style="display:${isOpen ? '' : 'none'}">
        <td colspan="6"><div class="sal-grp-paylist">${detailRows}</div></td>
      </tr>` : '';

      return headRow + detailRow;
    }).join('');

    document.getElementById('salaryTotals').innerHTML = `
      <div class="card" style="padding:0;overflow:hidden">
        <table class="sal-summary-tbl">
          <thead><tr>
            <th>Group</th>
            <th>Annual</th>
            <th>Paid</th>
            <th>Deductions</th>
            <th>Still Owed</th>
            <th style="min-width:120px">Progress</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
          <tfoot><tr>
            <td><div style="font-weight:700">Total · GBP</div><div style="font-size:0.72rem;color:var(--muted)">${allActive.length} employees</div></td>
            <td><div style="font-weight:700">${fmtGBP(gtTarget)}</div></td>
            <td><div style="font-weight:700">${fmtGBP(gtPaid)}</div></td>
            <td>${gtDeduct > 0 ? `<div style="color:var(--warning)">−${fmtGBP(gtDeduct)}</div>` : '<span style="color:var(--muted)">—</span>'}</td>
            <td><div style="font-weight:700">${fmtGBP(gtRemain)}</div></td>
            <td>
              <div style="display:flex;align-items:center;gap:8px">
                <div style="flex:1;height:6px;background:var(--border);border-radius:3px;min-width:48px">
                  <div style="height:100%;width:${gtPaidPct}%;background:var(--primary);border-radius:3px"></div>
                </div>
                <span style="font-size:0.78rem;font-weight:700;min-width:30px">${gtPaidPct}%</span>
              </div>
            </td>
          </tr></tfoot>
        </table>
      </div>`;

    // Payment Board removed — salary reminder panel handles categorized view
    document.getElementById('salaryBoard').innerHTML = '';

    // ── Per-employee cards ──
    if (!rows.length) {
      container.innerHTML = `<div class="empty-state"><div class="icon">💰</div><div>No employees with salary data.</div></div>`;
      return;
    }

    container.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px;margin-top:16px';
    container.innerHTML = rows.map(emp => {
      const annualSalary    = parseFloat(emp.annual_salary) || 0;
      const salaryTarget    = parseFloat(emp.salary_target ?? emp.annual_salary) || 0;
      const isProRatedYear  = !emp.is_terminated && salaryTarget !== annualSalary && salaryTarget > 0;
      const totalPaidEmp    = parseFloat(emp.total_paid) || 0;
      const excessDeduction = parseFloat(emp.excess_deduction) || 0;
      const netRemaining    = parseFloat(emp.net_remaining) || 0;
      const excessDays      = parseFloat(emp.excess_days) || 0;
      const totalDaysOff    = emp.total_days_off != null ? emp.total_days_off : 0;
      const allowanceDays   = emp.allowance_days != null ? emp.allowance_days : '—';
      const pctPaid         = parseFloat(emp.pct_paid) || 0;
      const payments        = Array.isArray(emp.payments) ? emp.payments : [];
      const officeDeductions = Array.isArray(emp.office_deductions) ? emp.office_deductions : [];
      const bonuses         = Array.isArray(emp.bonuses) ? emp.bonuses : [];
      const salaryHistory   = Array.isArray(emp.salary_history) ? emp.salary_history : [];
      const officeTotal     = parseFloat(emp.total_office_deductions) || 0;
      const bonusTotal      = parseFloat(emp.total_bonuses) || 0;
      const cur             = emp.currency || 'GBP';
      const sym             = currencySymbol(cur);
      const paye            = emp.paye_breakdown || null;
      const netMonthly      = emp.net_monthly ? parseFloat(emp.net_monthly) : null;

      // First-month suggestion: server-provided or client-side fallback
      const pr = emp.pro_rated;
      const fm = emp.first_month_full;
      const isPartialFirstMonth = fm && fm.first_month_days < fm.first_month_total_days;
      const payeNetFactor = paye && annualSalary > 0 ? paye.net_annual / annualSalary : 1;
      let suggestedFirstMonthNet = isPartialFirstMonth
        ? parseFloat((fm.first_month_pay * payeNetFactor).toFixed(2))
        : null;
      let fmMeta = isPartialFirstMonth ? {
        monthName: MONTHS[parseInt(fm.first_month.split('-')[1]) - 1] || fm.first_month,
        startDate: fm.start_date || emp.start_date,
        daysWorked: fm.first_month_days,
        daysTotal: fm.first_month_total_days
      } : null;

      // Client-side fallback: derive from emp.start_date when server didn't provide fm data
      if (suggestedFirstMonthNet === null && emp.start_date && !emp.is_terminated) {
        const sd = new Date(emp.start_date + 'T00:00:00');
        const startDay = sd.getDate();
        if (startDay > 1) {
          const daysInMonth = new Date(sd.getFullYear(), sd.getMonth() + 1, 0).getDate();
          const daysWorked = daysInMonth - startDay + 1;
          const netM = (paye ? paye.net_monthly : null) || netMonthly || (annualSalary / 12);
          suggestedFirstMonthNet = parseFloat((netM * (daysWorked / daysInMonth)).toFixed(2));
          fmMeta = {
            monthName: MONTHS[sd.getMonth()],
            startDate: emp.start_date,
            daysWorked,
            daysTotal: daysInMonth
          };
        }
      }

      const initials = (emp.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
      const typeLabel = emp.employment_type === 'self_employed' ? 'Self-Employed' : 'Payroll';
      const typeBadge = 'badge-grey';
      const allowanceLabel = emp.employment_type === 'self_employed' ? '5 days/yr free' : '20 days/yr free';
      const isTerminated = !!emp.is_terminated;
      const isOverpaid = netRemaining < 0;


      const earnedTotal = emp.earned_to_date != null ? parseFloat(emp.earned_to_date) : null;
      const eb = emp.earned_breakdown;

      // ── figures strip values ──
      const figOutClass = isOverpaid ? 'sc-fig-ok' : netRemaining === 0 ? 'sc-fig-dim' : 'sc-fig-bad';

      // ── build card ──
      const avatarTypeClass = isTerminated ? '' : emp.employment_type === 'self_employed' ? ' sc-self-emp-type' : '';
      const accentClass = isTerminated ? 'sc-term-accent' : emp.employment_type === 'self_employed' ? 'sc-self-emp' : 'sc-payroll';

      return `<div class="sc-card${isTerminated ? ' sc-terminated' : ''}${avatarTypeClass}" id="sc-emp-${emp.employee_id}">
        <div class="sc-accent ${accentClass}"></div>

        ${isTerminated ? `<div class="sc-term-banner">
          <span>Terminated</span>
          <span class="tb-date">${emp.termination_date}</span>
          ${emp.termination_reason ? `<span class="tb-reason">· ${esc(emp.termination_reason)}</span>` : ''}
        </div>` : ''}

        <div class="sc-head">
          <div class="sc-info">
            <div class="sc-emp-name">${empLink(emp.employee_id, emp.name || '')}</div>
            ${emp.job_title || emp.department ? `<div class="sc-emp-role">${[emp.job_title, emp.department].filter(Boolean).map(s => esc(s)).join(' · ')}</div>` : ''}
            <div class="sc-emp-badges">
              <span class="badge ${typeBadge}" style="font-size:0.67rem">${typeLabel}</span>
              ${emp.start_date ? `<span class="sc-emp-since">${isTerminated ? 'Started' : 'Since'} ${emp.start_date}</span>` : ''}
            </div>
          </div>
          <div class="sc-annual">
            <div class="sc-annual-lbl">${isTerminated ? 'Final earned' : isProRatedYear ? `Target ${year}` : 'Annual'}</div>
            <div class="sc-annual-val">${sym}${(isTerminated ? (earnedTotal ?? annualSalary) : isProRatedYear ? salaryTarget : annualSalary).toLocaleString('en-GB',{maximumFractionDigits:0})}</div>
          </div>
          ${!isTerminated ? `<button class="btn btn-primary btn-sm" onclick="openSalaryPaymentModal(${emp.employee_id})" style="flex-shrink:0">+ Pay</button>` : ''}
        </div>

        <div class="sc-prog">
          <div class="sc-prog-meta">
            <span>${pctPaid}% paid</span>
            <span class="sc-prog-left${isOverpaid ? ' is-over' : ''}">${isOverpaid ? 'Overpaid' : netRemaining === 0 ? 'Fully paid' : `${sym}${Math.abs(netRemaining).toLocaleString('en-GB',{maximumFractionDigits:0})} left`}</span>
          </div>
          <div class="sc-prog-track">
            <div class="sc-prog-fill${isOverpaid ? ' overpaid' : ''}" style="width:${Math.min(pctPaid,100)}%"></div>
          </div>
        </div>


        ${(() => {
          const monthlyVal = paye ? paye.net_monthly : annualSalary / 12;
          const monthlyLbl = paye ? 'Take-home / mo' : 'Monthly';
          const monthlySub = paye ? 'after PAYE' + (paye.pension > 0 ? ' + pension' : '') : '';
          const showFirstMonth = suggestedFirstMonthNet !== null && fmMeta && !isOverpaid;
          const firstMonthUnpaid = showFirstMonth && totalPaidEmp === 0;
          return '<div class="sc-figs">' +
            '<div class="sc-fig">' +
              '<div class="sc-fig-lbl">' + monthlyLbl + '</div>' +
              '<div class="sc-fig-val">' + sym + monthlyVal.toLocaleString('en-GB',{maximumFractionDigits:0}) + '</div>' +
              (monthlySub ? '<div class="sc-fig-sub">' + monthlySub + '</div>' : '') +
            '</div>' +
            '<div class="sc-fig">' +
              (firstMonthUnpaid
                ? '<div class="sc-fig-lbl">Pay this month</div>' +
                  '<div class="sc-fig-val is-due">' + sym + Math.round(suggestedFirstMonthNet).toLocaleString('en-GB') + '</div>' +
                  (fmMeta ? '<div class="sc-fig-sub">' + fmMeta.daysWorked + ' of ' + fmMeta.daysTotal + ' days · ' + (fmMeta.monthName||'') + '</div>' : '')
                : (() => {
                    // Latest by year+month; same-month payments tie-break on id
                    // (highest id = most recently recorded)
                    const payKey = p => (Number(p.payment_year)||0)*100 + (Number(p.payment_month)||0);
                    const lastPay = payments.length
                      ? payments.reduce((a,b) => {
                          const ka = payKey(a), kb = payKey(b);
                          return kb > ka || (kb === ka && (Number(b.id)||0) > (Number(a.id)||0)) ? b : a;
                        }, payments[0])
                      : null;
                    if (!lastPay) return '<div class="sc-fig-lbl">Last payment</div>' +
                      '<div class="sc-fig-val is-none">—</div>' +
                      '<div class="sc-fig-sub">No payments yet</div>';
                    const lpMonth = MONTHS[Number(lastPay.payment_month)] || '';
                    const lpYear  = lastPay.payment_year || '';
                    const lpAmt   = sym + parseFloat(lastPay.amount||0).toLocaleString('en-GB',{maximumFractionDigits:0});
                    return '<div class="sc-fig-lbl">Last payment</div>' +
                      '<div class="sc-fig-val">' + lpAmt + '</div>' +
                      '<div class="sc-fig-sub">' + lpMonth + (lpYear ? ' ' + lpYear : '') + '</div>';
                  })()
              ) +
            '</div>' +
          '</div>' +
          (!paye && excessDays > 0
            ? '<div class="sc-excess">' +
              excessDays + ' excess day' + (excessDays > 1 ? 's' : '') + ' — −' + sym + excessDeduction.toLocaleString('en-GB',{minimumFractionDigits:2}) + ' deducted</div>'
            : '');
        })()}

        <div class="sc-sections">

          <!-- Payments -->
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Payments (${payments.length})</span>
              ${payments.length ? `<span class="sc-sec-sum">${sym}${totalPaidEmp.toLocaleString('en-GB',{minimumFractionDigits:2})}</span>` : ''}
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              ${payments.length ? payments.map(p => `
                <div class="sc-item">
                  <span class="sc-item-date">${MONTHS[p.payment_month]?.slice(0,3)||p.payment_month} ${p.payment_year}</span>
                  <span class="sc-item-amt pos">+${sym}${parseFloat(p.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2})}</span>
                  <span class="sc-item-note">${esc(p.notes||'')}</span>
                  <button class="btn btn-danger btn-sm" onclick="deleteSalaryPayment(${p.id})">×</button>
                </div>`).join('') : `<div class="sc-empty">No payments logged yet.</div>`}
            </div>
          </div>

          ${paye ? `
          <!-- PAYE Breakdown -->
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">PAYE Breakdown (2024/25)</span>
              <span class="sc-sec-sum">${sym}${(paye.income_tax+paye.national_insurance+paye.pension).toLocaleString('en-GB',{minimumFractionDigits:2})}/yr deducted</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-paye-grid">
                <div class="sc-paye-box">
                  <div class="sc-paye-lbl">Income Tax</div>
                  <div class="sc-paye-val">${sym}${paye.income_tax.toLocaleString('en-GB',{minimumFractionDigits:2})}</div>
                  <div class="sc-paye-sub">per year</div>
                </div>
                <div class="sc-paye-box">
                  <div class="sc-paye-lbl">National Insurance</div>
                  <div class="sc-paye-val">${sym}${paye.national_insurance.toLocaleString('en-GB',{minimumFractionDigits:2})}</div>
                  <div class="sc-paye-sub">per year</div>
                </div>
                ${paye.pension > 0 ? `
                <div class="sc-paye-box">
                  <div class="sc-paye-lbl">Pension (${emp.pension_rate}%)</div>
                  <div class="sc-paye-val">${sym}${paye.pension.toLocaleString('en-GB',{minimumFractionDigits:2})}</div>
                  <div class="sc-paye-sub">per year</div>
                </div>` : ''}
              </div>
              <div class="sc-paye-footer">
                <span class="sc-paye-footer-lbl">Monthly take-home</span>
                <span class="sc-paye-footer-val">${sym}${paye.net_monthly.toLocaleString('en-GB',{minimumFractionDigits:2})}</span>
              </div>
            </div>
          </div>` : ''}

          <!-- Office Deductions -->
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Office Deductions (${officeDeductions.length})</span>
              ${officeTotal > 0 ? `<span class="sc-sec-sum red">−${sym}${officeTotal.toLocaleString('en-GB',{minimumFractionDigits:2})}</span>` : ''}
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-sec-actions">
                <button class="btn btn-ghost btn-sm" onclick="openOfficeDeductModal(${emp.employee_id})">+ Add Deduction</button>
              </div>
              ${officeDeductions.length ? officeDeductions.map(od => `
                <div class="sc-item">
                  <span class="sc-item-date">${od.deduction_date||''}</span>
                  <span class="sc-item-amt neg">−${sym}${parseFloat(od.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2})}</span>
                  <span class="sc-item-note">${esc(od.description||'')}${od.notes?` · ${esc(od.notes)}`:''}</span>
                  <button class="btn btn-danger btn-sm" onclick="deleteOfficeDeduction(${od.id})">×</button>
                </div>`).join('') : `<div class="sc-empty">No deductions logged.</div>`}
            </div>
          </div>

          <!-- Bonuses -->
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Bonuses (${bonuses.length})</span>
              ${bonusTotal > 0 ? `<span class="sc-sec-sum amber">+${sym}${bonusTotal.toLocaleString('en-GB',{minimumFractionDigits:2})}</span>` : ''}
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-sec-actions">
                <button class="btn btn-ghost btn-sm" style="border-color:rgba(245,158,11,0.4);color:var(--warning)" onclick="openBonusModal(${emp.employee_id})">+ Add Bonus</button>
              </div>
              ${bonuses.length ? bonuses.map(b => `
                <div class="sc-item" style="background:var(--warning-soft);border-color:rgba(245,158,11,0.35)">
                  <span class="sc-item-date">${b.bonus_date||''}</span>
                  <span class="sc-item-amt amb">+${sym}${parseFloat(b.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2})}</span>
                  <span class="sc-item-note">${esc(b.reason||'')}${b.notes?` · ${esc(b.notes)}`:''}</span>
                  <button class="btn btn-danger btn-sm" onclick="deleteBonus(${b.id})">×</button>
                </div>`).join('') : `<div class="sc-empty">No bonuses logged yet.</div>`}
            </div>
          </div>

          <!-- Days off (payroll only) -->
          ${emp.employment_type === 'payroll' ? `
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Days Off — ${totalDaysOff} / ${allowanceDays} used</span>
              ${excessDays > 0
                ? `<span class="sc-sec-sum red">−${sym}${excessDeduction.toLocaleString('en-GB',{minimumFractionDigits:2})} deducted</span>`
                : `<span class="sc-sec-sum muted">within allowance</span>`}
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-days-note">${excessDays > 0
                ? `${excessDays} day${excessDays > 1 ? 's' : ''} over the ${allowanceDays}-day allowance → ${sym}${excessDeduction.toLocaleString('en-GB',{minimumFractionDigits:2})} deducted from salary.`
                : `${totalDaysOff} of ${allowanceDays} free days used — no deduction.`}</div>
            </div>
          </div>` : ''}

          <!-- Pro-rated breakdown -->
          ${(emp.pro_rated || emp.first_month_full || (suggestedFirstMonthNet !== null && fmMeta)) ? (() => {
            const pr = emp.pro_rated;
            const fmr = emp.first_month_full;
            // Client-side fallback only (no server data)
            if (!pr && !fmr && suggestedFirstMonthNet !== null && fmMeta) {
              const grossMonthly = annualSalary / 12;
              const grossProrata = grossMonthly * (fmMeta.daysWorked / fmMeta.daysTotal);
              const payLabel = paye ? ('Net after PAYE/NI' + (paye.pension > 0 ? '/pension' : '')) : 'Pro-rata amount';
              return `
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Pro-Rated Pay — started ${fmMeta.startDate}</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-breakdown">
                <div class="sc-breakdown-title">First month payment — ${fmMeta.monthName}</div>
                <div class="sc-breakdown-row"><span>${fmMeta.daysWorked} of ${fmMeta.daysTotal} days in ${fmMeta.monthName}</span><span>${sym}${grossProrata.toLocaleString('en-GB',{minimumFractionDigits:2})} gross</span></div>
                <div class="sc-breakdown-row total"><span>${payLabel}</span><span>${sym}${suggestedFirstMonthNet.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>
              </div>
            </div>
          </div>`;
            }
            const showFmFull = fmr && fmr.first_month_days < fmr.first_month_total_days;
            const fmrName = fmr ? (MONTHS[parseInt(fmr.first_month.split('-')[1])] || fmr.first_month) : null;
            const fmrGross = fmr ? fmr.first_month_pay : 0;
            const fmrNet = fmr ? parseFloat((fmrGross * payeNetFactor).toFixed(2)) : 0;
            const startLabel = (fmr || pr).start_date;
            return `
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Pro-Rated Pay — started ${startLabel}</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              ${showFmFull ? `
              <div class="sc-breakdown">
                <div class="sc-breakdown-title">Payment due — end of ${fmrName}</div>
                <div class="sc-breakdown-row"><span>Working days (${fmr.first_month_days}/${fmr.first_month_total_days} in ${fmrName})</span><span>${sym}${fmrGross.toLocaleString('en-GB',{minimumFractionDigits:2})} gross</span></div>
                ${paye ? `<div class="sc-breakdown-row total"><span>Net after PAYE/NI${paye.pension > 0 ? '/pension' : ''}</span><span>${sym}${fmrNet.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>`
                       : `<div class="sc-breakdown-row total"><span>Gross amount due</span><span>${sym}${fmrGross.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>`}
              </div>` : ''}
              ${pr ? `
              <div class="sc-breakdown${showFmFull ? ' sc-breakdown-secondary' : ''}">
                <div class="sc-breakdown-title">${showFmFull ? 'Earned to today' : 'Earned pay to date'}</div>
                <div class="sc-breakdown-row"><span>First month (${pr.first_month_days}/${pr.first_month_total_days} working days)</span><span>${sym}${pr.first_month_pay.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>
                ${pr.full_months_count > 0 ? `<div class="sc-breakdown-row"><span>${pr.full_months_count} full month${pr.full_months_count > 1 ? 's' : ''}</span><span>${sym}${pr.full_months_pay.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>` : ''}
                <div class="sc-breakdown-row total"><span>Total expected to date</span><span>${sym}${pr.total_expected.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>
              </div>` : ''}
            </div>
          </div>`; })() : ''}

          <!-- Salary history / raises -->
          ${salaryHistory.length ? `
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Salary History (${salaryHistory.length})</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              ${salaryHistory.map(h => `
                <div class="sc-hist-item">
                  <span class="sc-item-date">${h.effective_from||''}</span>
                  <span style="font-weight:800;color:#059669;min-width:100px">${currencySymbol(h.currency||cur)}${parseFloat(h.annual_salary||0).toLocaleString('en-GB',{minimumFractionDigits:2})}/yr</span>
                  <span class="sc-item-note">${esc(h.reason||'')}</span>
                  <button class="btn btn-danger btn-sm" onclick="deleteSalaryHistory(${h.id})">×</button>
                </div>`).join('')}
            </div>
          </div>` : ''}

          <!-- Final pay breakdown for terminated -->
          ${isTerminated && eb ? `
          <div class="sc-section">
            <button class="sc-sec-toggle" onclick="toggleSection(this)">
              <span class="sc-sec-title">Final Pay Breakdown</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-breakdown danger">
                <div class="sc-breakdown-title">${emp.start_date ? `Started ${emp.start_date} → ` : ''}Terminated ${emp.termination_date}</div>
                <div class="sc-breakdown-row"><span>First month (${eb.first_month_days}/${eb.first_month_total_days} working days)</span><span>${sym}${eb.first_month_pay.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>
                ${eb.full_months_count > 0 ? `<div class="sc-breakdown-row"><span>${eb.full_months_count} full month${eb.full_months_count > 1 ? 's' : ''}</span><span>${sym}${eb.full_months_pay.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>` : ''}
                ${eb.last_month_pay > 0 ? `<div class="sc-breakdown-row"><span>Last month (pro-rated)</span><span>${sym}${eb.last_month_pay.toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>` : ''}
                <div class="sc-breakdown-row total"><span>Total earned</span><span>${sym}${(earnedTotal||0).toLocaleString('en-GB',{minimumFractionDigits:2})}</span></div>
              </div>
            </div>
          </div>` : ''}

          <!-- HR Notes -->
          <div class="sc-section" id="notes-section-${emp.employee_id}">
            <button class="sc-sec-toggle" onclick="toggleNotesSection(this, ${emp.employee_id})">
              <span class="sc-sec-title">HR Notes</span>
              <span class="sc-chevron">›</span>
            </button>
            <div class="sc-sec-body">
              <div class="sc-sec-actions">
                <button class="btn btn-ghost btn-sm" onclick="openNoteModal(${emp.employee_id})">+ Add Note</button>
              </div>
              <div id="notes-list-${emp.employee_id}" class="sc-notes-list">
                <div class="sc-empty">Click to load notes…</div>
              </div>
            </div>
          </div>

          <!-- Print / Export row -->
          <div class="sc-card-footer">
            <button class="btn btn-ghost btn-sm" onclick="printPayslip(${emp.employee_id}, '${esc(emp.name)}')" title="Print formatted payslip">🖨 Print Payslip</button>
          </div>

        </div>
      </div>`;
    }).join('');
  } catch(e) {
    console.error('loadSalaryPage error:', e);
    container.innerHTML = `<div class="alert alert-error" style="margin:24px">Failed to load salary data: ${esc(e.message)}. Please refresh and try again.</div>`;
  }
}

function toggleSection(btn) {
  btn.closest('.sc-section').classList.toggle('open');
}

function showSalaryBreakdown(key) {
  const rows = window._salaryRows || [];
  const BD_FX = { GBP: 1, AED: window._salaryAedRate || (1/4.67), PHP: 0.0138 };
  const toGBP = (v, cur) => v * (BD_FX[cur] || 1);
  const fmtGBP = v => '£' + Math.abs(v).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fmtCur = (v, cur) => currencySymbol(cur) + Math.abs(v).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});

  const titles = { paid: 'Total Paid — Breakdown', due: 'Total Salaries — Breakdown', outstanding: 'Outstanding Balance — Breakdown', bonuses: 'Total Bonuses — Breakdown' };
  const notes  = { paid: 'Payments logged this year per employee', due: 'Net annual salary target incl. PAYE/NI deductions', outstanding: 'Remaining balance after payments & deductions (excl. bonuses)', bonuses: 'Bonus payments logged per employee' };

  // Build per-employee rows
  const empRows = rows.map(emp => {
    const cur = emp.currency || 'GBP';
    let nativeVal, gbpVal, label;
    if (key === 'paid') {
      nativeVal = parseFloat(emp.total_paid) || 0;
      gbpVal    = toGBP(nativeVal, cur);
      label     = nativeVal;
    } else if (key === 'due') {
      nativeVal = parseFloat(emp.salary_target ?? emp.annual_salary) || 0;
      gbpVal    = toGBP(nativeVal, cur);
    } else if (key === 'outstanding') {
      nativeVal = parseFloat(emp.net_remaining) || 0;
      gbpVal    = toGBP(nativeVal, cur);
    } else { // bonuses
      nativeVal = parseFloat(emp.total_bonuses) || 0;
      gbpVal    = toGBP(nativeVal, cur);
    }
    return { emp, cur, nativeVal, gbpVal };
  }).filter(r => Math.abs(r.nativeVal) > 0.005)
    .sort((a, b) => Math.abs(b.gbpVal) - Math.abs(a.gbpVal));

  const totalGBP = empRows.reduce((s, r) => s + r.gbpVal, 0);

  const rowsHtml = empRows.map(({ emp, cur, nativeVal, gbpVal }) => {
    const isNeg = nativeVal < 0;
    const valColor = key === 'outstanding' ? (isNeg ? 'var(--positive)' : 'var(--negative)') : 'var(--text)';
    const deductHtml = key === 'outstanding' ? (() => {
      const od  = parseFloat(emp.total_office_deductions) || 0;
      const ed  = parseFloat(emp.excess_deduction) || 0;
      const paid = parseFloat(emp.total_paid) || 0;
      const target = parseFloat(emp.salary_target ?? emp.annual_salary) || 0;
      const parts = [];
      if (paid > 0)  parts.push('<span style="color:var(--positive)">−' + fmtCur(paid, cur) + ' paid</span>');
      if (od > 0)    parts.push('<span style="color:var(--negative)">−' + fmtCur(od, cur) + ' deductions</span>');
      if (ed > 0)    parts.push('<span style="color:var(--negative)">−' + fmtCur(ed, cur) + ' excess days</span>');
      return parts.length ? '<div style="font:500 10px/1.4 var(--font-mono);color:var(--muted);margin-top:3px">' + parts.join(' · ') + '</div>' : '';
    })() : '';
    return '<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font:700 11px/1 var(--font-mono);color:#000;flex-shrink:0">' +
        (emp.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font:600 13px/1 var(--font-sans);color:var(--text)">' + esc(emp.name||'') + '</div>' +
        '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:2px">' + esc(emp.job_title||emp.department||'') + '</div>' +
        deductHtml +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font:700 14px/1 var(--font-mono);color:' + valColor + '">' + (isNeg ? '−' : '') + fmtCur(nativeVal, cur) + '</div>' +
        (cur !== 'GBP' ? '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">≈ ' + fmtGBP(gbpVal) + ' GBP</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML =
    '<div class="modal" style="max-width:520px;max-height:80vh;display:flex;flex-direction:column">' +
      '<div class="modal-header" style="flex-shrink:0">' +
        '<h3 class="modal-title">' + titles[key] + '</h3>' +
        '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">×</button>' +
      '</div>' +
      '<div style="padding:0 20px 8px;flex-shrink:0">' +
        '<div style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + notes[key] + '</div>' +
        (key === 'outstanding' ? '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:4px">Excludes bonuses · AED @ ' + BD_FX.AED.toFixed(4) + ' · PHP @ 0.0138 GBP</div>' : '') +
      '</div>' +
      '<div style="overflow-y:auto;padding:0 20px 8px;flex:1">' +
        (rowsHtml || '<div style="color:var(--muted);padding:20px 0;font:500 12px/1 var(--font-mono)">No data.</div>') +
      '</div>' +
      '<div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:var(--surface)">' +
        '<span style="font:600 11px/1 var(--font-mono);color:var(--muted)">TOTAL (' + empRows.length + ' employee' + (empRows.length !== 1 ? 's' : '') + ')</span>' +
        '<span style="font:700 18px/1 var(--font-mono);color:var(--text)">' + fmtGBP(totalGBP) + '</span>' +
      '</div>' +
    '</div>';
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));
}

// ─── HR NOTES ─────────────────────────────────────────────────────────────────
async function toggleNotesSection(btn, empId) {
  const section = btn.closest('.sc-section');
  const wasOpen = section.classList.contains('open');
  section.classList.toggle('open');
  if (!wasOpen) await loadNotesList(empId);
}

async function loadNotesList(empId) {
  const container = document.getElementById(`notes-list-${empId}`);
  if (!container) return;
  const res = await fetch(`/api/employee-notes/${empId}`);
  if (!res.ok) { container.innerHTML = '<div class="sc-empty">Failed to load notes.</div>'; return; }
  const notes = await res.json();
  if (!notes.length) { container.innerHTML = '<div class="sc-empty">No notes yet.</div>'; return; }
  const NOTE_COLORS = { general: 'badge-grey', performance: 'badge-blue', hr: 'badge-purple', warning: 'badge-red' };
  container.innerHTML = notes.map(n => `
    <div class="sc-note-item">
      <div class="sc-note-meta">
        <span class="badge ${NOTE_COLORS[n.note_type] || 'badge-grey'}" style="font-size:0.62rem">${n.note_type}</span>
        <span class="sc-note-date">${new Date(n.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</span>
        ${n.created_by_name ? `<span class="sc-note-author">by ${esc(n.created_by_name)}</span>` : ''}
        <button class="btn btn-danger btn-sm" style="margin-left:auto;padding:2px 8px" onclick="deleteNote(${n.id},${empId})">×</button>
      </div>
      <div class="sc-note-text">${esc(n.note)}</div>
    </div>`).join('');
}

function openNoteModal(empId) {
  document.getElementById('noteEmpId').value = empId;
  document.getElementById('noteType').value = 'general';
  document.getElementById('noteText').value = '';
  openModal('noteModal');
}

async function saveNote() {
  const employee_id = document.getElementById('noteEmpId').value;
  const note_type   = document.getElementById('noteType').value;
  const note        = document.getElementById('noteText').value.trim();
  if (!note) return showToast('Note text is required', 'error');
  const res = await fetch('/api/employee-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id, note, note_type })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('noteModal');
  showToast('Note saved', 'success');
  await loadNotesList(employee_id);
}

async function deleteNote(id, empId) {
  if (!await showConfirm('Delete this note?')) return;
  await fetch(`/api/employee-notes/${id}`, { method: 'DELETE' });
  await loadNotesList(empId);
}

// ─── PAYROLL CSV EXPORT ───────────────────────────────────────────────────────
async function exportPayrollCSV() {
  const year = document.getElementById('salaryYear')?.value || new Date().getFullYear();
  showToast('Generating CSV…', 'info');
  const a = document.createElement('a');
  a.href = `/api/export/payroll-csv?year=${year}`;
  a.download = `payroll-${year}.csv`;
  a.click();
}

// ─── PRINT PAYSLIP ────────────────────────────────────────────────────────────
async function printPayslip(empId, empName) {
  const year  = document.getElementById('salaryYear')?.value || new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  showToast('Preparing payslip…', 'info');
  const res = await fetch(`/api/salary-overview?year=${year}`);
  if (!res.ok) return showToast('Failed to load salary data', 'error');
  const data = await res.json();
  const emp  = data.find(e => e.employee_id === empId);
  if (!emp)  return showToast('Employee data not found', 'error');

  const sym   = currencySymbol(emp.currency || 'GBP');
  const paye  = emp.paye_breakdown;
  const annSal = parseFloat(emp.annual_salary) || 0;
  const grossM = paye ? paye.gross_monthly : annSal / 12;
  const netM   = paye ? paye.net_monthly   : annSal / 12;
  const monthName = MONTHS[month];

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Payslip – ${empName} – ${monthName} ${year}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #0d1326; padding: 40px; max-width: 700px; margin: 0 auto; }
    .ps-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #4f46e5; padding-bottom: 16px; margin-bottom: 24px; }
    .ps-company { font-size: 1.4rem; font-weight: 800; color: #4f46e5; letter-spacing: -0.5px; }
    .ps-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: #566880; margin-top: 2px; }
    .ps-period { text-align: right; }
    .ps-period-val { font-size: 1.1rem; font-weight: 700; }
    .ps-period-sub { font-size: 0.75rem; color: #566880; }
    .ps-employee { background: #f0eeff; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; display: flex; gap: 40px; flex-wrap: wrap; }
    .ps-emp-field label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; color: #7c6fcd; font-weight: 700; display: block; margin-bottom: 3px; }
    .ps-emp-field span { font-weight: 600; }
    .ps-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .ps-table th { background: #e9eef6; padding: 9px 14px; text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; color: #566880; }
    .ps-table td { padding: 9px 14px; border-bottom: 1px solid #e4eaf3; }
    .ps-table tr:last-child td { border-bottom: none; }
    .ps-table .pos { color: #059669; font-weight: 700; }
    .ps-table .neg { color: #e11d48; font-weight: 700; }
    .ps-net { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #3730a3, #4f46e5); color: #fff; border-radius: 10px; padding: 16px 20px; margin-top: 16px; }
    .ps-net-label { font-size: 0.8rem; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
    .ps-net-val { font-size: 1.5rem; font-weight: 800; }
    .ps-footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e4eaf3; font-size: 0.72rem; color: #8698b2; text-align: center; }
    @media print { body { padding: 20px; } }
  </style></head><body>
  <div class="ps-header">
    <div>
      <div class="ps-company">EmpTracker</div>
      <div class="ps-title">Payslip</div>
    </div>
    <div class="ps-period">
      <div class="ps-period-val">${monthName} ${year}</div>
      <div class="ps-period-sub">Pay Period</div>
    </div>
  </div>
  <div class="ps-employee">
    <div class="ps-emp-field"><label>Employee</label><span>${esc(emp.name)}</span></div>
    ${emp.job_title ? `<div class="ps-emp-field"><label>Job Title</label><span>${esc(emp.job_title)}</span></div>` : ''}
    ${emp.department ? `<div class="ps-emp-field"><label>Department</label><span>${esc(emp.department)}</span></div>` : ''}
    <div class="ps-emp-field"><label>Employment Type</label><span>${emp.employment_type === 'self_employed' ? 'Self-Employed' : 'Payroll'}</span></div>
    <div class="ps-emp-field"><label>Currency</label><span>${emp.currency || 'GBP'}</span></div>
    ${emp.start_date ? `<div class="ps-emp-field"><label>Start Date</label><span>${emp.start_date}</span></div>` : ''}
  </div>
  <table class="ps-table">
    <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      <tr><td>Gross Monthly Salary</td><td class="pos" style="text-align:right">${sym}${grossM.toLocaleString('en-GB',{minimumFractionDigits:2})}</td></tr>
      ${paye ? `
      <tr><td>Income Tax (PAYE)</td><td class="neg" style="text-align:right">−${sym}${(paye.income_tax/12).toLocaleString('en-GB',{minimumFractionDigits:2})}</td></tr>
      <tr><td>National Insurance</td><td class="neg" style="text-align:right">−${sym}${(paye.national_insurance/12).toLocaleString('en-GB',{minimumFractionDigits:2})}</td></tr>
      ${paye.pension > 0 ? `<tr><td>Pension (${emp.pension_rate}%)</td><td class="neg" style="text-align:right">−${sym}${(paye.pension/12).toLocaleString('en-GB',{minimumFractionDigits:2})}</td></tr>` : ''}
      ` : ''}
    </tbody>
  </table>
  <div class="ps-net">
    <div><div class="ps-net-label">Net Monthly Pay</div></div>
    <div class="ps-net-val">${sym}${netM.toLocaleString('en-GB',{minimumFractionDigits:2})}</div>
  </div>
  <div class="ps-footer">Generated ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'})} · EmpTracker · Confidential</div>
  </body></html>`;

  const w = window.open('', '_blank', 'width=800,height=700');
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

function togglePaymentsList(btn) {
  const list = btn.nextElementSibling;
  const open = list.classList.toggle('open');
  btn.textContent = (open ? '▼' : '▶') + btn.textContent.slice(1);
}

function openSalaryPaymentModal(empId = '') {
  const now = new Date();
  const sel = document.getElementById('spEmpId');
  sel.innerHTML = '';
  employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id; opt.textContent = e.name; sel.appendChild(opt);
  });
  if (empId) sel.value = empId;
  document.getElementById('spYear').value  = now.getFullYear();
  document.getElementById('spMonth').value = now.getMonth() + 1;
  document.getElementById('spAmount').value = '';
  document.getElementById('spNotes').value  = '';
  // Auto-set currency from selected employee
  const emp = employees.find(e => String(e.id) === String(empId));
  document.getElementById('spCurrency').value = emp?.currency || 'GBP';
  openModal('salaryPayModal');
}

async function saveSalaryPayment() {
  const employee_id   = document.getElementById('spEmpId').value;
  const payment_year  = document.getElementById('spYear').value;
  const payment_month = document.getElementById('spMonth').value;
  const amount        = document.getElementById('spAmount').value;
  const notes         = document.getElementById('spNotes').value;
  const currency      = document.getElementById('spCurrency').value;
  if (!amount || parseFloat(amount) <= 0) return showToast('Enter a valid amount', 'error');
  const res = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id, payment_year, payment_month, amount, notes, currency })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('salaryPayModal');
  loadSalaryPage();
}

async function deleteSalaryPayment(id) {
  if (!await showConfirm('Delete this payment?')) return;
  await fetch(`/api/payments/${id}`, { method: 'DELETE' });
  loadSalaryPage();
}

function openOfficeDeductModal(empId) {
  document.getElementById('odEmpId').value = empId;
  document.getElementById('odDescription').value = '';
  document.getElementById('odAmount').value = '';
  document.getElementById('odDate').value = today();
  document.getElementById('odNotes').value = '';
  openModal('officeDeductModal');
}

async function saveOfficeDeduction() {
  const employee_id   = document.getElementById('odEmpId').value;
  const description   = document.getElementById('odDescription').value.trim();
  const amount        = document.getElementById('odAmount').value;
  const deduction_date = document.getElementById('odDate').value;
  const notes         = document.getElementById('odNotes').value;
  if (!description) return showToast('Description is required', 'error');
  if (!amount || parseFloat(amount) <= 0) return showToast('Enter a valid amount', 'error');
  const res = await fetch('/api/office-deductions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id, description, amount, deduction_date, notes })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('officeDeductModal');
  loadSalaryPage();
}

async function deleteOfficeDeduction(id) {
  if (!await showConfirm('Remove this deduction?')) return;
  await fetch(`/api/office-deductions/${id}`, { method: 'DELETE' });
  loadSalaryPage();
}

function openBonusModal(empId) {
  document.getElementById('bonusEmpId').value = empId;
  document.getElementById('bonusAmount').value = '';
  document.getElementById('bonusDate').value = today();
  document.getElementById('bonusReason').value = '';
  document.getElementById('bonusNotes').value = '';
  openModal('bonusModal');
}

async function saveBonusRecord() {
  const employee_id = document.getElementById('bonusEmpId').value;
  const amount      = document.getElementById('bonusAmount').value;
  const bonus_date  = document.getElementById('bonusDate').value;
  const reason      = document.getElementById('bonusReason').value.trim();
  const notes       = document.getElementById('bonusNotes').value.trim();
  if (!amount || parseFloat(amount) <= 0) return showToast('Enter a valid bonus amount', 'error');
  const res = await fetch('/api/bonuses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id, amount, bonus_date, reason, notes })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error, 'error'); }
  closeModal('bonusModal');
  loadSalaryPage();
}

async function deleteBonus(id) {
  if (!await showConfirm('Remove this bonus record?')) return;
  await fetch(`/api/bonuses/${id}`, { method: 'DELETE' });
  loadSalaryPage();
}

async function deleteSalaryHistory(id) {
  if (!await showConfirm('Remove this salary history entry?')) return;
  await fetch(`/api/salary-history/${id}`, { method: 'DELETE' });
  loadSalaryPage();
}

function fmtK(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(2);
}

// ─── CALENDAR ────────────────────────────────────────────────────────────────
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth() + 1; // 1-based
let calData  = []; // raw rows from /api/calendar

let calReminders = [];

async function loadCalendar() {
  document.getElementById('calMonthLabel').textContent = `${MONTHS[calMonth]} ${calYear}`;

  const empFilter = document.getElementById('calEmpFilter').value;

  const [calRes, remRes, pendingRes] = await Promise.all([
    fetch(`/api/calendar?year=${calYear}&month=${calMonth}`),
    fetch(`/api/calendar-reminders?year=${calYear}&month=${calMonth}`),
    fetch(`/api/day-off-requests`)
  ]);
  calData = await calRes.json();
  calReminders = remRes.ok ? await remRes.json() : [];
  const pendingRequests = pendingRes.ok ? await pendingRes.json() : [];
  renderDayOffRequestsBanner(pendingRequests);
  updateCalendarBadge(pendingRequests.length);

  // Update calSub
  const calSub = document.getElementById('calSub');
  if (calSub) {
    const daysOffCount = calData.length;
    const reminderCount = calReminders.length;
    calSub.textContent = `// ${MONTHS[calMonth]} ${calYear} · ${daysOffCount} day${daysOffCount !== 1 ? 's' : ''} off · ${reminderCount} reminder${reminderCount !== 1 ? 's' : ''}`;
  }

  const byDate = {};
  calData.forEach(r => { if (!byDate[r.record_date]) byDate[r.record_date] = []; byDate[r.record_date].push(r); });

  const remindersByDate = {};
  calReminders.forEach(r => { if (!remindersByDate[r.virtual_date]) remindersByDate[r.virtual_date] = []; remindersByDate[r.virtual_date].push(r); });

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDow = (new Date(calYear, calMonth - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const prevDays  = new Date(calYear, calMonth - 1, 0).getDate();
  const todayStr  = today();

  for (let i = 0; i < firstDow; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<div class="cal-date">${prevDays - firstDow + i + 1}</div>`;
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = (new Date(calYear, calMonth - 1, d).getDay() + 6) % 7;
    const entries = (byDate[dateStr] || []).filter(r => !empFilter || String(r.employee_id) === empFilter);
    const remindersToday = remindersByDate[dateStr] || [];

    const cell = document.createElement('div');
    const classes = ['cal-cell'];
    if (dateStr === todayStr) classes.push('today');
    if (dow >= 5) classes.push('weekend');
    if (entries.length) classes.push('has-offs');
    if (remindersToday.length) classes.push('has-reminders');
    cell.className = classes.join(' ');

    const maxShow = 2;
    const chips = entries.slice(0, maxShow).map(r => {
      const cls = parseFloat(r.is_day_off) === 1 ? 'chip-full' : 'chip-half';
      return `<span class="cal-chip ${cls}">${esc(r.employee_name)}</span>`;
    }).join('');
    const more = entries.length > maxShow ? `<div class="cal-more">+${entries.length - maxShow} more</div>` : '';
    const dots = remindersToday.length
      ? `<div class="cal-reminder-dots">${remindersToday.map(r => `<span class="cal-reminder-dot cat-${r.category}" title="${esc(r.title)}"></span>`).join('')}</div>`
      : '';

    cell.innerHTML = `<div class="cal-date">${d}</div><div class="cal-chips">${chips}${more}</div>${dots}`;
    cell.addEventListener('click', () => openDayModal(dateStr, entries, remindersToday));
    grid.appendChild(cell);
  }

  const totalCells = firstDow + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.innerHTML = `<div class="cal-date">${i}</div>`;
    grid.appendChild(cell);
  }

  renderCalSummary(byDate, empFilter);
}

async function renderCalSummary(byDate, empFilter) {
  const summary = document.getElementById('calSummary');
  const CAT_ICONS = { rent:'🏠', subscription:'📦', deposit:'💳', utility:'⚡', other:'📌' };

  // Fetch upcoming reminders (next 60 days)
  let reminders = [];
  try {
    const r = await fetch('/api/calendar-reminders/upcoming?days=60');
    if (r.ok) reminders = await r.json();
  } catch {}

  const dates = Object.keys(byDate).sort();
  let daysHtml = '';
  let fullDaysTotal = 0, halfDaysTotal = 0;
  dates.forEach(date => {
    const entries = byDate[date].filter(r => !empFilter || String(r.employee_id) === empFilter);
    if (!entries.length) return;
    entries.forEach(r => {
      const v = parseFloat(r.is_day_off);
      if (v === 1) fullDaysTotal++;
      else if (v === 0.5) halfDaysTotal++;
    });
    const chips = entries.map(r => {
      const cls = parseFloat(r.is_day_off) === 1 ? 'chip-full' : 'chip-half';
      const label = parseFloat(r.is_day_off) === 1 ? 'Full' : 'Half';
      return `<div class="cal-sum-row"><span class="cal-chip ${cls}">${label}</span><span class="cal-sum-name">${esc(r.employee_name)}</span></div>`;
    }).join('');
    daysHtml += `<div class="cal-sum-item"><div class="cal-sum-date">${formatDate(date)}</div>${chips}</div>`;
  });

  let remHtml = '';
  reminders.forEach(r => {
    const sym = r.currency === 'AED' ? 'AED ' : r.currency === 'EUR' ? '€' : '£';
    const amt = r.amount ? `<span class="cal-sum-amt">${sym}${parseFloat(r.amount).toLocaleString('en-GB',{minimumFractionDigits:2})}</span>` : '';
    remHtml += `<div class="cal-sum-item">
      <div class="cal-sum-date">${r.virtual_date}</div>
      <div class="cal-sum-row">${CAT_ICONS[r.category] || '📌'} <span class="cal-sum-name">${esc(r.title)}</span>${amt}</div>
    </div>`;
  });

  summary.classList.add('hidden');

  // ── Upcoming panel (next 60 days) ──
  const upcoming = document.getElementById('calUpcoming');
  if (!upcoming) return;

  const MONS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const todayD = new Date(); todayD.setHours(0,0,0,0);
  const in60 = new Date(todayD); in60.setDate(in60.getDate() + 60);

  // Future day-offs (all employees, next 60 days)
  let upcomingDayOffs = [];
  try {
    const r = await fetch(`/api/calendar?year=${todayD.getFullYear()}&month=${todayD.getMonth()+1}`);
    const d2r = await fetch(`/api/calendar?year=${in60.getFullYear()}&month=${in60.getMonth()+1}`);
    const d1 = r.ok ? await r.json() : [];
    const d2 = d2r.ok ? await d2r.json() : [];
    upcomingDayOffs = [...d1, ...d2].filter(r => {
      const d = new Date(r.record_date); d.setHours(0,0,0,0);
      return d >= todayD && d <= in60;
    }).sort((a,b) => a.record_date.localeCompare(b.record_date));
  } catch {}

  const dayOffItems = upcomingDayOffs.slice(0,10).map(r => {
    const d = new Date(r.record_date);
    const typeLabel = parseFloat(r.is_day_off) === 1 ? 'Full day' : 'Half day';
    const cls = parseFloat(r.is_day_off) === 1 ? 'chip-full' : 'chip-half';
    return `<div class="cal-upcoming-item">
      <div class="cal-upcoming-badge">
        <div class="cal-upcoming-badge-day">${d.getUTCDate()}</div>
        <div class="cal-upcoming-badge-mon">${MONS_SHORT[d.getUTCMonth()]}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="cal-upcoming-name">${empLink(r.employee_id, r.employee_name)}</div>
        <div class="cal-upcoming-sub"><span class="cal-chip ${cls}" style="font-size:9px;padding:1px 5px">${typeLabel}</span></div>
      </div>
    </div>`;
  }).join('') || '<div class="cal-upcoming-empty">No days off in the next 60 days</div>';

  const remItems = reminders.slice(0,10).map(r => {
    const d = new Date(r.virtual_date);
    const sym = r.currency === 'AED' ? 'AED ' : r.currency === 'EUR' ? '€' : '£';
    const amt = r.amount ? `<div class="cal-upcoming-amt">${sym}${parseFloat(r.amount).toLocaleString('en-GB',{minimumFractionDigits:2})}</div>` : '';
    const daysUntil = Math.round((d - todayD) / 86400000);
    const urgency = daysUntil <= 7 ? 'color:var(--negative);font-weight:700' : daysUntil <= 14 ? 'color:var(--warning);font-weight:600' : 'color:var(--muted)';
    return `<div class="cal-upcoming-item">
      <div class="cal-upcoming-badge">
        <div class="cal-upcoming-badge-day">${d.getUTCDate()}</div>
        <div class="cal-upcoming-badge-mon">${MONS_SHORT[d.getUTCMonth()]}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="cal-upcoming-name">${esc(r.title)}</div>
        <div class="cal-upcoming-sub" style="${urgency}">${daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `in ${daysUntil} days`}</div>
      </div>
      ${amt}
    </div>`;
  }).join('') || '<div class="cal-upcoming-empty">No upcoming expense reminders</div>';

  upcoming.innerHTML = `
    <div class="cal-upcoming-section">
      <div class="cal-upcoming-head"><span class="cal-upcoming-icon">🏖</span> Upcoming Days Off</div>
      ${dayOffItems}
    </div>
    <div class="cal-upcoming-section">
      <div class="cal-upcoming-head"><span class="cal-upcoming-icon">🔔</span> Upcoming Expenses</div>
      ${remItems}
    </div>`;
}

function renderDayOffRequestsBanner(pending) {
  let banner = document.getElementById('dayOffRequestsBanner');
  if (!banner) {
    const calPage = document.getElementById('page-calendar');
    if (!calPage) return;
    banner = document.createElement('div');
    banner.id = 'dayOffRequestsBanner';
    calPage.insertBefore(banner, calPage.firstChild);
  }
  if (!pending.length) { banner.innerHTML = ''; return; }

  const MONS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const rows = pending.map(r => {
    const d = new Date(r.request_date);
    const typeLabel = parseFloat(r.is_day_off) === 1 ? 'Full day' : 'Half day';
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border)">' +
      '<div style="width:36px;text-align:center;background:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:5px 0;flex-shrink:0">' +
        '<div style="font:800 13px/1 var(--font-mono);color:#fff">' + d.getUTCDate() + '</div>' +
        '<div style="font:600 9px/1 var(--font-mono);color:rgba(255,255,255,0.75)">' + MONS[d.getUTCMonth()] + '</div>' +
      '</div>' +
      '<div style="flex:1">' +
        '<div style="font:600 13px/1 var(--font-sans);color:var(--text)">' + esc(r.employee_name) + '</div>' +
        '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:3px">' + typeLabel + (r.department ? ' · ' + esc(r.department) : '') + '</div>' +
        (r.reason ? '<div style="font:500 11px/1.4 var(--font-sans);color:var(--text-2);margin-top:4px;padding:4px 8px;background:var(--surface);border-radius:4px;border-left:2px solid var(--warning)">' + esc(r.reason) + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">' +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-primary btn-sm" onclick="approveLeave(' + r.id + ')">Approve</button>' +
          '<button class="btn btn-danger btn-sm" onclick="declineLeave(' + r.id + ')">Decline</button>' +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:5px;font:500 10.5px/1 var(--font-sans);color:var(--muted);cursor:pointer;white-space:nowrap">' +
          '<input type="checkbox" id="dor-nodeduct-' + r.id + '" style="width:13px;height:13px;cursor:pointer">' +
          'No deduct' +
        '</label>' +
      '</div>' +
    '</div>';
  }).join('');

  banner.innerHTML =
    '<div class="card" style="margin-bottom:16px;border:1px solid var(--warning)">' +
      '<div class="card-header" style="background:var(--warning)22">' +
        '<span class="card-title">Pending Day-Off Requests</span>' +
        '<span style="font:700 11px/1 var(--font-mono);color:var(--muted)">' + pending.length + ' pending</span>' +
      '</div>' +
      '<div>' + rows + '</div>' +
    '</div>';
}

async function approveLeave(id) {
  const noDeduct = document.getElementById('dor-nodeduct-' + id)?.checked || false;
  const res = await fetch('/api/day-off-requests/' + id + '/approve', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ no_deduction: noDeduct })
  });
  if (res.ok) { showToast(noDeduct ? 'Day off approved (no deduct)' : 'Day off approved', 'success'); loadCalendar(); }
  else showToast('Failed to approve', 'error');
}

async function declineLeave(id) {
  const reason = prompt('Reason for declining (optional):') ?? '';
  const res = await fetch('/api/day-off-requests/' + id + '/decline', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason })
  });
  if (res.ok) { showToast('Request declined', 'success'); loadCalendar(); }
  else showToast('Failed to decline', 'error');
}

function openDayModal(dateStr, entries, remindersToday = []) {
  document.getElementById('dayModalTitle').textContent = formatDate(dateStr);
  const CAT_ICONS = { rent:'🏠', subscription:'📦', deposit:'💳', utility:'⚡', other:'📌' };
  const REC_LABEL = { none:'one-time', monthly:'monthly', yearly:'yearly' };

  let content = '';

  if (remindersToday.length) {
    content += `<div style="margin-bottom:14px">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--warning);margin-bottom:8px">Expense Reminders</div>
      ${remindersToday.map(r => `
        <div class="cal-reminder-entry">
          <span style="font-size:1.1rem;flex-shrink:0">${CAT_ICONS[r.category] || '📌'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700">${esc(r.title)}${r.amount ? ` <span style="color:var(--warning);font-weight:800;margin-left:6px">${currencySymbol(r.currency)}${parseFloat(r.amount).toLocaleString('en-GB',{minimumFractionDigits:2})}</span>` : ''}</div>
            <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${REC_LABEL[r.recurrence] || 'one-time'}${r.notes ? ' · ' + esc(r.notes) : ''}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="deleteCalReminder(${r.id})">Del</button>
        </div>`).join('')}
    </div>`;
  }

  if (entries.length) {
    content += `<div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted);margin-bottom:8px">Days Off</div>`;
    content += entries.map(r => {
      const label = parseFloat(r.is_day_off) === 1 ? 'Full Day' : 'Half Day';
      const cls   = parseFloat(r.is_day_off) === 1 ? 'chip-full' : 'chip-half';
      const typeLabel = r.employment_type === 'self_employed' ? 'Self-Emp' : 'Payroll';
      return `<div class="day-off-entry">
        <span class="cal-chip ${cls}">${label}</span>
        <strong>${esc(r.employee_name)}</strong>
        <span class="badge badge-grey" style="font-size:0.72rem">${typeLabel}</span>
        ${r.notes ? `<span style="color:var(--muted);font-size:0.8rem">${esc(r.notes)}</span>` : ''}
        <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="deleteRecord(${r.record_id});closeModal('dayModal')">Remove</button>
      </div>`;
    }).join('');
  }

  if (!content) {
    content = `<p style="color:var(--muted);font-size:0.88rem">No entries for this date.</p>`;
  }

  document.getElementById('dayModalContent').innerHTML = content;
  document.getElementById('dayModalBookBtn').onclick = () => { closeModal('dayModal'); openRecordModalForDate(dateStr); };
  openModal('dayModal');
}

function openRecordModalForDate(dateStr) {
  document.getElementById('recId').value = '';
  document.getElementById('recEmpId').value = '';
  document.getElementById('recDate').value = dateStr;
  document.getElementById('recBreak').value = 40;
  document.getElementById('recPhone').value = 0;
  document.getElementById('recWasted').value = 0;
  document.getElementById('recLate').value = 0;
  document.getElementById('recDayOff').value = '1';
  document.getElementById('recNoDeduction').checked = false;
  document.getElementById('recNotes').value = '';
  document.getElementById('recFields').style.display = 'none';
  document.getElementById('recNoDeductRow').style.display = '';
  document.getElementById('recordModalTitle').textContent = 'Book Day Off – ' + dateStr;

  // Show employee selector and populate it
  const empRow = document.getElementById('recEmpRow');
  const empSel = document.getElementById('recEmpSelect');
  empSel.innerHTML = '<option value="">-- Select Employee --</option>';
  employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id; opt.textContent = e.name;
    empSel.appendChild(opt);
  });
  empRow.classList.remove('hidden');

  updatePreview();
  openModal('recordModal');
}

function calPrevMonth() {
  calMonth--;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  loadCalendar();
}

function calGoToday() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  loadCalendar();
}

function calNextMonth() {
  calMonth++;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  loadCalendar();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Esc closes the topmost open modal (covers class-based and inline-display overlays)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const overlays = Array.from(document.querySelectorAll('.modal-overlay')).filter(m =>
    m.classList.contains('open') || m.classList.contains('active') || m.style.display === 'flex');
  const top = overlays[overlays.length - 1];
  if (!top) return;
  if (top.classList.contains('open')) top.classList.remove('open');
  else if (top.classList.contains('active')) top.remove();
  else top.style.display = 'none';
});
function today() { return new Date().toISOString().slice(0, 10); }
function formatDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}
function thisMonth() {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const last = new Date(now.getFullYear(), now.getMonth()+1, 0);
  return { from, to: last.toISOString().slice(0,10) };
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── TOAST NOTIFICATIONS ─────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.setProperty('--toast-dur', duration + 'ms');
  toast.innerHTML = `
    <div class="toast-body">
      <span class="toast-msg">${esc(String(msg))}</span>
      <button class="toast-close" onclick="dismissToast(this.parentElement.parentElement)">✕</button>
    </div>
    <div class="toast-progress"></div>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (!toast || toast._dismissing) return;
  toast._dismissing = true;
  clearTimeout(toast._timer);
  toast.classList.add('dismissing');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
  setTimeout(() => toast.remove(), 600);
}

// ─── CONFIRM / PROMPT DIALOGS ─────────────────────────────────────────────────
function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">Confirm</span></div>
        <div class="modal-body"><p style="margin:0 0 20px;font-size:0.92rem">${esc(msg)}</p>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn btn-ghost" id="_cfCancel">Cancel</button>
            <button class="btn btn-danger" id="_cfOk">Confirm</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#_cfOk').onclick     = () => cleanup(true);
    overlay.querySelector('#_cfCancel').onclick  = () => cleanup(false);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
  });
}

function showPrompt(msg, placeholder = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px">
        <div class="modal-header"><span class="modal-title">${esc(msg)}</span></div>
        <div class="modal-body">
          <input id="_promptInput" class="form-control" placeholder="${esc(placeholder)}" style="margin-bottom:16px">
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn btn-ghost" id="_prCancel">Cancel</button>
            <button class="btn btn-primary" id="_prOk">OK</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#_promptInput');
    input.focus();
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#_prOk').onclick     = () => cleanup(input.value.trim() || null);
    overlay.querySelector('#_prCancel').onclick  = () => cleanup(null);
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') cleanup(input.value.trim() || null); });
  });
}

// ─── SALARY BADGE ─────────────────────────────────────────────────────────────
function updateSalaryBadge(count) {
  ['salaryNavBadge', 'salaryBottomBadge'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  });
}

function updateCalendarBadge(count) {
  ['calNavBadge', 'calBellBadge'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  });
}

async function refreshCalendarBadge() {
  try {
    const res = await fetch('/api/day-off-requests');
    if (res.ok) updateCalendarBadge((await res.json()).length);
  } catch {}
}

// ─── SALARY REMINDER PANEL ────────────────────────────────────────────────────
function getUnpaidThisMonth(overview, year, month) {
  return (overview || []).filter(emp => {
    if (emp.is_terminated || !emp.annual_salary || parseFloat(emp.annual_salary) <= 0) return false;
    if (emp.start_date) {
      const [sy, sm] = emp.start_date.slice(0, 7).split('-').map(Number);
      if (sy > year || (sy === year && sm > month)) return false;
    }
    const skipKey = `paySkip_${year}_${month}_${emp.employee_id}`;
    if (localStorage.getItem(skipKey)) return false;
    const paid = (emp.payments || []).some(p =>
      parseInt(p.payment_year) === year && parseInt(p.payment_month) === month
    );
    return !paid;
  });
}

// Expand/collapse a group's "to pay" list inside the salary summary table
function toggleSalaryGroup(key) {
  window._salGrpOpen = window._salGrpOpen || {};
  const open = !window._salGrpOpen[key];
  window._salGrpOpen[key] = open;
  const detail = document.getElementById('salgrp-detail-' + key);
  const head   = document.getElementById('salgrp-head-' + key);
  if (detail) detail.style.display = open ? '' : 'none';
  if (head) {
    head.classList.toggle('sal-grp-open', open);
    const chev = head.querySelector('.sal-grp-chevron');
    if (chev) chev.textContent = open ? '▼' : '▶';
  }
}

// Skip a single employee for the current month from the merged summary list
function skipGroupReminder(empId) {
  const now = new Date();
  localStorage.setItem(`paySkip_${now.getFullYear()}_${now.getMonth() + 1}_${empId}`, '1');
  loadSalaryPage();
}

// ─── CALENDAR REMINDERS ───────────────────────────────────────────────────────
function openCalReminderModal(dateStr = null) {
  document.getElementById('crTitle').value    = '';
  document.getElementById('crCategory').value = 'other';
  document.getElementById('crDate').value     = dateStr || today();
  document.getElementById('crRecurrence').value = 'none';
  document.getElementById('crAmount').value   = '';
  document.getElementById('crCurrency').value = 'GBP';
  document.getElementById('crNotes').value    = '';
  document.getElementById('crVisibleToStaff').checked = false;
  openModal('calReminderModal');
}

async function saveCalReminder() {
  const title      = document.getElementById('crTitle').value.trim();
  const category   = document.getElementById('crCategory').value;
  const reminderDate = document.getElementById('crDate').value;
  const recurrence = document.getElementById('crRecurrence').value;
  const amount     = document.getElementById('crAmount').value;
  const currency   = document.getElementById('crCurrency').value;
  const notes      = document.getElementById('crNotes').value.trim();
  if (!title)        return showToast('Title is required', 'error');
  if (!reminderDate) return showToast('Date is required', 'error');
  const res = await fetch('/api/calendar-reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, reminder_date: reminderDate, recurrence, amount: amount || null, currency, notes, visible_to_staff: document.getElementById('crVisibleToStaff').checked })
  });
  if (!res.ok) { const e = await res.json(); return showToast(e.error || 'Save failed', 'error'); }
  closeModal('calReminderModal');
  showToast('Reminder saved', 'success');
  loadCalendar();
}

async function deleteCalReminder(id) {
  if (!await showConfirm('Delete this reminder? All recurrences will be removed.')) return;
  const res = await fetch(`/api/calendar-reminders/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Reminder deleted', 'success');
  closeModal('dayModal');
  loadCalendar();
}

// ─── DASHBOARD UPCOMING WIDGET ────────────────────────────────────────────────
function renderUpcomingWidget(upcoming) {
  const stats = document.getElementById('dashStats');
  if (!stats) return;
  const existing = document.getElementById('upcomingWidget');
  if (existing) existing.remove();
  if (!upcoming || !upcoming.length) return;

  const CAT_ICONS = { rent:'🏠', subscription:'📦', deposit:'💳', utility:'⚡', other:'📌' };
  const widget = document.createElement('div');
  widget.id = 'upcomingWidget';
  widget.className = 'dashboard-widget';
  widget.innerHTML = `
    <div class="dashboard-widget-header">Upcoming Reminders (next 7 days)</div>
    <div class="dashboard-widget-body">
      ${upcoming.map(r => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:1.1rem">${CAT_ICONS[r.category] || '📌'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:0.88rem">${esc(r.title)}</div>
            <div style="font-size:0.75rem;color:var(--muted)">${r.virtual_date}${r.amount ? ' · ' + currencySymbol(r.currency) + parseFloat(r.amount).toLocaleString('en-GB',{minimumFractionDigits:2}) : ''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  stats.insertAdjacentElement('afterend', widget);
}

// ─── HOTEL EXPENSES ──────────────────────────────────────────────────────────

let hotelData = [];
let _hotelYearFilter = 'all';
const HOTEL_YEARS = [2025, 2026, 2027, 2028];

async function loadHotelExpenses() {
  const res = await fetch('/api/hotel-expenses');
  if (!res.ok) { showToast('Failed to load hotel expenses', 'error'); return; }
  hotelData = await res.json();
  renderHotelSummary();
  renderHotelTable();
}

function setHotelYear(btn, yr) {
  _hotelYearFilter = yr;
  document.querySelectorAll('#hotelYearFilters .deal-q-btn').forEach(b => b.classList.toggle('active', b.dataset.hyr === yr));
  renderHotelSummary();
  renderHotelTable();
}

function hotelYearFiltered() {
  if (_hotelYearFilter === 'all') return hotelData;
  const yr = parseInt(_hotelYearFilter);
  return hotelData.filter(r => parseInt(r.event_year) === yr);
}

// Year a newly added event should default to: the year tab you're looking at,
// falling back to the current calendar year on "All Years".
function hotelDefaultYear() {
  const yr = parseInt(_hotelYearFilter);
  return Number.isFinite(yr) ? yr : new Date().getFullYear();
}

function hotelCurrencySymbol(c) {
  if (c === 'GBP') return '£';
  if (c === 'EUR') return '€';
  if (c === 'CHF') return 'CHF ';
  if (c === 'AED') return 'AED ';
  return '$';
}

function fmtHotelNum(v) {
  if (v == null || v === '') return '—';
  return parseFloat(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtHotelAmount(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1) + 'k';
  return v.toFixed(0);
}

function renderHotelSummary() {
  const yearData = hotelYearFiltered();

  function parseCost(str) {
    if (!str) return 0;
    return parseFloat(String(str).replace(/[^0-9.]/g, '')) || 0;
  }

  const byCur = {};
  function ensureCur(c) { byCur[c] = byCur[c] || { paid: 0, av: 0, cost: 0 }; }
  yearData.forEach(r => {
    const paidCur = r.paid_currency || r.currency || 'USD';
    const avCur   = r.av_currency   || r.currency || 'USD';
    const costCur = r.paid_currency || r.currency || 'USD';
    ensureCur(paidCur);
    if (r.paid_amount != null) byCur[paidCur].paid += parseFloat(r.paid_amount) || 0;
    if (r.av_amount != null && r.av_billing !== 'included') {
      ensureCur(avCur);
      byCur[avCur].av += parseFloat(r.av_amount) || 0;
    }
    const costNum = parseCost(r.cost);
    ensureCur(costCur);
    if (costNum > 0) byCur[costCur].cost += costNum;
  });

  const total  = yearData.length;
  const unpaid = yearData.filter(r => r.status !== 'paid').length;
  const fmtN = n => n.toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});

  // GBP conversion rates (approximate)
  const TO_GBP = { GBP:1, USD:0.787, EUR:0.855, CHF:0.885, AED:0.2141, PHP:0.0138 };
  let gbpPaid = 0, gbpAv = 0, gbpCost = 0;
  Object.entries(byCur).forEach(([cur, sums]) => {
    const rate = TO_GBP[cur] || 0.787;
    gbpPaid += sums.paid * rate;
    gbpAv   += sums.av   * rate;
    gbpCost += sums.cost * rate;
  });
  const gbpOutstanding = gbpCost > 0 ? Math.max(0, gbpCost - gbpPaid) : null;
  const yr = _hotelYearFilter !== 'all' ? ` · ${_hotelYearFilter}` : '';

  // Headline figures, all in GBP; the per-currency detail sits in a table below.
  const card = (label, value, sub, extra = '') => `
    <div class="deal-stat-card ${extra}">
      <div class="deal-stat-label">${label}</div>
      <div class="deal-stat-value">${value}</div>
      <div class="deal-stat-sub">${sub}</div>
    </div>`;
  const cards = `<div class="deal-stat-cards">
    ${card(`Hotel cost${yr}`, gbpCost > 0 ? '£' + fmtN(gbpCost) : '—', `${total} event${total === 1 ? '' : 's'} · in GBP`)}
    ${card('AV cost', '£' + fmtN(gbpAv), 'Billed separately')}
    ${card('Paid so far', '£' + fmtN(gbpPaid), `${total - unpaid} of ${total} fully paid`)}
    ${card('Outstanding', gbpOutstanding === null ? '—' : '£' + fmtN(gbpOutstanding),
           unpaid > 0 ? `${unpaid} event${unpaid === 1 ? '' : 's'} still to pay` : 'All settled',
           unpaid > 0 ? 'ds--remaining' : 'ds--remaining is-clear')}
  </div>`;

  const curRows = Object.entries(byCur).filter(([, s]) => s.cost || s.av || s.paid).map(([cur, sums]) => {
    const sym = hotelCurrencySymbol(cur);
    const outstanding = sums.cost > 0 ? Math.max(0, sums.cost - sums.paid) : null;
    return `<tr>
      <td><strong>${cur}</strong></td>
      <td class="dt-r">${sums.cost > 0 ? sym + fmtN(sums.cost) : '—'}</td>
      <td class="dt-r">${sym}${fmtN(sums.av)}</td>
      <td class="dt-r">${sym}${fmtN(sums.paid)}</td>
      <td class="dt-r">${outstanding === null ? '—' : outstanding > 0 ? `<span class="hotel-owe">${sym}${fmtN(outstanding)}</span>` : '<span class="hotel-settled">Settled</span>'}</td>
    </tr>`;
  }).join('');
  const byCurrency = curRows ? `
    <div class="card hotel-cur-card">
      <div class="card-header"><span class="card-title">By currency</span>
        <span class="hotel-cur-rates">GBP figures use USD×0.787 · EUR×0.855 · CHF×0.885 · AED×0.214</span></div>
      <div class="table-wrap"><table class="hotel-cur-table">
        <thead><tr><th>Currency</th><th class="dt-r">Hotel cost</th><th class="dt-r">AV cost</th><th class="dt-r">Paid</th><th class="dt-r">Outstanding</th></tr></thead>
        <tbody>${curRows}</tbody>
      </table></div>
    </div>` : '';

  document.getElementById('hotelSummary').innerHTML = cards + byCurrency;
}

function renderHotelTable() {
  const search = (document.getElementById('hotelSearch')?.value || '').toLowerCase();
  const statusF = document.getElementById('hotelStatusFilter')?.value || '';
  const yearData = hotelYearFiltered();
  const filtered = yearData.filter(r => {
    const matchSearch = !search || r.event_name.toLowerCase().includes(search) || (r.hotel||'').toLowerCase().includes(search);
    const matchStatus = !statusF || r.status === statusF;
    return matchSearch && matchStatus;
  });

  const tbody = document.getElementById('hotelTableBody');
  const empty = document.getElementById('hotelEmpty');
  document.getElementById('hotelRowCount').textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const STATUS_BADGE = {
    paid:    '<span class="badge badge-green">Paid</span>',
    partial: '<span class="badge badge-yellow">Partial</span>',
    pending: '<span class="badge badge-grey">Pending</span>'
  };

  const CURRENCIES = ['USD','GBP','EUR','CHF','AED','CAD','AUD'];
  const curOpts = CURRENCIES.map(c => `<option>${c}</option>`).join('');

  tbody.innerHTML = filtered.map(r => {
    const rowClass = r.status === 'paid' ? 'hotel-row-paid' : r.status === 'partial' ? 'hotel-row-partial' : '';
    const rowCur  = r.currency || r.paid_currency || 'USD';
    const avSym   = hotelCurrencySymbol(rowCur);
    const paidSym = hotelCurrencySymbol(rowCur);

    function cellText(field, val, style='') {
      const display = val != null && val !== '' ? esc(String(val)) : '<span class="ht-empty">—</span>';
      return `<td class="ht-cell" data-id="${r.id}" data-field="${field}" data-val="${val != null ? esc(String(val)) : ''}" onclick="htEditCell(this)" style="${style}">${display}</td>`;
    }
    function cellNum(field, val, style='') {
      const display = val != null ? fmtHotelNum(val) : '<span class="ht-empty">—</span>';
      return `<td class="ht-cell ht-num" data-id="${r.id}" data-field="${field}" data-val="${val != null ? val : ''}" onclick="htEditCell(this)" style="${style}">${display}</td>`;
    }
    function cellCur(field, val) {
      return `<td class="ht-cell ht-cur-sel" data-id="${r.id}" data-field="${field}" data-val="${val||'USD'}">
        <select class="ht-select" onchange="htPatchField(${r.id},'${field}',this.value)" onclick="event.stopPropagation()">
          ${CURRENCIES.map(c=>`<option${c===(val||'USD')?' selected':''}>${c}</option>`).join('')}
        </select>
      </td>`;
    }

    const avBilling = r.av_billing === 'included'
      ? `<span class="hotel-incl-badge" style="margin-left:4px">incl.</span>`
      : '';

    const hasInvoice = !!r.invoice_name;
    const invoiceCell = hasInvoice
      ? `<div style="display:flex;gap:4px;align-items:center">
           <a href="/api/hotel-expenses/${r.id}/invoice" target="_blank" class="btn btn-ghost btn-sm" style="font-size:0.72rem;padding:3px 7px" title="${esc(r.invoice_name)}">📄 View</a>
           <button class="btn btn-danger btn-sm" style="padding:3px 6px" onclick="htDeleteInvoice(${r.id})" title="Remove invoice">×</button>
         </div>`
      : `<label class="ht-upload-btn" title="Upload invoice">
           📎 Upload
           <input type="file" accept=".pdf,.png,.jpg,.jpeg" style="display:none" onchange="htUploadInvoice(${r.id},this)">
         </label>`;

    return `<tr class="${rowClass}" id="htr-${r.id}">
      ${cellText('event_name', r.event_name, 'font-weight:700')}
      ${cellText('hotel', r.hotel||'')}
      ${cellText('cost', r.cost||'')}
      ${cellCur('currency', r.currency || r.paid_currency || 'USD')}
      ${cellNum('av_amount', r.av_amount)}
      <td class="ht-cell ht-cur-sel" data-id="${r.id}" data-field="av_billing" data-val="${r.av_billing||'separate'}">
        <select class="ht-select" onchange="htPatchField(${r.id},'av_billing',this.value)" onclick="event.stopPropagation()">
          <option value="separate"${(r.av_billing||'separate')==='separate'?' selected':''}>Sep.</option>
          <option value="included"${r.av_billing==='included'?' selected':''}>Incl.</option>
        </select>
      </td>
      ${cellNum('paid_amount', r.paid_amount, 'font-weight:600')}
      <td class="ht-cell ht-cur-sel" data-id="${r.id}" data-field="status">
        <select class="ht-select ht-status-sel" onchange="htPatchField(${r.id},'status',this.value);htUpdateRowClass(${r.id},this.value)" onclick="event.stopPropagation()">
          <option value="pending"${(r.status||'pending')==='pending'?' selected':''}>Pending</option>
          <option value="partial"${r.status==='partial'?' selected':''}>Partial</option>
          <option value="paid"${r.status==='paid'?' selected':''}>Paid</option>
        </select>
      </td>
      <td class="ht-cell ht-cur-sel" data-id="${r.id}" data-field="event_year" data-val="${r.event_year || ''}">
        <select class="ht-select" onchange="htMoveYear(${r.id},this.value)" onclick="event.stopPropagation()" title="Move this event to another year">
          <option value=""${!r.event_year ? ' selected' : ''}>—</option>
          ${HOTEL_YEARS.map(y=>`<option value="${y}"${parseInt(r.event_year)===y?' selected':''}>${y}</option>`).join('')}
        </select>
      </td>
      <td style="padding:4px 8px">${invoiceCell}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteHotelExpense(${r.id})">×</button></td>
      <td style="padding:4px 6px;text-align:center">
        <button class="ht-notes-btn${r.notes ? ' ht-notes-btn--has' : ''}" onclick="toggleHotelNotes(${r.id})" title="${r.notes ? 'View/edit notes' : 'Add notes'}">📝</button>
      </td>
    </tr>
    <tr id="hotel-notes-row-${r.id}" class="hotel-notes-row" style="display:none">
      <td colspan="12" style="padding:0">
        <div class="hotel-notes-panel">
          <textarea id="hotel-notes-ta-${r.id}" class="hotel-notes-ta" placeholder="Add notes for this event…" onblur="saveHotelNotes(${r.id})">${esc(r.notes || '')}</textarea>
          <div class="hotel-notes-hint">Changes save automatically when you click away</div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function toggleHotelDetail(id) {
  const detail = document.getElementById('hotel-detail-' + id);
  const chev   = document.getElementById('hotel-chev-' + id);
  if (!detail) return;
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'table-row';
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
}

function toggleHotelNotes(id) {
  const row = document.getElementById('hotel-notes-row-' + id);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : 'table-row';
  if (!open) {
    const ta = document.getElementById('hotel-notes-ta-' + id);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

async function saveHotelNotes(id) {
  const ta = document.getElementById('hotel-notes-ta-' + id);
  if (!ta) return;
  const notes = ta.value;
  await htPatchField(id, 'notes', notes);
  const btn = document.querySelector(`#htr-${id} .ht-notes-btn`);
  if (btn) {
    btn.classList.toggle('ht-notes-btn--has', !!notes.trim());
    btn.title = notes.trim() ? 'View/edit notes' : 'Add notes';
  }
  const rec = hotelData.find(h => h.id === id);
  if (rec) rec.notes = notes;
}

function openHotelModal(id) {
  const r = id ? hotelData.find(x => x.id === id) : null;
  document.getElementById('hotelModalTitle').textContent = r ? 'Edit Hotel Expense' : 'Add Hotel Expense';
  document.getElementById('hotelEditId').value = r ? r.id : '';
  document.getElementById('hotelEventName').value  = r ? r.event_name : '';
  document.getElementById('hotelHotelName').value  = r ? (r.hotel || '') : '';
  document.getElementById('hotelCost').value        = r ? (r.cost || '') : '';
  document.getElementById('hotelStatus').value      = r ? r.status : 'pending';
  document.getElementById('hotelRowCurrency').value = r ? (r.currency || r.paid_currency || 'USD') : 'USD';
  document.getElementById('hotelAvAmount').value    = r && r.av_amount != null ? r.av_amount : '';
  document.getElementById('hotelAvBilling').value   = r ? (r.av_billing || 'separate') : 'separate';
  document.getElementById('hotelPaidAmount').value  = r && r.paid_amount != null ? r.paid_amount : '';
  document.getElementById('hotelStaffHotel').value  = r && r.staff_hotel != null ? r.staff_hotel : '';
  document.getElementById('hotelFlights').value     = r && r.flights    != null ? r.flights    : '';
  document.getElementById('hotelPrinting').value    = r && r.printing   != null ? r.printing   : '';
  document.getElementById('hotelNotes').value       = r ? (r.notes || '') : '';
  document.getElementById('hotelEventYear').value   = r
    ? (r.event_year ? String(r.event_year) : '')
    : String(hotelDefaultYear());
  document.getElementById('hotelModal').classList.add('open');
}

function closeHotelModal() {
  document.getElementById('hotelModal').classList.remove('open');
}

async function saveHotelExpense() {
  const id = document.getElementById('hotelEditId').value;
  const payload = {
    event_name:    document.getElementById('hotelEventName').value.trim(),
    hotel:         document.getElementById('hotelHotelName').value.trim(),
    cost:          document.getElementById('hotelCost').value.trim(),
    status:        document.getElementById('hotelStatus').value,
    currency:      document.getElementById('hotelRowCurrency').value,
    av_amount:     document.getElementById('hotelAvAmount').value || null,
    av_billing:    document.getElementById('hotelAvBilling').value,
    paid_amount:   document.getElementById('hotelPaidAmount').value || null,
    staff_hotel:    document.getElementById('hotelStaffHotel').value || null,
    flights:        document.getElementById('hotelFlights').value || null,
    printing:       document.getElementById('hotelPrinting').value || null,
    notes:          document.getElementById('hotelNotes').value.trim(),
    event_year:     document.getElementById('hotelEventYear').value || null
  };
  if (!payload.event_name) { showToast('Event name is required', 'error'); return; }
  const method = id ? 'PUT' : 'POST';
  const url    = id ? `/api/hotel-expenses/${id}` : '/api/hotel-expenses';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Save failed', 'error'); return; }
  showToast(id ? 'Updated' : 'Added', 'success');
  closeHotelModal();
  loadHotelExpenses();
}

async function deleteHotelExpense(id) {
  if (!confirm('Delete this hotel expense record?')) return;
  const res = await fetch(`/api/hotel-expenses/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Deleted', 'success');
  loadHotelExpenses();
}

// ─── Hotel inline editing ─────────────────────────────────────────────────────

function htEditCell(td) {
  if (td.querySelector('input')) return; // already editing
  const id    = td.dataset.id;
  const field = td.dataset.field;
  const val   = td.dataset.val;
  const isNum = td.classList.contains('ht-num');

  const input = document.createElement('input');
  input.type  = isNum ? 'number' : 'text';
  input.value = val;
  input.className = 'ht-input';
  if (isNum) { input.step = '0.01'; input.min = '0'; }
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newVal = input.value.trim();
    if (newVal !== val) htPatchField(parseInt(id), field, newVal === '' ? null : (isNum ? parseFloat(newVal) : newVal));
    td.dataset.val = newVal;
    td.innerHTML = newVal !== '' ? esc(isNum ? fmtHotelNum(newVal) : newVal) : '<span class="ht-empty">—</span>';
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { td.innerHTML = val !== '' ? esc(isNum ? fmtHotelNum(val) : val) : '<span class="ht-empty">—</span>'; } });
}

async function htPatchField(id, field, value) {
  try {
    const res = await fetch(`/api/hotel-expenses/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value })
    });
    if (!res.ok) { showToast('Save failed', 'error'); return; }
    // Update local data
    const updated = await res.json();
    const idx = hotelData.findIndex(r => r.id === id);
    if (idx !== -1) hotelData[idx] = updated;
    renderHotelSummary();
    if (field === 'cost' || field === 'paid_amount' || field === 'currency' || field === 'event_year') {
      renderHotelTable();
    }
  } catch { showToast('Save failed', 'error'); }
}

// Move a single event to another year straight from the table
async function htMoveYear(id, value) {
  const rec  = hotelData.find(r => r.id === id);
  const name = rec ? rec.event_name : 'Event';
  await htPatchField(id, 'event_year', value === '' ? null : parseInt(value));
  showToast(value ? `${name} moved to ${value}` : `${name} year cleared`, 'success');
}

function htUpdateRowClass(id, status) {
  const tr = document.getElementById(`htr-${id}`);
  if (!tr) return;
  tr.className = status === 'paid' ? 'hotel-row-paid' : status === 'partial' ? 'hotel-row-partial' : '';
}

async function htUploadInvoice(id, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { showToast('File must be under 8 MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = async e => {
    const base64 = e.target.result.split(',')[1];
    const res = await fetch(`/api/hotel-expenses/${id}/invoice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoice_name: file.name, invoice_data: base64 })
    });
    if (!res.ok) { showToast('Upload failed', 'error'); return; }
    showToast('Invoice saved', 'success');
    const idx = hotelData.findIndex(r => r.id === id);
    if (idx !== -1) hotelData[idx].invoice_name = file.name;
    renderHotelTable();
  };
  reader.readAsDataURL(file);
}

async function htDeleteInvoice(id) {
  if (!confirm('Remove stored invoice?')) return;
  const res = await fetch(`/api/hotel-expenses/${id}/invoice`, { method: 'DELETE' });
  if (!res.ok) { showToast('Failed', 'error'); return; }
  showToast('Invoice removed', 'success');
  const idx = hotelData.findIndex(r => r.id === id);
  if (idx !== -1) { hotelData[idx].invoice_name = null; hotelData[idx].invoice_data = null; }
  renderHotelTable();
}

// ─── HOLIDAY REQUEST NOTIFICATIONS ───────────────────────────────────────────

async function refreshNotifBadge() {
  try {
    const [hrRes, agRes] = await Promise.all([
      fetch('/api/holiday-requests/count'),
      fetch('/api/agenda-notifications')
    ]);
    const { count: hrCount } = hrRes.ok ? await hrRes.json() : { count: 0 };
    const agItems = agRes.ok ? await agRes.json() : [];
    const total = hrCount + agItems.length;
    const badge = document.getElementById('notifBadge');
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
    document.getElementById('notifBellBtn').classList.toggle('notif-has-pending', total > 0);
  } catch {}
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const isHidden = panel.classList.toggle('hidden');
  if (!isHidden) loadNotifPanel();
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('notifBellWrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('notifPanel')?.classList.add('hidden');
  }
});

async function loadNotifPanel() {
  const list = document.getElementById('notifList');
  list.innerHTML = '<div class="notif-empty">Loading…</div>';
  try {
    const [hrRes, agRes] = await Promise.all([
      fetch('/api/holiday-requests?status=pending'),
      fetch('/api/agenda-notifications')
    ]);
    const hrItems = hrRes.ok ? await hrRes.json() : [];
    const agItems = agRes.ok ? await agRes.json() : [];
    if (!hrItems.length && !agItems.length) { list.innerHTML = '<div class="notif-empty">No pending notifications</div>'; return; }
    const agendaHtml = agItems.map(a => {
      const since = new Date(a.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `<div class="notif-item" id="ag-notif-${a.id}">
        <div class="notif-item-name">📋 Agenda uploaded</div>
        <div class="notif-item-meta">${esc(a.employee_name)} · ${esc(a.event_name)} · ${since}</div>
        <div class="notif-item-actions">
          <button class="notif-approve-btn" onclick="dismissAgendaNotif(${a.id})">✓ Dismiss</button>
        </div>
      </div>`;
    }).join('');
    const hrHtml = hrItems.map(r => {
      const d = new Date(r.request_date);
      const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const typeStr = r.day_type === 'half' ? 'Half Day' : 'Full Day';
      const since = new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `<div class="notif-item" id="notif-item-${r.id}">
        <div class="notif-item-name">${esc(r.employee_name)}</div>
        <div class="notif-item-meta">${dateStr} · ${typeStr} · Requested ${since}</div>
        ${r.note ? `<div class="notif-item-note">"${esc(r.note)}"</div>` : ''}
        <label style="display:flex;align-items:center;gap:5px;font:500 11px/1 var(--font-sans);color:var(--muted);cursor:pointer;margin-top:4px">
          <input type="checkbox" id="hr-nodeduct-${r.id}" style="width:13px;height:13px;cursor:pointer">
          Doesn't count towards the deduction
        </label>
        <div class="notif-item-actions">
          <button class="notif-approve-btn" onclick="reviewHolidayRequest(${r.id},'approve')">✓ Approve</button>
          <button class="notif-deny-btn" onclick="reviewHolidayRequest(${r.id},'deny')">✕ Deny</button>
        </div>
      </div>`;
    }).join('');
    list.innerHTML = agendaHtml + hrHtml;
  } catch { list.innerHTML = '<div class="notif-empty">Failed to load</div>'; }
}

async function dismissAgendaNotif(id) {
  await fetch(`/api/agenda-notifications/${id}/read`, { method: 'PUT' });
  document.getElementById(`ag-notif-${id}`)?.remove();
  const remaining = document.querySelectorAll('#notifList .notif-item').length;
  if (!remaining) document.getElementById('notifList').innerHTML = '<div class="notif-empty">No pending notifications</div>';
  refreshNotifBadge();
}

async function reviewHolidayRequest(id, action) {
  const noDeduct = action === 'approve' && (document.getElementById('hr-nodeduct-' + id)?.checked || false);
  const res = await fetch(`/api/holiday-requests/${id}/${action}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ no_deduction: noDeduct })
  });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Failed', 'error'); return; }
  showToast(action === 'approve' ? 'Request approved' : 'Request denied', action === 'approve' ? 'success' : 'error');
  document.getElementById(`notif-item-${id}`)?.remove();
  const remaining = document.querySelectorAll('#notifList .notif-item').length;
  if (!remaining) document.getElementById('notifList').innerHTML = '<div class="notif-empty">No pending requests</div>';
  refreshNotifBadge();
}

// ─── COMPANY EXPENSES ─────────────────────────────────────────────────────────
let expData = [];
let _expQuarter = 'all';
let _expVat = 'all';
let _expReceiptBase64 = null;
let _expReceiptName = null;

const EXP_CATEGORY_LABEL = { office:'Office', travel:'Travel', marketing:'Marketing', software:'Software', staff:'Staff / HR', event:'Event Costs', legal:'Legal / Professional', other:'Other' };

function expQuarterOf(dateStr) {
  if (!dateStr) return null;
  const m = parseInt(String(dateStr).slice(5, 7), 10);
  if (m === 11 || m === 12 || m === 1) return 'Q1';
  if (m === 2 || m === 3 || m === 4)   return 'Q2';
  if (m === 5 || m === 6 || m === 7)   return 'Q3';
  if (m === 8 || m === 9 || m === 10)  return 'Q4';
  return null;
}

async function loadExpenses() {
  const res = await fetch('/api/expenses');
  if (!res.ok) { showToast('Failed to load expenses', 'error'); return; }
  expData = await res.json();
  renderExpPending();
  renderExpSummary();
  renderExpTable();
}

// ── Invoices waiting to be paid ─────────────────────────────────────────
function renderExpPending() {
  const listEl = document.getElementById('expPendingList');
  const countEl = document.getElementById('expPendingCount');
  if (!listEl) return;
  const pending = expData.filter(r => r.status === 'pending')
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  if (countEl) {
    countEl.textContent = pending.length || '';
    countEl.style.display = pending.length ? '' : 'none';
  }
  if (!pending.length) {
    listEl.innerHTML = `<div class="exp-pending-empty">
      <div class="epe-icon">✓</div>
      <div>
        <div class="epe-title">All settled — nothing waiting to be paid</div>
        <div class="epe-sub">Log an invoice you still owe with + Add Invoice, then tick it off once it's paid and it joins your expenses automatically.</div>
      </div>
    </div>`;
    return;
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const soonStr = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  listEl.innerHTML = pending.map(r => {
    const due = (r.due_date || '').slice(0, 10);
    const overdue = due && due < todayStr;
    const dueSoon = !overdue && due && due <= soonStr;
    const dueChip = due
      ? `<span class="exp-due-chip${overdue ? ' exp-due-overdue' : dueSoon ? ' exp-due-soon' : ''}">${overdue ? 'OVERDUE ' : 'DUE '}${due}</span>`
      : '';
    return `<div class="exp-pend-row">
      <button class="exp-pend-check" title="Mark as paid" onclick="markExpensePaid(${r.id})"></button>
      <div style="flex:1;min-width:0">
        <div style="font:600 13px/1.3 var(--font-sans);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.description)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">
          <span class="badge badge-grey" style="font-size:0.62rem">${esc(EXP_CATEGORY_LABEL[r.category] || r.category)}</span>
          ${r.vat_status === 'vat' ? '<span class="badge badge-blue" style="font-size:0.62rem">VAT</span>' : ''}
          ${dueChip}
        </div>
      </div>
      <div style="font:700 13.5px/1 var(--font-mono);color:var(--text);white-space:nowrap">${expCurSymbol(r.currency)}${parseFloat(r.amount || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      ${r.has_receipt ? `<a href="/api/expenses/${r.id}/receipt" target="_blank" class="badge badge-green" style="text-decoration:none;flex-shrink:0">📄 Invoice</a>` : ''}
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" onclick="openExpModal(${r.id},'pending')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteExpense(${r.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function markExpensePaid(id) {
  const r = expData.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Mark "${r.description}" as paid today? It will move into your expenses under today's date and quarter.`)) return;
  const res = await fetch(`/api/expenses/${id}/paid`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paid_date: new Date().toISOString().slice(0, 10) })
  });
  if (!res.ok) { showToast('Failed to mark paid', 'error'); return; }
  showToast('Paid — allocated to today\'s expenses', 'success');
  loadExpenses();
}

function setExpQuarter(btn, q) {
  _expQuarter = q;
  document.querySelectorAll('#expQFilters .deal-q-btn').forEach(b => b.classList.toggle('active', b.dataset.eq === q));
  renderExpSummary();
  renderExpTable();
}

function setExpVat(btn, v) {
  _expVat = v;
  document.querySelectorAll('#expVatFilters .deal-q-btn').forEach(b => b.classList.toggle('active', b.dataset.ev === v));
  renderExpSummary();
  renderExpTable();
}

function expFiltered() {
  return expData.filter(r => {
    if (r.status === 'pending') return false; // unpaid invoices live in their own section
    if (_expQuarter !== 'all' && expQuarterOf(r.expense_date) !== _expQuarter) return false;
    if (_expVat !== 'all' && r.vat_status !== _expVat) return false;
    return true;
  });
}

function expCurSymbol(c) {
  if (c === 'GBP') return '£';
  if (c === 'EUR') return '€';
  if (c === 'AED') return 'AED ';
  return '$';
}

function renderExpSummary() {
  const rows = expFiltered();
  const byCur = {};
  rows.forEach(r => {
    const cur = r.currency || 'GBP';
    byCur[cur] = byCur[cur] || { vat: 0, nonVat: 0, total: 0, vatPortion: 0 };
    const amt = parseFloat(r.amount) || 0;
    byCur[cur].total += amt;
    if (r.vat_status === 'vat') {
      byCur[cur].vat += amt;
      byCur[cur].vatPortion += parseFloat(r.vat_amount) || 0;
    } else {
      byCur[cur].nonVat += amt;
    }
  });
  const fmtN = n => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cards = Object.entries(byCur).map(([cur, s]) => `
    <div class="hotel-fin-card">
      <div class="hotel-fin-currency">${cur}</div>
      <div class="hotel-fin-row"><span class="hotel-fin-lbl">Vatable Expenses</span><span class="hotel-fin-val">${expCurSymbol(cur)}${fmtN(s.vat)}</span></div>
      <div class="hotel-fin-row"><span class="hotel-fin-lbl">of which VAT</span><span class="hotel-fin-val hotel-fin-green">${expCurSymbol(cur)}${fmtN(s.vatPortion)}</span></div>
      <div class="hotel-fin-row hotel-fin-total-row"><span class="hotel-fin-lbl">Total Expenses</span><span class="hotel-fin-val hotel-fin-blue">${expCurSymbol(cur)}${fmtN(s.total)}</span></div>
    </div>`).join('');
  const qLabel = _expQuarter !== 'all' ? ` · ${_expQuarter}` : '';
  const vLabel = _expVat !== 'all' ? ` · ${_expVat === 'vat' ? 'VAT' : 'Non-VAT'}` : '';
  document.getElementById('expSummary').innerHTML = `
    <div class="hotel-fin-strip">
      ${cards || '<div class="hotel-fin-card"><div class="hotel-fin-currency">TOTALS${qLabel}${vLabel}</div><div class="hotel-fin-row"><span class="hotel-fin-lbl">No expenses in this filter</span></div></div>'}
      <div class="hotel-fin-card hotel-fin-card--status">
        <div class="hotel-fin-currency">STATUS${qLabel}${vLabel}</div>
        <div class="hotel-fin-row"><span class="hotel-fin-lbl">Line Items</span><span class="hotel-fin-val">${rows.length}</span></div>
        <div class="hotel-fin-row"><span class="hotel-fin-lbl">With Receipt</span><span class="hotel-fin-val hotel-fin-green">${rows.filter(r=>r.has_receipt).length}</span></div>
        <div class="hotel-fin-row hotel-fin-total-row"><span class="hotel-fin-lbl">Missing Receipt</span><span class="hotel-fin-val hotel-fin-red">${rows.filter(r=>!r.has_receipt).length}</span></div>
      </div>
    </div>`;
}

function renderExpTable() {
  const search = (document.getElementById('expSearch')?.value || '').toLowerCase();
  const rows = expFiltered().filter(r => !search || (r.description||'').toLowerCase().includes(search) || (r.category||'').toLowerCase().includes(search));
  const tbody = document.getElementById('expTableBody');
  const empty = document.getElementById('expEmpty');
  document.getElementById('expRowCount').textContent = `${rows.length} item${rows.length !== 1 ? 's' : ''}`;
  if (!rows.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.expense_date ? r.expense_date.slice(0,10) : '—'}</td>
      <td><span class="badge badge-grey">${esc(EXP_CATEGORY_LABEL[r.category] || r.category)}</span></td>
      <td>${esc(r.description)}</td>
      <td>${r.vat_status === 'vat'
        ? '<span class="badge badge-blue">VAT</span>' + (r.vat_amount != null && parseFloat(r.vat_amount) > 0 ? `<div style="font:600 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">${expCurSymbol(r.currency)}${parseFloat(r.vat_amount).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})} VAT</div>` : '')
        : '<span class="badge badge-yellow">Non-VAT</span>'}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-weight:600">${expCurSymbol(r.currency)}${parseFloat(r.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td>${r.has_receipt ? `<a href="/api/expenses/${r.id}/receipt" target="_blank" class="badge badge-green" style="text-decoration:none">🧾 View</a>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="openExpModal(${r.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteExpense(${r.id})">✕</button>
      </td>
    </tr>`).join('');
}

// VAT expenses: Amount is the gross total and the VAT portion is entered separately
function expVatToggle() {
  const isVat = document.getElementById('expVatStatus').value === 'vat';
  document.getElementById('expVatAmountRow').classList.toggle('hidden', !isVat);
  document.getElementById('expAmountLbl').textContent = isVat ? 'Total Amount (inc VAT)' : 'Amount';
  if (!isVat) document.getElementById('expVatAmount').value = '';
}

let _expModalMode = 'paid'; // 'paid' = normal expense, 'pending' = invoice to pay

function openExpModal(id, mode) {
  const r = id ? expData.find(x => x.id === id) : null;
  _expModalMode = r ? (r.status === 'pending' ? 'pending' : 'paid') : (mode === 'pending' ? 'pending' : 'paid');
  const isPending = _expModalMode === 'pending';
  document.getElementById('expModalTitle').textContent = isPending
    ? (r ? 'Edit Invoice to Pay' : 'Add Invoice to Pay')
    : (r ? 'Edit Expense' : 'Add Expense');
  document.getElementById('expDateLbl').textContent = isPending ? 'Due Date *' : 'Date *';
  document.getElementById('expReceiptLbl').textContent = isPending ? 'Invoice File' : 'Receipt';
  document.getElementById('expEditId').value = r ? r.id : '';
  document.getElementById('expDate').value = r
    ? ((isPending ? r.due_date : r.expense_date) || r.expense_date || '').slice(0,10)
    : today();
  document.getElementById('expCategory').value = r ? r.category : 'other';
  document.getElementById('expDescription').value = r ? r.description : '';
  document.getElementById('expAmount').value = r ? r.amount : '';
  document.getElementById('expCurrency').value = r ? (r.currency || 'GBP') : 'GBP';
  document.getElementById('expVatStatus').value = r ? r.vat_status : 'non_vat';
  document.getElementById('expVatAmount').value = r && r.vat_amount != null ? r.vat_amount : '';
  expVatToggle();
  document.getElementById('expNotes').value = r ? (r.notes || '') : '';
  document.getElementById('expReceiptFile').value = '';
  _expReceiptBase64 = null; _expReceiptName = null;
  const cur = document.getElementById('expReceiptCurrent');
  if (r && r.has_receipt) {
    cur.classList.remove('hidden');
    document.getElementById('expReceiptLink').href = `/api/expenses/${r.id}/receipt`;
    document.getElementById('expReceiptLink').textContent = r.receipt_name || 'View receipt';
  } else {
    cur.classList.add('hidden');
  }
  openModal('expModal');
}

function expReceiptPreview(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { showToast('File must be under 8 MB', 'error'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    _expReceiptBase64 = e.target.result.split(',')[1];
    _expReceiptName = file.name;
    showToast('Receipt ready — will attach on save', 'success');
  };
  reader.readAsDataURL(file);
}

async function expRemoveReceipt() {
  const id = document.getElementById('expEditId').value;
  if (id) {
    if (!confirm('Remove stored receipt?')) return;
    const res = await fetch(`/api/expenses/${id}/receipt`, { method: 'DELETE' });
    if (!res.ok) { showToast('Failed', 'error'); return; }
    const idx = expData.findIndex(r => r.id == id);
    if (idx !== -1) expData[idx].has_receipt = false;
  }
  document.getElementById('expReceiptCurrent').classList.add('hidden');
}

async function saveExpense() {
  const id = document.getElementById('expEditId').value;
  const isVat = document.getElementById('expVatStatus').value === 'vat';
  const isPending = _expModalMode === 'pending';
  const dateVal = document.getElementById('expDate').value;
  const payload = {
    category: document.getElementById('expCategory').value,
    description: document.getElementById('expDescription').value.trim(),
    vat_status: document.getElementById('expVatStatus').value,
    amount: parseFloat(document.getElementById('expAmount').value) || 0,
    vat_amount: isVat ? (parseFloat(document.getElementById('expVatAmount').value) || 0) : null,
    currency: document.getElementById('expCurrency').value,
    expense_date: dateVal,
    status: isPending ? 'pending' : 'paid',
    due_date: isPending ? dateVal : null,
    notes: document.getElementById('expNotes').value.trim()
  };
  if (!payload.expense_date) { showToast('Date is required', 'error'); return; }
  if (!payload.description) { showToast('Description is required', 'error'); return; }
  if (isVat && !payload.vat_amount) { showToast('Enter the VAT amount included in the total', 'error'); return; }
  if (isVat && payload.vat_amount >= payload.amount) { showToast('VAT amount must be less than the total (the total should include VAT)', 'error'); return; }
  if (!id && _expReceiptBase64) { payload.receipt_name = _expReceiptName; payload.receipt_data = _expReceiptBase64; }
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/expenses/${id}` : '/api/expenses';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Save failed', 'error'); return; }
  const saved = await res.json();
  if (id && _expReceiptBase64) {
    await fetch(`/api/expenses/${id}/receipt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt_name: _expReceiptName, receipt_data: _expReceiptBase64 })
    });
  }
  showToast(id ? 'Updated' : 'Added', 'success');
  closeModal('expModal');
  loadExpenses();
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Deleted', 'success');
  loadExpenses();
}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

const SUB_FX = { GBP: 1, USD: 0.79, AED: 1/4.67, PHP: 0.014 };
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, annually: 12, one_off: 0 };
let subsData = [];
let _subCycleFilter = 'all';

function setSubFilter(cycle) {
  _subCycleFilter = cycle;
  document.querySelectorAll('#subCycleFilters .deal-q-btn').forEach(b => b.classList.toggle('active', b.dataset.cycle === cycle));
  renderSubTable();
}

function subToGBPPerMonth(s) {
  const rate = SUB_FX[s.currency] || 1;
  const months = CYCLE_MONTHS[s.billing_cycle];
  const qty = Math.max(1, parseInt(s.quantity) || 1);
  if (!months) return 0;
  return (parseFloat(s.amount) * qty * rate) / months;
}

async function loadSubscriptions() {
  try {
    const res = await fetch('/api/subscriptions');
    subsData = await res.json();
    renderSubTotals();
    renderSubTable();
  } catch { showToast('Failed to load subscriptions', 'error'); }
}

function renderSubTotals() {
  const activeOnlyChk = document.getElementById('subActiveOnly');
  const activeOnly = !activeOnlyChk || activeOnlyChk.checked;
  let filtered = _subCycleFilter === 'all' ? subsData : subsData.filter(s => s.billing_cycle === _subCycleFilter);
  const active = activeOnly ? filtered.filter(s => s.active) : filtered;
  const perMonth = active.reduce((a, s) => a + subToGBPPerMonth(s), 0);
  const perYear = active.reduce((a, s) => {
    const rate = SUB_FX[s.currency] || 1;
    const months = CYCLE_MONTHS[s.billing_cycle];
    const qty = Math.max(1, parseInt(s.quantity) || 1);
    return a + (months ? parseFloat(s.amount) * qty * rate * (12 / months) : parseFloat(s.amount) * qty * rate);
  }, 0);
  document.getElementById('subTotals').innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div class="dash-mini-card dash-mini--indigo" style="flex:1;min-width:160px">
        <div class="dash-mini-label">Total / Month (GBP)</div>
        <div class="dash-mini-value">£${fmt(perMonth)}</div>
      </div>
      <div class="dash-mini-card dash-mini--green" style="flex:1;min-width:160px">
        <div class="dash-mini-label">Total / Year (GBP)</div>
        <div class="dash-mini-value">£${fmt(perYear)}</div>
      </div>
      <div class="dash-mini-card" style="flex:1;min-width:160px">
        <div class="dash-mini-label">Active Subscriptions</div>
        <div class="dash-mini-value">${active.length}</div>
      </div>
    </div>`;
}

function renderSubTable() {
  const tbody = document.getElementById('subTableBody');
  const empty = document.getElementById('subEmpty');
  const count = document.getElementById('subCount');
  const activeOnlyChk = document.getElementById('subActiveOnly');
  const activeOnly = !activeOnlyChk || activeOnlyChk.checked;
  let filtered = _subCycleFilter === 'all' ? subsData : subsData.filter(s => s.billing_cycle === _subCycleFilter);
  if (activeOnly) filtered = filtered.filter(s => s.active);
  count.textContent = `${filtered.length} of ${subsData.length} subscription${subsData.length !== 1 ? 's' : ''}`;
  if (!filtered.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const symMap = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱' };
  const now = new Date(); now.setHours(0,0,0,0);
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30);
  tbody.innerHTML = filtered.map(s => {
    const sym = symMap[s.currency] || '';
    const qty = Math.max(1, parseInt(s.quantity) || 1);
    const unitAmt = parseFloat(s.amount);
    const totalAmt = unitAmt * qty;
    const perMonth = subToGBPPerMonth(s);
    const months = CYCLE_MONTHS[s.billing_cycle];
    const perYear = months ? perMonth * 12 : totalAmt * (SUB_FX[s.currency] || 1);
    const cycleLabel = { monthly:'Monthly', quarterly:'Quarterly', annually:'Annually', one_off:'One-Off' }[s.billing_cycle] || s.billing_cycle;
    let renewalHtml = '—';
    if (s.renewal_date) {
      const rd = new Date(s.renewal_date); rd.setHours(0,0,0,0);
      const renewalStr = rd.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
      if (rd < now) {
        renewalHtml = `<span class="sub-renewal-overdue">${renewalStr}</span>`;
      } else if (rd <= in30) {
        renewalHtml = `<span class="sub-renewal-warn">${renewalStr}</span>`;
      } else {
        renewalHtml = renewalStr;
      }
    }
    const activeDot = s.active
      ? '<span style="color:var(--success);font-size:1.1em;vertical-align:middle">●</span>'
      : '<span style="color:var(--muted);font-size:1.1em;vertical-align:middle">●</span>';
    const rowCycleClass = `sub-row-${s.billing_cycle}`;
    let nameCell = `${activeDot} ${esc(s.name)}`;
    if (!s.active) {
      const deDate = s.deactivated_at
        ? new Date(s.deactivated_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})
        : null;
      nameCell += `<div class="sub-inactive-tag">Inactive${deDate ? ` · since ${deDate}` : ''}</div>`;
    }
    return `<tr class="${rowCycleClass}${s.active ? '' : ' sub-inactive'}">
      <td>${nameCell}</td>
      <td>${qty > 1 ? `${sym}${fmt(unitAmt)} <span style="color:var(--muted);font-size:0.78rem">× ${qty}</span> = ${sym}${fmt(totalAmt)}` : `${sym}${fmt(unitAmt)}`}</td>
      <td>${cycleLabel}</td>
      <td>£${fmt(perMonth)}</td>
      <td>£${fmt(perYear)}</td>
      <td>${renewalHtml}</td>
      <td style="max-width:160px;white-space:normal;font-size:0.8rem;color:var(--muted)">${esc(s.notes||'')}</td>
      <td>
        <div class="sub-actions">
          <button class="sub-action-btn" title="Edit" onclick="openSubModal(${s.id})">✏️ Edit</button>
          <button class="sub-action-btn ${s.active ? 'sub-action-btn--pause' : 'sub-action-btn--play'}" title="${s.active ? 'Deactivate' : 'Activate'}" onclick="toggleSubActive(${s.id},${!s.active})">
            ${s.active ? '⏸ Deactivate' : '▶ Activate'}
          </button>
          <button class="sub-action-btn sub-action-btn--danger" title="Delete" onclick="deleteSub(${s.id})">🗑 Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openSubModal(id) {
  document.getElementById('subEditId').value = id || '';
  document.getElementById('subModalTitle').textContent = id ? 'Edit Subscription' : 'Add Subscription';
  if (id) {
    const s = subsData.find(x => x.id === id);
    if (!s) return;
    document.getElementById('subName').value = s.name;
    document.getElementById('subCurrency').value = s.currency;
    document.getElementById('subAmount').value = s.amount;
    document.getElementById('subQty').value = Math.max(1, parseInt(s.quantity) || 1);
    document.getElementById('subCycle').value = s.billing_cycle;
    document.getElementById('subRenewal').value = s.renewal_date ? s.renewal_date.split('T')[0] : '';
    document.getElementById('subNotes').value = s.notes || '';
  } else {
    document.getElementById('subName').value = '';
    document.getElementById('subCurrency').value = 'GBP';
    document.getElementById('subAmount').value = '';
    document.getElementById('subQty').value = '1';
    document.getElementById('subCycle').value = 'monthly';
    document.getElementById('subRenewal').value = '';
    document.getElementById('subNotes').value = '';
  }
  openModal('subModal');
}

async function saveSub() {
  const id = document.getElementById('subEditId').value;
  const name = document.getElementById('subName').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const amount = parseFloat(document.getElementById('subAmount').value);
  if (isNaN(amount) || amount < 0) { showToast('Enter a valid amount', 'error'); return; }
  const quantity = Math.max(1, parseInt(document.getElementById('subQty').value) || 1);
  const body = {
    name, vendor: '',
    currency: document.getElementById('subCurrency').value,
    amount, quantity,
    billing_cycle: document.getElementById('subCycle').value,
    renewal_date: document.getElementById('subRenewal').value || null,
    notes: document.getElementById('subNotes').value.trim()
  };
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/subscriptions/${id}` : '/api/subscriptions';
  const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Save failed', 'error'); return; }
  showToast(id ? 'Subscription updated' : 'Subscription added', 'success');
  closeModal('subModal');
  loadSubscriptions();
}

async function toggleSubActive(id, active) {
  const sub = subsData.find(s => s.id === id);
  if (!active && !confirm(`Deactivate "${sub ? sub.name : 'this subscription'}"? It stays on record but won't count towards your totals.`)) return;
  const res = await fetch(`/api/subscriptions/${id}/active`, { method: 'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ active }) });
  if (!res.ok) { showToast('Update failed', 'error'); return; }
  const updated = await res.json().catch(() => null);
  const idx = subsData.findIndex(s => s.id === id);
  if (idx !== -1) {
    subsData[idx].active = active;
    subsData[idx].deactivated_at = updated ? updated.deactivated_at : (active ? null : new Date().toISOString());
  }
  showToast(active ? 'Subscription reactivated' : 'Subscription deactivated', 'success');
  renderSubTotals();
  renderSubTable();
}

async function deleteSub(id) {
  if (!confirm('Delete this subscription?')) return;
  const res = await fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Subscription deleted', 'success');
  loadSubscriptions();
}

// ─── PORTFOLIO ────────────────────────────────────────────────────────────────
//
// The admin Portfolio page reads like the sales CRM's Event Performance page:
// a headline figure with a meter, a KPI row, revenue by series, then the event
// list grouped by producer team. Money here is GBP as the tracker stores it on
// portfolio_events (total_pipeline = allocated, total_won = paid).

let portfolioData = [];
let _portTeams = [];   // [{ series, programme_year, sales, delegates, production, co_producer }]
let _portYearFilter = String(new Date().getFullYear() + 1); // default to next year (2027)
let _portExtraYears = new Set();
let _portSearch = '';

// The 2027 programme, as /api/programme/2027 last reported it. Nothing in it
// is applied by reading it; decisions are collected here and only sent when
// the person presses Apply.
let _programme2027 = { status: 'idle', data: null, error: null };
let _programmeDecisions = {};       // key -> 'rename' | 'create' | 'skip'
// The 2027 programme panel is a tool for placing rows, not a fixture of the
// page: once every confirmed event is linked it stays out of the way, opened
// from the toolbar when wanted, and only a one-line notice appears when a
// row needs a decision again. The choice is remembered per browser.
let _portShowProgramme = (() => { try { return localStorage.getItem('portShowProgramme') === '1'; } catch { return false; } })();

const PORT_PRODUCERS = ['Gio & Karam', 'Tara & Maryam', 'Fidak', 'Santos', 'Arj & Leena'];

// Series ids match the sales CRM's events catalogue, so the two apps agree on
// which portfolio an event belongs to. The chart index is the series' hue
// (--chart-N) and follows the entity everywhere: never cycled, never repainted.
// One CFO/COO portfolio, not three. The order is the display order in every
// chart and it is the one order in which each neighbouring pair of hues stays
// apart under red-green colour blindness (validated on both card surfaces);
// every series keeps the hue it always had.
const PORT_SERIES = [
  { id: 'private-debt',       code: '01', name: 'Private Debt Fundraising Series',      short: 'Private Debt',       chart: 1 },
  { id: 'cfo-coo',            code: '02', name: 'CFO / COO Series',                     short: 'CFO / COO',          chart: 2 },
  { id: 'operational-fund',   code: '03', name: 'Operational Fund Summit Series',       short: 'Operational Fund',   chart: 7 },
  { id: 'operating-partners', code: '04', name: 'Operating Partners Conference Series', short: 'Operating Partners', chart: 5 },
  { id: 'data-tech',          code: '05', name: 'Data & Technology Forum Series',       short: 'Data & Technology',  chart: 6 },
];
// Ids stored by earlier versions all fold into the one CFO/COO series.
const PORT_LEGACY_SERIES = { 'cfo-private-markets': 'cfo-coo', 'cfo-pe-debt': 'cfo-coo', 'cfo-pe': 'cfo-coo' };
function portNormaliseSeries(id) {
  if (!id) return null;
  if (PORT_SERIES_MAP[id]) return id;
  return PORT_LEGACY_SERIES[id] || null;
}
const PORT_SERIES_MAP = Object.fromEntries(PORT_SERIES.map(s => [s.id, s]));

/**
 * Series from an event's name. A port of the sales CRM's guessSeries -- the
 * rules must stay identical in both apps. Order matters; first match wins.
 * Used only when a row carries no programme key.
 */
function portGuessSeries(eventName) {
  const n = String(eventName || '').toLowerCase();
  if (n.includes('operational fund')) return 'operational-fund';
  if (n.includes('operating partners')) return 'operating-partners';
  if (n.includes('data') && (n.includes('tech') || n.includes('ai'))) return 'data-tech';
  // Every CFO/COO conference -- Private Markets, Private Equity or Private
  // Debt -- is the one CFO/COO series, and the word decides before the
  // "private debt" rule can claim a CFO/COO Private Debt event for fundraising.
  if (/\bcfo\b/.test(n) || /\bcoo\b/.test(n)) return 'cfo-coo';
  if (n.includes('private debt') || n.includes('sports investing')) return 'private-debt';
  // tracker shorthand
  if (/\bops\b/.test(n)) return 'operating-partners';
  if (/\bdata\s*tech\b/.test(n)) return 'data-tech';
  if (/\bpd\b/.test(n) || n.includes('fundraising') || n.includes('sports')) return 'private-debt';
  // cities hosting exactly one 2027 event
  if (n.includes('berlin')) return 'private-debt';
  if (n.includes('lux')) return 'operational-fund';
  if (n.includes('switzerland') || n.includes('zurich')) return 'cfo-coo';
  return null;
}

/** The series a row belongs to: its programme key if linked, else a guess from its name. */
function portSeriesFor(ev) {
  const items = _programme2027.data && _programme2027.data.items;
  if (ev.programme_key && items) {
    const it = items.find(i => i.programme_key === ev.programme_key);
    if (it && it.series) return portNormaliseSeries(it.series) || it.series;
  }
  return portGuessSeries(ev.name);
}

/** A row belongs to its programme year even when its date is still TBC. */
function portRowYear(ev) {
  if (ev.programme_year) return Number(ev.programme_year);
  if (ev.event_date) {
    const y = parseInt(String(ev.event_date).slice(0, 4), 10);
    if (!isNaN(y)) return y;
  }
  return null;
}

/** Whole pounds for figures and bar labels; the deals expander keeps pence. */
function fmtGBP(n) { return '£' + Math.round(Number(n) || 0).toLocaleString('en-GB'); }

function setPortYear(y) {
  _portYearFilter = y;
  renderPortfolioGrid();
}

function addPortYear() {
  const input = prompt('Enter year to add (e.g. 2028):');
  if (!input) return;
  const y = parseInt(input.trim());
  if (isNaN(y) || y < 2000 || y > 2100) { showToast('Invalid year', 'error'); return; }
  _portExtraYears.add(y);
  _portYearFilter = String(y);
  renderPortfolioGrid();
}

async function loadPortfolio() {
  try {
    const teamsRes = await fetch('/api/portfolio-teams').catch(() => null);
    _portTeams = teamsRes && teamsRes.ok ? await teamsRes.json() : [];
  } catch { _portTeams = []; }
  try {
    const res = await fetch('/api/portfolio-events');
    if (!res.ok) { showToast('Failed to load portfolio events', 'error'); return; }
    portfolioData = await res.json();
    if (!Array.isArray(portfolioData)) portfolioData = [];
    renderPortfolioGrid();
  } catch { showToast('Failed to load portfolio', 'error'); }
  // The series of a linked row comes from the programme, so it is fetched
  // alongside and refreshed on every reload: a row edited or deleted here
  // must not leave the panel holding a stale suggestion or row id.
  if (_programme2027.status !== 'loading') loadProgramme2027();
}

async function loadProgramme2027() {
  _programme2027 = { status: 'loading', data: null, error: null };
  try {
    const res = await fetch('/api/programme/2027');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _programme2027 = { status: 'ready', data, error: null };
    // Decisions are reset when the reconcile changes underneath them.
    _programmeDecisions = {};
  } catch (e) {
    _programme2027 = { status: 'error', data: null, error: e.message || 'Could not load the programme' };
  }
  renderPortfolioGrid();
}

function portFilterCards(q) {
  _portSearch = (q || '').toLowerCase().trim();
  document.querySelectorAll('#portfolioGrid .pec-card').forEach(c => {
    const hay = c.dataset.name || '';
    c.style.display = !_portSearch || hay.includes(_portSearch) ? '' : 'none';
  });
  // A team with nothing showing hides its header too.
  document.querySelectorAll('#portfolioGrid .pf-group').forEach(g => {
    const any = [...g.querySelectorAll('.pec-card')].some(c => c.style.display !== 'none');
    g.style.display = any ? '' : 'none';
  });
}

function togglePortfolioProgramme() {
  _portShowProgramme = !_portShowProgramme;
  try { localStorage.setItem('portShowProgramme', _portShowProgramme ? '1' : '0'); } catch { /* private mode: not remembered */ }
  renderPortfolioGrid();
}

// What the programme still needs from a person, from the last reconcile.
function programmePending() {
  const p = _programme2027;
  if (p.status !== 'ready' || !p.data) return null;
  const c = p.data.counts || {};
  const suggested = c.suggested || 0, missing = c.missing || 0, duplicates = c.duplicates || 0;
  return { suggested, missing, duplicates, total: suggested + missing + duplicates };
}

// The panel folded to one line: shown only while something needs deciding.
function renderProgrammeNotice() {
  const p = _programme2027;
  if (p.status === 'error') {
    return `<div class="pf-prog-notice"><span class="pf-prog-dot pf-prog-dot--missing"></span><span>The 2027 programme could not be checked: ${esc(p.error || '')}</span><button class="btn btn-ghost btn-sm" onclick="loadProgramme2027()">Retry</button></div>`;
  }
  const pend = programmePending();
  if (!pend || !pend.total) return '';
  const parts = [
    pend.suggested ? `${pend.suggested} matched, awaiting confirmation` : '',
    pend.duplicates ? `${pend.duplicates} older row${pend.duplicates === 1 ? '' : 's'} look${pend.duplicates === 1 ? 's' : ''} like ${pend.duplicates === 1 ? 'a linked event' : 'linked events'}` : '',
    pend.missing ? `${pend.missing} to create` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="pf-prog-notice"><span class="pf-prog-dot pf-prog-dot--suggested"></span><span><b>2027 programme</b> · ${parts}</span><button class="btn btn-ghost btn-sm" onclick="togglePortfolioProgramme()">Review</button></div>`;
}

function renderPortfolioGrid() {
  const grid  = document.getElementById('portfolioGrid');
  const empty = document.getElementById('portfolioEmpty');
  if (!grid) return;

  // Year tabs: always this year and next, plus any year a row belongs to.
  const curYear = new Date().getFullYear();
  const yearsSet = new Set([curYear, curYear + 1]);
  portfolioData.forEach(e => { const y = portRowYear(e); if (y) yearsSet.add(y); });
  _portExtraYears.forEach(y => yearsSet.add(y));
  const years = [...yearsSet].sort((a, b) => b - a);
  if (_portYearFilter !== 'all' && !years.includes(parseInt(_portYearFilter))) _portYearFilter = String(years[0] || curYear);

  const filtered = _portYearFilter === 'all'
    ? portfolioData
    : portfolioData.filter(e => (portRowYear(e) || curYear) === parseInt(_portYearFilter));

  const yearLabel = _portYearFilter === 'all' ? 'All years' : `${_portYearFilter} programme`;

  const toolbarHtml =
    `<div class="deal-filter-card" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">` +
      `<div class="deal-q-filters">` +
        years.map(y => `<button class="deal-q-btn${_portYearFilter === String(y) ? ' active' : ''}" onclick="setPortYear('${y}')">${y}</button>`).join('') +
        `<button class="deal-q-btn${_portYearFilter === 'all' ? ' active' : ''}" onclick="setPortYear('all')">All</button>` +
        `<button class="deal-q-btn" onclick="addPortYear()" title="Add year">+</button>` +
      `</div>` +
      `<input class="port-search" id="portSearch" style="width:260px" placeholder="Search events, cities, teams" oninput="portFilterCards(this.value)" value="${esc(_portSearch)}">` +
      `<span style="flex:1"></span>` +
      `<button class="btn btn-ghost btn-sm" onclick="togglePortfolioProgramme()">${_portShowProgramme ? 'Hide' : 'Show'} 2027 programme</button>` +
      `<button class="btn btn-primary btn-sm" onclick="openPortfolioModal()">+ Add Event</button>` +
    `</div>`;

  const programmeHtml = _portShowProgramme ? renderProgrammePanel() : renderProgrammeNotice();

  if (!filtered.length) {
    grid.innerHTML = toolbarHtml + programmeHtml;
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // ── Roll-ups ──
  const num = (v) => parseFloat(v) || 0;
  const allocated   = filtered.reduce((a, e) => a + num(e.total_pipeline), 0);
  const paid        = filtered.reduce((a, e) => a + num(e.total_won), 0);
  const outstanding = Math.max(0, allocated - paid);
  const deals       = filtered.reduce((a, e) => a + (parseInt(e.deal_count) || 0), 0);
  const collectPct  = allocated > 0 ? Math.round(paid / allocated * 100) : 0;
  const meterPct    = allocated > 0 ? Math.min(100, paid / allocated * 100) : 0;

  const heroHtml =
    `<section class="pf-panel pf-hero">
      <p class="pf-eyebrow">${esc(yearLabel)} · allocated to date</p>
      <div class="pf-hero-row">
        <p class="pf-hero-fig">${fmtGBP(allocated)}</p>
        <p class="pf-hero-sub">of which <b>${fmtGBP(paid)}</b> paid</p>
      </div>
      <div class="pf-meter" role="img" aria-label="${collectPct}% of allocated is paid"><div class="pf-meter-fill pf-anim" data-pct="${meterPct}"></div></div>
      <p class="pf-hero-note">${allocated > 0
        ? `<b>${collectPct}%</b> collected · ${fmtGBP(outstanding)} outstanding across ${filtered.length} event${filtered.length === 1 ? '' : 's'}`
        : `Nothing allocated yet across ${filtered.length} event${filtered.length === 1 ? '' : 's'}`}</p>
    </section>`;

  const kpi = (label, value, sub, tone) =>
    `<div class="dss-card dss-card--${tone}"><div class="dss-label">${label}</div><div class="dss-value">${value}</div><div class="pf-kpi-sub">${sub}</div></div>`;
  const kpiHtml =
    `<div class="pf-kpis">` +
      kpi('Events', filtered.length, `${deals} deal${deals === 1 ? '' : 's'} allocated`, 'neutral') +
      kpi('Allocated', fmtGBP(allocated), 'sponsor money against these events', 'accent') +
      kpi('Paid', fmtGBP(paid), 'invoiced and received', 'ok') +
      kpi('Outstanding', fmtGBP(outstanding), outstanding > 0 ? 'allocated, not yet paid' : 'nothing owed', outstanding > 0 ? 'warn' : 'neutral') +
      kpi('Collected', `${collectPct}%`, allocated > 0 ? 'of allocated is paid' : 'nothing allocated yet', 'neutral') +
    `</div>`;

  // ── Revenue by portfolio ──
  const bySeries = new Map();
  filtered.forEach(e => {
    const id = portSeriesFor(e) || 'unassigned';
    if (!bySeries.has(id)) bySeries.set(id, { id, allocated: 0, paid: 0, events: 0, deals: 0 });
    const b = bySeries.get(id);
    b.allocated += num(e.total_pipeline); b.paid += num(e.total_won); b.events += 1; b.deals += parseInt(e.deal_count) || 0;
  });
  const seriesRows = [
    ...PORT_SERIES.filter(s => bySeries.has(s.id)).map(s => ({ ...bySeries.get(s.id), short: s.short, name: s.name, color: `var(--chart-${s.chart})` })),
    ...(bySeries.has('unassigned') ? [{ ...bySeries.get('unassigned'), short: 'Unassigned', name: 'No series yet', color: 'var(--dim)' }] : []),
  ];
  const seriesScale = Math.max(1, ...seriesRows.map(r => r.allocated));
  const seriesHtml =
    `<section class="pf-panel">
      <div class="pf-panel-hd">
        <div>
          <h2 class="pf-panel-title">Revenue by portfolio</h2>
          <p class="pf-panel-desc">Allocated per programme series. The tick on each bar is how much of it has been paid.</p>
        </div>
        <p class="pf-panel-aside">Amounts in GBP</p>
      </div>
      <div class="pf-series">${seriesRows.map(r => {
        const w = r.allocated / seriesScale * 100;
        const pw = Math.min(100, r.paid / seriesScale * 100);
        return `<div class="pf-series-row" tabindex="0">
          <div class="pf-series-top">
            <span class="pf-series-name"><span class="pf-chip" style="background:${r.color}"></span><span class="pf-series-short">${esc(r.short)}</span><span class="pf-series-n">${r.events} event${r.events === 1 ? '' : 's'}</span></span>
            <span class="pf-series-val">${fmtGBP(r.allocated)} <small>· ${fmtGBP(r.paid)} paid</small></span>
          </div>
          <div class="pf-track">
            <div class="pf-bar pf-anim" data-pct="${w}" style="background:${r.color}"></div>
            ${r.paid > 0 && r.paid < r.allocated ? `<span class="pf-mark" style="left:calc(${pw}% - 1px)" title="Paid ${fmtGBP(r.paid)}"></span>` : ''}
          </div>
          <div class="pf-tip">
            <div class="pf-tip-title">${esc(r.name)}</div>
            <div class="pf-tip-row"><span>Allocated</span><span>${fmtGBP(r.allocated)}</span></div>
            <div class="pf-tip-row"><span>Paid</span><span>${fmtGBP(r.paid)}</span></div>
            <div class="pf-tip-row"><span>Outstanding</span><span>${fmtGBP(Math.max(0, r.allocated - r.paid))}</span></div>
            <div class="pf-tip-row"><span>Events</span><span>${r.events}</span></div>
            <div class="pf-tip-row"><span>Deals</span><span>${r.deals}</span></div>
          </div>
        </div>`;
      }).join('') || '<div class="pf-empty">No events allocated yet.</div>'}</div>
    </section>`;

  // ── Event list by producer team ──
  const byProducer = new Map();
  filtered.forEach(e => {
    const k = e.producer || '';
    if (!byProducer.has(k)) byProducer.set(k, []);
    byProducer.get(k).push(e);
  });
  const producerRank = (p) => { const i = PORT_PRODUCERS.indexOf(p); return i === -1 ? PORT_PRODUCERS.length : i; };
  const producers = [...byProducer.keys()].sort((a, b) => {
    if (!a) return 1; if (!b) return -1;
    return producerRank(a) - producerRank(b) || a.localeCompare(b);
  });
  // Dated first, soonest first; a month with the day TBC keeps its month;
  // no date at all goes last.
  const byDate = (a, b) => {
    const ad = a.event_date && a.date_tbc !== 'date' ? String(a.event_date).slice(0, 10) : '';
    const bd = b.event_date && b.date_tbc !== 'date' ? String(b.event_date).slice(0, 10) : '';
    if (!ad && !bd) return String(a.name).localeCompare(String(b.name));
    if (!ad) return 1;
    if (!bd) return -1;
    return ad.localeCompare(bd) || String(a.name).localeCompare(String(b.name));
  };
  const rowScale = Math.max(1, ...filtered.map(e => num(e.total_pipeline)));
  const listHtml =
    `<section class="pf-list">
      <div class="pf-list-hd">
        <h2 class="pf-panel-title">Events by producer team</h2>
        <span class="pf-panel-aside">${filtered.length} event${filtered.length === 1 ? '' : 's'} · click a name for its sponsors</span>
      </div>
      ${producers.map(p => {
        const evs = byProducer.get(p).sort(byDate);
        const pAlloc = evs.reduce((a, e) => a + num(e.total_pipeline), 0);
        const pPaid  = evs.reduce((a, e) => a + num(e.total_won), 0);
        return `<div class="pf-group" data-producer="${esc(p.toLowerCase())}">
          <div class="pf-group-hd">
            <span class="pf-group-name">${p ? esc(p) : 'Other events'}</span>
            <span class="pf-group-n">${evs.length} event${evs.length === 1 ? '' : 's'}</span>
            <span class="pf-group-total">${fmtGBP(pAlloc)} <small>· ${fmtGBP(pPaid)} paid</small></span>
          </div>
          ${evs.map(e => renderPortfolioEventCard(e, rowScale)).join('')}
        </div>`;
      }).join('')}
    </section>`;

  grid.innerHTML = toolbarHtml + heroHtml + kpiHtml + seriesHtml + renderPortfolioTeams() + programmeHtml + listHtml;

  // Bars grow in after paint.
  requestAnimationFrame(() => setTimeout(() => {
    grid.querySelectorAll('.pf-anim').forEach(b => { b.style.width = Math.max(b.dataset.pct > 0 ? 1.5 : 0, Number(b.dataset.pct) || 0) + '%'; });
  }, 40));

  if (_portSearch) portFilterCards(_portSearch);
}

// ── Portfolio teams ──
// Each portfolio (programme series) has four people per programme year. On
// All Years the panel shows the default programme year's teams.
// `dept` picks the department whose staff are offered first for the role.
const PORT_TEAM_ROLES = [
  { key: 'sales',       label: 'Sales',       dept: /sales/i },
  { key: 'delegates',   label: 'Delegates',   dept: /delegat/i },
  { key: 'production',  label: 'Production',  dept: /produc/i },
  { key: 'co_producer', label: 'Co-producer', dept: /produc/i },
];
const PORT_TEAM_OUTSIDE = 'outside';

function portTeamYear() {
  return _portYearFilter !== 'all' ? parseInt(_portYearFilter, 10) : new Date().getFullYear() + 1;
}

function portTeamFor(series, year) {
  return _portTeams.find(t => t.series === series && Number(t.programme_year) === year) || null;
}

function renderPortfolioTeams() {
  const year = portTeamYear();
  const rows = PORT_SERIES.map(s => {
    const t = portTeamFor(s.id, year);
    const cells = PORT_TEAM_ROLES.map(r => {
      const name = t && t[r.key] ? esc(t[r.key]) : '';
      if (!name) return `<td data-label="${r.label}"><span class="pf-team-empty">—</span></td>`;
      const id = t[`${r.key}_id`];
      const tag = !id ? '<span class="pf-team-tag">outside</span>' : t[`${r.key}_active`] === false ? '<span class="pf-team-tag">left</span>' : '';
      const nameHtml = id
        ? `<button type="button" class="pf-team-name pf-team-link" onclick="goToEmployee(${Number(id)})" title="Open ${name}'s record">${name}</button>`
        : `<span class="pf-team-name">${name}</span>`;
      return `<td data-label="${r.label}">${nameHtml}${tag}</td>`;
    }).join('');
    return `<tr>
      <td><span class="pf-team-series"><span class="pf-chip" style="background:var(--chart-${s.chart})"></span>${esc(s.short)}</span></td>
      ${cells}
      <td class="pf-team-act"><button type="button" class="btn btn-ghost btn-sm" onclick="openPortTeamModal('${s.id}')">${t ? 'Edit' : 'Add team'}</button></td>
    </tr>`;
  }).join('');
  return `<section class="pf-panel pf-teams">
    <div class="pf-panel-hd">
      <div>
        <h2 class="pf-panel-title">Portfolio teams</h2>
        <p class="pf-panel-desc">Who runs each portfolio in ${year}.</p>
      </div>
    </div>
    <div class="table-wrap"><table class="pf-teams-table">
      <thead><tr><th>Portfolio</th>${PORT_TEAM_ROLES.map(r => `<th>${r.label}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

let _portTeamStaff = [];

// One role's picker: that department's staff first, then everyone else, then
// "someone outside the company". A saved person who has since left stays
// selectable so the record is not silently changed.
function portTeamFillPicker(role, team) {
  const sel = document.getElementById(`portTeam_${role.key}_sel`);
  const other = document.getElementById(`portTeam_${role.key}`);
  const savedId = team && team[`${role.key}_id`] ? Number(team[`${role.key}_id`]) : null;
  const savedName = team && team[role.key] ? team[role.key] : '';
  const staff = _portTeamStaff.filter(e => e.active || e.id === savedId);
  const inDept = staff.filter(e => role.dept.test(e.department || ''));
  const rest = staff.filter(e => !role.dept.test(e.department || ''));
  const opt = e => `<option value="${e.id}">${esc(e.name)}${e.active ? '' : ' (left)'}${e.department && !role.dept.test(e.department) ? ` · ${esc(e.department)}` : ''}</option>`;
  const deptNames = [...new Set(inDept.map(e => e.department))].join(' / ');
  sel.innerHTML = '<option value="">Nobody yet</option>' +
    (inDept.length ? `<optgroup label="${esc(deptNames)} team">${inDept.map(opt).join('')}</optgroup>` : '') +
    (rest.length ? `<optgroup label="${inDept.length ? 'Everyone else' : 'Staff'}">${rest.map(opt).join('')}</optgroup>` : '') +
    `<option value="${PORT_TEAM_OUTSIDE}">Someone outside the company…</option>`;
  if (savedId) sel.value = String(savedId);
  else if (savedName) sel.value = PORT_TEAM_OUTSIDE;
  else sel.value = '';
  other.value = savedId ? '' : savedName;
  other.classList.toggle('hidden', sel.value !== PORT_TEAM_OUTSIDE);
}

function portTeamPick(roleKey) {
  const sel = document.getElementById(`portTeam_${roleKey}_sel`);
  const other = document.getElementById(`portTeam_${roleKey}`);
  const outside = sel.value === PORT_TEAM_OUTSIDE;
  other.classList.toggle('hidden', !outside);
  if (outside) other.focus();
}

async function openPortTeamModal(series) {
  const s = PORT_SERIES_MAP[series];
  if (!s) return;
  const year = portTeamYear();
  const t = portTeamFor(series, year) || {};
  document.getElementById('portTeamSeries').value = series;
  document.getElementById('portTeamTitle').textContent = `${s.short} team`;
  document.getElementById('portTeamSub').textContent = `${s.name} · ${year}`;
  try {
    const res = await fetch('/api/employees/all');
    _portTeamStaff = res.ok ? await res.json() : [];
  } catch { _portTeamStaff = []; }
  _portTeamStaff.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  PORT_TEAM_ROLES.forEach(r => portTeamFillPicker(r, t));
  openModal('portTeamModal');
  document.getElementById('portTeam_sales_sel').focus();
}

async function savePortTeam() {
  const series = document.getElementById('portTeamSeries').value;
  const body = { year: portTeamYear() };
  for (const r of PORT_TEAM_ROLES) {
    const v = document.getElementById(`portTeam_${r.key}_sel`).value;
    if (v === PORT_TEAM_OUTSIDE) {
      const name = document.getElementById(`portTeam_${r.key}`).value.trim();
      if (!name) { showToast(`Type a name for ${r.label}, or pick someone from the list`, 'error'); return; }
      body[r.key] = name;
    } else if (v) {
      body[`${r.key}_id`] = parseInt(v, 10);
    }
  }
  const res = await fetch(`/api/portfolio-teams/${encodeURIComponent(series)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.error || 'Could not save the team', 'error'); return; }
  const saved = await res.json();
  _portTeams = _portTeams.filter(t => !(t.series === saved.series && Number(t.programme_year) === Number(saved.programme_year))).concat(saved);
  closeModal('portTeamModal');
  showToast('Team saved', 'success');
  renderPortfolioGrid();
}

// ── An employee's portfolio work, for their record ──
// Each role they have held, with how that portfolio did that year: events,
// money allocated against them and paid. Portfolio figures come from the
// same events and programme data the Portfolio page uses.
async function loadEmpPortfolioRoles(empId, boxId = 'empPortfolioRoles') {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.innerHTML = '<div class="epr-empty">Loading…</div>';
  try {
    const [rolesRes, evRes] = await Promise.all([
      fetch(`/api/employees/${empId}/portfolio-roles`),
      portfolioData.length ? null : fetch('/api/portfolio-events'),
    ]);
    if (!rolesRes.ok) { box.innerHTML = ''; return; }
    const roles = await rolesRes.json();
    if (evRes && evRes.ok) { const d = await evRes.json(); if (Array.isArray(d)) portfolioData = d; }
    if (!_programme2027.data && _programme2027.status !== 'loading') await loadProgramme2027Quiet();
    if (!roles.length) { box.innerHTML = '<div class="epr-empty">Not on any portfolio team yet. Teams are set on the Portfolio page.</div>'; return; }

    const roleLabel = k => (PORT_TEAM_ROLES.find(r => r.key === k) || {}).label || k;
    const stats = (series, year) => portfolioData
      .filter(e => portRowYear(e) === Number(year) && portSeriesFor(e) === series)
      .reduce((t, e) => { t.events++; t.allocated += parseFloat(e.total_pipeline) || 0; t.paid += parseFloat(e.total_won) || 0; t.deals += parseInt(e.deal_count) || 0; return t; },
              { events: 0, allocated: 0, paid: 0, deals: 0 });
    // One line per portfolio and year; several roles in it are joined.
    const grouped = new Map();
    roles.forEach(r => {
      const k = `${r.programme_year}|${r.series}`;
      if (!grouped.has(k)) grouped.set(k, { ...r, roles: [] });
      grouped.get(k).roles.push(roleLabel(r.role));
    });
    const total = { allocated: 0, paid: 0 };
    const rows = [...grouped.values()].map(g => {
      const s = PORT_SERIES_MAP[g.series];
      const st = stats(g.series, g.programme_year);
      total.allocated += st.allocated; total.paid += st.paid;
      return `<div class="epr-row">
        <div class="epr-main">
          <span class="pf-chip" style="background:${s ? `var(--chart-${s.chart})` : 'var(--dim)'}"></span>
          <span class="epr-series">${esc(s ? s.short : g.series)}</span>
          <span class="epr-year">${g.programme_year}</span>
          <span class="epr-roles">${g.roles.map(esc).join(' · ')}</span>
        </div>
        <div class="epr-stats">${st.events} event${st.events === 1 ? '' : 's'} · ${fmtGBP(st.allocated)} allocated · ${fmtGBP(st.paid)} paid</div>
      </div>`;
    }).join('');
    box.innerHTML = rows + `<div class="epr-total">Across these portfolios: ${fmtGBP(total.allocated)} allocated, ${fmtGBP(total.paid)} paid</div>`;
  } catch {
    box.innerHTML = '<div class="epr-empty">Could not load portfolio roles.</div>';
  }
}

// Programme data without re-rendering the Portfolio page.
async function loadProgramme2027Quiet() {
  try {
    const res = await fetch('/api/programme/2027');
    if (res.ok) _programme2027 = { status: 'ready', data: await res.json(), error: null };
  } catch { /* series fall back to guessing from the event name */ }
}

const PF_ICON_PIN   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const PF_ICON_USERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const PF_ICON_CHEV  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/** Series chip: colour square plus the short name in muted ink. Text never wears the hue. */
function renderSeriesChip(seriesId) {
  const s = seriesId && PORT_SERIES_MAP[seriesId];
  if (!s) return `<span class="pf-series-chip"><span class="pf-chip"></span>Unassigned</span>`;
  return `<span class="pf-series-chip" title="${esc(s.code)} · ${esc(s.name)}"><span class="pf-chip" style="background:var(--chart-${s.chart})"></span>${esc(s.short)}</span>`;
}

/**
 * One event row. `scale` is the largest allocation in the visible list so
 * bar lengths are comparable; the bar is one hue because the series chip
 * already carries identity.
 */
function renderPortfolioEventCard(ev, scale) {
  const won         = parseFloat(ev.total_won) || 0;
  const pipeline    = parseFloat(ev.total_pipeline) || 0;
  const outstanding = Math.max(0, pipeline - won);
  const dealCount   = parseInt(ev.deal_count) || 0;
  const pct         = pipeline / Math.max(1, scale || pipeline) * 100;
  const series      = portSeriesFor(ev);
  const when        = fmtEventDate(ev, { long: true });
  const isTbc       = !!ev.date_tbc || !ev.event_date;
  const looksLike   = ev.programme_key ? '' : programmeLooksLike(ev.id);
  const hay         = [ev.name, ev.location, ev.producer, series && PORT_SERIES_MAP[series] ? PORT_SERIES_MAP[series].short : ''].join(' ').toLowerCase();

  return `<div class="pec-card pf-row" data-name="${esc(hay)}" data-id="${ev.id}">
    <div class="pf-row-main">
      <div class="pf-row-id">
        <button type="button" class="pf-row-btn" onclick="togglePortfolioDeals(this,${ev.id})" aria-expanded="false">
          <span class="pec-arrow">${PF_ICON_CHEV}</span>
          <span class="pf-row-txt">
            <span class="pf-row-name">${esc(ev.name)}</span>
            <span class="pf-row-meta">
              ${renderSeriesChip(series)}
              ${ev.location ? `<span class="pf-meta-item">${PF_ICON_PIN}${esc(ev.location)}</span>` : ''}
              <span class="pf-meta-item${isTbc ? ' pf-meta-tbc' : ''}">${esc(when)}</span>
              <span class="pf-meta-item">${PF_ICON_USERS}${dealCount}</span>
              ${looksLike ? `<span class="pf-meta-item pf-meta-dup" title="The 2027 programme panel above can fold this row into it">looks like ${esc(looksLike)}</span>` : ''}
            </span>
          </span>
        </button>
      </div>
      <div class="pf-row-figs-wrap">
        <div class="pf-row-figs">
          <span class="pf-row-alloc">${fmtGBP(pipeline)}</span>
          <span class="pf-row-paid">${pipeline > 0
            ? (outstanding > 0 ? `${fmtGBP(won)} paid · ${fmtGBP(outstanding)} owed` : 'fully paid')
            : 'nothing allocated'}</span>
        </div>
        <div class="pf-track"><div class="pf-bar pf-anim" data-pct="${pct}"></div></div>
      </div>
      <div class="pf-row-actions sub-actions">
        <button class="sub-action-btn" onclick="openPortfolioModal(${ev.id})">Edit</button>
        <button class="sub-action-btn sub-action-btn--danger" onclick="deletePortfolioEvent(${ev.id})">Delete</button>
      </div>
    </div>
    <div class="pec-deals-list"></div>
  </div>`;
}

async function togglePortfolioDeals(btn, eventId) {
  const card = btn.closest('.pec-card');
  const list = card ? card.querySelector('.pec-deals-list') : null;
  if (!card || !list) return;
  const isOpen = card.classList.contains('open');
  const toggleBtn = card.querySelector('.pf-row-btn');

  if (isOpen) {
    card.classList.remove('open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    return;
  }
  card.classList.add('open');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
  if (list.dataset.loaded === String(eventId)) return;

  const ev = portfolioData.find(x => x.id === eventId) || {};
  const head = `<div class="pf-deals-hd"><span class="pf-eyebrow">Sponsoring this event</span>` +
    `<button class="sub-action-btn" onclick="viewEventDeals(${eventId},'${esc(ev.name || '').replace(/'/g, "\\'")}')">View in Deals</button></div>`;
  list.innerHTML = head + '<div class="pf-deals-msg">Loading from the deal tracker…</div>';

  try {
    const res = await fetch(`/api/portfolio-events/${eventId}/deals`);
    const deals = res.ok ? await res.json() : [];
    list.dataset.loaded = String(eventId);
    if (!deals.length) {
      list.innerHTML = head + '<div class="pf-deals-msg">No sponsors allocated to this event yet.</div>';
      return;
    }
    const symMap = { GBP: '£', USD: '$', AED: 'AED ', PHP: '₱', EUR: '€', CHF: 'CHF ' };
    list.innerHTML = head + `<div class="pf-deals">` + deals.map(d => {
      const sym  = symMap[d.currency] || '£';
      const paid = parseFloat(d.paid_inc_vat) || 0;
      const amt  = parseFloat(d.amount) || 0;
      const isPaid = paid > 0;
      const isPart = isPaid && paid < amt;
      const state  = isPaid && !isPart ? 'Paid' : isPart ? `Part paid · ${sym}${fmt(paid)}` : 'Awaiting payment';
      const dot    = isPaid && !isPart ? 'pf-deal-dot--paid' : isPart ? 'pf-deal-dot--part' : '';
      const sub = [state, d.package_label, d.signed_by ? `signed by ${d.signed_by}` : ''].filter(Boolean).map(esc).join(' · ');
      return `<div class="pf-deal">
        <span class="pf-deal-dot ${dot}"></span>
        <span class="pf-deal-body"><span class="pf-deal-co">${esc(d.company)}</span><span class="pf-deal-sub">${sub}</span></span>
        <span class="pf-deal-amt">${sym}${fmt(amt)}</span>
      </div>`;
    }).join('') + `</div>`;
  } catch {
    list.innerHTML = head + '<div class="pf-deals-msg pf-err">Failed to load deals.</div>';
  }
}

function viewEventDeals(eventId, eventName) {
  _dealEventFilter = String(eventId);
  navigate('deals');
  // Ensure deals are loaded then apply filter
  const apply = () => {
    const sel = document.getElementById('dealEventFilter');
    if (sel) {
      // Ensure the option exists (loadDeals populates it)
      let opt = Array.from(sel.options).find(o => o.value === String(eventId));
      if (!opt) {
        opt = new Option(eventName, String(eventId));
        sel.add(opt);
      }
      sel.value = String(eventId);
    }
    renderDealsTable();
  };
  if (dealsData.length) { apply(); }
  else { loadDeals().then(apply); }
}

// ── 2027 programme panel ──
//
// The confirmed programme reconciled against what the tracker holds. Every
// row shows what will happen and nothing happens until "Apply" is pressed:
// a rename keeps the row (and every deal on it), a create adds a row.

function programmeDefaultDecision(item) {
  if (item.status === 'suggested') return '';        // a person must choose
  if (item.status === 'missing') return 'create';
  if (item.duplicate) return '';                     // linked, but an older row looks like it: choose
  return 'linked';
}
function programmeNeedsChoice(item) {
  return item.status === 'suggested' ? !!item.suggestion : (item.status === 'linked' && !!item.duplicate);
}
function programmeDecision(item) {
  return _programmeDecisions[item.key] || programmeDefaultDecision(item);
}
function programmeUndecided() {
  const items = (_programme2027.data && _programme2027.data.items) || [];
  return items.filter(it => programmeNeedsChoice(it) && !programmeDecision(it)).length;
}
function acceptAllSuggestedRenames() {
  const items = (_programme2027.data && _programme2027.data.items) || [];
  items.forEach(it => {
    if (it.status === 'suggested' && it.suggestion) _programmeDecisions[it.key] = 'rename';
    else if (it.status === 'linked' && it.duplicate) _programmeDecisions[it.key] = 'merge';
  });
  renderPortfolioGrid();
}
function setProgrammeDecision(key, action) {
  _programmeDecisions[key] = action;
  // Only the count on the Apply button changes; no need to redraw the page.
  const btn = document.getElementById('pfApplyBtn');
  const status = document.getElementById('pfApplyStatus');
  if (btn || status) {
    const { renames, creates, merges } = programmeTally();
    const n = renames + creates + merges;
    const undecided = programmeUndecided();
    if (btn) {
      btn.textContent = undecided ? `Choose for ${undecided} matched event${undecided === 1 ? '' : 's'} first` : `Apply ${n} decision${n === 1 ? '' : 's'}`;
      btn.disabled = n === 0 || undecided > 0;
    }
    if (status) status.innerHTML = programmeTallyText(renames, creates, merges);
  }
}
function programmeTally() {
  const items = (_programme2027.data && _programme2027.data.items) || [];
  let renames = 0, creates = 0, merges = 0;
  items.forEach(it => {
    const d = programmeDecision(it);
    if (it.status === 'linked') { if (d === 'merge' && it.duplicate) merges++; return; }
    if (d === 'rename' && it.suggestion) renames++;
    else if (d === 'create') creates++;
  });
  return { renames, creates, merges };
}
function programmeTallyText(renames, creates, merges) {
  if (!renames && !creates && !merges) return 'Nothing to apply';
  return [
    renames ? `<b>${renames}</b> rename${renames === 1 ? '' : 's'}` : '',
    creates ? `<b>${creates}</b> new event${creates === 1 ? '' : 's'}` : '',
    merges ? `<b>${merges}</b> merge${merges === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') + ' when applied';
}

// The confirmed event an unlinked row seems to be, per the reconcile: a
// rename candidate, or an older duplicate of a row already linked.
function programmeLooksLike(rowId) {
  const items = (_programme2027.status === 'ready' && _programme2027.data && _programme2027.data.items) || [];
  const it = items.find(i => (i.suggestion && i.suggestion.id === rowId) || (i.duplicate && i.duplicate.id === rowId));
  return it ? it.name : '';
}

function renderProgrammePanel() {
  const p = _programme2027;
  const hd = (aside) => `<div class="pf-panel-hd">
      <div>
        <h2 class="pf-panel-title">2027 programme</h2>
        <p class="pf-panel-desc">The confirmed calendar, 25 events across 5 producer teams, checked against what the tracker already holds. Renaming keeps a row and every deal allocated to it; merging moves an older row's deals onto the linked one and removes the old row. Nothing changes until you apply.</p>
      </div>
      <div class="pf-panel-aside">${aside || ''}</div>
    </div>`;

  if (p.status === 'loading' || p.status === 'idle') {
    return `<section class="pf-panel">${hd('')}<p class="pf-prog-status">Loading the programme…</p></section>`;
  }
  if (p.status === 'error') {
    return `<section class="pf-panel">${hd(`<button class="btn btn-ghost btn-sm" onclick="loadProgramme2027()">Retry</button>`)}<p class="pf-prog-status">Could not load the programme: ${esc(p.error || '')}</p></section>`;
  }

  const data = p.data;
  const c = data.counts || { linked: 0, suggested: 0, missing: 0, duplicates: 0 };
  const dups = c.duplicates || 0;
  const seriesShort = (id) => (data.series && data.series[id] && data.series[id].short) || (PORT_SERIES_MAP[id] && PORT_SERIES_MAP[id].short) || id;
  const statusLine =
    `<p class="pf-prog-status">` +
      `<span class="pf-prog-dot pf-prog-dot--linked"></span><b>${c.linked}</b> linked &nbsp;·&nbsp; ` +
      `<span class="pf-prog-dot pf-prog-dot--suggested"></span><b>${c.suggested}</b> matched, awaiting your confirmation &nbsp;·&nbsp; ` +
      `<span class="pf-prog-dot pf-prog-dot--missing"></span><b>${c.missing}</b> to create` +
      (dups ? ` &nbsp;·&nbsp; <span class="pf-prog-dot pf-prog-dot--suggested"></span><b>${dups}</b> older row${dups === 1 ? '' : 's'} look${dups === 1 ? 's' : ''} like ${dups === 1 ? 'a linked event' : 'linked events'}` : '') +
    `</p>`;

  const decisionCell = (it) => {
    const d = programmeDecision(it);
    const opt = (v, label) => `<option value="${v}"${d === v ? ' selected' : ''}>${label}</option>`;
    if (it.status === 'linked') {
      const r = it.row || {};
      let html = `<span class="pf-prog-linked">Linked to #${r.id} · <b>${esc(r.name || '')}</b>` +
        ` <button class="pf-prog-unlink" onclick="unlinkProgrammeRow(${parseInt(r.id, 10) || 0}, ${JSON.stringify(String(r.name || ''))})" title="Undo this link. The event, its date and its deals stay exactly as they are; it just stops counting as this programme entry.">Unlink</button></span>`;
      // An older row under its shorthand name, still sitting beside the
      // linked one. Merging moves its deals here and removes it.
      if (it.duplicate) {
        const dup = it.duplicate;
        const n = parseInt(dup.deal_count) || 0;
        const deals = `${n} deal${n === 1 ? '' : 's'}`;
        html += `<div class="pf-prog-dup">` +
          `<span class="pf-prog-dup-lbl">Older row <b>#${dup.id} ${esc(dup.name)}</b> (${deals}) looks like the same event.</span>` +
          `<select class="pf-prog-select${d ? '' : ' pf-prog-select--undecided'}" onchange="setProgrammeDecision('${esc(it.key)}', this.value)">` +
            opt('', 'Same event? Choose\u2026') +
            opt('merge', `Yes \u2014 merge it in (moves its ${deals} here, removes "${esc(dup.name)}")`) +
            opt('leave', 'No \u2014 a different event, leave it') +
          `</select></div>`;
      }
      return html;
    }
    if (it.status === 'suggested' && it.suggestion) {
      const s = it.suggestion;
      const n = parseInt(s.deal_count) || 0;
      return `<select class="pf-prog-select${d ? '' : ' pf-prog-select--undecided'}" onchange="setProgrammeDecision('${esc(it.key)}', this.value)">` +
        opt('', `Is this "${esc(s.name)}"? Choose\u2026`) +
        opt('rename', `Yes \u2014 rename it (keeps its ${n} deal${n === 1 ? '' : 's'})`) +
        opt('create', 'No \u2014 create as a new event') +
        opt('skip', 'Skip for now') +
      `</select>`;
    }
    return `<select class="pf-prog-select" onchange="setProgrammeDecision('${esc(it.key)}', this.value)">` +
      opt('create', 'Create') + opt('skip', 'Skip') + `</select>`;
  };

  const rows = (data.items || []).map(it => {
    const sid = it.series;
    const s = PORT_SERIES_MAP[sid];
    const chip = s
      ? `<span class="pf-series-chip"><span class="pf-chip" style="background:var(--chart-${s.chart})"></span>${esc(seriesShort(sid))}</span>`
      : renderSeriesChip(null);
    return `<tr>
      <td class="pf-td-name"><span class="pf-prog-dot pf-prog-dot--${esc(it.status)}" title="${esc(it.status)}"></span>${esc(it.name)}<div class="pf-row-meta">${chip}${it.location ? `<span class="pf-meta-item">${PF_ICON_PIN}${esc(it.location)}</span>` : ''}</div></td>
      <td class="pf-td-muted">${esc(it.producer)}</td>
      <td class="pf-td-muted">${esc(fmtEventDate({ event_date: it.date, date_tbc: it.tbc, programme_year: data.year || 2027 }, { long: true }))}</td>
      <td>${decisionCell(it)}</td>
    </tr>`;
  }).join('');

  const { renames, creates, merges } = programmeTally();
  const n = renames + creates + merges;
  const undecided = programmeUndecided();
  const matches = (c.suggested || 0) + dups;
  const notRunning = (data.not_running || []);
  return `<section class="pf-panel" id="pfProgramme">
    ${hd(`<button class="btn btn-ghost btn-sm" onclick="togglePortfolioProgramme()">Hide</button>`)}
    ${statusLine}
    <div class="pf-prog-scroll"><table class="pf-prog-table">
      <thead><tr><th>Event</th><th>Producer</th><th>Date</th><th>Decision</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="pf-prog-actions">
      <span class="pf-prog-status" id="pfApplyStatus">${programmeTallyText(renames, creates, merges)}</span>
      ${matches ? `<button class="btn btn-ghost btn-sm" onclick="acceptAllSuggestedRenames()" title="Sets every matched event to Yes: renames for unlinked events, merges for older rows beside linked ones. You can still change any row before applying.">Accept all ${matches} match${matches === 1 ? '' : 'es'}</button>` : ''}
      <button class="btn btn-primary btn-sm" id="pfApplyBtn" onclick="applyProgramme2027()"${(n === 0 || undecided > 0) ? ' disabled' : ''}>${undecided ? `Choose for ${undecided} matched event${undecided === 1 ? '' : 's'} first` : `Apply ${n} decision${n === 1 ? '' : 's'}`}</button>
    </div>
    ${notRunning.length ? `<p class="pf-prog-foot">Not running in 2027: ${notRunning.map(esc).join(', ')}. Listed so nobody re-creates ${notRunning.length === 1 ? 'it' : 'them'} by hand.</p>` : ''}
  </section>`;
}

/** Undo a confirmed link. Clears the programme key only; nothing else moves. */
async function unlinkProgrammeRow(rowId, rowName) {
  if (!rowId) return;
  if (!confirm(`Unlink "${rowName}" from the 2027 programme?\n\nThe event keeps its name, date and every deal. It simply stops counting as this programme entry, and the panel can suggest it again.`)) return;
  try {
    const res = await fetch('/api/programme/2027/unlink', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ row_id: rowId }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(out.error || 'Could not unlink', 'error'); return; }
    showToast('Unlinked. The event itself is unchanged.', 'success');
  } catch (e) {
    showToast('Could not unlink: ' + e.message, 'error');
  }
  await loadPortfolio();
}

async function applyProgramme2027() {
  const items = (_programme2027.data && _programme2027.data.items) || [];
  const decisions = [];
  items.forEach(it => {
    const d = programmeDecision(it);
    if (it.status === 'linked') {
      if (d === 'merge' && it.duplicate) decisions.push({ key: it.key, action: 'merge', row_id: it.duplicate.id });
      return;
    }
    if (d === 'rename' && it.suggestion) decisions.push({ key: it.key, action: 'rename', row_id: it.suggestion.id });
    else if (d === 'create') decisions.push({ key: it.key, action: 'create' });
  });
  if (!decisions.length) { showToast('Nothing to apply', 'info'); return; }
  const renames = decisions.filter(d => d.action === 'rename').length;
  const creates = decisions.filter(d => d.action === 'create').length;
  const merges  = decisions.filter(d => d.action === 'merge').length;
  const summary = [
    renames ? `rename ${renames} existing event${renames === 1 ? '' : 's'} to the confirmed name (their deals stay allocated)` : '',
    creates ? `create ${creates} new event${creates === 1 ? '' : 's'}` : '',
    merges ? `merge ${merges} older event${merges === 1 ? '' : 's'} into the confirmed one${merges === 1 ? '' : 's'} (the deals move across and the old row${merges === 1 ? ' is' : 's are'} removed)` : '',
  ].filter(Boolean).join(', ');
  if (!confirm(`This will ${summary}. Skipped events are left as they are. Continue?`)) return;

  const btn = document.getElementById('pfApplyBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  try {
    const res = await fetch('/api/programme/2027/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions }),
    });
    const out = await res.json().catch(() => ({}));
    const results = Array.isArray(out.results) ? out.results : [];
    const count = (o) => results.filter(r => r.outcome === o).length;
    const movedDeals = results.filter(r => r.outcome === 'merged').reduce((a, r) => a + (Number(r.deals_moved) || 0), 0);
    const done = [`${count('renamed')} renamed`, `${count('created')} created`]
      .concat(merges ? [`${count('merged')} merged (${movedDeals} deal${movedDeals === 1 ? '' : 's'} moved)`] : []).join(', ');
    if (!res.ok || !out.ok) {
      showToast(`Programme apply stopped: ${out.error || `HTTP ${res.status}`} (${done})`, 'error', 7000);
    } else {
      const held = count('row-wrong-year') + count('row-changed-underneath') + count('row-already-linked') + count('not-linked') + count('row-not-found');
      const other = results.length - count('renamed') - count('created') - count('merged') - count('skipped') - held;
      showToast(`2027 programme applied: ${done}${held ? `, ${held} held (row changed underneath, or from another year)` : ''}${other ? `, ${other} left as they were` : ''}`, held ? 'warning' : 'success', 7000);
    }
  } catch (e) {
    showToast('Could not apply the programme: ' + e.message, 'error');
  }
  _programmeDecisions = {};
  await loadPortfolio();
  await loadProgramme2027();
}

// ── Edit form ──

function portDateChanged() {
  const tbc  = document.getElementById('portDateTbc');
  const date = document.getElementById('portDate');
  const hint = document.getElementById('portDateHint');
  if (!tbc || !date || !hint) return;
  const preview = fmtEventDate({ event_date: date.value || null, date_tbc: tbc.value, programme_year: parseInt(document.getElementById('portYear').value, 10) || null }, { long: true });
  hint.textContent = tbc.value === 'date'
    ? `Shown as "${preview}". The date is optional until it is confirmed.`
    : tbc.value === 'day'
      ? `Shown as "${preview}". Pick any day in the month; only the month is shown.`
      : (date.value ? `Shown as "${preview}".` : '');
}

function openPortfolioModal(id) {
  document.getElementById('portEditId').value = id || '';
  document.getElementById('portfolioModalTitle').textContent = id ? 'Edit Event' : 'Add Event';
  const producerSel = document.getElementById('portProducer');
  const ev = id ? portfolioData.find(x => x.id === id) : null;
  if (id && !ev) return;
  // A producer the select does not know (an older row) is still shown, not silently dropped.
  if (ev && ev.producer && ![...producerSel.options].some(o => o.value === ev.producer)) {
    producerSel.add(new Option(ev.producer, ev.producer));
  }
  document.getElementById('portName').value     = ev ? ev.name : '';
  document.getElementById('portDate').value     = ev && ev.event_date ? String(ev.event_date).slice(0, 10) : '';
  document.getElementById('portDateTbc').value  = ev ? (ev.date_tbc || '') : '';
  producerSel.value                             = ev ? (ev.producer || '') : '';
  document.getElementById('portYear').value     = ev ? (ev.programme_year || '') : (_portYearFilter !== 'all' ? _portYearFilter : '');
  document.getElementById('portLocation').value = ev ? (ev.location || '') : '';
  document.getElementById('portNotes').value    = ev ? (ev.notes || '') : '';
  portDateChanged();
  openModal('portfolioModal');
}

async function savePortfolioEvent() {
  const id = document.getElementById('portEditId').value;
  const name = document.getElementById('portName').value.trim();
  if (!name) { showToast('Event name is required', 'error'); return; }
  const dateTbc = document.getElementById('portDateTbc').value;
  const picked = document.getElementById('portDate').value || null;
  if (!picked && dateTbc !== 'date') { showToast('Pick a date, or mark the date as TBC', 'error'); return; }
  // "Date TBC" means there is no date. A day left in the box is not sent, so
  // no placeholder can ever be printed as a booking; its year still counts.
  const date = dateTbc === 'date' ? null : picked;
  const yearRaw = document.getElementById('portYear').value || (dateTbc === 'date' && picked ? picked.slice(0, 4) : '');
  const year = yearRaw ? parseInt(yearRaw, 10) : null;
  if (yearRaw && (isNaN(year) || year < 2000 || year > 2100)) { showToast('Programme year must be a four-digit year', 'error'); return; }
  if (!date && !year) { showToast('An event with no date needs a programme year to be filed under', 'error'); return; }

  const saveBtn = document.querySelector('#portfolioModal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  const body = {
    name,
    event_date: date,
    location: document.getElementById('portLocation').value.trim(),
    notes: document.getElementById('portNotes').value.trim(),
    producer: document.getElementById('portProducer').value || '',
    date_tbc: dateTbc,
    programme_year: year,
  };
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/portfolio-events/${id}` : '/api/portfolio-events';
  try {
    const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.error || 'Save failed', 'error'); return; }
    showToast(id ? 'Event updated' : 'Event added', 'success');
    const savedYear = year || (date ? parseInt(date.slice(0, 4), 10) : null);
    if (savedYear) _portYearFilter = String(savedYear);
    closeModal('portfolioModal');
    loadPortfolio();
  } catch (e) {
    showToast('Could not save event: ' + e.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

async function deletePortfolioEvent(id) {
  if (!confirm('Delete this event? Associated deal allocations will also be removed.')) return;
  const res = await fetch(`/api/portfolio-events/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Event deleted', 'success');
  loadPortfolio();
}

// ─── DEAL TRACKER ─────────────────────────────────────────────────────────────

const DEAL_STAGES = ['Prospect','Qualified','Proposal','Negotiation','Won','Lost'];
const DEAL_STAGE_COLOR = { Prospect:'#64748b', Qualified:'#7c3aed', Proposal:'#2563eb', Negotiation:'#d97706', Won:'#16a34a', Lost:'#dc2626' };
const DEAL_VAT_QUARTERS = {
  Q1: [11, 12, 1],   // Nov, Dec, Jan
  Q2: [2, 3, 4],     // Feb, Mar, Apr
  Q3: [5, 6, 7],     // May, Jun, Jul
  Q4: [8, 9, 10]     // Aug, Sep, Oct
};
let dealsData = [];
let _dealInv1 = null;
let _dealInv2 = null;
let _dealPackageMode = false;
let _dealPackages = {}; // { [eventId]: { amount, label } }
let _dealQFilter = 'all';
let _dealYearFilter = 'all';
let _dealEventFilter = '';
let _dealRangeFrom = '';  // YYYY-MM
let _dealRangeTo   = '';  // YYYY-MM
let _selectedDealIds = new Set();
let _lastInvoiceId = null;
let _nextInvoiceNum = null;
let _importRows = [];

/** Deals filed under a different year from their events, offered as one fix. */
async function checkDealsToRefile() {
  const el = document.getElementById('dealRefileBanner');
  if (!el) return;
  try {
    const res = await fetch('/api/deals/refile-by-events');
    if (!res.ok) { el.classList.add('hidden'); return; }
    const { deals } = await res.json();
    if (!deals || !deals.length) { el.classList.add('hidden'); return; }
    const sample = deals.slice(0, 3).map(d => `${esc(d.company)} (${d.fiscal_year || 'no year'} \u2192 ${d.events_year})`).join(', ');
    el.innerHTML = `<span class="deal-refile-text"><b>${deals.length}</b> deal${deals.length === 1 ? ' is' : 's are'} filed under a different year from ${deals.length === 1 ? 'its' : 'their'} events: ${sample}${deals.length > 3 ? ` and ${deals.length - 3} more` : ''}.</span>` +
      `<button class="btn btn-primary btn-sm" onclick="refileDealsByEvents(${deals.length})">Refile ${deals.length} by ${deals.length === 1 ? 'its' : 'their'} events</button>`;
    el.classList.remove('hidden');
  } catch { el.classList.add('hidden'); }
}
async function refileDealsByEvents(n) {
  if (!confirm(`Refile ${n} deal${n === 1 ? '' : 's'} under the year of ${n === 1 ? 'its' : 'their'} events?\n\nOnly the year tab changes. The month signed, the amounts and the allocations stay as they are.`)) return;
  try {
    const res = await fetch('/api/deals/refile-by-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(out.error || 'Could not refile', 'error'); return; }
    showToast(`${(out.refiled || []).length} deal${(out.refiled || []).length === 1 ? '' : 's'} refiled by ${(out.refiled || []).length === 1 ? 'its' : 'their'} events`, 'success');
  } catch (e) { showToast('Could not refile: ' + e.message, 'error'); }
  loadDeals();
}

async function loadDeals() {
  checkDealsToRefile();
  try {
    const [dealsRes, invRes] = await Promise.all([
      fetch('/api/deals'),
      fetch('/api/deals/last-invoice')
    ]);
    dealsData = await dealsRes.json();
    // Populate event filter dropdown from deals' events arrays
    const evtSel = document.getElementById('dealEventFilter');
    if (evtSel) {
      const evtMap = {};
      dealsData.forEach(d => (d.events||[]).forEach(ev => { if (ev.event_id) evtMap[ev.event_id] = ev.event_name; }));
      const current = evtSel.value;
      evtSel.innerHTML = '<option value="">All Events</option>' +
        Object.entries(evtMap).map(([id,name]) => `<option value="${id}"${String(id)===current?'selected':''}>${esc(name)}</option>`).join('');
    }
    const invData = await invRes.json();
    _lastInvoiceId = invData.id;
    _nextInvoiceNum = invData.next_number;
    // Update last invoice banner
    const banner = document.getElementById('dealLastInvoice');
    const link = document.getElementById('dealLastInvLink');
    const nextEl = document.getElementById('dealNextInvNum');
    if (invData.invoice_number) {
      banner.style.display = 'flex';
      link.textContent = invData.invoice_number;
      link.dataset.dealId = invData.id;
      // Build prefix + next
      const prefix = invData.invoice_number.replace(/\d+$/, '');
      const nextNum = invData.next_number;
      nextEl.textContent = prefix + String(nextNum).padStart(3, '0');
      document.getElementById('dealNextInvNum').dataset.prefix = prefix;
      document.getElementById('dealNextInvNum').dataset.num = nextNum;
    } else {
      banner.style.display = 'none';
    }
    renderDealsTable();
  } catch { showToast('Failed to load deals', 'error'); }
}

function scrollToLastInvoice(e) {
  e.preventDefault();
  if (!_lastInvoiceId) return;
  const row = document.getElementById(`deal-row-${_lastInvoiceId}`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('deal-row-highlight');
    setTimeout(() => row.classList.remove('deal-row-highlight'), 2000);
  }
}

function copyNextInvoice() {
  const el = document.getElementById('dealNextInvNum');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied!', 'success'));
}

function setDealYear(btn, yr) {
  _dealYearFilter = yr;
  document.querySelectorAll('#dealYearFilters .deal-q-btn').forEach(b => b.classList.toggle('active', b.dataset.yr === yr));
  renderDealsTable();
}

function addDealYear() {
  const yr = prompt('Enter year (e.g. 2028):');
  if (!yr || !/^\d{4}$/.test(yr.trim())) return;
  const container = document.getElementById('dealYearFilters');
  const addBtn = container.querySelector('.deal-q-add');
  const btn = document.createElement('button');
  btn.className = 'deal-q-btn';
  btn.dataset.yr = yr.trim();
  btn.textContent = yr.trim();
  btn.onclick = () => setDealYear(btn, yr.trim());
  container.insertBefore(btn, addBtn);
}

function setDealQ(btn, q) {
  _dealQFilter = q;
  document.querySelectorAll('[data-q]').forEach(b => b.classList.toggle('active', b.dataset.q === q));
  renderDealsTable();
}

function setDealRange() {
  _dealRangeFrom = document.getElementById('dealRangeFrom')?.value || '';
  _dealRangeTo   = document.getElementById('dealRangeTo')?.value   || '';
  const active = _dealRangeFrom || _dealRangeTo;
  document.getElementById('dealRangeClear')?.classList.toggle('hidden', !active);
  // When a range is active, clear Q/year filters so they don't conflict
  if (active) {
    _dealQFilter = 'all';
    _dealYearFilter = 'all';
    document.querySelectorAll('[data-q]').forEach(b => b.classList.toggle('active', b.dataset.q === 'all'));
    document.querySelectorAll('[data-yr]').forEach(b => b.classList.toggle('active', b.dataset.yr === 'all'));
  }
  renderDealsTable();
}

function clearDealRange() {
  _dealRangeFrom = ''; _dealRangeTo = '';
  const from = document.getElementById('dealRangeFrom');
  const to   = document.getElementById('dealRangeTo');
  if (from) from.value = '';
  if (to)   to.value   = '';
  document.getElementById('dealRangeClear')?.classList.add('hidden');
  renderDealsTable();
}

function setDealEvent(eventId) {
  _dealEventFilter = eventId;
  renderDealsTable();
}

function dealPassesFilter(d) {
  const q = _dealQFilter;
  const yr = _dealYearFilter;
  const search = (document.getElementById('dealSearch')?.value || '').trim().toLowerCase();
  const byFilter = document.getElementById('dealByFilter')?.value || '';
  if (search && ![(d.company||''),(d.title||''),(d.contact_name||''),(d.invoice_number||'')].some(s => s.toLowerCase().includes(search))) return false;
  if (byFilter && (d.initials||'').toUpperCase() !== byFilter.toUpperCase()) return false;
  if (_dealEventFilter) {
    const evtId = String(_dealEventFilter);
    if (!Array.isArray(d.events) || !d.events.some(ev => String(ev.event_id) === evtId)) return false;
  }
  // Q1/Q2/Q3/Q4 and Year tabs → invoice_date (tax purposes)
  const invDateStr   = d.invoice_date ? String(d.invoice_date).slice(0, 10) : null;
  const invYear      = invDateStr ? parseInt(invDateStr.slice(0, 4), 10) : null;
  const invMonthNum  = invDateStr ? parseInt(invDateStr.slice(5, 7), 10) : null;
  // Range filter → deal_month field (business month, independent of invoice date)
  // deal_month stored as "YY - Mon" text; convert to YYYY-MM for comparison
  const MONTHS_SHORT_F = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dealMonthStr = (() => {
    const raw = (d.deal_month || '').trim();
    if (!raw) {
      // fall back to invoice_date
      if (!invDateStr) return null;
      return invDateStr.slice(0, 7); // YYYY-MM
    }
    // parse "YY - Mon" → YYYY-MM
    const m = raw.match(/^(\d{2})\s*[-–]\s*([A-Za-z]{3})/);
    if (!m) return null;
    const yr2 = parseInt(m[1], 10);
    const fullYr = yr2 >= 0 && yr2 <= 99 ? (yr2 >= 50 ? 1900 + yr2 : 2000 + yr2) : yr2;
    const mo = MONTHS_SHORT_F.findIndex(mn => mn.toLowerCase() === m[2].toLowerCase()) + 1;
    if (!mo) return null;
    return `${fullYr}-${String(mo).padStart(2,'0')}`;
  })();
  if (_dealRangeFrom || _dealRangeTo) {
    if (!dealMonthStr) return false;
    if (_dealRangeFrom && dealMonthStr < _dealRangeFrom) return false;
    if (_dealRangeTo   && dealMonthStr > _dealRangeTo)   return false;
    return true;
  }
  if (yr !== 'all') {
    // fiscal_year takes priority; then invoice_date's calendar year; then the
    // year encoded in the business month ("26 - Sep"), so a deal entered with
    // neither an explicit year nor an invoice date still lands on a year tab
    // instead of only showing under All Years.
    const dealYear = d.fiscal_year ? String(d.fiscal_year)
                   : invYear       ? String(invYear)
                   : dealMonthStr  ? dealMonthStr.slice(0, 4)
                   : null;
    if (!dealYear || dealYear !== yr) return false;
  }
  if (q !== 'all') {
    const months = DEAL_VAT_QUARTERS[q];
    if (!invMonthNum) return false;
    if (!months.includes(invMonthNum)) return false;
  }
  return true;
}

function renderDealsTable() {
  const filtered = dealsData.filter(dealPassesFilter);
  const tbody = document.getElementById('dealsTableBody');
  const empty = document.getElementById('dealsEmpty');
  const tfoot = document.getElementById('dealsTfoot');

  if (!filtered.length) {
    tbody.innerHTML = ''; tfoot.innerHTML = '';
    empty.classList.remove('hidden');
    renderDealTotals([], tfoot);
    return;
  }
  empty.classList.add('hidden');

  // Populate "By" dropdown with unique initials from all deals
  const byEl = document.getElementById('dealByFilter');
  if (byEl) {
    const currentBy = byEl.value;
    const allInitials = [...new Set(dealsData.map(d => (d.initials||'').toUpperCase()).filter(Boolean))].sort();
    byEl.innerHTML = '<option value="">All Reps</option>' +
      allInitials.map(i => `<option value="${esc(i)}"${i === currentBy ? ' selected' : ''}>${esc(i)}</option>`).join('');
  }

  const symMap = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' };
  const dash = '<span class="deal-muted">—</span>';
  const FLAG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>';
  const CLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  const TICK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const DOC_SVG  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const TRASH_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  tbody.innerHTML = filtered.map(d => {
    const sym = symMap[d.currency] || '£';
    const paidAmt   = parseFloat(d.paid_inc_vat) || 0;
    const dealAmt   = parseFloat(d.amount) || 0;
    const hasPaid   = d.paid_inc_vat != null && paidAmt > 0;
    // Paid in full means the deal value plus its VAT. Anything else that has
    // been paid (short or over) gets a yellow cell so someone looks at it.
    const expectedAmt = dealAmt + (parseFloat(d.tax_vat) || 0);
    const paidOff     = hasPaid && Math.abs(paidAmt - expectedAmt) >= 0.01;
    const isFlagged = !!d.is_flagged;
    const isSelected = _selectedDealIds.has(d.id);
    // A flagged row wears the flag tint whatever its payment state.
    const rowClass = ['deal-row', isFlagged ? 'deal-row-flagged' : (hasPaid ? 'deal-row-paid' : ''), isSelected ? 'deal-row-selected' : '']
      .filter(Boolean).join(' ');

    // Editable cell. `cls` joins the cell's own classes; `extra` is any
    // further attribute (a context-menu hook, say).
    const ec = (field, type, val, display, cls = '', extra = '') => {
      const hlKey = `dhl:${d.id}-${field}`;
      const isHl = localStorage.getItem(hlKey) === '1';
      return `<td class="deal-cell-edit${cls ? ' ' + cls : ''}${isHl ? ' deal-cell-orange' : ''}" data-id="${d.id}" data-field="${field}" data-type="${type}" data-val="${String(val ?? '').replace(/"/g, '&quot;')}" data-hlkey="${hlKey}" onclick="dealCellClick(this)" ${extra}>${display}</td>`;
    };

    const paidDisplay = !hasPaid ? dash : `<span class="${paidOff ? 'deal-paid-off' : 'deal-paid-fig'}">${sym}${fmt(paidAmt)}</span>`;
    const paidTitle   = paidOff
      ? ` title="Paid ${sym}${fmt(paidAmt)}, expected ${sym}${fmt(expectedAmt)} (deal value + VAT) · ${paidAmt < expectedAmt ? sym + fmt(expectedAmt - paidAmt) + ' short' : sym + fmt(paidAmt - expectedAmt) + ' over'}"`
      : '';
    const dateCell = (iso) => iso ? dealShortDate(iso) : dash;
    const notesDisplay = d.notes ? `<span class="deal-notes-cell" title="${esc(d.notes)}">${esc(d.notes)}</span>` : dash;
    const coHlKey = `dhl:${d.id}-company`;
    const coHl = localStorage.getItem(coHlKey) === '1';

    // Paperwork, in one glyph: how many files are on record, or an amber "!"
    // when the invoice still has to be sent. The signed copy has its own tick.
    const st = dealAgreementStatus(d);
    const nFiles = (d.invoice1_name ? 1 : 0) + (d.invoice2_name ? 1 : 0);
    const filesCls  = nFiles ? '' : (st.key === 'need_invoice' ? ' is-todo' : ' is-none');
    const filesGlyph = nFiles ? `${CLIP_SVG}${nFiles > 1 ? nFiles : ''}` : (st.key === 'need_invoice' ? '!' : '—');

    return `<tr id="deal-row-${d.id}" class="${rowClass}">
      <td class="deal-td-mark">
        <input type="checkbox" class="deal-select-cb" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation();toggleDealSelect(${d.id})" title="Select">
        <button type="button" class="deal-flag${isFlagged ? ' is-on' : ''}" onclick="event.stopPropagation();dealToggleFlag(${d.id})" title="${isFlagged ? 'Flagged — click to clear' : 'Flag this row'}">${FLAG_SVG}</button>
      </td>
      ${ec('deal_month', 'period', d.deal_month || '', dealPeriodDisplayHtml(d), 'deal-td-month')}
      <td class="deal-cell-company${coHl ? ' deal-cell-orange' : ''}" data-id="${d.id}" data-hlkey="${coHlKey}" onclick="dealCompanyClick(event,${d.id},this)" title="Open the deal · Shift+click to highlight"><span class="deal-co-link">${esc(d.company || d.title)}</span></td>
      ${ec('amount', 'number', d.amount || 0, `<span class="deal-figure">${sym}${fmt(dealAmt)}</span>`, 'deal-num dt-r')}
      ${ec('paid_inc_vat', 'number', d.paid_inc_vat ?? '', paidDisplay, `deal-num dt-r${paidOff ? ' deal-cell-check' : ''}`, `oncontextmenu="dealCellContextMenu(event,this)"${paidTitle}`)}
      ${ec('tax_vat', 'number', d.tax_vat ?? '', d.tax_vat ? `${sym}${fmt(parseFloat(d.tax_vat))}` : dash, 'deal-num dt-r')}
      ${ec('invoice_date', 'date', d.invoice_date || '', dateCell(d.invoice_date), 'deal-td-date')}
      ${ec('paid_date', 'date', d.paid_date || '', dateCell(d.paid_date), 'deal-td-date')}
      ${ec('bank', 'select-bank', d.bank || '', esc(d.bank || '') || dash, 'deal-td-bank')}
      ${ec('invoice_number', 'text', d.invoice_number || '', d.invoice_number ? `<span class="deal-inv-num">${esc(d.invoice_number)}</span>` : dash)}
      <td class="deal-td-files" onclick="openDealInvoicePanel(${d.id})" title="${esc(st.title)} · click to view or upload"><span class="deal-files${filesCls}">${filesGlyph}</span></td>
      <td class="deal-cell-toggle deal-td-signed" onclick="dealToggleBool(${d.id},'signature_received',${!!d.signature_received})" title="${d.signature_received ? 'Signed copy received — click to clear' : 'Click when the signed copy arrives'}">${d.signature_received ? `<span class="deal-tick">${TICK_SVG}</span>` : dash}</td>
      ${ec('initials', 'text', d.initials || '', d.initials ? `<span class="deal-by">${esc(d.initials)}</span>` : dash, 'dt-c')}
      ${ec('notes', 'textarea', d.notes || '', notesDisplay, 'deal-td-notes')}
      <td class="deal-act-cell">
        <button class="deal-act-invoice" onclick="event.stopPropagation();openInvoiceGenModal(${d.id})" title="Generate the invoice document">${DOC_SVG}</button>
        <button class="deal-act-del" onclick="event.stopPropagation();deleteDeal(${d.id})" title="Delete deal">${TRASH_SVG}</button>
      </td>
    </tr>`;
  }).join('');

  window._dealCurrentFiltered = filtered;
  renderDealTotals(filtered, tfoot);
  renderDealsByInitials(filtered);
  updateDealSelectionUI();
}

let _dealCellMenuTd = null;
function dealCellContextMenu(evt, td) {
  evt.preventDefault();
  _dealCellMenuTd = td;
  const menu = document.getElementById('dealCellMenu');
  const isHl = td.classList.contains('deal-cell-orange');
  document.getElementById('dealCellMenuHL').style.display = isHl ? 'none' : 'block';
  document.getElementById('dealCellMenuClear').style.display = isHl ? 'block' : 'none';
  menu.style.display = 'block';
  const x = Math.min(evt.clientX, window.innerWidth - 200);
  const y = Math.min(evt.clientY, window.innerHeight - 80);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  const close = () => { menu.style.display = 'none'; document.removeEventListener('click', close); document.removeEventListener('contextmenu', close); };
  setTimeout(() => { document.addEventListener('click', close); document.addEventListener('contextmenu', close); }, 0);
}
function dealCellMenuAction(action) {
  const td = _dealCellMenuTd;
  if (!td) return;
  const hlKey = td.dataset.hlkey;
  if (!hlKey) return;
  if (action === 'hl') { localStorage.setItem(hlKey, '1'); td.classList.add('deal-cell-orange'); }
  else { localStorage.removeItem(hlKey); td.classList.remove('deal-cell-orange'); }
  document.getElementById('dealCellMenu').style.display = 'none';
}

function dealCompanyClick(evt, id, td) {
  if (evt.shiftKey) {
    const hlKey = td.dataset.hlkey || `dhl:${id}-company`;
    const isHl = localStorage.getItem(hlKey) === '1';
    if (isHl) { localStorage.removeItem(hlKey); td.classList.remove('deal-cell-orange'); }
    else { localStorage.setItem(hlKey, '1'); td.classList.add('deal-cell-orange'); }
    return;
  }
  openDealModal(id);
}

function dealCellClick(td) {
  // Don't open editor if clicking a link/button inside the cell
  if (event.target.tagName === 'A' || event.target.tagName === 'BUTTON' || event.target.closest('a,button')) return;
  // Shift+click = toggle orange highlight
  if (event.shiftKey) {
    const hlKey = td.dataset.hlkey;
    if (hlKey) {
      const isHl = localStorage.getItem(hlKey) === '1';
      if (isHl) { localStorage.removeItem(hlKey); td.classList.remove('deal-cell-orange'); }
      else { localStorage.setItem(hlKey, '1'); td.classList.add('deal-cell-orange'); }
    }
    return;
  }
  // Already editing
  if (td.querySelector('input,select')) return;
  const id = parseInt(td.dataset.id);
  const field = td.dataset.field;
  const type = td.dataset.type;
  const val = td.dataset.val;
  const originalHTML = td.innerHTML;

  let input;
  let periodMonth, periodYear; // the two selects of a period editor
  if (type === 'period') {
    // Month + year pickers, like the deal form. Focus moving between the two
    // must not commit, so the container's focusout is what commits (below).
    const deal = dealsData.find(x => x.id === id) || {};
    const parsed = parseDealMonth(val);
    const fallbackDt = new Date(deal.invoice_date || deal.created_at || Date.now());
    input = document.createElement('span');
    input.className = 'deal-inline-period';
    periodMonth = document.createElement('select');
    periodYear  = document.createElement('select');
    periodMonth.className = periodYear.className = 'deal-inline-select';
    fillPeriodSelects(periodMonth, periodYear,
      parsed ? parsed.month : fallbackDt.getMonth() + 1,
      dealYearOf(deal) || String(fallbackDt.getFullYear()));
    input.append(periodMonth, periodYear);
  } else if (type === 'select') {
    input = document.createElement('select');
    input.className = 'deal-inline-select';
    DEAL_STAGES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      if (s === val) opt.selected = true;
      input.appendChild(opt);
    });
  } else if (type === 'select-bank') {
    input = document.createElement('select');
    input.className = 'deal-inline-select';
    ['','HSBC','Stripe'].forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s || '—';
      if (s === val) opt.selected = true;
      input.appendChild(opt);
    });
  } else if (type === 'textarea') {
    input = document.createElement('textarea');
    input.className = 'deal-inline-input';
    input.value = val;
    input.rows = 2;
    input.style.resize = 'vertical';
    input.style.minHeight = '48px';
  } else {
    input = document.createElement('input');
    input.className = 'deal-inline-input';
    input.type = type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';
    input.value = val;
    if (type === 'number') { input.step = '0.01'; input.min = '0'; }
    if (field === 'initials') { input.maxLength = 4; input.style.textTransform = 'uppercase'; input.style.width = '46px'; }
    if (field === 'invoice_number') input.style.fontFamily = 'monospace';
  }

  td.innerHTML = '';
  td.appendChild(input);
  if (type === 'period') periodMonth.focus(); else input.focus();
  if (input.tagName !== 'TEXTAREA' && (input.type === 'text' || input.type === 'number')) input.select();

  if (type === 'period') {
    let done = false;
    const commitPeriod = async () => {
      if (done) return; done = true;
      const month = parseInt(periodMonth.value, 10), year = parseInt(periodYear.value, 10);
      td.innerHTML = originalHTML;
      // The month signed is one fact; the programme year (the year tab) is
      // another and is not touched here. A deal with no programme year yet
      // takes this year, so it still lands on a tab.
      const cur = dealsData.find(d => d.id === id);
      const ok = await dealPatchField(id, 'deal_month', dealMonthText(month, year))
              && (cur && cur.fiscal_year ? true : await dealPatchField(id, 'fiscal_year', year));
      if (ok) {
        const idx = dealsData.findIndex(d => d.id === id);
        if (idx !== -1) { dealsData[idx].deal_month = dealMonthText(month, year); if (!dealsData[idx].fiscal_year) dealsData[idx].fiscal_year = year; }
        renderDealsTable();
      }
    };
    const cancelPeriod = () => { done = true; td.innerHTML = originalHTML; };
    // Only commit when focus leaves the editor entirely, not when it hops between the two selects
    input.addEventListener('focusout', e => { if (!input.contains(e.relatedTarget)) commitPeriod(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commitPeriod(); }
      if (e.key === 'Escape') { cancelPeriod(); }
    });
    return;
  }

  const commit = async () => {
    let newVal = input.value;
    if (field === 'initials') newVal = newVal.toUpperCase();
    if (type === 'number') newVal = newVal === '' ? null : parseFloat(newVal);
    if (type === 'date') newVal = newVal || null;
    td.innerHTML = originalHTML; // restore immediately for snappy feel
    const ok = await dealPatchField(id, field, newVal);
    if (ok) {
      const idx = dealsData.findIndex(d => d.id === id);
      if (idx !== -1) dealsData[idx][field] = newVal;
      // Instantly update row green/white when paid amount changes
      if (field === 'paid_inc_vat') {
        const row = document.getElementById(`deal-row-${id}`);
        if (row) {
          const paid = parseFloat(newVal) || 0;
          row.classList.toggle('deal-row-paid', paid > 0);
        }
      }
      renderDealsTable();
    }
  };

  const cancel = () => { td.innerHTML = originalHTML; };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (type !== 'textarea' || e.ctrlKey || e.metaKey)) { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.removeEventListener('blur', commit); cancel(); }
  });
}

/**
 * Where a deal stands on paperwork. Mirrors agreementStatus() in bridge.js, so
 * the tracker and the sales CRM say the same thing about the same deal.
 *
 * Keyed off the FILE, not the "sent" tick: a deal can be marked sent with
 * nothing filed, and that still means someone has to produce the document.
 */
function dealAgreementStatus(d) {
  if (d.signature_received) {
    return { key: 'signed', label: '✓ Signed', cls: 'deal-inv-filed-badge', title: d.invoice2_name || 'Signed copy received' };
  }
  if (!d.invoice1_name) {
    return {
      key: 'need_invoice',
      label: '! Need to send invoice',
      cls: 'deal-inv-todo-badge',
      title: d.invoice_agreement_sent
        ? 'Marked sent, but no document is on file — upload it here'
        : 'No agreement or invoice on file yet — send one and upload it here',
    };
  }
  return {
    key: 'awaiting_signature',
    label: '⧗ Awaiting signature',
    cls: 'deal-inv-await-badge',
    title: `Sent: ${d.invoice1_name} — waiting on the signed copy`,
  };
}

function openDealInvoicePanel(dealId) {
  const deal = dealsData.find(d => d.id === dealId);
  if (!deal) return;
  const body = document.getElementById('dealInvoicePanelBody');

  // Slot 1 is what we send the client; slot 2 is what comes back signed.
  function slotHtml(n) {
    const name = n === 1 ? deal.invoice1_name : deal.invoice2_name;
    const label = n === 1 ? 'Agreement / invoice sent' : 'Signed copy';
    const emptyHint = n === 1
      ? "Nothing on file — send the client their agreement, then upload it here"
      : "Upload the countersigned copy once it comes back";
    return `<div id="dealInvSlot${n}" style="border:1px solid ${name ? 'rgba(95,211,150,0.35)' : 'var(--border)'};background:${name ? 'var(--positive-soft)' : 'transparent'};border-radius:10px;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font:700 12px/1 var(--font-mono);text-transform:uppercase;letter-spacing:0.5px;color:var(--muted)">${label}</div>
        ${name ? '<span style="font:700 10px/1.6 var(--font-mono);color:var(--positive);background:rgba(95,211,150,0.18);padding:2px 8px;border-radius:20px">✓ ON FILE</span>' : ''}
      </div>
      ${name
        ? `<div style="display:flex;align-items:center;gap:10px">
            <a href="/api/deals/${dealId}/invoice/${n}" target="_blank" style="font-size:13px;font-weight:600;color:var(--positive);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">📄 ${esc(name)}</a>
            <button class="btn btn-ghost btn-sm" style="color:var(--negative);flex-shrink:0" onclick="dealInvoiceDelete(${dealId},${n})">Remove</button>
          </div>`
        : `<label style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <span style="font-size:13px;color:var(--muted);flex:1">${emptyHint}</span>
            <input type="file" accept=".pdf,.doc,.docx" style="display:none" onchange="dealInvoiceUpload(event,${dealId},${n})">
            <button class="btn btn-ghost btn-sm" style="flex-shrink:0" onclick="this.previousElementSibling.click()">Upload PDF / Word</button>
          </label>`
      }
      ${n === 2 ? `
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);cursor:pointer">
        <input type="checkbox" id="dealSignedTick" ${deal.signature_received ? 'checked' : ''}
               onchange="dealSetSigned(${dealId}, this.checked)" style="width:15px;height:15px;cursor:pointer">
        <span style="font-size:13px;font-weight:600">Signed</span>
        <span style="font-size:12px;color:var(--muted)">— tick once they've signed and returned it</span>
      </label>` : ''}
    </div>`;
  }

  const st = dealAgreementStatus(deal);
  const banner = st.key === 'need_invoice'
    ? `<div style="border:1px solid rgba(234,88,12,0.35);background:rgba(234,88,12,0.12);border-radius:10px;padding:12px 14px;font-size:13px;color:#f59e0b">
         <strong>Need to send invoice.</strong> ${esc(deal.company || deal.title || 'This deal')} has no agreement on file${deal.invoice_agreement_sent ? ' despite being marked sent' : ''} — send it, then upload it below.
       </div>`
    : st.key === 'awaiting_signature'
      ? `<div style="border:1px solid var(--border);background:var(--surface-2);border-radius:10px;padding:12px 14px;font-size:13px;color:var(--muted)">
           Agreement sent. Waiting on the signed copy — upload it and tick <strong>Signed</strong> when it arrives.
         </div>`
      : '';

  body.innerHTML = banner + slotHtml(1) + slotHtml(2);
  openModal('dealInvoicePanel');
}

/** Tick/untick the signature on a deal from the invoice panel. */
async function dealSetSigned(dealId, signed) {
  const ok = await dealPatchField(dealId, 'signature_received', signed);
  if (!ok) { showToast('Could not update', 'error'); return; }
  const idx = dealsData.findIndex(d => d.id === dealId);
  if (idx !== -1) dealsData[idx].signature_received = signed;
  showToast(signed ? 'Marked as signed' : 'Signature cleared', 'success');
  openDealInvoicePanel(dealId);
  renderDealsTable();
}

async function dealInvoiceUpload(evt, dealId, n) {
  const file = evt.target.files[0];
  if (!file) return;
  const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.includes(file.type)) { showToast('Only PDF or Word files allowed', 'error'); return; }
  const reader = new FileReader();
  reader.onload = async e => {
    const base64 = e.target.result.split(',')[1];
    const res = await fetch(`/api/deals/${dealId}/invoice/${n}`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ invoice_name: file.name, invoice_data: base64 })
    });
    if (!res.ok) { showToast('Upload failed', 'error'); return; }
    showToast(n === 1 ? 'Agreement uploaded' : 'Signed copy uploaded', 'success');
    const idx = dealsData.findIndex(d => d.id === dealId);
    if (idx !== -1) {
      if (n === 1) { dealsData[idx].invoice1_name = file.name; dealsData[idx].invoice1_data = base64; }
      else         { dealsData[idx].invoice2_name = file.name; dealsData[idx].invoice2_data = base64; }
    }
    // Uploading the signed copy is the moment it's signed — tick it in the
    // same motion rather than leaving the deal reading "awaiting signature".
    if (n === 2 && idx !== -1 && !dealsData[idx].signature_received) {
      await dealSetSigned(dealId, true);
      return;
    }
    openDealInvoicePanel(dealId);
    renderDealsTable();
  };
  reader.readAsDataURL(file);
}

async function dealInvoiceDelete(dealId, n) {
  if (!confirm(`Remove invoice ${n}?`)) return;
  const res = await fetch(`/api/deals/${dealId}/invoice/${n}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Remove failed', 'error'); return; }
  showToast('Invoice removed', 'success');
  const idx = dealsData.findIndex(d => d.id === dealId);
  if (idx !== -1) {
    if (n === 1) { dealsData[idx].invoice1_name = null; dealsData[idx].invoice1_data = null; }
    else         { dealsData[idx].invoice2_name = null; dealsData[idx].invoice2_data = null; }
  }
  openDealInvoicePanel(dealId);
  renderDealsTable();
}

async function dealToggleFlag(id) {
  const idx = dealsData.findIndex(d => d.id === id);
  if (idx === -1) return;
  const newVal = !dealsData[idx].is_flagged;
  const ok = await dealPatchField(id, 'is_flagged', newVal);
  if (ok) {
    dealsData[idx].is_flagged = newVal;
    const row = document.getElementById(`deal-row-${id}`);
    if (row) {
      const paid = parseFloat(dealsData[idx].paid_inc_vat) || 0;
      row.classList.toggle('deal-row-flagged', newVal);
      row.classList.toggle('deal-row-paid', !newVal && paid > 0);
      const btn = row.querySelector('.deal-flag');
      if (btn) { btn.classList.toggle('is-on', newVal); btn.title = newVal ? 'Flagged \u2014 click to clear' : 'Flag this row'; }
    }
  }
}

async function dealToggleBool(id, field, currentVal) {
  const newVal = !currentVal;
  const ok = await dealPatchField(id, field, newVal);
  if (ok) {
    const idx = dealsData.findIndex(d => d.id === id);
    if (idx !== -1) dealsData[idx][field] = newVal;
    renderDealsTable();
  }
}

async function dealPatchField(id, field, value) {
  try {
    const res = await fetch(`/api/deals/${id}/field`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ field, value })
    });
    if (!res.ok) { const e = await res.json(); showToast(e.error || 'Save failed', 'error'); return false; }
    return true;
  } catch { showToast('Save failed', 'error'); return false; }
}

function showDealColorPicker(e, id) {
  e.stopPropagation();
  document.querySelectorAll('.deal-color-picker').forEach(el => el.remove());
  const colors = [
    { status:'none',    label:'Clear',   bg:'transparent', border:'var(--border-bright)', icon:'⬜' },
    { status:'paid',    label:'Paid',    bg:'#16a34a',      icon:'🟢' },
    { status:'flagged', label:'Flag',    bg:'#ca8a04',      icon:'🚩' },
    { status:'issue',   label:'Issue',   bg:'#ea580c',      icon:'🟠' },
    { status:'urgent',  label:'Urgent',  bg:'#dc2626',      icon:'🔴' },
  ];
  const picker = document.createElement('div');
  picker.className = 'deal-color-picker';
  picker.innerHTML = colors.map(c => `
    <button class="dcp-btn" title="${c.label}"
      style="background:${c.bg};border:2px solid ${c.border||c.bg}"
      onclick="cycleDealStatus(${id},'${c.status}');document.querySelectorAll('.deal-color-picker').forEach(el=>el.remove())">
      <span>${c.icon}</span>
      <span class="dcp-label">${c.label}</span>
    </button>`).join('');
  const rect = e.currentTarget.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top = (rect.bottom + 6) + 'px';
  picker.style.left = Math.max(4, rect.left - 60) + 'px';
  document.body.appendChild(picker);
  setTimeout(() => document.addEventListener('click', () => document.querySelectorAll('.deal-color-picker').forEach(el=>el.remove()), { once: true }), 10);
}

function renderDealTotals(filtered, tfoot) {
  const totalPaid = filtered.reduce((a, d) => a + (parseFloat(d.paid_inc_vat) || 0), 0);
  const totalDeal = filtered.reduce((a, d) => a + (parseFloat(d.amount) || 0), 0);
  const totalTax  = filtered.reduce((a, d) => a + (parseFloat(d.tax_vat) || 0), 0);
  const remaining = totalDeal - totalPaid;
  tfoot.innerHTML = filtered.length ? `<tr class="deal-totals-row">
    <td colspan="3">${filtered.length} deal${filtered.length === 1 ? '' : 's'}</td>
    <td class="dt-r"><span class="deal-figure">£${fmt(totalDeal)}</span></td>
    <td class="dt-r"><span class="deal-figure">£${fmt(totalPaid)}</span></td>
    <td class="dt-r">£${fmt(totalTax)}</td>
    <td colspan="9">${remaining > 0 ? `Remaining <span class="deal-figure" style="color:var(--warning)">£${fmt(remaining)}</span>` : 'Nothing outstanding'}</td>
  </tr>` : '';

  // Store filtered for VAT breakdown
  window._dealTotalsFiltered = filtered;

  const paidCount = filtered.filter(d => (parseFloat(d.paid_inc_vat) || 0) > 0).length;
  const card = (label, value, sub, extra = '', attrs = '') => `
      <div class="deal-stat-card ${extra}" ${attrs}>
        <div class="deal-stat-label">${label}</div>
        <div class="deal-stat-value">${value}</div>
        <div class="deal-stat-sub">${sub}</div>
      </div>`;
  document.getElementById('dealTotals').innerHTML = `
    <div class="deal-stat-cards">
      ${card('Deal value', `£${fmt(totalDeal)}`, `${filtered.length} deal${filtered.length === 1 ? '' : 's'}`)}
      ${card('Paid inc VAT', `£${fmt(totalPaid)}`, `${paidCount} of ${filtered.length} deals have paid`)}
      ${card(`Tax / VAT${_dealQFilter !== 'all' ? ` · ${_dealQFilter}` : ''}`, `£${fmt(totalTax)}`,
             '<span class="deal-stat-link">By company ›</span>', 'ds--vat', 'onclick="openVatBreakdown()" title="VAT by company"')}
      ${card('Remaining', `£${fmt(Math.max(0, remaining))}`, remaining > 0 ? 'Still to collect' : 'Nothing outstanding',
             remaining > 0 ? 'ds--remaining' : 'ds--remaining is-clear')}
    </div>`;
}

function openVatBreakdown() {
  const filtered = window._dealTotalsFiltered || [];
  const withVat = filtered.filter(d => parseFloat(d.tax_vat) > 0)
    .sort((a,b) => {
      const da = a.invoice_date || '';
      const db = b.invoice_date || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  const totalTax = filtered.reduce((a,d) => a + (parseFloat(d.tax_vat)||0), 0);

  const rows = withVat.map(d => {
    const vat = parseFloat(d.tax_vat);
    const pct = totalTax > 0 ? ((vat / totalTax) * 100).toFixed(1) : 0;
    const invDate = d.invoice_date ? new Date(d.invoice_date).toLocaleDateString('en-GB',{month:'short',year:'2-digit'}) : '—';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font:600 13px/1.3 var(--font-sans);color:var(--text)">${esc(d.company||d.title)}</div>
        <div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:3px">${invDate}${d.invoice_number ? ' · ' + esc(d.invoice_number) : ''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:16px">
        <div style="font:700 14px/1 var(--font-sans);color:var(--accent)">£${fmt(vat)}</div>
        <div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">${pct}%</div>
      </div>
    </div>`;
  }).join('');

  const label = _dealQFilter !== 'all' ? `VAT ${_dealQFilter}` : 'VAT Total';
  document.getElementById('vatBreakdownTitle').textContent = `${label} — Company Breakdown`;
  document.getElementById('vatBreakdownBody').innerHTML = rows +
    `<div style="display:flex;justify-content:space-between;padding:12px 0 0;font:700 14px/1 var(--font-sans)">
      <span>Total</span><span style="color:var(--accent)">£${fmt(totalTax)}</span>
    </div>`;
  openModal('vatBreakdownModal');
}

// ─── EMPLOYEE PORTAL ──────────────────────────────────────────────────────────
async function checkUserRole() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function initEmployeePortal(user) {
  window.currentUser = user;

  initSidebarCollapse();

  // Wire logout
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // Reveal employee-only nav items (e.g. My Profile)
  document.querySelectorAll('.employee-only').forEach(el => el.classList.remove('hidden'));

  // Hide non-allowed nav items
  const EMP_PAGES = ['dashboard', 'calendar', 'portfolio', 'eventkit', 'profile', 'directory'];
  document.querySelectorAll('.nav-item').forEach(el => {
    if (!EMP_PAGES.includes(el.dataset.page)) el.style.display = 'none';
  });
  document.querySelectorAll('.bottom-nav-item').forEach(el => {
    if (!EMP_PAGES.includes(el.dataset.page)) el.style.display = 'none';
  });
  const addEmpBtn = document.getElementById('addEmpBtn');
  if (addEmpBtn) addEmpBtn.style.display = 'none';

  document.title = 'LPGP – My Portal';

  // Override navigate
  window.navigate = function(page) {
    if (!EMP_PAGES.includes(page)) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById('page-' + page);
    if (pageEl) pageEl.classList.add('active');
    document.querySelectorAll('[data-page="' + page + '"]').forEach(n => n.classList.add('active'));
    const empTitles = { dashboard: 'Dashboard', calendar: 'Calendar', portfolio: 'Portfolio', eventkit: 'Event Kit', profile: 'My Profile', directory: 'Team' };
    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = empTitles[page] || page;
    if (page === 'dashboard')  loadEmployeeDashboard(user);
    if (page === 'calendar')   loadEmployeeCalendar();
    if (page === 'portfolio')  loadEmployeePortfolio();
    if (page === 'eventkit')   loadEmployeeKitPage();
    if (page === 'profile')    loadEmployeeProfile();
    if (page === 'directory')  loadEmployeeDirectory();
  };

  // Attach click handlers since admin init was skipped
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => window.navigate(el.dataset.page));
  });
  document.querySelectorAll('.bottom-nav-item').forEach(el => {
    el.addEventListener('click', () => window.navigate(el.dataset.page));
  });

  // Poll notifications
  loadEmpNotifications();
  setInterval(loadEmpNotifications, 30000);

  // Show dashboard
  window.navigate('dashboard');
}

// ─── ACCOUNTS PORTAL ─────────────────────────────────────────────────────────
async function initAccountsPortal(user) {
  window.currentUser = user;
  initSidebarCollapse();

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  const initials = user.username.slice(0,2).toUpperCase();
  document.getElementById('userLabel').innerHTML =
    '<div class="sidebar-user-pill"><div class="sidebar-user-avatar">' + esc(initials) + '</div>' +
    '<span class="sidebar-user-name">' + esc(user.username) + '</span>' +
    '<span class="sidebar-user-role" style="font:500 9px/1 var(--font-mono);color:var(--accent);text-transform:uppercase;letter-spacing:.5px">Accounts</span></div>';

  document.title = 'LPGP – Accounts';

  const ACC_PAGES = ['dashboard', 'calendar', 'deals'];

  // Hide pages not allowed
  document.querySelectorAll('.nav-item').forEach(el => {
    if (!ACC_PAGES.includes(el.dataset.page)) el.style.display = 'none';
  });
  document.querySelectorAll('.nav-section-label').forEach(el => el.style.display = 'none');

  window.navigate = function(page) {
    if (!ACC_PAGES.includes(page)) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById('page-' + page);
    if (pageEl) pageEl.classList.add('active');
    document.querySelectorAll('[data-page="' + page + '"]').forEach(n => n.classList.add('active'));
    const titles = { dashboard: 'Accounts Dashboard', calendar: 'Calendar', deals: 'Deal Tracker' };
    document.getElementById('pageTitle').textContent = titles[page] || page;
    if (page === 'dashboard') loadAccountsDashboard(user);
    if (page === 'calendar')  loadCalendar();
    if (page === 'deals')     loadDealTracker();
  };

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => { if (ACC_PAGES.includes(el.dataset.page)) window.navigate(el.dataset.page); });
  });

  window.navigate('dashboard');
}

async function loadAccountsDashboard(user) {
  const page = document.getElementById('page-dashboard');
  if (!page) return;
  page.innerHTML = '<div style="padding:32px 24px"><div style="font:500 11px/1 var(--font-mono);color:var(--muted)">Loading…</div></div>';

  let deals = [];
  try {
    const r = await fetch('/api/deal-tracker');
    if (r.ok) deals = await r.json();
  } catch(e) {}

  const active = deals.filter(d => d.status !== 'cancelled');
  const totalPaid  = active.reduce((s,d) => s + (parseFloat(d.paid_inc_vat)||0), 0);
  const totalDeal  = active.reduce((s,d) => s + (parseFloat(d.deal_amount)||0), 0);
  const outstanding = totalDeal - totalPaid;
  const fmtAmt = v => '£' + v.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});

  let lastInv = '', nextInv = '';
  let maxN = -1;
  active.forEach(d => {
    if (!d.invoice_number) return;
    const m = String(d.invoice_number).match(/(\d+)\s*$/);
    if (m) { const n = parseInt(m[1]); if (n > maxN) { maxN = n; lastInv = d.invoice_number; } }
  });
  if (maxN >= 0) nextInv = lastInv.replace(/\d+$/, String(maxN + 1));

  const card = (label, val, color) =>
    '<div style="flex:1;min-width:140px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px">' +
      '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px">' + label + '</div>' +
      '<div style="font:700 22px/1 var(--font-sans);color:' + (color||'var(--text)') + '">' + val + '</div>' +
    '</div>';

  const greeting = 'Good ' + (new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening') + ', ' + user.username;

  page.innerHTML =
    '<div style="padding:28px 24px">' +
      '<div style="margin-bottom:24px">' +
        '<div style="font:700 20px/1.2 var(--font-sans);color:var(--text);margin-bottom:4px">' + esc(greeting) + '</div>' +
        '<div style="font:500 11px/1 var(--font-mono);color:var(--muted)">Accounts overview · ' + active.length + ' active deal' + (active.length!==1?'s':'') + '</div>' +
      '</div>' +

      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">' +
        card('Total Paid', fmtAmt(totalPaid), 'var(--positive)') +
        card('Total Deal Value', fmtAmt(totalDeal)) +
        card('Outstanding', fmtAmt(outstanding), outstanding > 0 ? 'var(--negative)' : 'var(--positive)') +
        (lastInv ?
          '<div style="flex:1;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px">' +
            '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px">Last Invoice</div>' +
            '<div style="font:600 12px/1.3 var(--font-mono);color:var(--text);word-break:break-all">' + esc(lastInv) + '</div>' +
            '<div style="font:500 11px/1 var(--font-mono);color:var(--primary);margin-top:10px">Next → ' + esc(nextInv) + '</div>' +
          '</div>'
        : '') +
      '</div>' +

      '<div style="display:flex;gap:12px;flex-wrap:wrap">' +
        '<button class="btn btn-primary" onclick="window.navigate(\'deals\')" style="gap:8px">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
          'Open Deal Tracker' +
        '</button>' +
        '<button class="btn btn-ghost" onclick="window.navigate(\'calendar\')" style="gap:8px">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
          'View Calendar' +
        '</button>' +
      '</div>' +
    '</div>';
}

async function loadEmpNotifications() {
  const res = await fetch('/api/employee/notifications');
  if (!res.ok) return;
  const notifs = await res.json();
  const unread = notifs.filter(n => !n.is_read).length;

  // Badge button above Sign Out in sidebar-footer
  let badge = document.getElementById('empNotifBadge');
  if (!badge) {
    badge = document.createElement('button');
    badge.id = 'empNotifBadge';
    badge.className = 'btn btn-ghost btn-sm';
    badge.style.cssText = 'width:100%;justify-content:center;margin-bottom:6px;gap:6px';
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.parentNode.insertBefore(badge, logoutBtn);
  }
  badge.onclick = () => openEmpNotificationsModal(notifs);
  const bellSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  if (unread > 0) {
    badge.innerHTML = bellSvg + ' Notifications <span style="background:var(--negative);color:#fff;font:700 9px/1 var(--font-mono);padding:2px 5px;border-radius:8px;margin-left:2px">' + unread + '</span>';
    badge.style.borderColor = 'var(--negative)';
    badge.style.color = 'var(--text)';
  } else {
    badge.innerHTML = bellSvg + ' Notifications';
    badge.style.borderColor = '';
    badge.style.color = '';
  }
}

function openEmpNotificationsModal(notifs) {
  fetch('/api/employee/notifications/read-all', { method: 'PUT' });
  setTimeout(loadEmpNotifications, 500);

  const existing = document.getElementById('empNotifModal');
  if (existing) existing.remove();

  const TYPE_COLOR = { approved: 'var(--positive)', declined: 'var(--negative)', info: 'var(--primary)' };
  const TYPE_ICON  = { approved: '✓', declined: '✕', info: 'ℹ' };
  const rows = notifs.length
    ? notifs.map(n => {
        const d = new Date(n.created_at).toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'});
        const color = TYPE_COLOR[n.type] || 'var(--muted)';
        const icon  = TYPE_ICON[n.type]  || 'ℹ';
        const unreadDot = !n.is_read ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--negative);display:inline-block;margin-right:6px;flex-shrink:0;margin-top:2px"></span>' : '';
        return '<div style="display:flex;gap:10px;padding:14px 0;border-bottom:1px solid var(--border)">' +
          unreadDot +
          '<div style="flex:1">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
              '<span style="font:700 11px/1 var(--font-mono);text-transform:uppercase;color:' + color + '">' + icon + ' ' + n.type + '</span>' +
              '<span style="font:500 10px/1 var(--font-mono);color:var(--muted)">' + d + '</span>' +
            '</div>' +
            '<div style="font:500 13px/1.5 var(--font-sans);color:var(--text)">' + esc(n.message) + '</div>' +
          '</div>' +
        '</div>';
      }).join('')
    : '<div style="color:var(--muted);font-size:0.85rem;padding:24px 0;text-align:center">No notifications yet</div>';

  const modal = document.createElement('div');
  modal.id = 'empNotifModal';
  modal.className = 'modal-overlay';
  modal.innerHTML =
    '<div class="modal" style="max-width:440px">' +
      '<div class="modal-header"><span class="modal-title">Notifications</span>' +
        '<button class="modal-close" onclick="document.getElementById(\'empNotifModal\').remove()">×</button></div>' +
      '<div style="padding:0 20px 4px;max-height:440px;overflow-y:auto">' + rows + '</div>' +
      '<div style="padding:14px 20px;border-top:1px solid var(--border)">' +
        '<button class="btn btn-ghost btn-sm" style="width:100%" onclick="document.getElementById(\'empNotifModal\').remove()">Close</button>' +
      '</div>' +
    '</div>';
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function loadEmployeeDashboard(user) {
  const el = document.getElementById('dashStats');
  if (!el) return;
  el.innerHTML = '<div class="skeleton" style="height:200px;border-radius:16px"></div>';

  try {
    const [profileRes, remindersRes, salaryRes] = await Promise.all([
      fetch('/api/employee/profile'),
      fetch('/api/employee/reminders'),
      fetch('/api/employee/salary')
    ]);
    const profile   = profileRes.ok   ? await profileRes.json()   : {};
    const reminders = remindersRes.ok  ? await remindersRes.json() : [];
    const sal       = salaryRes.ok    ? await salaryRes.json()    : null;

    const daysUsed      = parseFloat(profile.days_used) || 0;
    const allowance     = profile.allowance_days || 20;
    const excessDays    = parseFloat(profile.excess_days) || 0;
    const excessDeduct  = parseFloat(profile.excess_deduction) || 0;
    const remaining     = Math.max(0, allowance - daysUsed);
    const pct           = Math.min(100, Math.round((daysUsed / allowance) * 100));
    const initials      = (profile.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const barColor      = pct > 80 ? 'var(--negative)' : pct > 60 ? 'var(--warning)' : 'var(--positive)';
    const MONS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

    window._empReminders = reminders;
    function remindersCardHtml() {
      const pending = (window._empReminders||[]).filter(r => !r.is_done);
      const done    = (window._empReminders||[]).filter(r => r.is_done);
      const fmtDate = d => { if (!d) return ''; const dt = new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); };
      const itemHtml = r => {
        const isPast = r.reminder_date && r.reminder_date.slice(0,10) < new Date().toLocaleDateString('en-CA');
        return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">' +
          '<div onclick="empToggleReminder(' + r.id + ')" style="width:18px;height:18px;border:2px solid ' + (r.is_done?'var(--primary)':'var(--border)') + ';border-radius:4px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;background:' + (r.is_done?'var(--primary)':'transparent') + '">' +
            (r.is_done ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><polyline points="2,6 5,9 10,3"/></svg>' : '') +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font:600 13px/1 var(--font-sans);color:' + (r.is_done?'var(--dim)':'var(--text)') + ';' + (r.is_done?'text-decoration:line-through':'') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.title) + '</div>' +
            (r.reminder_date ? '<div style="font:500 10px/1 var(--font-mono);color:' + (isPast&&!r.is_done?'var(--negative)':'var(--muted)') + ';margin-top:3px">' + fmtDate(r.reminder_date) + (isPast&&!r.is_done?' · overdue':'') + '</div>' : '') +
          '</div>' +
          '<button onclick="empDeleteReminder(' + r.id + ')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:2px 4px;flex-shrink:0">×</button>' +
        '</div>';
      };
      const listHtml = pending.map(itemHtml).join('') + (done.length ? '<div style="font:600 9px/1 var(--font-mono);color:var(--dim);letter-spacing:.5px;margin:10px 0 4px">COMPLETED</div>' + done.slice(0,3).map(itemHtml).join('') : '');
      return '<div id="empRemindersList">' + (listHtml || '<div style="color:var(--muted);font:500 12px/1.5 var(--font-mono);padding:12px 0;text-align:center">No reminders yet.<br>Add one below.</div>') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
          '<input id="empReminderInput" class="form-control" style="flex:1;font-size:12px;padding:7px 10px" placeholder="Add a reminder..." onkeydown="if(event.keyCode===13)empAddReminder()">' +
          '<input id="empReminderDate" class="form-control" type="date" style="width:130px;font-size:12px;padding:7px 8px">' +
          '<button class="btn btn-primary btn-sm" onclick="empAddReminder()">+</button>' +
        '</div>';
    }

    // ── Salary card HTML (employee read-only view) ──
    let salHtml = '';
    if (sal && sal.annual_salary > 0) {
      const s = sal;
      const sSym = s.currency === 'GBP' ? '£' : s.currency === 'USD' ? '$' : (s.currency + ' ');
      const paye = s.paye_breakdown;
      const monthlyVal = paye ? paye.net_monthly : s.annual_salary / 12;
      const monthlyLbl = paye ? 'Take-home / mo' : 'Monthly pay';
      const monthlySub = paye
        ? ('after PAYE + NI' + (paye.pension > 0 ? ' + pension' : ''))
        : (sSym + s.annual_salary.toLocaleString('en-GB',{maximumFractionDigits:0}) + '/yr');
      const netRemaining = parseFloat(s.net_remaining) || 0;
      const isOverpaid   = netRemaining < 0;
      const outColor = isOverpaid ? 'var(--positive)' : netRemaining === 0 ? 'var(--muted)' : 'var(--negative)';
      const pctPaid  = parseInt(s.pct_paid) || 0;
      const barW     = Math.min(100, pctPaid);
      const barCol   = pctPaid >= 100 ? 'var(--positive)' : pctPaid > 60 ? 'var(--primary)' : 'var(--warning)';

      // First-month logic (same as admin salary card)
      const fm = s.first_month_full;
      const isPartialFirstMonth = fm && fm.first_month_days < fm.first_month_total_days;
      const payeNetFactor = paye && s.annual_salary > 0 ? paye.net_annual / s.annual_salary : 1;
      let sugFirstMonthNet = isPartialFirstMonth ? parseFloat((fm.first_month_pay * payeNetFactor).toFixed(2)) : null;
      let fmMeta2 = isPartialFirstMonth ? {
        monthName: MONTHS[parseInt(fm.first_month.split('-')[1]) - 1] || fm.first_month,
        daysWorked: fm.first_month_days, daysTotal: fm.first_month_total_days
      } : null;
      if (sugFirstMonthNet === null && s.start_date) {
        const sd2 = new Date(s.start_date + 'T00:00:00');
        if (sd2.getDate() > 1) {
          const dim = new Date(sd2.getFullYear(), sd2.getMonth() + 1, 0).getDate();
          const dw  = dim - sd2.getDate() + 1;
          const nm  = paye ? paye.net_monthly : s.annual_salary / 12;
          sugFirstMonthNet = parseFloat((nm * (dw / dim)).toFixed(2));
          fmMeta2 = { monthName: MONTHS[sd2.getMonth()], daysWorked: dw, daysTotal: dim };
        }
      }
      const showFM = sugFirstMonthNet !== null && fmMeta2 && !isOverpaid;

      const payments = Array.isArray(s.payments) ? s.payments : [];
      const paymentsHtml = payments.length
        ? payments.map(p => '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);font:500 12px/1 var(--font-mono);color:var(--muted)">' +
            '<span>' + (MONTHS[p.payment_month] || p.payment_month) + ' ' + p.payment_year + '</span>' +
            '<span style="color:var(--positive)">+' + sSym + parseFloat(p.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
          '</div>').join('')
        : '<div style="color:var(--muted);font:500 12px/1 var(--font-mono);padding:12px 0">No payments yet this year.</div>';

      const bonuses = Array.isArray(s.bonuses) ? s.bonuses : [];
      const totalBonuses = parseFloat(s.total_bonuses) || 0;
      const fmtBonusDate = d => { if (!d) return ''; const dt = new Date(d + 'T12:00:00'); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); };
      const bonusesHtml = bonuses.length
        ? '<div style="padding:16px 20px;border-top:1px solid var(--border)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
              '<span style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted)">🎁 Bonuses (' + bonuses.length + ')</span>' +
              '<span style="font:700 12px/1 var(--font-mono);color:var(--positive)">+' + sSym + totalBonuses.toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
            '</div>' +
            bonuses.map(b => '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);font:500 12px/1 var(--font-mono);color:var(--muted)">' +
              '<span style="min-width:0"><span style="color:var(--text)">' + esc(b.reason || 'Bonus') + '</span><br><span style="font-size:10px">' + fmtBonusDate(b.bonus_date) + '</span></span>' +
              '<span style="color:var(--positive);white-space:nowrap">+' + sSym + parseFloat(b.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
            '</div>').join('') +
          '</div>'
        : '';

      // Deductions (office deductions + day-off excess) — shown so the
      // remaining figure visibly reconciles with what the admin sees
      const officeDeds = Array.isArray(s.office_deductions) ? s.office_deductions : [];
      const totalOfficeDeds = parseFloat(s.total_office_deductions) || 0;
      const excessDed = parseFloat(s.excess_deduction) || 0;
      const totalDeds = totalOfficeDeds + excessDed;
      const deductionsHtml = totalDeds > 0
        ? '<div style="padding:16px 20px;border-top:1px solid var(--border)">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
              '<span style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted)">Deductions</span>' +
              '<span style="font:700 12px/1 var(--font-mono);color:var(--negative)">−' + sSym + totalDeds.toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
            '</div>' +
            officeDeds.map(d => '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);font:500 12px/1 var(--font-mono);color:var(--muted)">' +
              '<span style="min-width:0"><span style="color:var(--text)">' + esc(d.description || 'Office deduction') + '</span><br><span style="font-size:10px">' + fmtBonusDate(d.deduction_date) + '</span></span>' +
              '<span style="color:var(--negative);white-space:nowrap">−' + sSym + parseFloat(d.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
            '</div>').join('') +
            (excessDed > 0
              ? '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);font:500 12px/1 var(--font-mono);color:var(--muted)">' +
                  '<span style="min-width:0"><span style="color:var(--text)">Excess days off</span><br><span style="font-size:10px">' + (parseFloat(s.excess_days)||0) + ' day' + ((parseFloat(s.excess_days)||0) !== 1 ? 's' : '') + ' over allowance</span></span>' +
                  '<span style="color:var(--negative);white-space:nowrap">−' + sSym + excessDed.toLocaleString('en-GB',{minimumFractionDigits:2}) + '</span>' +
                '</div>'
              : '') +
            '<div style="font:500 10px/1.5 var(--font-mono);color:var(--muted);margin-top:10px">Deductions are already reflected in your remaining balance above.</div>' +
          '</div>'
        : '';

      salHtml =
        '<div class="card" style="margin-top:16px">' +
          '<div class="card-header"><span class="card-title">My Pay — ' + s.year + '</span>' +
            '<span style="font:700 11px/1 var(--font-mono);color:var(--muted)">' + (s.employment_type === 'self_employed' ? 'SELF-EMPLOYED' : 'PAYROLL') + '</span>' +
          '</div>' +
          // Progress bar
          '<div style="padding:18px 20px;border-bottom:1px solid var(--border)">' +
            '<div style="display:flex;justify-content:space-between;font:600 12px/1 var(--font-mono);color:var(--muted);margin-bottom:10px">' +
              '<span>Payments received</span><span style="color:' + barCol + '">' + pctPaid + '%</span>' +
            '</div>' +
            '<div style="height:8px;background:var(--border);border-radius:4px">' +
              '<div style="height:100%;width:' + barW + '%;background:' + barCol + ';border-radius:4px;transition:width .4s"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:8px">' +
              '<span>' + sSym + parseFloat(s.total_paid).toLocaleString('en-GB',{minimumFractionDigits:2}) + ' received</span>' +
              (isOverpaid
                ? '<span style="color:var(--positive)">Fully paid ✓</span>'
                : '<span style="color:' + outColor + '">' + sSym + Math.abs(netRemaining).toLocaleString('en-GB',{minimumFractionDigits:2}) + ' remaining</span>') +
            '</div>' +
          '</div>' +
          // Stat row
          '<div class="emp-pay-stats" style="display:flex;border-bottom:1px solid var(--border)">' +
            '<div style="flex:1;padding:16px 20px;border-right:1px solid var(--border)">' +
              '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px">' + monthlyLbl + '</div>' +
              '<div style="font:700 22px/1 var(--font-mono);color:var(--text)">' + sSym + monthlyVal.toLocaleString('en-GB',{maximumFractionDigits:0}) + '</div>' +
              '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:6px">' + monthlySub + '</div>' +
            '</div>' +
            (showFM
              ? '<div style="flex:1;padding:16px 20px;border-right:1px solid var(--border);background:rgba(251,191,36,0.05)">' +
                  '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:#f59e0b;margin-bottom:8px">1st Month Due</div>' +
                  '<div style="font:700 22px/1 var(--font-mono);color:#f59e0b">' + sSym + Math.round(sugFirstMonthNet).toLocaleString('en-GB') + '</div>' +
                  '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:6px">' + fmMeta2.daysWorked + ' of ' + fmMeta2.daysTotal + ' days · ' + fmMeta2.monthName + '</div>' +
                '</div>'
              : '') +
            (() => {
              // Latest by year+month; same-month payments tie-break on id
              const payKey2 = p => (Number(p.payment_year)||0)*100 + (Number(p.payment_month)||0);
              const lastPay2 = payments.length
                ? payments.reduce((a,b) => {
                    const ka = payKey2(a), kb = payKey2(b);
                    return kb > ka || (kb === ka && (Number(b.id)||0) > (Number(a.id)||0)) ? b : a;
                  }, payments[0])
                : null;
              const lp2Amt   = lastPay2 ? sSym + parseFloat(lastPay2.amount||0).toLocaleString('en-GB',{maximumFractionDigits:0}) : '—';
              const lp2Date  = lastPay2 ? (MONTHS[Number(lastPay2.payment_month)]||'') + (lastPay2.payment_year ? ' '+lastPay2.payment_year : '') : 'No payments yet';
              const remAmt   = isOverpaid ? 'Paid ✓' : sSym + Math.abs(netRemaining).toLocaleString('en-GB',{maximumFractionDigits:0});
              const remSub   = isOverpaid ? 'fully settled' : 'left this year';
              const remColor = isOverpaid ? 'var(--positive)' : netRemaining === 0 ? 'var(--muted)' : outColor;
              return '<div style="flex:1;padding:16px 20px;border-left:1px solid var(--border)">' +
                  '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px">Last Payment</div>' +
                  '<div style="font:700 22px/1 var(--font-mono);color:' + (lastPay2 ? 'var(--positive)' : 'var(--muted)') + '">' + lp2Amt + '</div>' +
                  '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:6px">' + lp2Date + '</div>' +
                '</div>' +
                '<div style="flex:1;padding:16px 20px;border-left:1px solid var(--border)">' +
                  '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px">Remaining</div>' +
                  '<div style="font:700 22px/1 var(--font-mono);color:' + remColor + '">' + remAmt + '</div>' +
                  '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:6px">' + remSub + '</div>' +
              '</div>';
            })() +
          '</div>' +
          // PAYE breakdown (if applicable)
          (paye ? '<div class="emp-paye-grid" style="padding:16px 20px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
              '<div style="text-align:center">' +
                '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px">Income Tax</div>' +
                '<div style="font:700 16px/1 var(--font-mono);color:var(--text)">' + sSym + paye.income_tax.toLocaleString('en-GB',{minimumFractionDigits:0}) + '</div>' +
                '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:4px">per year</div>' +
              '</div>' +
              '<div style="text-align:center;border-left:1px solid var(--border);border-right:1px solid var(--border)">' +
                '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px">National Ins.</div>' +
                '<div style="font:700 16px/1 var(--font-mono);color:var(--text)">' + sSym + paye.national_insurance.toLocaleString('en-GB',{minimumFractionDigits:0}) + '</div>' +
                '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:4px">per year</div>' +
              '</div>' +
              '<div style="text-align:center">' +
                '<div style="font:600 9px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px">Take-home</div>' +
                '<div style="font:700 16px/1 var(--font-mono);color:var(--positive)">' + sSym + paye.net_annual.toLocaleString('en-GB',{minimumFractionDigits:0}) + '</div>' +
                '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:4px">per year</div>' +
              '</div>' +
            '</div>'
          : '') +
          // Payments list
          '<div style="padding:16px 20px">' +
            '<div style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:12px">Payments (' + payments.length + ')</div>' +
            paymentsHtml +
          '</div>' +
          bonusesHtml +
          deductionsHtml +
        '</div>';
    }

    el.innerHTML =
      '<div class="emp-dash-grid">' +
        // Profile card
        '<div class="card">' +
          '<div style="padding:24px">' +
            '<div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">' +
              '<div style="width:52px;height:52px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font:800 18px/1 var(--font-mono);color:#000;flex-shrink:0">' + initials + '</div>' +
              '<div style="min-width:0">' +
                '<div style="font:700 18px/1.25 var(--font-sans);color:var(--text)">' + esc(profile.name||'') + '</div>' +
                '<div style="font:500 12px/1.4 var(--font-mono);color:var(--muted);margin-top:4px">' + esc([profile.job_title, profile.department].filter(Boolean).join(' · ')) + '</div>' +
              '</div>' +
            '</div>' +
            (profile.start_date ? '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-bottom:16px">Since ' + profile.start_date + '</div>' : '') +
            '<div style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px">Days Off ' + (profile.year||new Date().getFullYear()) + '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:10px;font:600 12px/1.4 var(--font-mono);color:var(--muted);margin-bottom:6px">' +
              '<span style="white-space:nowrap">' + daysUsed + ' used</span>' +
              (excessDays > 0
                ? '<span style="color:var(--negative);white-space:nowrap">' + excessDays + ' excess day' + (excessDays !== 1 ? 's' : '') + '</span>'
                : '<span style="color:' + barColor + ';white-space:nowrap">' + remaining + ' remaining</span>') +
            '</div>' +
            '<div style="height:8px;background:var(--border);border-radius:4px;margin-bottom:8px">' +
              '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:4px"></div>' +
            '</div>' +
            '<div style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + daysUsed + ' used · ' + allowance + ' allowed</div>' +
            (excessDays > 0
              ? '<div style="margin-top:8px;padding:8px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font:500 10px/1.4 var(--font-mono);color:var(--negative)">' +
                  excessDays + ' excess day' + (excessDays !== 1 ? 's' : '') + ' · ' +
                  (excessDeduct > 0 ? '£' + excessDeduct.toLocaleString('en-GB',{minimumFractionDigits:2}) + ' deducted from salary' : 'deduction calculated at year end') +
                '</div>'
              : '') +
          '</div>' +
        '</div>' +
        // My Reminders card
        '<div class="card" id="empRemindersCard">' +
          '<div class="card-header"><span class="card-title">My Reminders</span>' +
            '<span style="font:700 11px/1 var(--font-mono);color:var(--muted)">' + ((window._empReminders||[]).filter(r=>!r.is_done).length||'') + (((window._empReminders||[]).filter(r=>!r.is_done).length) ? ' pending' : 'PERSONAL') + '</span>' +
          '</div>' +
          '<div style="padding:4px 18px 14px">' + remindersCardHtml() + '</div>' +
        '</div>' +
      '</div>' +
      salHtml;

    // Hide the other dashboard panels
    ['contractExpiryPanel','headcountPanel','upcomingPanel','activityPanel'].forEach(id => {
      const e = document.getElementById(id);
      if (e) e.innerHTML = '';
    });
    const dashTable = document.querySelector('.card .table-wrap');
    // hide the full employee summary table section
    const dashTableCard = document.getElementById('dashTable');
    if (dashTableCard) {
      const card = dashTableCard.closest('.card');
      if (card) card.style.display = 'none';
    }

  } catch(e) {
    el.innerHTML = '<div class="alert alert-error">Failed to load profile: ' + e.message + '</div>';
  }
}

// ─── EMPLOYEE PROFILE (staff portal) ──────────────────────────────────────────
async function loadEmployeeProfile() {
  const el = document.getElementById('profileContent');
  if (!el) return;
  el.innerHTML = '<div class="skeleton" style="height:300px;border-radius:16px"></div>';
  try {
    const res = await fetch('/api/employee/profile');
    const p = res.ok ? await res.json() : {};
    const initials = (p.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const detail = (label, val) =>
      '<div style="display:flex;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border);font:500 13px/1.3 var(--font-sans)">' +
        '<span style="color:var(--muted)">' + label + '</span>' +
        '<span style="color:var(--text);text-align:right">' + (val ? esc(String(val)) : '—') + '</span>' +
      '</div>';

    el.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">' +
        // Details card
        '<div class="card" style="padding:24px">' +
          '<div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">' +
            '<div style="width:56px;height:56px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font:800 20px/1 var(--font-mono);color:#1a1a1f;flex-shrink:0">' + initials + '</div>' +
            '<div><div style="font:700 18px/1 var(--font-sans);color:var(--text)">' + esc(p.name || '') + '</div>' +
              '<div style="font:500 12px/1 var(--font-mono);color:var(--muted);margin-top:5px">' + esc([p.job_title, p.department].filter(Boolean).join(' · ')) + '</div></div>' +
          '</div>' +
          '<div style="font:600 10px/1 var(--font-mono);text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:6px">My Details</div>' +
          detail('Email', p.email) +
          detail('Job title', p.job_title) +
          detail('Department', p.department) +
          detail('Start date', p.start_date ? formatDate(p.start_date.slice(0,10)) : '') +
          '<div style="margin-top:18px">' +
            '<label style="font:600 11px/1 var(--font-sans);color:var(--muted);display:block;margin-bottom:6px">Job title</label>' +
            '<input id="profJobTitle" class="form-control" type="text" style="margin-bottom:12px" placeholder="e.g. Event Coordinator" value="' + esc(p.job_title || '') + '">' +
            '<label style="font:600 11px/1 var(--font-sans);color:var(--muted);display:block;margin-bottom:6px">Phone number</label>' +
            '<div style="display:flex;gap:8px">' +
              '<input id="profPhone" class="form-control" type="tel" style="flex:1" placeholder="Add your phone number" value="' + esc(p.phone || '') + '">' +
              '<button class="btn btn-primary" onclick="saveProfileDetails()">Save</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // Change PIN card
        '<div class="card" style="padding:24px">' +
          '<div style="font:700 15px/1 var(--font-sans);color:var(--text);margin-bottom:6px">🔒 Change PIN</div>' +
          '<div style="font:500 12px/1.5 var(--font-mono);color:var(--muted);margin-bottom:18px">Your PIN is used to log in to the staff portal. Use 4–6 digits.</div>' +
          (p.has_pin
            ? '<div class="form-group" style="margin-bottom:14px"><label>Current PIN</label><input id="profCurrentPin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="current-password"></div>'
            : '<div style="margin-bottom:14px;padding:10px 12px;background:var(--warning-soft);border:1px solid var(--warning);border-radius:8px;font:500 11px/1.4 var(--font-mono);color:var(--warning)">No PIN set yet — set one below to secure your account.</div>') +
          '<div class="form-group" style="margin-bottom:14px"><label>New PIN</label><input id="profNewPin" type="password" inputmode="numeric" maxlength="6" placeholder="4–6 digits" autocomplete="new-password"></div>' +
          '<div class="form-group" style="margin-bottom:18px"><label>Confirm new PIN</label><input id="profNewPin2" type="password" inputmode="numeric" maxlength="6" placeholder="Re-enter new PIN" autocomplete="new-password"></div>' +
          '<button class="btn btn-primary" style="width:100%" onclick="changeMyPin(' + (p.has_pin ? 'true' : 'false') + ')">Update PIN</button>' +
        '</div>' +
      '</div>';
  } catch (e) {
    el.innerHTML = '<div class="alert alert-error">Failed to load profile: ' + e.message + '</div>';
  }
}

async function saveProfileDetails() {
  const phone = document.getElementById('profPhone').value.trim();
  const job_title = document.getElementById('profJobTitle').value.trim();
  try {
    const res = await fetch('/api/employee/profile', {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone, job_title })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.error || 'Could not save', 'error'); return; }
    showToast('Details saved', 'success');
    loadEmployeeProfile();
  } catch (e) { showToast('Could not save: ' + e.message, 'error'); }
}

async function changeMyPin(hasPin) {
  const current = document.getElementById('profCurrentPin')?.value || '';
  const newPin  = document.getElementById('profNewPin').value;
  const newPin2 = document.getElementById('profNewPin2').value;
  if (hasPin && !current) { showToast('Enter your current PIN', 'error'); return; }
  if (!/^\d{4,6}$/.test(newPin)) { showToast('New PIN must be 4–6 digits', 'error'); return; }
  if (newPin !== newPin2) { showToast('New PINs do not match', 'error'); return; }
  try {
    const res = await fetch('/api/employee/change-pin', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ current_pin: current, new_pin: newPin })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showToast(data.error || 'Could not change PIN', 'error'); return; }
    showToast('PIN updated successfully', 'success');
    loadEmployeeProfile();
  } catch (e) { showToast('Could not change PIN: ' + e.message, 'error'); }
}

// ─── EMPLOYEE DIRECTORY (staff portal) ────────────────────────────────────────
async function loadEmployeeDirectory() {
  const el = document.getElementById('directoryContent');
  if (!el) return;
  el.innerHTML = '<div class="skeleton" style="height:300px;border-radius:16px"></div>';
  try {
    const res = await fetch('/api/employees/all');
    const all = res.ok ? await res.json() : [];
    // Active employees only, sorted by name
    const active = all.filter(e => e.active);

    // Group by department (blank → "Other")
    const deptMap = {};
    active.forEach(e => {
      const dept = (e.department || 'Other').trim();
      if (!deptMap[dept]) deptMap[dept] = [];
      deptMap[dept].push(e);
    });
    const depts = Object.keys(deptMap).sort((a, b) => a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b));

    const card = (e) => {
      const initials = (e.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
      const typeColors = { payroll:'var(--accent)', self_employed:'var(--positive)', contractor:'var(--warning)', intern:'var(--muted)' };
      const avatarBg = typeColors[e.employment_type] || 'var(--accent)';
      return '<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)">' +
        '<div style="width:42px;height:42px;border-radius:50%;background:' + avatarBg + ';display:flex;align-items:center;justify-content:center;font:700 14px/1 var(--font-mono);color:#1a1a1f;flex-shrink:0">' + initials + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font:600 14px/1.2 var(--font-sans);color:var(--text)">' + esc(e.name) + '</div>' +
          (e.job_title ? '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:3px">' + esc(e.job_title) + '</div>' : '') +
        '</div>' +
        (e.email
          ? '<a href="mailto:' + esc(e.email) + '" style="font:500 12px/1 var(--font-mono);color:var(--accent);text-decoration:none;white-space:nowrap;flex-shrink:0" title="Send email">' + esc(e.email) + '</a>'
          : '<span style="font:500 12px/1 var(--font-mono);color:var(--muted)">No email</span>') +
      '</div>';
    };

    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">' +
        '<div>' +
          '<h2 style="font:700 20px/1 var(--font-sans);color:var(--text);margin:0">Team Directory</h2>' +
          '<div style="font:500 12px/1 var(--font-mono);color:var(--muted);margin-top:4px">' + active.length + ' active team members · ' + depts.length + ' department' + (depts.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
      '</div>' +
      depts.map(dept => {
        const members = deptMap[dept];
        return '<div class="card" style="padding:20px 24px;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
            '<div style="font:700 13px/1 var(--font-sans);text-transform:uppercase;letter-spacing:.08em;color:var(--accent)">' + esc(dept) + '</div>' +
            '<div style="font:600 11px/1 var(--font-mono);color:var(--muted)">' + members.length + ' member' + (members.length !== 1 ? 's' : '') + '</div>' +
          '</div>' +
          '<div>' + members.map(card).join('') + '</div>' +
        '</div>';
      }).join('');
  } catch (e) {
    el.innerHTML = '<div class="alert alert-error">Failed to load directory: ' + e.message + '</div>';
  }
}

// ─── DEAL TRACKER ─────────────────────────────────────────────────────────────
let _dealData      = [];
let _dealFromMonth = '';
let _dealToMonth   = '';
let _dealSearch    = '';
let _dealYear      = '';

async function loadDealTracker() {
  const page = document.getElementById('page-deals');
  if (!page) return;
  page.innerHTML = '<div class="skeleton" style="height:500px;border-radius:16px;margin:24px"></div>';
  try {
    const res = await fetch('/api/deal-tracker');
    _dealData = res.ok ? await res.json() : [];
    renderDealTracker();
  } catch(e) {
    page.innerHTML = '<div style="padding:24px"><div class="alert alert-error">Failed to load deals: ' + e.message + '</div></div>';
  }
}

function renderDealTracker() {
  const page = document.getElementById('page-deals');
  if (!page) return;

  const ROW_COLORS = {
    green:  { bg: 'rgba(34,197,94,0.12)',  dot: '#22c55e' },
    orange: { bg: 'rgba(251,146,60,0.14)', dot: '#fb923c' },
    red:    { bg: 'rgba(239,68,68,0.14)',  dot: '#ef4444' },
    yellow: { bg: 'rgba(250,204,21,0.18)', dot: '#facc15' },
    none:   { bg: 'transparent',           dot: 'var(--border)' },
  };

  const fmtAmt = v => (v == null || v === '') ? '' : '£' + parseFloat(v).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fmtDate = d => { if (!d) return ''; const dt = new Date(String(d).slice(0,10)+'T12:00:00'); return isNaN(dt)?'':dt.toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'2-digit'}); };

  const allActive = _dealData.filter(r => r.status !== 'cancelled');
  const cancelled = _dealData.filter(r => r.status === 'cancelled');

  // Apply filters
  const active = allActive.filter(r => {
    // Text search
    if (_dealSearch) {
      const q = _dealSearch.toLowerCase();
      const hay = ((r.company||'') + ' ' + (r.invoice_number||'') + ' ' + (r.bank||'') + ' ' + (r.notes||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // Date range filter
    if (_dealFromMonth || _dealToMonth) {
      const m = r.date_invoice_issued ? String(r.date_invoice_issued).slice(0,7) : null;
      if (!m) return false;
      if (_dealFromMonth && m < _dealFromMonth) return false;
      if (_dealToMonth   && m > _dealToMonth)   return false;
    }
    return true;
  });

  // Collect years present in data for the year dropdown
  const yearsInData = [...new Set(allActive.map(r => r.date_invoice_issued ? String(r.date_invoice_issued).slice(0,4) : null).filter(Boolean))].sort();

  // Totals (active filtered only)
  const totalPaid  = active.reduce((s,r) => s + (parseFloat(r.paid_inc_vat)||0), 0);
  const totalDeal  = active.reduce((s,r) => s + (parseFloat(r.deal_amount)||0), 0);
  const totalVat   = active.reduce((s,r) => s + (parseFloat(r.tax_vat)||0), 0);
  const remaining  = totalDeal - totalPaid;

  // Latest invoice number (scan all deals, not just filtered)
  let _lastInvNum = '', _nextInvNum = '';
  (function() {
    let maxN = -1, maxRaw = '';
    _dealData.forEach(r => {
      if (!r.invoice_number) return;
      const m = String(r.invoice_number).match(/(\d+)\s*$/);
      if (m) { const n = parseInt(m[1]); if (n > maxN) { maxN = n; maxRaw = r.invoice_number; } }
    });
    if (maxN >= 0) {
      _lastInvNum = maxRaw;
      _nextInvNum = maxRaw.replace(/\d+$/, String(maxN + 1));
    }
  })();

  const colW = ['80px','200px','110px','110px','90px','90px','90px','90px','160px','200px','90px','80px','55px'];
  const colH = ['Month','Company','Paid inc VAT','Deal','Tax/VAT','Invoice Date','Date Paid','Bank','Invoice Number','Notes','Sent','Signed','Init'];
  const headerCols =
    '<div style="width:36px;min-width:36px;border-right:1px solid var(--border);flex-shrink:0"></div>' +
    colH.map((h,i) => '<div style="width:' + colW[i] + ';min-width:' + colW[i] + ';padding:8px 10px;font:700 10px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;border-right:1px solid var(--border);flex-shrink:0">' + h + '</div>').join('');

  const buildRows = list => list.map(r => {
    const effectiveColor = r.is_flagged ? 'yellow' : (r.row_color || 'none');
    const c = ROW_COLORS[effectiveColor] || ROW_COLORS.none;
    const flagged = r.is_flagged;
    const flagBtn =
      '<div style="width:36px;min-width:36px;border-right:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center">' +
        '<button onclick="toggleDealFlag(' + r.id + ',event)" title="' + (flagged?'Remove flag':'Flag row') + '" style="background:none;border:none;cursor:pointer;padding:4px;font-size:15px;line-height:1;color:' + (flagged?'#facc15':'var(--dim)') + ';transition:color .15s">⚑</button>' +
      '</div>';

    const mkCell = (w, content, onclick, cursor) =>
      '<div onclick="' + onclick + '" style="width:' + w + ';min-width:' + w + ';padding:10px;border-right:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;cursor:' + (cursor||'text') + '">' + content + '</div>';
    const ie = field => 'startDealInlineEdit(' + r.id + ',\'' + field + '\',event)';

    return '<div style="display:flex;align-items:stretch;border-bottom:1px solid var(--border);background:' + c.bg + ';border-left:3px solid ' + c.dot + ';transition:filter .15s" onmouseenter="this.style.filter=\'brightness(1.08)\'" onmouseleave="this.style.filter=\'\'">' +
      flagBtn +
      mkCell(colW[0],  '<span style="font:600 11px/1.3 var(--font-mono);color:var(--muted)">' + esc(r.month_label||'') + '</span>', ie('month_label')) +
      mkCell(colW[1],  '<span style="font:600 13px/1.3 var(--font-sans);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block">' + esc(r.company) + '</span>', 'accOpenDealModal(' + r.id + ')', 'pointer') +
      mkCell(colW[2],  '<span style="font:700 12px/1 var(--font-mono);color:var(--text)">' + esc(fmtAmt(r.paid_inc_vat)) + '</span>', ie('paid_inc_vat')) +
      mkCell(colW[3],  '<span style="font:600 12px/1 var(--font-mono);color:var(--muted)">' + esc(fmtAmt(r.deal_amount)) + '</span>', ie('deal_amount')) +
      mkCell(colW[4],  '<span style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + esc(fmtAmt(r.tax_vat)) + '</span>', ie('tax_vat')) +
      mkCell(colW[5],  '<span style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + esc(fmtDate(r.date_invoice_issued)) + '</span>', ie('date_invoice_issued')) +
      mkCell(colW[6],  '<span style="font:600 11px/1 var(--font-mono);color:' + (r.date_paid?'var(--positive)':'var(--muted)') + '">' + esc(fmtDate(r.date_paid)) + '</span>', ie('date_paid')) +
      mkCell(colW[7],  '<span style="font:500 11px/1 var(--font-mono);color:var(--muted)">' + esc(r.bank||'') + '</span>', ie('bank')) +
      mkCell(colW[8],  r.invoice_number
        ? '<span style="font:500 10px/1.3 var(--font-mono);color:var(--primary);text-decoration:underline;text-underline-offset:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block">' + esc(r.invoice_number) + ' 📎</span>'
        : '<span style="font:500 10px/1.3 var(--font-mono);color:var(--dim)">+ upload</span>',
        'openInvoiceModal(' + r.id + ',event)', 'pointer') +
      mkCell(colW[9],  '<span style="font:500 11px/1.4 var(--font-sans);color:var(--text);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc(r.notes||'') + '</span>', ie('notes')) +
      mkCell(colW[10], '<span style="font:600 10px/1 var(--font-mono);color:' + (r.invoice_sent&&r.invoice_sent!=='no'?'var(--positive)':'var(--muted)') + '">' + esc(r.invoice_sent==='no'?'—':r.invoice_sent) + '</span>', ie('invoice_sent'), 'pointer') +
      mkCell(colW[11], '<span style="font:600 10px/1 var(--font-mono);color:' + (r.signature_received==='yes'?'var(--positive)':'var(--muted)') + '">' + esc(r.signature_received==='yes'?'yes':'—') + '</span>', ie('signature_received'), 'pointer') +
      mkCell(colW[12], '<span style="font:700 11px/1 var(--font-mono);color:var(--text)">' + esc(r.initials||'') + '</span>', ie('initials')) +
    '</div>';
  }).join('');

  const rowsHtml       = buildRows(active);
  const cancelledHtml  = buildRows(cancelled);

  const fmtTotal = v => '£' + v.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});

  page.innerHTML =
    '<div style="padding:20px 24px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<h2 style="font:700 20px/1 var(--font-sans);color:var(--text);flex:1">Deal Tracker</h2>' +
      '<button class="btn btn-ghost btn-sm" onclick="dealAutoColour()" title="Set green where paid, no colour where unpaid">Auto-colour rows</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="accOpenDealImport()" style="gap:6px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Import Excel / CSV</button>' +
      '<button class="btn btn-primary btn-sm" onclick="accOpenDealModal(null)">+ Add Deal</button>' +
    '</div>' +

    // Summary cards
    '<div style="padding:16px 24px;display:flex;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:140px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
        '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Total Paid</div>' +
        '<div style="font:700 18px/1 var(--font-sans);color:var(--positive)">' + fmtTotal(totalPaid) + '</div>' +
      '</div>' +
      '<div style="flex:1;min-width:140px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
        '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Total Deal Value</div>' +
        '<div style="font:700 18px/1 var(--font-sans);color:var(--text)">' + fmtTotal(totalDeal) + '</div>' +
      '</div>' +
      '<div style="flex:1;min-width:140px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
        '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Tax / VAT</div>' +
        '<div style="font:700 18px/1 var(--font-sans);color:var(--text)">' + fmtTotal(totalVat) + '</div>' +
      '</div>' +
      '<div style="flex:1;min-width:140px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
        '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Remaining</div>' +
        '<div style="font:700 18px/1 var(--font-sans);color:' + (remaining > 0 ? 'var(--negative)' : 'var(--positive)') + '">' + fmtTotal(remaining) + '</div>' +
      '</div>' +
      (_lastInvNum ? (
        '<div style="flex:1;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">' +
          '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px">Last Invoice</div>' +
          '<div style="font:600 11px/1.3 var(--font-mono);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(_lastInvNum) + '">' + esc(_lastInvNum) + '</div>' +
          '<div style="font:500 10px/1 var(--font-mono);color:var(--primary);margin-top:8px">Next → ' + esc(_nextInvNum) + '</div>' +
        '</div>'
      ) : '') +
    '</div>' +

    // Filter bar
    (function(){
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthOpts = (selected, placeholder) =>
        '<option value="">' + placeholder + '</option>' +
        MONTHS.map((m,i) => { const v = String(i+1).padStart(2,'0'); return '<option value="' + v + '"' + (selected===v?' selected':'') + '>' + m + '</option>'; }).join('');
      const yearOpts = yearsInData.map(y => '<option value="' + y + '"' + (_dealYear===y?' selected':'') + '>' + y + '</option>').join('');

      const fromMo = _dealFromMonth ? _dealFromMonth.slice(5,7) : '';
      const toMo   = _dealToMonth   ? _dealToMonth.slice(5,7)   : '';
      const isFiltered = _dealFromMonth || _dealToMonth || _dealSearch;

      return '<div style="padding:0 24px 14px">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">' +
          // Text search
          '<input id="dealSearchInput" class="form-control" style="width:180px;font-size:12px;padding:6px 10px" placeholder="Search company, invoice…" value="' + esc(_dealSearch) + '" oninput="_dealSearch=this.value;renderDealTracker()">' +
          '<div style="width:1px;height:24px;background:var(--border);margin:0 4px"></div>' +
          // Year
          '<select class="form-control" style="width:90px;font-size:12px;padding:6px 8px" onchange="dealSetYear(this.value)"><option value="">All years</option>' + yearOpts + '</select>' +
          // Quick quarters (fiscal: Q1=Nov-Jan, Q2=Feb-Apr, Q3=May-Jul, Q4=Aug-Oct)
          (function(){
            const aq = _activeQuarter();
            const qLabels = ['Q1 Nov–Jan','Q2 Feb–Apr','Q3 May–Jul','Q4 Aug–Oct'];
            return '<div style="display:flex;gap:4px">' +
              qLabels.map((lbl,i) => {
                const isActive = aq === i+1;
                return '<button onclick="dealSetQuarter(' + (i+1) + ')" title="' + lbl + '" style="padding:5px 10px;font:700 11px/1 var(--font-mono);border-radius:6px;border:1px solid var(--border);background:' + (isActive?'var(--primary)':'var(--surface)') + ';color:' + (isActive?'#fff':'var(--text)') + ';cursor:pointer;white-space:nowrap">' + lbl + '</button>';
              }).join('') +
            '</div>';
          })()+
          '<div style="width:1px;height:24px;background:var(--border);margin:0 4px"></div>' +
          // Custom from/to month
          '<span style="font:600 10px/1 var(--font-mono);color:var(--muted)">FROM</span>' +
          '<select class="form-control" style="width:80px;font-size:12px;padding:6px 8px" onchange="dealSetFromMonth(this.value)">' + monthOpts(fromMo,'Month') + '</select>' +
          '<span style="font:600 10px/1 var(--font-mono);color:var(--muted)">TO</span>' +
          '<select class="form-control" style="width:80px;font-size:12px;padding:6px 8px" onchange="dealSetToMonth(this.value)">' + monthOpts(toMo,'Month') + '</select>' +
          (isFiltered
            ? '<button class="btn btn-ghost btn-sm" onclick="dealClearFilters()" style="color:var(--negative)">✕ Clear</button>' +
              '<span style="font:600 11px/1 var(--font-mono);color:var(--primary)">' + active.length + ' / ' + allActive.length + ' deals</span>'
            : '') +
        '</div>' +
      '</div>';
    })()+

    // Table
    '<div style="padding:0 24px 32px">' +
      '<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden">' +
        '<div style="overflow-x:auto">' +
          '<div style="min-width:1400px">' +
            // Header
            '<div style="display:flex;background:var(--surface-2,var(--surface));border-bottom:2px solid var(--border)">' + headerCols + '</div>' +
            // Rows
            (rowsHtml || '<div style="padding:40px;text-align:center;color:var(--muted);font:500 13px/1 var(--font-mono)">No deals yet. Click "+ Add Deal" to get started.</div>') +
            // Totals
            (rowsHtml ? '<div style="display:flex;align-items:stretch;border-top:2px solid var(--border);background:rgba(250,204,21,0.06)">' +
              // flag spacer
              '<div style="width:36px;min-width:36px;border-right:1px solid var(--border);flex-shrink:0"></div>' +
              // TOTAL label in Month col
              '<div style="width:80px;min-width:80px;padding:10px 10px;border-right:1px solid var(--border);flex-shrink:0;display:flex;align-items:center"><span style="font:800 11px/1 var(--font-mono);color:var(--warning);letter-spacing:.5px">TOTAL</span></div>' +
              // Company col empty
              '<div style="width:200px;min-width:200px;border-right:1px solid var(--border);flex-shrink:0"></div>' +
              // Paid inc VAT
              '<div style="width:110px;min-width:110px;padding:8px 10px;border-right:1px solid var(--border);flex-shrink:0">' +
                '<div style="font:600 8px/1 var(--font-mono);color:var(--muted);letter-spacing:.6px;text-transform:uppercase;margin-bottom:5px">Paid Amount</div>' +
                '<div style="font:800 12px/1 var(--font-mono);color:var(--text)">' + fmtTotal(totalPaid) + '</div>' +
              '</div>' +
              // Deal Amount
              '<div style="width:110px;min-width:110px;padding:8px 10px;border-right:1px solid var(--border);flex-shrink:0">' +
                '<div style="font:600 8px/1 var(--font-mono);color:var(--muted);letter-spacing:.6px;text-transform:uppercase;margin-bottom:5px">Deal Amount</div>' +
                '<div style="font:800 12px/1 var(--font-mono);color:var(--text)">' + fmtTotal(totalDeal) + '</div>' +
              '</div>' +
              // VAT
              '<div style="width:90px;min-width:90px;padding:8px 10px;border-right:1px solid var(--border);flex-shrink:0">' +
                '<div style="font:600 8px/1 var(--font-mono);color:var(--muted);letter-spacing:.6px;text-transform:uppercase;margin-bottom:5px">VAT Amount</div>' +
                '<div style="font:800 12px/1 var(--font-mono);color:var(--text)">' + fmtTotal(totalVat) + '</div>' +
              '</div>' +
              // Remaining spans the rest
              '<div style="flex:1;padding:8px 16px;display:flex;align-items:center">' +
                '<div>' +
                  '<div style="font:600 8px/1 var(--font-mono);color:var(--muted);letter-spacing:.6px;text-transform:uppercase;margin-bottom:5px">Remaining</div>' +
                  '<div style="font:800 15px/1 var(--font-mono);color:' + (remaining>0?'var(--negative)':'var(--positive)') + '">' + fmtTotal(remaining) + '</div>' +
                '</div>' +
              '</div>' +
            '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // Cancelled section
    (cancelled.length ?
      '<div style="padding:0 24px 32px">' +
        '<details>' +
          '<summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font:600 13px/1 var(--font-sans);color:var(--muted);user-select:none">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
            '<span style="flex:1">Cancelled Deals</span>' +
            '<span style="font:700 11px/1 var(--font-mono);background:rgba(239,68,68,0.12);color:var(--negative);padding:3px 8px;border-radius:20px">' + cancelled.length + '</span>' +
          '</summary>' +
          '<div style="margin-top:8px;border:1px solid var(--border);border-radius:10px;overflow:hidden">' +
            '<div style="overflow-x:auto"><div style="min-width:1400px;opacity:.7">' +
              '<div style="display:flex;background:var(--surface-2,var(--surface));border-bottom:2px solid var(--border)">' + headerCols + '</div>' +
              cancelledHtml +
            '</div></div>' +
          '</div>' +
        '</details>' +
      '</div>'
    : '') ;
}

function dealSetYear(y) {
  _dealYear = y;
  if (y) { _dealFromMonth = (parseInt(y)-1) + '-11'; _dealToMonth = y + '-10'; }
  else    { _dealFromMonth = ''; _dealToMonth = ''; }
  renderDealTracker();
}
// Fiscal quarters: Q1=Nov-Jan, Q2=Feb-Apr, Q3=May-Jul, Q4=Aug-Oct
function dealSetQuarter(q) {
  const y = parseInt(_dealYear || String(new Date().getFullYear()));
  _dealYear = String(y);
  if      (q === 1) { _dealFromMonth = (y-1) + '-11'; _dealToMonth = y + '-01'; }
  else if (q === 2) { _dealFromMonth = y + '-02';      _dealToMonth = y + '-04'; }
  else if (q === 3) { _dealFromMonth = y + '-05';      _dealToMonth = y + '-07'; }
  else              { _dealFromMonth = y + '-08';      _dealToMonth = y + '-10'; }
  renderDealTracker();
}
function _activeQuarter() {
  if (!_dealFromMonth || !_dealToMonth) return 0;
  const y = parseInt(_dealYear || _dealFromMonth.slice(0,4));
  if (_dealFromMonth === (y-1)+'-11' && _dealToMonth === y+'-01') return 1;
  if (_dealFromMonth === y+'-02'     && _dealToMonth === y+'-04') return 2;
  if (_dealFromMonth === y+'-05'     && _dealToMonth === y+'-07') return 3;
  if (_dealFromMonth === y+'-08'     && _dealToMonth === y+'-10') return 4;
  return 0;
}
function dealSetFromMonth(mo) {
  const y = _dealYear || String(new Date().getFullYear());
  _dealYear      = y;
  _dealFromMonth = mo ? y + '-' + mo : '';
  renderDealTracker();
}
function dealSetToMonth(mo) {
  const y = _dealYear || String(new Date().getFullYear());
  _dealYear      = y;
  _dealToMonth   = mo ? y + '-' + mo : '';
  renderDealTracker();
}
function dealClearFilters() {
  _dealFromMonth = ''; _dealToMonth = ''; _dealSearch = ''; _dealYear = '';
  renderDealTracker();
}

function accOpenDealModal(id) {
  const deal = id ? _dealData.find(d => d.id === id) : null;
  const v = k => deal ? (deal[k] != null ? deal[k] : '') : '';
  const fmtDateInput = d => { if (!d) return ''; return String(d).slice(0,10); };

  const colorOpts = [
    { val:'green',  label:'Green — Paid' },
    { val:'orange', label:'Orange — Partial / Incomplete' },
    { val:'red',    label:'Red — Overdue / Problem' },
    { val:'none',   label:'No colour' },
  ];
  const colorSel = colorOpts.map(o => '<option value="' + o.val + '"' + (v('row_color')===o.val||(!v('row_color')&&o.val==='green')?' selected':'') + '>' + o.label + '</option>').join('');
  const sentOpts = ['no','yes','yes-pdf'].map(o => '<option value="' + o + '"' + (v('invoice_sent')===o?' selected':'') + '>' + (o==='no'?'No':o==='yes'?'Yes':'Yes (PDF)') + '</option>').join('');
  const sigOpts  = ['no','yes'].map(o => '<option value="' + o + '"' + (v('signature_received')===o?' selected':'') + '>' + (o==='no'?'No':'Yes') + '</option>').join('');
  const statusSel = ['active','cancelled'].map(o => '<option value="' + o + '"' + ((v('status')||'active')===o?' selected':'') + '>' + (o==='active'?'Active':'Cancelled') + '</option>').join('');

  const html =
    '<div class="modal-overlay active" id="accDealModal" onclick="if(event.target===this)accCloseDealModal()">' +
    '<div class="modal" style="max-width:680px;width:95vw">' +
    '<div class="modal-header">' +
      '<h2>' + (deal ? 'Edit Deal' : 'Add Deal') + '</h2>' +
      '<button class="modal-close" onclick="accCloseDealModal()">✕</button>' +
    '</div>' +
    '<div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:14px">' +
      '<div class="form-group" style="grid-column:1/-1">' +
        '<label class="form-label">Company *</label>' +
        '<input id="dlCompany" class="form-control" value="' + esc(v('company')) + '" placeholder="Company name">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Month Label</label>' +
        '<input id="dlMonth" class="form-control" value="' + esc(v('month_label')) + '" placeholder="e.g. 26-Jan">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Row Colour</label>' +
        '<select id="dlColor" class="form-control">' + colorSel + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Status</label>' +
        '<select id="dlStatus" class="form-control">' + statusSel + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Deal Amount (£)</label>' +
        '<input id="dlDeal" class="form-control" type="number" step="0.01" value="' + esc(v('deal_amount')) + '" placeholder="0.00">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Paid inc VAT (£)</label>' +
        '<input id="dlPaid" class="form-control" type="number" step="0.01" value="' + esc(v('paid_inc_vat')) + '" placeholder="0.00">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Tax / VAT (£)</label>' +
        '<input id="dlVat" class="form-control" type="number" step="0.01" value="' + esc(v('tax_vat')) + '" placeholder="0.00">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Invoice Date</label>' +
        '<input id="dlInvDate" class="form-control" type="date" value="' + esc(fmtDateInput(v('date_invoice_issued'))) + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Date Paid</label>' +
        '<input id="dlPaidDate" class="form-control" type="date" value="' + esc(fmtDateInput(v('date_paid'))) + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Bank / Payment via</label>' +
        '<input id="dlBank" class="form-control" value="' + esc(v('bank')) + '" placeholder="HSBC / Stripe / etc.">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Invoice Number</label>' +
        '<input id="dlInvNum" class="form-control" value="' + esc(v('invoice_number')) + '" placeholder="LPGPCONNECTCOMLTD…">' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Invoice &amp; Agreement Sent</label>' +
        '<select id="dlSent" class="form-control">' + sentOpts + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Signature Received</label>' +
        '<select id="dlSig" class="form-control">' + sigOpts + '</select>' +
      '</div>' +
      '<div class="form-group">' +
        '<label class="form-label">Initials</label>' +
        '<input id="dlInitials" class="form-control" value="' + esc(v('initials')) + '" placeholder="MR / CS">' +
      '</div>' +
      '<div class="form-group" style="grid-column:1/-1">' +
        '<label class="form-label">Notes</label>' +
        '<textarea id="dlNotes" class="form-control" rows="3" placeholder="Any notes…">' + esc(v('notes')) + '</textarea>' +
      '</div>' +
    '</div>' +
    '<div style="padding:0 20px 20px;display:flex;gap:10px;justify-content:flex-end">' +
      (deal ? '<button class="btn btn-ghost btn-sm" style="color:var(--negative)" onclick="accDeleteDeal(' + id + ')">Delete</button><span style="flex:1"></span>' : '') +
      '<button class="btn btn-ghost btn-sm" onclick="accCloseDealModal()">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" onclick="accSaveDeal(' + (id||'null') + ')">Save</button>' +
    '</div>' +
    '</div></div>';

  let existing = document.getElementById('accDealModal');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('dlCompany').focus();
}

function accCloseDealModal() {
  const m = document.getElementById('accDealModal');
  if (m) m.remove();
}

async function accSaveDeal(id) {
  const company = document.getElementById('dlCompany').value.trim();
  if (!company) { showToast('Company name is required', 'error'); return; }
  const payload = {
    company,
    month_label:        document.getElementById('dlMonth').value.trim(),
    row_color:          document.getElementById('dlColor').value,
    status:             document.getElementById('dlStatus').value,
    deal_amount:        document.getElementById('dlDeal').value || null,
    paid_inc_vat:       document.getElementById('dlPaid').value || null,
    tax_vat:            document.getElementById('dlVat').value || null,
    date_invoice_issued:document.getElementById('dlInvDate').value || null,
    date_paid:          document.getElementById('dlPaidDate').value || null,
    bank:               document.getElementById('dlBank').value.trim(),
    invoice_number:     document.getElementById('dlInvNum').value.trim(),
    invoice_sent:       document.getElementById('dlSent').value,
    signature_received: document.getElementById('dlSig').value,
    initials:           document.getElementById('dlInitials').value.trim(),
    notes:              document.getElementById('dlNotes').value.trim(),
  };
  try {
    const url  = id ? '/api/deal-tracker/' + id : '/api/deal-tracker';
    const meth = id ? 'PUT' : 'POST';
    const res  = await fetch(url, { method: meth, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    if (id) {
      const idx = _dealData.findIndex(d => d.id === id);
      if (idx !== -1) _dealData[idx] = data; else _dealData.push(data);
    } else {
      _dealData.push(data);
    }
    accCloseDealModal();
    renderDealTracker();
    showToast(id ? 'Deal updated' : 'Deal added', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function accDeleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  try {
    const res = await fetch('/api/deal-tracker/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    _dealData = _dealData.filter(d => d.id !== id);
    accCloseDealModal();
    renderDealTracker();
    showToast('Deal deleted', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function dealAutoColour() {
  try {
    const res  = await fetch('/api/deal-tracker/auto-colour', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    await loadDealTracker();
    showToast('Colours updated: ' + data.updated + ' rows changed', 'success');
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

async function toggleDealFlag(id, event) {
  event.stopPropagation();
  const deal = _dealData.find(d => d.id === id);
  if (!deal) return;
  const payload = Object.assign({}, deal, { is_flagged: !deal.is_flagged });
  try {
    const res  = await fetch('/api/deal-tracker/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let updated;
    try { updated = JSON.parse(text); } catch(e) { throw new Error('Server returned: ' + text.slice(0,120)); }
    if (!res.ok) throw new Error(updated.error || 'Save failed');
    const idx = _dealData.findIndex(d => d.id === id);
    if (idx !== -1) _dealData[idx] = updated;
    renderDealTracker();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

function startDealInlineEdit(id, field, event) {
  event.stopPropagation();
  const deal = _dealData.find(d => d.id === id);
  if (!deal) return;
  const cell = event.currentTarget;
  const origHtml = cell.innerHTML;

  const iBase = 'width:100%;background:transparent;border:none;border-bottom:2px solid var(--primary);outline:none;color:var(--text);padding:2px 0;font:inherit';
  const numFields  = ['paid_inc_vat','deal_amount','tax_vat'];
  const dateFields = ['date_invoice_issued','date_paid'];

  let inp;
  if (numFields.includes(field)) {
    inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.01';
    inp.value = deal[field] != null ? parseFloat(deal[field]) : '';
    inp.style.cssText = iBase + ';font:700 12px/1 var(--font-mono)';
  } else if (dateFields.includes(field)) {
    inp = document.createElement('input');
    inp.type = 'date';
    inp.value = deal[field] ? String(deal[field]).slice(0,10) : '';
    inp.style.cssText = iBase + ';font:500 11px/1 var(--font-mono)';
  } else if (field === 'invoice_sent') {
    inp = document.createElement('select');
    inp.style.cssText = iBase + ';font:600 10px/1 var(--font-mono)';
    [['no','No'],['yes','Yes'],['yes-pdf','Yes (PDF)']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (deal[field] === v) o.selected = true;
      inp.appendChild(o);
    });
  } else if (field === 'signature_received') {
    inp = document.createElement('select');
    inp.style.cssText = iBase + ';font:600 10px/1 var(--font-mono)';
    [['no','No'],['yes','Yes']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (deal[field] === v) o.selected = true;
      inp.appendChild(o);
    });
  } else {
    inp = document.createElement('input');
    inp.type = 'text';
    inp.value = deal[field] || '';
    inp.style.cssText = iBase + ';font:500 12px/1 var(--font-mono)';
  }
  inp.style.width = '100%';

  cell.innerHTML = '';
  cell.appendChild(inp);
  inp.focus();
  if (inp.select && inp.type !== 'date') inp.select();

  let done = false;
  const save = async () => {
    if (done) return; done = true;
    let val = inp.value;
    if (numFields.includes(field))  val = val === '' ? null : parseFloat(val);
    if (dateFields.includes(field)) val = val === '' ? null : val;
    const payload = Object.assign({}, deal, { [field]: val });
    try {
      const res  = await fetch('/api/deal-tracker/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const text = await res.text();
      let updated; try { updated = JSON.parse(text); } catch(e) { throw new Error(text.slice(0,120)); }
      if (!res.ok) throw new Error(updated.error || 'Save failed');
      const idx = _dealData.findIndex(d => d.id === id);
      if (idx !== -1) _dealData[idx] = updated;
      renderDealTracker();
    } catch(e) { showToast('Error: ' + e.message, 'error'); cell.innerHTML = origHtml; }
  };
  const cancel = () => { done = true; cell.innerHTML = origHtml; };

  if (inp.tagName === 'SELECT') {
    inp.addEventListener('change', () => { inp.blur(); });
    inp.addEventListener('blur', save);
  } else {
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { cancel(); }
    });
  }
}

// ─── INVOICE DOCUMENTS ────────────────────────────────────────────────────────
async function openInvoiceModal(dealId, event) {
  if (event) event.stopPropagation();
  const deal = _dealData.find(d => d.id === dealId);
  let existing = document.getElementById('invoiceDocModal');
  if (existing) existing.remove();

  const html =
    '<div class="modal-overlay active" id="invoiceDocModal" onclick="if(event.target===this)closeInvoiceModal()">' +
    '<div class="modal" style="max-width:520px;width:95vw">' +
    '<div class="modal-header">' +
      '<div>' +
        '<h2 style="margin:0">Invoice Documents</h2>' +
        (deal && deal.invoice_number ? '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:4px">' + esc(deal.invoice_number) + '</div>' : '') +
      '</div>' +
      '<button class="modal-close" onclick="closeInvoiceModal()">✕</button>' +
    '</div>' +
    '<div style="padding:20px">' +
      '<div id="invoiceDocList"><div style="text-align:center;padding:20px;color:var(--muted);font:500 12px/1 var(--font-mono)">Loading…</div></div>' +
      '<div style="margin-top:18px;padding-top:18px;border-top:1px solid var(--border)">' +
        '<div style="font:600 11px/1 var(--font-mono);color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Upload</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<label style="flex:1;min-width:140px;display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border:2px dashed var(--border);border-radius:8px;cursor:pointer;font:600 12px/1 var(--font-sans);color:var(--text);transition:border-color .2s" onmouseenter="this.style.borderColor=\'var(--primary)\'" onmouseleave="this.style.borderColor=\'\'">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            'Upload PDF' +
            '<input type="file" accept=".pdf,application/pdf" style="display:none" onchange="uploadInvoiceFile(' + dealId + ',this,\'pdf\')">' +
          '</label>' +
          '<label style="flex:1;min-width:140px;display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border:2px dashed var(--border);border-radius:8px;cursor:pointer;font:600 12px/1 var(--font-sans);color:var(--text);transition:border-color .2s" onmouseenter="this.style.borderColor=\'var(--primary)\'" onmouseleave="this.style.borderColor=\'\'">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>' +
            'Upload Word Doc' +
            '<input type="file" accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="display:none" onchange="uploadInvoiceFile(' + dealId + ',this,\'word\')">' +
          '</label>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '</div></div>';

  document.body.insertAdjacentHTML('beforeend', html);
  loadInvoiceFiles(dealId);
}

function closeInvoiceModal() {
  const m = document.getElementById('invoiceDocModal');
  if (m) m.remove();
}

async function loadInvoiceFiles(dealId) {
  const list = document.getElementById('invoiceDocList');
  if (!list) return;
  try {
    const res  = await fetch('/api/deal-tracker/' + dealId + '/invoices');
    const docs = res.ok ? await res.json() : [];
    if (!docs.length) {
      list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font:500 12px/1.5 var(--font-mono)">No documents uploaded yet.</div>';
      return;
    }
    const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(0) + ' KB' : (b/1048576).toFixed(1) + ' MB';
    const icon = t => t === 'pdf'
      ? '<div style="width:32px;height:32px;background:rgba(239,68,68,0.12);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">📄</div>'
      : '<div style="width:32px;height:32px;background:rgba(59,130,246,0.12);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px">📝</div>';
    list.innerHTML = docs.map(d =>
      '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">' +
        icon(d.file_type) +
        '<div style="flex:1;min-width:0">' +
          '<div style="font:600 12px/1 var(--font-sans);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.file_name) + '</div>' +
          '<div style="font:500 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">' + fmtSize(d.file_size||0) + ' · ' + d.file_type.toUpperCase() + '</div>' +
        '</div>' +
        '<button onclick="downloadInvoiceFile(' + d.id + ',\'' + esc(d.file_name) + '\',\'' + d.file_type + '\')" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;font:600 11px/1 var(--font-mono);color:var(--text)">↓ Download</button>' +
        '<button onclick="deleteInvoiceFile(' + d.id + ',' + dealId + ')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:16px;padding:4px">×</button>' +
      '</div>'
    ).join('');
  } catch(e) {
    list.innerHTML = '<div style="color:var(--negative);font:500 12px/1 var(--font-mono);padding:10px">Failed to load: ' + esc(e.message) + '</div>';
  }
}

async function uploadInvoiceFile(dealId, input, fileType) {
  const file = (input.files||[])[0];
  if (!file) return;
  const MAX = 10 * 1024 * 1024;
  if (file.size > MAX) { showToast('File too large (max 10 MB)', 'error'); return; }
  const list = document.getElementById('invoiceDocList');
  if (list) list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font:500 12px/1 var(--font-mono)">Uploading…</div>';
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await fetch('/api/deal-tracker/' + dealId + '/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: file.name, file_type: fileType, file_data: base64, file_size: file.size })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    showToast('Uploaded: ' + file.name, 'success');
    loadInvoiceFiles(dealId);
  } catch(e) { showToast('Upload failed: ' + e.message, 'error'); if (list) loadInvoiceFiles(dealId); }
  input.value = '';
}

async function downloadInvoiceFile(id, fileName, fileType) {
  try {
    const res  = await fetch('/api/deal-invoices/' + id + '/download');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Download failed');
    const mimeMap = { pdf: 'application/pdf', word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const mime = mimeMap[fileType] || 'application/octet-stream';
    const link = document.createElement('a');
    link.href = 'data:' + mime + ';base64,' + data.file_data;
    link.download = data.file_name || fileName;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  } catch(e) { showToast('Download failed: ' + e.message, 'error'); }
}

async function deleteInvoiceFile(id, dealId) {
  if (!confirm('Delete this document?')) return;
  try {
    const res = await fetch('/api/deal-invoices/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    showToast('Document deleted', 'success');
    loadInvoiceFiles(dealId);
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

// ─── DEAL IMPORT ──────────────────────────────────────────────────────────────
function accOpenDealImport() {
  let existing = document.getElementById('accDealImportModal');
  if (existing) existing.remove();
  const html =
    '<div class="modal-overlay active" id="accDealImportModal" onclick="if(event.target===this)closeDealImport()">' +
    '<div class="modal" style="max-width:560px;width:95vw">' +
    '<div class="modal-header"><h2>Import from Excel / CSV</h2><button class="modal-close" onclick="closeDealImport()">✕</button></div>' +
    '<div style="padding:20px">' +
      '<p style="font:500 13px/1.6 var(--font-sans);color:var(--muted);margin-bottom:16px">Select your Excel (.xlsx) or CSV file. Columns are matched automatically by header name.</p>' +
      '<div style="border:2px dashed var(--border);border-radius:10px;padding:36px;text-align:center;cursor:pointer;transition:border-color .2s" id="accDealDropZone" onclick="document.getElementById(\'accDealImportFile\').click()" ondragover="event.preventDefault();this.style.borderColor=\'var(--primary)\'" ondragleave="this.style.borderColor=\'\'" ondrop="event.preventDefault();this.style.borderColor=\'\';processDealImportFile({files:event.dataTransfer.files})">' +
        '<div style="font-size:36px;margin-bottom:8px">📂</div>' +
        '<div style="font:600 13px/1 var(--font-sans);color:var(--text)">Click to choose file or drag &amp; drop</div>' +
        '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:6px">.xlsx · .xls · .csv</div>' +
      '</div>' +
      '<input type="file" id="accDealImportFile" accept=".xlsx,.xls,.csv" style="display:none" onchange="processDealImportFile(this)">' +
      '<div id="accDealImportPreview" style="margin-top:16px"></div>' +
    '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
}

function closeDealImport() {
  const m = document.getElementById('accDealImportModal');
  if (m) m.remove();
}

async function processDealImportFile(input) {
  const file = (input.files||[])[0];
  if (!file) return;
  const preview = document.getElementById('accDealImportPreview');
  preview.innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted);font:500 12px/1 var(--font-mono)">Parsing file…</div>';

  // Lazy-load SheetJS
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = window.XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = window.XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
      const mapped = raw.map(mapDealImportRow).filter(r => r.company && !['total','remaining'].includes((r.company+'').toLowerCase().trim()));
      showDealImportPreview(mapped);
    } catch(err) {
      preview.innerHTML = '<div class="alert alert-error">Could not parse file: ' + esc(err.message) + '</div>';
    }
  };
  reader.readAsArrayBuffer(file);
}

function mapDealImportRow(row) {
  const find = (...keys) => {
    for (const k of keys) {
      const match = Object.keys(row).find(rk => rk.toLowerCase().replace(/[^a-z0-9]/g,'') === k.toLowerCase().replace(/[^a-z0-9]/g,''));
      if (match !== undefined) return row[match];
    }
    return '';
  };
  const parseAmt = v => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[£$€,\s]/g,''));
    return isNaN(n) ? null : n;
  };
  const parseDate = v => {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v)?null:v.toISOString().slice(0,10);
    const s = String(v).trim();
    if (!s) return null;
    // DD/MM/YY or DD/MM/YYYY
    const m1 = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m1) {
      const [, d, mo, y] = m1;
      const year = y.length === 2 ? '20' + y : y;
      const dt = new Date(year + '-' + mo.padStart(2,'0') + '-' + d.padStart(2,'0'));
      if (!isNaN(dt)) return dt.toISOString().slice(0,10);
    }
    const dt = new Date(s);
    return isNaN(dt) ? null : dt.toISOString().slice(0,10);
  };
  const normSent = v => {
    const s = String(v||'').toLowerCase().trim();
    if (s.includes('pdf')) return 'yes-pdf';
    if (s === 'yes' || s === 'y') return 'yes';
    return 'no';
  };
  const normSig = v => {
    const s = String(v||'').toLowerCase().trim();
    return (s === 'yes' || s === 'y') ? 'yes' : 'no';
  };
  return {
    month_label:         String(find('month','month label') || ''),
    company:             String(find('company') || ''),
    paid_inc_vat:        parseAmt(find('paidincvat','paid inc vat','paid','paid inc. vat')),
    deal_amount:         parseAmt(find('deal','deal amount','dealamount')),
    tax_vat:             parseAmt(find('taxvat','tax/vat','tax vat','tax','vat')),
    date_invoice_issued: parseDate(find('dateinvoiceissued','date invoice issued','invoice date','invoicedate')),
    date_paid:           parseDate(find('datepaid','date paid','paiddate')),
    bank:                String(find('bari','bank','payment via','paymentvia','payment method') || ''),
    invoice_number:      String(find('invoicenumber','invoice number','invoice no','invoice#') || ''),
    notes:               String(find('notes','note') || ''),
    invoice_sent:        normSent(find('invoice&agreementsent','invoiceagreementsent','invoice sent','invoicesent','sent')),
    signature_received:  normSig(find('signaturereceived','signature received','signature','signed')),
    initials:            String(find('initials','initial') || ''),
    row_color:           (parseAmt(find('paidincvat','paid inc vat','paid','paid inc. vat')) ? 'green' : 'none'),
  };
}

function showDealImportPreview(rows) {
  const preview = document.getElementById('accDealImportPreview');
  if (!rows.length) {
    preview.innerHTML = '<div class="alert alert-error">No valid rows found. Make sure your file has a "Company" column header.</div>';
    return;
  }
  window._dealImportRows = rows;
  const fmtA = v => v != null ? '£' + parseFloat(v).toLocaleString('en-GB',{minimumFractionDigits:2}) : '—';
  const sample = rows.slice(0,6);
  const tableRows = sample.map(r =>
    '<tr>' +
    '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">' + esc(r.month_label) + '</td>' +
    '<td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600">' + esc(r.company) + '</td>' +
    '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">' + fmtA(r.paid_inc_vat) + '</td>' +
    '<td style="padding:6px 8px;border-bottom:1px solid var(--border)">' + fmtA(r.deal_amount) + '</td>' +
    '<td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--muted)">' + esc(r.bank) + '</td>' +
    '</tr>'
  ).join('');
  preview.innerHTML =
    '<div style="margin-bottom:10px;padding:10px 14px;background:rgba(34,197,94,0.1);border-radius:8px;font:600 12px/1 var(--font-mono);color:var(--positive)">' +
      rows.length + ' rows ready to import' + (rows.length > 6 ? ' (showing first 6 below)' : '') +
    '</div>' +
    '<div style="overflow-x:auto;border-radius:8px;border:1px solid var(--border);margin-bottom:14px">' +
    '<table style="width:100%;border-collapse:collapse;font:500 11px/1 var(--font-mono)">' +
    '<thead><tr style="background:var(--surface)">' +
      '<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Month</th>' +
      '<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Company</th>' +
      '<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Paid</th>' +
      '<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Deal</th>' +
      '<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border)">Bank</th>' +
    '</tr></thead>' +
    '<tbody>' + tableRows + '</tbody>' +
    '</table></div>' +
    '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="btn btn-ghost btn-sm" onclick="closeDealImport()">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" onclick="confirmDealImport()">Import ' + rows.length + ' rows</button>' +
    '</div>';
}

async function confirmDealImport() {
  const rows = window._dealImportRows || [];
  if (!rows.length) return;
  const btn = document.querySelector('#accDealImportModal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    const res = await fetch('/api/deal-tracker/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deals: rows })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    closeDealImport();
    await loadDealTracker();
    showToast('Imported ' + (data.count || rows.length) + ' deals successfully', 'success');
  } catch(e) {
    showToast('Import failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Import ' + rows.length + ' rows'; }
  }
}

// ─── EMPLOYEE REMINDERS ───────────────────────────────────────────────────────
async function empToggleReminder(id) {
  try {
    await fetch('/api/employee/reminders/' + id + '/done', { method: 'PATCH' });
    const res = await fetch('/api/employee/reminders');
    window._empReminders = res.ok ? await res.json() : window._empReminders;
    const card = document.getElementById('empRemindersCard');
    if (card) {
      const inner = card.querySelector('[style*="padding:4px"]');
      if (inner) inner.innerHTML = empRemindersHtmlStandalone();
    }
  } catch(e) { console.warn('Toggle reminder failed', e); }
}

async function empDeleteReminder(id) {
  try {
    await fetch('/api/employee/reminders/' + id, { method: 'DELETE' });
    const res = await fetch('/api/employee/reminders');
    window._empReminders = res.ok ? await res.json() : (window._empReminders||[]).filter(r => r.id !== id);
    const card = document.getElementById('empRemindersCard');
    if (card) {
      const inner = card.querySelector('[style*="padding:4px"]');
      if (inner) inner.innerHTML = empRemindersHtmlStandalone();
    }
  } catch(e) { console.warn('Delete reminder failed', e); }
}

async function empAddReminder() {
  const inp = document.getElementById('empReminderInput');
  const dt  = document.getElementById('empReminderDate');
  if (!inp || !inp.value.trim()) return;
  try {
    await fetch('/api/employee/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: inp.value.trim(), reminder_date: dt ? dt.value || null : null })
    });
    if (inp) inp.value = '';
    if (dt)  dt.value  = '';
    const res = await fetch('/api/employee/reminders');
    window._empReminders = res.ok ? await res.json() : window._empReminders;
    const card = document.getElementById('empRemindersCard');
    if (card) {
      const inner = card.querySelector('[style*="padding:4px"]');
      if (inner) inner.innerHTML = empRemindersHtmlStandalone();
    }
  } catch(e) { console.warn('Add reminder failed', e); }
}

function empRemindersHtmlStandalone() {
  const reminders = window._empReminders || [];
  const pending = reminders.filter(r => !r.is_done);
  const done    = reminders.filter(r => r.is_done);
  const fmtDate = d => { if (!d) return ''; const dt = new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); };
  const itemHtml = r => {
    const isPast = r.reminder_date && r.reminder_date.slice(0,10) < new Date().toLocaleDateString('en-CA');
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">' +
      '<div onclick="empToggleReminder(' + r.id + ')" style="width:18px;height:18px;border:2px solid ' + (r.is_done?'var(--primary)':'var(--border)') + ';border-radius:4px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;background:' + (r.is_done?'var(--primary)':'transparent') + '">' +
        (r.is_done ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><polyline points="2,6 5,9 10,3"/></svg>' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font:600 13px/1 var(--font-sans);color:' + (r.is_done?'var(--dim)':'var(--text)') + ';' + (r.is_done?'text-decoration:line-through':'') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.title) + '</div>' +
        (r.reminder_date ? '<div style="font:500 10px/1 var(--font-mono);color:' + (isPast&&!r.is_done?'var(--negative)':'var(--muted)') + ';margin-top:3px">' + fmtDate(r.reminder_date) + (isPast&&!r.is_done?' · overdue':'') + '</div>' : '') +
      '</div>' +
      '<button onclick="empDeleteReminder(' + r.id + ')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:2px 4px;flex-shrink:0">×</button>' +
    '</div>';
  };
  const listHtml = pending.map(itemHtml).join('') + (done.length ? '<div style="font:600 9px/1 var(--font-mono);color:var(--dim);letter-spacing:.5px;margin:10px 0 4px">COMPLETED</div>' + done.slice(0,3).map(itemHtml).join('') : '');
  return '<div id="empRemindersList">' + (listHtml || '<div style="color:var(--muted);font:500 12px/1.5 var(--font-mono);padding:12px 0;text-align:center">No reminders yet.<br>Add one below.</div>') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
      '<input id="empReminderInput" class="form-control" style="flex:1;font-size:12px;padding:7px 10px" placeholder="Add a reminder..." onkeydown="if(event.keyCode===13)empAddReminder()">' +
      '<input id="empReminderDate" class="form-control" type="date" style="width:130px;font-size:12px;padding:7px 8px">' +
      '<button class="btn btn-primary btn-sm" onclick="empAddReminder()">+</button>' +
    '</div>';
}

// ─── ADMIN STAFF PORTFOLIO ────────────────────────────────────────────────────
let _adminPortfolioData = null;
let _adminPortfolioEmpFilter = '';

async function loadAdminPortfolio() {
  const page = document.getElementById('page-portfolio');
  if (!page) return;
  page.innerHTML = '<div class="skeleton" style="height:400px;border-radius:16px;margin:24px"></div>';
  try {
    const res = await fetch('/api/admin/staff-portfolio');
    _adminPortfolioData = res.ok ? await res.json() : { employees: [], events: [] };
    renderAdminPortfolioPage();
  } catch(e) {
    page.innerHTML = '<div style="padding:24px"><div class="alert alert-error">Failed to load staff portfolio: ' + e.message + '</div></div>';
  }
}

function renderAdminPortfolioPage() {
  const page = document.getElementById('page-portfolio');
  if (!page || !_adminPortfolioData) return;
  const { employees, events } = _adminPortfolioData;

  // Group events by employee
  const byEmp = {};
  employees.forEach(e => { byEmp[e.employee_id] = { emp: e, events: [] }; });
  events.forEach(ev => {
    if (byEmp[ev.employee_id]) byEmp[ev.employee_id].events.push(ev);
  });

  const filtered = _adminPortfolioEmpFilter
    ? Object.values(byEmp).filter(g => g.emp.employee_id == _adminPortfolioEmpFilter)
    : Object.values(byEmp);

  const empOptions = employees.map(e =>
    `<option value="${e.employee_id}" ${e.employee_id==_adminPortfolioEmpFilter?'selected':''}>${esc(e.name)}</option>`
  ).join('');

  const empCards = filtered.map(({ emp, events: evts }) => {
    const sorted = [...evts].sort((a,b) => {
      if (!a.event_date && !b.event_date) return 0;
      if (!a.event_date) return 1;
      if (!b.event_date) return -1;
      return new Date(b.event_date) - new Date(a.event_date);
    });

    const evtRows = sorted.map(ev => {
      const dateStr = ev.event_date ? new Date(ev.event_date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';
      const badgeColor = ev.added_by === 'admin' ? '#f59e0b' : 'var(--positive)';
      const badgeLabel = ev.added_by === 'admin' ? 'Allocated' : 'Self-added';
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font:600 13px/1 var(--font-sans);color:var(--text)">${esc(ev.event_name)}</div>
          <div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:3px">${dateStr}</div>
          ${ev.notes ? `<div style="font:500 11px/1.4 var(--font-mono);color:var(--text-2);margin-top:4px">${esc(ev.notes)}</div>` : ''}
        </div>
        <span style="font:700 9px/1 var(--font-mono);color:${badgeColor};padding:3px 8px;border:1px solid ${badgeColor};border-radius:20px;flex-shrink:0">${badgeLabel}</span>
        <button class="btn btn-danger btn-sm" onclick="adminDeletePortfolioEvent(${ev.id})" style="flex-shrink:0">×</button>
      </div>`;
    }).join('');

    return `<div class="card" style="margin-bottom:16px">
      <div style="padding:16px 20px 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
        <div>
          <div style="font:700 15px/1 var(--font-sans);color:var(--text)">${esc(emp.name)}</div>
          <div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:4px">${esc(emp.role||'')}${emp.department?' · '+esc(emp.department):''} · ${sorted.length} event${sorted.length!==1?'s':''}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="openAllocateEvent(${emp.employee_id}, '${esc(emp.name)}')">+ Allocate Event</button>
      </div>
      <div style="padding:4px 20px 12px">
        ${evtRows || '<div style="padding:16px 0;color:var(--muted);font:500 12px/1 var(--font-mono)">No events logged yet</div>'}
      </div>
    </div>`;
  }).join('');

  page.innerHTML = `
    <div style="padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div>
          <h2 style="font:700 20px/1 var(--font-sans);color:var(--text);margin:0">Staff Portfolio</h2>
          <div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:6px">${events.length} event${events.length!==1?'s':''} across ${employees.length} staff</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <select onchange="adminPortfolioFilter(this.value)" style="background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font:500 12px/1 var(--font-mono)">
            <option value="">All Staff</option>
            ${empOptions}
          </select>
        </div>
      </div>
      ${empCards || '<div style="text-align:center;padding:40px;color:var(--muted);font:500 13px/1 var(--font-mono)">No staff found.</div>'}
    </div>
    <!-- Allocate Event Modal -->
    <div id="allocateModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center">
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:16px;padding:28px;width:100%;max-width:440px;margin:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h3 id="allocateModalTitle" style="font:700 16px/1 var(--font-sans);color:var(--text);margin:0">Allocate Event</h3>
          <button onclick="closeAllocateModal()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0">✕</button>
        </div>
        <input type="hidden" id="allocateEmpId">
        <div class="form-group" style="margin-bottom:14px">
          <label class="form-label">Event Name *</label>
          <input id="allocEventName" class="form-control" type="text" placeholder="e.g. CFO NYC 2026">
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label class="form-label">Event Date</label>
          <input id="allocEventDate" class="form-control" type="date">
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label class="form-label">Notes (optional)</label>
          <textarea id="allocNotes" class="form-control" rows="3" placeholder="Any additional details..."></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-ghost" onclick="closeAllocateModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveAllocateEvent()">Allocate</button>
        </div>
      </div>
    </div>`;
}

function renderDealsByInitials(filtered) {
  // Build summary by initials — shown in totals if any
}

async function cycleDealStatus(id, newStatus) {
  const res = await fetch(`/api/deals/${id}/row-status`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ row_status: newStatus })
  });
  if (!res.ok) { showToast('Failed', 'error'); return; }
  const idx = dealsData.findIndex(d => d.id === id);
  if (idx !== -1) dealsData[idx].row_status = newStatus;
  renderDealsTable();
}

async function openDealModal(id, defaultStage) {
  _dealInv1 = null; _dealInv2 = null;
  _dealPeriodTouched = false;
  _dealPackageMode = false;
  _dealPackages = {};
  document.getElementById('dealEditId').value = id || '';
  document.getElementById('dealModalTitle').textContent = id ? 'Edit Deal' : 'Add Deal';
  document.querySelector('#dealModal .modal').classList.toggle('deal-modal-editing', !!id);
  document.getElementById('dealInv1Preview').textContent = '';
  document.getElementById('dealInv2Preview').textContent = '';
  document.getElementById('dealInv1File').value = '';
  document.getElementById('dealInv2File').value = '';
  document.getElementById('dealPackageRows').classList.add('hidden');
  document.getElementById('dealPackageRows').innerHTML = '';
  document.getElementById('dealSplitPreview').classList.remove('hidden');
  document.getElementById('dealPackageSingle').classList.remove('hidden');
  document.getElementById('dealPackageLabel').value = '';
  const pkgBtn = document.getElementById('dealPackageToggleBtn');
  if (pkgBtn) { pkgBtn.textContent = 'Custom Package Split'; pkgBtn.classList.remove('active'); }

  // Load events into checkbox picker
  let _evs = [];
  let _selectedEvIds = [];
  try {
    const evRes = await fetch('/api/portfolio-events');
    _evs = await evRes.json();
  } catch { _evs = []; }
  _dealEvsCache = Array.isArray(_evs) ? _evs : [];

  if (id) {
    const d = dealsData.find(x => x.id === id);
    if (!d) return;
    document.getElementById('dealTitle').value = d.title || d.company || '';
    document.getElementById('dealCompany').value = d.company || '';
    document.getElementById('dealInitials').value = d.initials || '';
    document.getElementById('dealStage').value = d.stage || 'Prospect';
    document.getElementById('dealCurrency').value = d.currency || 'GBP';
    document.getElementById('dealAmount').value = d.amount;
    document.getElementById('dealPaidIncVat').value = d.paid_inc_vat || '';
    document.getElementById('dealTaxVat').value = d.tax_vat || '';
    document.getElementById('dealInvoiceNumber').value = d.invoice_number || '';
    document.getElementById('dealInvoiceDate').value = d.invoice_date ? d.invoice_date.split('T')[0] : '';
    // Period: month from the stored business month (falling back to the invoice
    // date, then when the deal was created); year from wherever the tab comes from
    const parsed = parseDealMonth(d.deal_month);
    const fallbackDt = new Date(d.invoice_date || d.created_at || Date.now());
    // Signed month/year come from deal_month. The programme year it is filed
    // under is kept unless the events linked to it say otherwise.
    _dealStoredYear = d.fiscal_year ? parseInt(d.fiscal_year, 10) : null;
    setDealPeriod(parsed ? parsed.month : fallbackDt.getMonth() + 1,
                  parsed ? String(parsed.year) : (dealYearOf(d) || String(fallbackDt.getFullYear())));
    document.getElementById('dealInvSent').value = d.invoice_agreement_sent ? 'true' : 'false';
    document.getElementById('dealSigReceived').value = d.signature_received ? 'true' : 'false';
    document.getElementById('dealNotes').value = d.notes || '';
    _selectedEvIds = Array.isArray(d.events) ? d.events.map(e => e.event_id).filter(Boolean) : [];
    // One package on an even split fills the Package field; anything else
    // (different packages, or uneven amounts) restores custom package mode.
    if (Array.isArray(d.events) && d.events.some(e => e.package_label)) {
      if (dealIsSinglePackage(d)) {
        document.getElementById('dealPackageLabel').value = d.events[0].package_label;
      } else {
        _dealPackageMode = true;
        d.events.forEach(e => { _dealPackages[e.event_id] = { amount: e.allocated_amount, label: e.package_label || '' }; });
      }
    }
    if (d.invoice1_name) document.getElementById('dealInv1Preview').textContent = `Current: ${d.invoice1_name}`;
    if (d.invoice2_name) document.getElementById('dealInv2Preview').textContent = `Current: ${d.invoice2_name}`;
    setDealPayment(d.bank === 'Stripe' ? 'Stripe' : d.bank ? 'HSBC' : '');
  } else {
    document.getElementById('dealTitle').value = '';
    document.getElementById('dealCompany').value = '';
    document.getElementById('dealInitials').value = '';
    document.getElementById('dealStage').value = defaultStage || 'Prospect';
    document.getElementById('dealCurrency').value = 'GBP';
    document.getElementById('dealAmount').value = '';
    document.getElementById('dealPaidIncVat').value = '';
    document.getElementById('dealTaxVat').value = '';
    document.getElementById('dealInvoiceNumber').value = '';
    document.getElementById('dealInvoiceDate').value = '';
    // Period defaults to this month, in whichever year tab is open — so a deal
    // added while viewing 2027 lands in 2027, not only under All Years
    const now = new Date();
    _dealStoredYear = null;
    // Signed month is now; the programme year follows the events once picked
    // (and the open year tab until then).
    setDealPeriod(now.getMonth() + 1, String(now.getFullYear()));
    document.getElementById('dealInvSent').value = 'false';
    document.getElementById('dealSigReceived').value = 'false';
    document.getElementById('dealNotes').value = '';
    _selectedEvIds = [];
    setDealPayment('');
  }

  // Render the picker in date order, grouped by month, so the list reads like
  // a calendar. The producer team rides along on each row (and search still
  // matches it). Events whose day is TBC sit at the end of their month; events
  // with no usable date at all sit together at the very end under "Date TBC".
  const container = document.getElementById('dealEventsCheckboxes');
  if (container) {
    // A "date TBC" event's stored date is a placeholder, so it has no month.
    const evMonthKey = (ev) => {
      const m = ev.date_tbc === 'date' ? null : String(ev.event_date || '').match(/^(\d{4})-(\d{2})/);
      return m ? `${m[1]}-${m[2]}` : '';
    };
    const byMonth = new Map();
    for (const ev of _evs) {
      const key = evMonthKey(ev);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(ev);
    }
    const monthOrder = [...byMonth.keys()].sort((a, b) => {
      if (!a) return 1; if (!b) return -1;             // undated group last
      return a.localeCompare(b);
    });
    const byDate = (a, b) => {
      const ad = a.date_tbc === 'day' ? '9' : String(a.event_date || '');
      const bd = b.date_tbc === 'day' ? '9' : String(b.event_date || '');
      return ad.localeCompare(bd) || a.name.localeCompare(b.name);
    };
    const undatedOrder = (a, b) =>
      (a.programme_year || 9999) - (b.programme_year || 9999) || a.name.localeCompare(b.name);
    const monthLabel = (key) => {
      if (!key) return 'Date TBC';
      const [y, m] = key.split('-');
      return `${EVENT_MONTHS_SHORT[parseInt(m, 10) - 1] || ''} ${y}`;
    };
    // The first <span> inside each label is the event's name. The package
    // rows and the split preview read it, so the team and date come after.
    const item = (ev) => {
      const on = _selectedEvIds.includes(ev.id);
      return `<label class="deal-event-check-item${on ? ' selected' : ''}" data-name="${esc(ev.name.toLowerCase())}" data-producer="${esc((ev.producer || '').toLowerCase())}">
        <input type="checkbox" value="${ev.id}" ${on ? 'checked' : ''} onchange="onDealEventCheck(this)">
        <span>${esc(ev.name)}</span>
        ${ev.producer ? `<span class="deal-event-team">${esc(ev.producer)}</span>` : ''}
        <span class="deal-event-when${ev.date_tbc ? ' deal-event-when--tbc' : ''}">${esc(fmtEventDate(ev, { long: true }))}</span>
      </label>`;
    };
    container.innerHTML = monthOrder.map(key => {
      const evs = byMonth.get(key).sort(key ? byDate : undatedOrder);
      return `<div class="deal-event-group">
        <div class="deal-event-group-hd">
          <span>${monthLabel(key)}</span>
          <span class="deal-event-group-n">${evs.length}</span>
        </div>
        ${evs.map(item).join('')}
      </div>`;
    }).join('') || '<div style="padding:12px;font:500 12px/1 var(--font-mono);color:var(--muted)">No events yet — add one in Portfolio first.</div>';
  }
  const searchEl = document.getElementById('dealEventsSearch');
  if (searchEl) searchEl.value = '';
  updateDealSplitPreview();
  updateDealProgrammeYear();
  if (_dealPackageMode) { _dealPackageMode = false; toggleDealPackageMode(); }
  updateDealMoneySummary();
  openModal('dealModal');
}

// Which year tab a deal currently falls under, using the same precedence as
// dealPassesFilter: explicit fiscal_year, then invoice_date, then business month.
function dealYearOf(d) {
  if (d.fiscal_year) return String(d.fiscal_year);
  if (d.invoice_date) return String(d.invoice_date).slice(0, 4);
  const m = (d.deal_month || '').trim().match(/^(\d{2})\s*[-–]/);
  if (m) { const yr2 = parseInt(m[1], 10); return String(yr2 >= 50 ? 1900 + yr2 : 2000 + yr2); }
  return '';
}

// ── Deal period ──────────────────────────────────────────────────────────────
// A deal's period is one thing to the user — "the month and year this deal is
// for" — but it is stored as two columns: deal_month, the "YY - Mon" text the
// range filter and CSV import read, and fiscal_year, the year tab. The helpers
// below keep those two in step so they can never disagree again.

const DEAL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// "18 Sep 26": the form a ledger column can hold without wrapping.
function dealShortDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${parseInt(m[3], 10)} ${DEAL_MONTHS[parseInt(m[2], 10) - 1]} ${m[1].slice(2)}`;
}
let _dealPeriodTouched = false; // user picked a period by hand; don't let the invoice date overwrite it

// "26 - Sep" → { month: 9, year: 2026 }; anything unparseable → null
function parseDealMonth(text) {
  const m = (text || '').trim().match(/^(\d{2})\s*[-–]\s*([A-Za-z]{3})/);
  if (!m) return null;
  const month = DEAL_MONTHS.findIndex(mn => mn.toLowerCase() === m[2].toLowerCase()) + 1;
  if (!month) return null;
  const yr2 = parseInt(m[1], 10);
  return { month, year: yr2 >= 50 ? 1900 + yr2 : 2000 + yr2 };
}

// (9, 2026) → "26 - Sep", the stored deal_month format
function dealMonthText(month, year) {
  return String(year).slice(2) + ' - ' + DEAL_MONTHS[month - 1];
}

// The year options are the year tabs on the deals screen (including any added
// via +), plus the current year and the year being selected.
function dealYearOptions(selected) {
  const years = new Set();
  document.querySelectorAll('#dealYearFilters .deal-q-btn').forEach(b => {
    if (b.dataset.yr && b.dataset.yr !== 'all') years.add(b.dataset.yr);
  });
  years.add(String(new Date().getFullYear()));
  if (selected) years.add(String(selected));
  return [...years].sort((a, b) => b.localeCompare(a));
}

function fillPeriodSelects(monthSel, yearSel, month, year) {
  monthSel.innerHTML = DEAL_MONTHS.map((mn, i) => `<option value="${i + 1}">${mn}</option>`).join('');
  monthSel.value = String(month);
  yearSel.innerHTML = dealYearOptions(year).map(y => `<option value="${y}">${y}</option>`).join('');
  yearSel.value = String(year);
}

// A deal has two years that are usually the same and sometimes are not: the
// month it was signed ("Sep 2026", stored as deal_month) and the programme
// year it is for (2027, stored as fiscal_year -- the year tab). A deal signed
// in September 2026 for a 2027 event is a 2027 deal. The programme year is
// derived from the events picked and can be overridden; the signed month
// never decides it once an event is picked.
let _dealStoredYear = null;         // the programme year an existing deal is filed under
let _dealEvsCache = [];             // the events the picker was rendered from

function setDealPeriod(month, year) {
  fillPeriodSelects(document.getElementById('dealPeriodMonth'), document.getElementById('dealPeriodYear'), month, year);
  updateDealPeriodHint();
  updateDealProgrammeYear();
}

function getDealPeriod() {
  const month = parseInt(document.getElementById('dealPeriodMonth').value, 10);
  const year  = parseInt(document.getElementById('dealPeriodYear').value, 10);
  const progSel = document.getElementById('dealProgrammeYear');
  const prog = progSel && progSel.value ? parseInt(progSel.value, 10) : year;
  return { month, year, deal_month: dealMonthText(month, year), fiscal_year: prog };
}

function updateDealPeriodHint() {
  const hint = document.getElementById('dealPeriodHint');
  if (!hint) return;
  const { month, year, fiscal_year } = getDealPeriod();
  hint.innerHTML = `Signed ${DEAL_MONTHS[month - 1]} ${year}` +
    (fiscal_year && fiscal_year !== year ? ` · shows under <b>${fiscal_year}</b>` : '');
}

function onDealPeriodChange() {
  _dealPeriodTouched = true;
  updateDealPeriodHint();
  updateDealProgrammeYear();
}

/** The year the picked events agree on, or null when none / they disagree. */
function dealProgrammeYearFromEvents() {
  const ids = Array.from(document.querySelectorAll('#dealEventsCheckboxes input[type="checkbox"]:checked')).map(cb => parseInt(cb.value, 10));
  const years = new Set();
  ids.forEach(id => {
    const ev = _dealEvsCache.find(e => e.id === id);
    if (!ev) return;
    const y = ev.programme_year || (ev.event_date ? parseInt(String(ev.event_date).slice(0, 4), 10) : null);
    if (y) years.add(y);
  });
  return { year: years.size === 1 ? [...years][0] : null, picked: ids.length, spread: years.size > 1 };
}

/**
 * Work out the programme year (the year tab) the deal is filed under: the
 * year its linked events share, else the year it is already filed under,
 * else the year tab that is open, else the year it was signed. There is no
 * field for it; the signed-month hint says where it will show.
 */
function updateDealProgrammeYear() {
  const sel = document.getElementById('dealProgrammeYear');
  if (!sel) return;
  const signedYear = parseInt(document.getElementById('dealPeriodYear').value, 10);
  const tabYear = _dealYearFilter !== 'all' ? parseInt(_dealYearFilter, 10) : null;
  const value = dealProgrammeYearFromEvents().year || _dealStoredYear || tabYear || signedYear;
  sel.innerHTML = `<option value="${value}">${value}</option>`;
  sel.value = String(value);
  updateDealPeriodHint();
}

// Entering an invoice date proposes its month and year as the period — unless
// the user has already chosen one (a Sep 2026 invoice for a 2027 deal is normal).
function autofillDealMonth() {
  const dateVal = document.getElementById('dealInvoiceDate').value;
  if (!dateVal || _dealPeriodTouched) return;
  const dt = new Date(dateVal + 'T12:00:00');
  if (isNaN(dt.getTime())) return;
  setDealPeriod(dt.getMonth() + 1, String(dt.getFullYear()));
}

// Table cell: "Sep 2026" with the year muted. The month comes from the business
// month (falling back to the invoice date); the year is whichever one puts the
// deal on its tab, so the cell always agrees with the tab the row is under.
function dealPeriodDisplayHtml(d) {
  const parsed = parseDealMonth(d.deal_month);
  const monthNum = parsed ? parsed.month : (d.invoice_date ? parseInt(String(d.invoice_date).slice(5, 7), 10) : 0);
  if (!monthNum) return d.deal_month ? `<span class="deal-month-disp">${esc(d.deal_month)}</span>` : '<span style="color:var(--muted)">—</span>';
  const signedYear = parsed ? parsed.year : (d.invoice_date ? parseInt(String(d.invoice_date).slice(0, 4), 10) : null);
  const progYear = dealYearOf(d);
  // "for 2027" only earns its place under All Years; on a year tab every row
  // is already that year's.
  const differs = _dealYearFilter === 'all' && signedYear && progYear && String(signedYear) !== String(progYear);
  return `<span class="deal-month-disp"><span>${DEAL_MONTHS[monthNum - 1]}${signedYear ? ` <span class="deal-month-yr">${String(signedYear).slice(2)}</span>` : ''}</span>` +
    (differs ? `<span class="deal-month-for" title="Signed ${DEAL_MONTHS[monthNum - 1]} ${signedYear}, for the ${progYear} programme">for ${progYear}</span>` : '') +
    `</span>`;
}

function setDealPayment(value) {
  document.getElementById('dealBank').value = value || '';
  document.getElementById('dealPayBank')?.classList.toggle('active', value === 'HSBC');
  document.getElementById('dealPayStripe')?.classList.toggle('active', value === 'Stripe');
}
function selectDealPayment(method) {
  // Clicking the already-active method unsets it — no payment method by default
  const cur = document.getElementById('dealBank').value;
  setDealPayment(cur === method ? '' : method);
}

function fillNextInvoiceNumber() {
  const el = document.getElementById('dealNextInvNum');
  if (!el) return;
  document.getElementById('dealInvoiceNumber').value = el.textContent;
}

// Notes pop-out: a full-size editor over the deal modal for long notes. It
// edits the same text as the inline box, which is what saveDeal reads.
function openDealNotesPopup() {
  const company = document.getElementById('dealCompany')?.value.trim();
  document.getElementById('dealNotesPopupTitle').textContent = company ? `Notes · ${company}` : 'Deal Notes';
  const big = document.getElementById('dealNotesPopupText');
  big.value = document.getElementById('dealNotes').value;
  openModal('dealNotesModal');
  big.focus();
  big.setSelectionRange(big.value.length, big.value.length);
  big.scrollTop = 0;
}
function syncDealNotesPopup() {
  document.getElementById('dealNotes').value = document.getElementById('dealNotesPopupText').value;
}
function closeDealNotesPopup() {
  syncDealNotesPopup();
  closeModal('dealNotesModal');
}

function onDealEventCheck(cb) {
  const item = cb.closest('.deal-event-check-item');
  if (item) item.classList.toggle('selected', cb.checked);
  updateDealSplitPreview();
  updateDealProgrammeYear();
}

function filterDealEvents() {
  const q = (document.getElementById('dealEventsSearch')?.value || '').toLowerCase().trim();
  document.querySelectorAll('#dealEventsCheckboxes .deal-event-group').forEach(group => {
    let shown = 0;
    group.querySelectorAll('.deal-event-check-item').forEach(item => {
      // Matches on the event's name or its producer team, so "fidak" lists
      // that team's five events.
      const hit = !q || (item.dataset.name || '').includes(q) || (item.dataset.producer || '').includes(q);
      item.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });
    group.style.display = shown ? '' : 'none';
  });
}

function updateDealSplitPreview() {
  const checked = Array.from(document.querySelectorAll('#dealEventsCheckboxes input[type="checkbox"]:checked'));
  const countEl = document.getElementById('dealEventsCount');
  if (countEl) countEl.textContent = checked.length ? `${checked.length} selected` : '';
  if (_dealPackageMode) { renderDealPackageRows(); return; }
  const amount = parseFloat(document.getElementById('dealAmount').value) || 0;
  const sym = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' }[document.getElementById('dealCurrency')?.value] || '';
  const preview = document.getElementById('dealSplitPreview');
  if (checked.length > 1 && amount > 0) {
    const each = amount / checked.length;
    preview.textContent = `${sym}${fmt(each)} allocated to each of ${checked.length} events`;
  } else if (checked.length === 1 && amount > 0) {
    const label = checked[0].closest('label')?.querySelector('span')?.textContent || '';
    preview.textContent = `${sym}${fmt(amount)} allocated to ${label}`;
  } else {
    preview.textContent = '';
  }
}

// The even split the server makes when no custom amounts are sent.
function dealEvenShare(amount, n) {
  return n ? parseFloat((parseFloat(amount) / n).toFixed(2)) : 0;
}

// True when every linked event carries the same package on an even split,
// so the deal can be shown with the single Package field.
function dealIsSinglePackage(d) {
  const evs = d.events || [];
  if (!evs.length) return false;
  const label = evs[0].package_label || '';
  const share = dealEvenShare(d.amount, evs.length);
  return evs.every(e => (e.package_label || '') === label
    && Math.abs((parseFloat(e.allocated_amount) || 0) - share) < 0.01);
}

// One line under the money fields: what the invoice comes to with VAT, and
// (when editing) how much of it is still to come in.
function updateDealMoneySummary() {
  const el = document.getElementById('dealMoneySummary');
  if (!el) return;
  const amount = parseFloat(document.getElementById('dealAmount').value) || 0;
  const vat    = parseFloat(document.getElementById('dealTaxVat').value) || 0;
  const paid   = parseFloat(document.getElementById('dealPaidIncVat').value) || 0;
  if (amount <= 0) { el.innerHTML = ''; return; }
  const sym = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' }[document.getElementById('dealCurrency').value] || '';
  const total = amount + vat;
  const left  = total - paid;
  const editing = !!document.getElementById('dealEditId').value;
  const leftHtml = !editing ? '' : left > 0.005
    ? `<span class="dm-sum-left">${sym}${fmt(left)} left to pay</span>`
    : left < -0.005 ? `<span class="dm-sum-over">${sym}${fmt(-left)} overpaid</span>`
    : '<span class="dm-sum-done">Paid in full</span>';
  el.innerHTML = `<span>Invoice total <strong>${sym}${fmt(total)}</strong>${vat > 0 ? ' inc VAT' : ''}</span>${leftHtml}`;
}

function toggleDealPackageMode() {
  _dealPackageMode = !_dealPackageMode;
  const btn = document.getElementById('dealPackageToggleBtn');
  const rows = document.getElementById('dealPackageRows');
  const preview = document.getElementById('dealSplitPreview');
  const single = document.getElementById('dealPackageSingle');
  const singleInput = document.getElementById('dealPackageLabel');
  if (_dealPackageMode) {
    // Start each event from what an even split would give it, and carry the
    // single package across, so only the events that differ need touching.
    const label = singleInput.value.trim();
    const checked = document.querySelectorAll('#dealEventsCheckboxes input[type="checkbox"]:checked');
    const share = dealEvenShare(document.getElementById('dealAmount').value, checked.length);
    checked.forEach(cb => {
      const evId = parseInt(cb.value);
      if (!_dealPackages[evId]) _dealPackages[evId] = {};
      if (label && !_dealPackages[evId].label) _dealPackages[evId].label = label;
      if ((_dealPackages[evId].amount == null || _dealPackages[evId].amount === '') && share > 0) _dealPackages[evId].amount = share;
    });
    btn.textContent = 'Use Even Split';
    btn.classList.add('active');
    rows.classList.remove('hidden');
    preview.classList.add('hidden');
    single.classList.add('hidden');
    renderDealPackageRows();
  } else {
    // Back to one package: keep it when every event had the same one.
    const labels = [...new Set(Object.values(_dealPackages).map(p => (p.label || '').trim()).filter(Boolean))];
    if (labels.length === 1) singleInput.value = labels[0];
    btn.textContent = 'Custom Package Split';
    btn.classList.remove('active');
    rows.classList.add('hidden');
    preview.classList.remove('hidden');
    single.classList.remove('hidden');
    updateDealSplitPreview();
  }
}

function renderDealPackageRows() {
  const rows = document.getElementById('dealPackageRows');
  if (!rows) return;
  const checked = Array.from(document.querySelectorAll('#dealEventsCheckboxes input[type="checkbox"]:checked'));
  const sym = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' }[document.getElementById('dealCurrency')?.value] || '';
  if (!checked.length) {
    rows.innerHTML = '<div style="font:500 12px/1 var(--font-mono);color:var(--muted);padding:6px 0">Select events above to allocate a custom package to each.</div>';
    return;
  }
  rows.innerHTML = checked.map(cb => {
    const evId = parseInt(cb.value);
    const label = cb.closest('label')?.querySelector('span')?.textContent || '';
    const existing = _dealPackages[evId] || {};
    return `<div class="deal-package-row">
      <span class="dpr-name" title="${esc(label)}">${esc(label)}</span>
      <input type="text" placeholder="Package e.g. Exhibitor" value="${esc(existing.label || '')}"
        style="width:150px" oninput="dealPackageEdit(${evId},'label',this.value)">
      <span style="font:600 12px/1 var(--font-mono);color:var(--muted)">${sym}</span>
      <input type="number" min="0" step="0.01" placeholder="0.00" value="${existing.amount != null ? existing.amount : ''}"
        style="width:100px" oninput="dealPackageEdit(${evId},'amount',this.value)">
    </div>`;
  }).join('');
  const total = Object.values(_dealPackages).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const dealAmount = parseFloat(document.getElementById('dealAmount').value) || 0;
  const diff = dealAmount - total;
  rows.innerHTML += `<div style="font:600 11px/1 var(--font-mono);color:${Math.abs(diff) < 0.01 ? 'var(--positive)' : 'var(--warning)'};padding:2px 2px 0">
    Allocated ${sym}${fmt(total)} of ${sym}${fmt(dealAmount)} deal value ${Math.abs(diff) >= 0.01 ? `(${diff > 0 ? sym+fmt(diff)+' unallocated' : 'over-allocated by '+sym+fmt(Math.abs(diff))})` : '— fully allocated'}
  </div>`;
}

function dealPackageEdit(evId, field, value) {
  if (!_dealPackages[evId]) _dealPackages[evId] = {};
  _dealPackages[evId][field] = field === 'amount' ? value : value;
  // Re-render just the totals line without losing focus: recompute totals only
  const rows = document.getElementById('dealPackageRows');
  const totalLine = rows?.lastElementChild;
  const sym = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' }[document.getElementById('dealCurrency')?.value] || '';
  const total = Object.values(_dealPackages).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const dealAmount = parseFloat(document.getElementById('dealAmount').value) || 0;
  const diff = dealAmount - total;
  if (totalLine && totalLine.tagName === 'DIV' && totalLine.textContent.includes('Allocated')) {
    totalLine.style.color = Math.abs(diff) < 0.01 ? 'var(--positive)' : 'var(--warning)';
    totalLine.textContent = `Allocated ${sym}${fmt(total)} of ${sym}${fmt(dealAmount)} deal value ${Math.abs(diff) >= 0.01 ? `(${diff > 0 ? sym+fmt(diff)+' unallocated' : 'over-allocated by '+sym+fmt(Math.abs(diff))})` : '— fully allocated'}`;
  }
}

function dealFilePreview(n, input) {
  const file = input.files[0];
  const previewEl = document.getElementById(`dealInv${n}Preview`);
  if (!file) { previewEl.textContent = ''; return; }
  if (file.size > 8 * 1024 * 1024) { showToast('File must be under 8 MB', 'error'); input.value = ''; return; }
  previewEl.textContent = `Selected: ${file.name}`;
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result.split(',')[1];
    if (n === 1) _dealInv1 = { name: file.name, data: base64 };
    else _dealInv2 = { name: file.name, data: base64 };
  };
  reader.readAsDataURL(file);
}

async function saveDeal() {
  const id = document.getElementById('dealEditId').value;
  const company = document.getElementById('dealCompany').value.trim();
  if (!company) { showToast('Company name is required', 'error'); return; }
  const amount = parseFloat(document.getElementById('dealAmount').value);
  if (isNaN(amount) || amount < 0) { showToast('Enter a valid deal value', 'error'); return; }
  const event_ids = Array.from(document.querySelectorAll('#dealEventsCheckboxes input[type="checkbox"]:checked'))
    .map(cb => parseInt(cb.value)).filter(Boolean);
  const paidIncVat = document.getElementById('dealPaidIncVat').value;
  const taxVat = document.getElementById('dealTaxVat').value;
  // Use company as title if no explicit title stored
  const existingTitle = document.getElementById('dealTitle').value.trim();
  const body = {
    title: existingTitle || company,
    company,
    contact_name: '', initials: document.getElementById('dealInitials').value.trim().toUpperCase(),
    currency: document.getElementById('dealCurrency').value,
    amount, stage: document.getElementById('dealStage').value || 'Prospect',
    paid_inc_vat: paidIncVat ? parseFloat(paidIncVat) : null,
    tax_vat: taxVat ? parseFloat(taxVat) : null,
    invoice_number: document.getElementById('dealInvoiceNumber').value.trim(),
    invoice_date: document.getElementById('dealInvoiceDate').value || null,
    deal_month: getDealPeriod().deal_month,
    fiscal_year: getDealPeriod().fiscal_year,
    paid_date: null,
    bank: document.getElementById('dealBank').value,
    invoice_agreement_sent: document.getElementById('dealInvSent').value === 'true',
    signature_received: document.getElementById('dealSigReceived').value === 'true',
    notes: document.getElementById('dealNotes').value.trim(),
    event_ids
  };
  if (_dealPackageMode) {
    body.event_packages = event_ids.map(evId => ({
      event_id: evId,
      amount: parseFloat(_dealPackages[evId]?.amount) || 0,
      package_label: (_dealPackages[evId]?.label || '').trim()
    }));
  } else {
    // An even split still carries the package name, on every linked event.
    const label = document.getElementById('dealPackageLabel').value.trim();
    if (label && event_ids.length) {
      const share = dealEvenShare(amount, event_ids.length);
      body.event_packages = event_ids.map(evId => ({ event_id: evId, amount: share, package_label: label }));
    }
  }
  if (_dealInv1) { body.invoice1_name = _dealInv1.name; body.invoice1_data = _dealInv1.data; }
  if (_dealInv2) { body.invoice2_name = _dealInv2.name; body.invoice2_data = _dealInv2.data; }

  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/deals/${id}` : '/api/deals';
  const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json(); showToast(e.error || 'Save failed', 'error'); return; }
  showToast(id ? 'Deal updated' : 'Deal added', 'success');
  closeModal('dealModal');
  loadDeals();
  loadPortfolio();
}

async function deleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  const res = await fetch(`/api/deals/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  _selectedDealIds.delete(id);
  showToast('Deal deleted', 'success');
  loadDeals();
  loadPortfolio();
}

function toggleDealSelect(id) {
  if (_selectedDealIds.has(id)) _selectedDealIds.delete(id);
  else _selectedDealIds.add(id);
  updateDealSelectionUI();
  renderDealsTable();
}

function selectAllDeals() {
  const filtered = window._dealCurrentFiltered || [];
  const allSelected = filtered.every(d => _selectedDealIds.has(d.id));
  if (allSelected) filtered.forEach(d => _selectedDealIds.delete(d.id));
  else filtered.forEach(d => _selectedDealIds.add(d.id));
  updateDealSelectionUI();
  renderDealsTable();
}

function updateDealSelectionUI() {
  const n = _selectedDealIds.size;
  const delBtn = document.getElementById('deleteSelectedDealsBtn');
  const moveBtn = document.getElementById('moveYearDealsBtn');
  document.getElementById('dealsTableBody')?.classList.toggle('has-selection', n > 0);
  if (n > 0) {
    if (delBtn)  { delBtn.textContent = `Delete selected (${n})`; delBtn.style.display = 'inline-flex'; }
    if (moveBtn) { moveBtn.textContent = `Move to year (${n})`;  moveBtn.style.display = 'inline-flex'; }
  } else {
    if (delBtn)  delBtn.style.display = 'none';
    if (moveBtn) moveBtn.style.display = 'none';
  }
}

async function moveDealsToYear() {
  const ids = [..._selectedDealIds];
  if (!ids.length) return;
  const yr = prompt('Move selected deals to which fiscal year? (e.g. 2026)');
  if (!yr || !/^\d{4}$/.test(yr.trim())) return;
  const res = await fetch('/api/deals/bulk-year', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, fiscal_year: parseInt(yr) })
  });
  if (!res.ok) { showToast('Move failed', 'error'); return; }
  _selectedDealIds.clear();
  updateDealSelectionUI();
  showToast(`${ids.length} deal${ids.length > 1 ? 's' : ''} moved to ${yr}`, 'success');
  loadDeals();
}

async function deleteSelectedDeals() {
  const ids = [..._selectedDealIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected deal${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  const res = await fetch('/api/deals/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  if (!res.ok) { showToast('Bulk delete failed', 'error'); return; }
  _selectedDealIds.clear();
  updateDealSelectionUI();
  showToast(`${ids.length} deal${ids.length > 1 ? 's' : ''} deleted`, 'success');
  loadDeals();
  loadPortfolio();
}

// ─── DEAL CSV IMPORT ──────────────────────────────────────────────────────────

function openDealImport() {
  _importRows = [];
  document.getElementById('dealImportFile').value = '';
  document.getElementById('dealImportPreview').innerHTML = '';
  document.getElementById('dealImportBtn').disabled = true;
  openModal('dealImportModal');
}

function previewDealImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    _importRows = parseDealCSV(text);
    const preview = document.getElementById('dealImportPreview');
    const btn = document.getElementById('dealImportBtn');
    if (!_importRows.length) {
      preview.innerHTML = '<span style="color:var(--danger)">No valid rows found. Make sure the CSV has a Company or Title column.</span>';
      btn.disabled = true;
      return;
    }
    preview.innerHTML = `<div style="color:var(--success);margin-bottom:8px">✓ Found <strong>${_importRows.length}</strong> deals to import.</div>
      <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;font-size:0.75rem">
        <table style="width:100%"><thead><tr style="background:var(--bg-2)">
          <th style="padding:4px 8px">Company</th><th style="padding:4px 8px">Amount</th>
          <th style="padding:4px 8px">Invoice #</th><th style="padding:4px 8px">Invoice Date</th><th style="padding:4px 8px">By</th>
        </tr></thead><tbody>
          ${_importRows.slice(0,20).map(r=>`<tr>
            <td style="padding:3px 8px">${esc(r.company||'')}</td>
            <td style="padding:3px 8px">${r.amount||'—'}</td>
            <td style="padding:3px 8px;font-size:0.7rem;font-family:monospace">${esc(r.invoice_number||'')}</td>
            <td style="padding:3px 8px">${r.invoice_date||'—'}</td>
            <td style="padding:3px 8px">${esc(r.initials||'')}</td>
          </tr>`).join('')}
          ${_importRows.length > 20 ? `<tr><td colspan="5" style="padding:4px 8px;color:var(--muted)">...and ${_importRows.length-20} more</td></tr>` : ''}
        </tbody></table>
      </div>`;
    btn.disabled = false;
  };
  reader.readAsText(file);
}

function parseDealCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  // Parse header row (handle quoted fields)
  const parseRow = row => {
    const cols = []; let cur = ''; let inQ = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cols.push(cur.trim());
    return cols;
  };
  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,''));
  // Map known column names
  const colMap = {
    company: ['company','company_name','client','client_name'],
    title: ['title','deal_title','deal','name','description'],
    amount: ['amount','deal_value','value','deal_amount','contract_value'],
    currency: ['currency','ccy'],
    paid_inc_vat: ['paid_inc_vat','paid','paid_amount','payment','paid_inc_vat_'],
    tax_vat: ['tax_vat','vat','tax','vat_amount','tax_amount'],
    invoice_number: ['invoice_number','invoice_no','invoice','invoice_num','lpgp'],
    invoice_date: ['invoice_date','date_invoice','inv_date','invoice_issued','date_invoice_issued'],
    paid_date: ['paid_date','date_paid','payment_date'],
    bank: ['bank','payment_method','method'],
    invoice_agreement_sent: ['invoice_agreement_sent','sent','agreement_sent','inv_sent'],
    signature_received: ['signature_received','signed','signature','sig'],
    initials: ['initials','by','sales','rep'],
    deal_month: ['month','deal_month','business_month','month_label'],
    notes: ['notes','note','comments','comment']
  };
  const findCol = (aliases) => {
    for (const a of aliases) {
      const idx = headers.indexOf(a);
      if (idx !== -1) return idx;
    }
    // Partial match
    for (const a of aliases) {
      const idx = headers.findIndex(h => h.includes(a) || a.includes(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idxMap = {};
  for (const [field, aliases] of Object.entries(colMap)) idxMap[field] = findCol(aliases);

  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const get = field => (idxMap[field] >= 0 ? (cols[idxMap[field]] || '').trim() : '');
    const company = get('company');
    const title = get('title') || company;
    if (!company && !title) continue;
    const parseDate = s => {
      if (!s) return null;
      // Try DD/MM/YYYY or DD/MM/YY
      const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m) {
        const yr = m[3].length === 2 ? '20'+m[3] : m[3];
        return `${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      }
      // Try YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
      return null;
    };
    const parseBool = s => ['yes','true','1','y','✓','✅'].includes((s||'').toLowerCase());
    results.push({
      company, title,
      amount: get('amount').replace(/[£$€,\s]/g,'') || '0',
      currency: get('currency').toUpperCase() || 'GBP',
      paid_inc_vat: get('paid_inc_vat').replace(/[£$€,\s]/g,'') || null,
      tax_vat: get('tax_vat').replace(/[£$€,\s]/g,'') || null,
      invoice_number: get('invoice_number'),
      invoice_date: parseDate(get('invoice_date')),
      paid_date: parseDate(get('paid_date')),
      bank: get('bank'),
      invoice_agreement_sent: parseBool(get('invoice_agreement_sent')),
      signature_received: parseBool(get('signature_received')),
      initials: get('initials').toUpperCase(),
      deal_month: get('deal_month'),
      notes: get('notes')
    });
  }
  return results;
}

async function runDealImport() {
  if (!_importRows.length) return;
  const importYear = document.getElementById('dealImportYear')?.value;
  if (!importYear) { showToast('Please select a fiscal year first', 'error'); return; }
  const btn = document.getElementById('dealImportBtn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  let ok = 0, fail = 0;
  for (const row of _importRows) {
    const body = {
      title: row.title || row.company,
      company: row.company,
      contact_name: '',
      initials: row.initials || '',
      stage: 'Prospect',
      fiscal_year: parseInt(importYear),
      currency: row.currency || 'GBP',
      amount: parseFloat(row.amount) || 0,
      paid_inc_vat: row.paid_inc_vat ? parseFloat(row.paid_inc_vat) : null,
      tax_vat: row.tax_vat ? parseFloat(row.tax_vat) : null,
      invoice_number: row.invoice_number || '',
      invoice_date: row.invoice_date || null,
      paid_date: row.paid_date || null,
      bank: row.bank || '',
      invoice_agreement_sent: !!row.invoice_agreement_sent,
      signature_received: !!row.signature_received,
      deal_month: row.deal_month || '',
      notes: row.notes || '',
      event_ids: []
    };
    try {
      const res = await fetch('/api/deals', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (res.ok) ok++; else fail++;
    } catch { fail++; }
  }
  btn.textContent = 'Import';
  closeModal('dealImportModal');
  showToast(`Imported ${ok} deal${ok !== 1 ? 's' : ''}${fail ? ` (${fail} failed)` : ''}`, ok > 0 ? 'success' : 'error');
  if (ok > 0) loadDeals();
}

function adminPortfolioFilter(val) {
  _adminPortfolioEmpFilter = val;
  renderAdminPortfolioPage();
}

function openAllocateEvent(empId, empName) {
  document.getElementById('allocateEmpId').value = empId;
  document.getElementById('allocateModalTitle').textContent = 'Allocate Event — ' + empName;
  document.getElementById('allocEventName').value = '';
  document.getElementById('allocEventDate').value = '';
  document.getElementById('allocNotes').value = '';
  document.getElementById('allocateModal').style.display = 'flex';
}

function closeAllocateModal() {
  document.getElementById('allocateModal').style.display = 'none';
}

async function saveAllocateEvent() {
  const empId = document.getElementById('allocateEmpId').value;
  const name  = document.getElementById('allocEventName').value.trim();
  const date  = document.getElementById('allocEventDate').value;
  const notes = document.getElementById('allocNotes').value.trim();
  if (!name) { alert('Please enter an event name'); return; }
  const res = await fetch('/api/admin/staff-portfolio', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ employee_id: parseInt(empId), event_name: name, event_date: date || null, notes })
  });
  if (res.ok) {
    closeAllocateModal();
    await loadAdminPortfolio();
  } else {
    const err = await res.json();
    alert('Error: ' + (err.error || 'Failed to allocate'));
  }
}

async function adminDeletePortfolioEvent(id) {
  if (!confirm('Remove this event from the portfolio?')) return;
  const res = await fetch('/api/admin/staff-portfolio/' + id, { method: 'DELETE' });
  if (res.ok) await loadAdminPortfolio();
}

let _portfolioEvents = [];
let _portfolioYear   = new Date().getFullYear();

async function loadEmployeePortfolio() {
  const page = document.getElementById('page-portfolio');
  if (!page) return;
  page.innerHTML = '<div class="skeleton" style="height:300px;border-radius:16px;margin:24px"></div>';
  try {
    const res = await fetch('/api/employee/portfolio');
    _portfolioEvents = res.ok ? await res.json() : [];
    renderPortfolioPage();
  } catch(e) {
    page.innerHTML = '<div style="padding:24px"><div class="alert alert-error">Failed to load portfolio: ' + e.message + '</div></div>';
  }
}

function renderPortfolioPage() {
  const page = document.getElementById('page-portfolio');
  if (!page) return;

  const eventYears = new Set(_portfolioEvents.map(e => e.event_date ? new Date(e.event_date).getFullYear() : null).filter(Boolean));
  const curYear = new Date().getFullYear();
  [2025, 2026, 2027, 2028].forEach(y => eventYears.add(y));
  const years = [...eventYears].sort((a,b) => b-a);
  if (!years.includes(_portfolioYear)) _portfolioYear = curYear;

  const filtered = _portfolioEvents.filter(e => {
    if (!e.event_date) return false;
    return new Date(e.event_date).getFullYear() === _portfolioYear;
  });
  const undated  = _portfolioYear === curYear ? _portfolioEvents.filter(e => !e.event_date) : [];

  const yearTabs = years.map(y =>
    `<button onclick="portfolioSetYear(${y})" style="padding:6px 16px;border-radius:20px;border:1px solid ${y===_portfolioYear?'var(--accent)':'var(--border)'};background:${y===_portfolioYear?'var(--accent)':'transparent'};color:${y===_portfolioYear?'#fff':'var(--muted)'};font:600 12px/1 var(--font-mono);cursor:pointer">${y}</button>`
  ).join('');

  const evtCard = (r) => {
    const dateStr = r.event_date ? new Date(r.event_date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : 'No date';
    const byAdmin = r.added_by === 'admin';
    return `<div class="card" style="margin-bottom:10px;padding:16px 20px;display:flex;align-items:center;gap:16px">
      <div style="flex:1;min-width:0">
        <div style="font:700 14px/1 var(--font-sans);color:var(--text)">${esc(r.event_name)}</div>
        <div style="font:500 11px/1.5 var(--font-mono);color:var(--muted);margin-top:4px">${dateStr}${byAdmin?' · <span style="color:#f59e0b">allocated by admin</span>':''}</div>
        ${r.notes ? `<div style="font:500 11px/1.4 var(--font-mono);color:var(--text-2);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">${esc(r.notes)}</div>` : ''}
      </div>
      ${!byAdmin ? `<button class="btn btn-ghost btn-sm" onclick="deleteEmployeePortfolioEvent(${r.id})" style="color:var(--danger);flex-shrink:0">×</button>` : ''}
    </div>`;
  };

  const allCards = [...filtered, ...undated].map(evtCard).join('');

  page.innerHTML = `
    <div style="padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div>
          <h2 style="font:700 20px/1 var(--font-sans);color:var(--text);margin:0">My Portfolio</h2>
          <div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-top:6px">${_portfolioEvents.length} event${_portfolioEvents.length!==1?'s':''} total</div>
        </div>
        <button class="btn btn-primary" onclick="openAddPortfolioEvent()">+ Add Event</button>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">${yearTabs}</div>
      ${allCards || `<div style="text-align:center;padding:40px 20px;color:var(--muted);font:500 12px/1.6 var(--font-mono)">No events in ${_portfolioYear}.<br>Click <strong>+ Add Event</strong> to log one.</div>`}
    </div>
    <!-- Add Event Modal -->
    <div id="portfolioModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center">
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:16px;padding:28px;width:100%;max-width:440px;margin:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h3 style="font:700 16px/1 var(--font-sans);color:var(--text);margin:0">Add Portfolio Event</h3>
          <button onclick="closePortfolioModal()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0">✕</button>
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label class="form-label">Event Name *</label>
          <input id="pfEventName" class="form-control" type="text" placeholder="e.g. CFO NYC 2026">
        </div>
        <div class="form-group" style="margin-bottom:14px">
          <label class="form-label">Event Date</label>
          <input id="pfEventDate" class="form-control" type="date">
        </div>
        <div class="form-group" style="margin-bottom:20px">
          <label class="form-label">Notes (optional)</label>
          <textarea id="pfNotes" class="form-control" rows="3" placeholder="Any additional details..."></textarea>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-ghost" onclick="closePortfolioModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveEmpPortfolioEvent()">Save Event</button>
        </div>
      </div>
    </div>`;
}

function portfolioSetYear(y) {
  _portfolioYear = y;
  renderPortfolioPage();
}

function openAddPortfolioEvent() {
  document.getElementById('pfEventName').value = '';
  document.getElementById('pfEventDate').value = '';
  document.getElementById('pfNotes').value = '';
  document.getElementById('portfolioModal').style.display = 'flex';
}

function closePortfolioModal() {
  document.getElementById('portfolioModal').style.display = 'none';
}

async function saveEmpPortfolioEvent() {
  const name  = document.getElementById('pfEventName').value.trim();
  const date  = document.getElementById('pfEventDate').value;
  const notes = document.getElementById('pfNotes').value.trim();
  if (!name) { alert('Please enter an event name'); return; }
  const res = await fetch('/api/employee/portfolio', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ event_name: name, event_date: date || null, notes })
  });
  if (res.ok) {
    closePortfolioModal();
    await loadEmployeePortfolio();
  } else {
    const err = await res.json();
    alert('Error: ' + (err.error || 'Failed to save'));
  }
}

async function deleteEmployeePortfolioEvent(id) {
  if (!confirm('Remove this event from your portfolio?')) return;
  const res = await fetch('/api/employee/portfolio/' + id, { method: 'DELETE' });
  if (res.ok) await loadEmployeePortfolio();
}

let empCalYear  = new Date().getFullYear();
let empCalMonth = new Date().getMonth() + 1;

async function loadEmployeeCalendar() {
  const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  // Build page scaffold once
  let container = document.getElementById('empCalContainer');
  if (!container) {
    const page = document.getElementById('page-calendar');
    if (!page) return;
    page.innerHTML =
      '<div class="page-head">' +
        '<div><h1>My Calendar</h1><div class="sub">// Your days off &amp; team bookings</div></div>' +
        '<button class="btn btn-primary" onclick="openEmpDayOffModal()">+ Request Day Off</button>' +
      '</div>' +
      '<div id="empCalContainer"></div>';
    container = document.getElementById('empCalContainer');
  }

  // Ensure day-off modal lives at body level (correct overlay behaviour)
  if (!document.getElementById('empDayOffModal')) {
    const m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'empDayOffModal';
    m.innerHTML =
      '<div class="modal" style="max-width:380px">' +
        '<div class="modal-header"><span class="modal-title">Request Day Off</span>' +
          '<button class="modal-close" onclick="closeModal(\'empDayOffModal\')">×</button></div>' +
        '<div style="padding:20px;display:flex;flex-direction:column;gap:14px">' +
          '<div id="empDayOffRangeNote" class="hidden" style="font:600 12px/1.4 var(--font-sans);color:var(--accent);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px"></div>' +
          '<div class="form-row" style="display:flex;gap:10px">' +
            '<div class="form-group" style="flex:1"><label>From</label><input type="date" id="empDayOffDate" onchange="empDayOffSyncEnd()"></div>' +
            '<div class="form-group" style="flex:1"><label>To</label><input type="date" id="empDayOffEndDate"></div>' +
          '</div>' +
          '<div class="form-group"><label>Type</label>' +
            '<select id="empDayOffType"><option value="1">Full Day</option><option value="0.5">Half Day</option></select></div>' +
          '<div class="form-group"><label>Reason <span style="color:var(--muted);font-weight:400">(required)</span></label><textarea id="empDayOffReason" class="form-control" rows="3" placeholder="e.g. Medical appointment, personal matter..."></textarea></div>' +
          '<button class="btn btn-primary" style="width:100%" onclick="submitEmpDayOff()">Submit Request</button>' +
        '</div>' +
      '</div>';
    m.addEventListener('click', function(e) { if (e.target === m) closeModal('empDayOffModal'); });
    document.body.appendChild(m);
  }

  container.innerHTML = '<div class="skeleton" style="height:400px;border-radius:12px"></div>';

  try {
    const [requestsRes, teamRes, upcomingRes] = await Promise.all([
      fetch('/api/employee/day-off-requests'),
      fetch('/api/calendar?year=' + empCalYear + '&month=' + empCalMonth),
      fetch('/api/employee/upcoming?days=60')
    ]);
    const allRequests = requestsRes.ok ? await requestsRes.json() : [];
    const teamRecords = teamRes.ok    ? await teamRes.json()     : [];
    const upcomingData = upcomingRes.ok ? await upcomingRes.json() : { dayOffs: [], reminders: [] };
    const upcomingDayOffs = upcomingData.dayOffs || [];
    const upcomingReminders = upcomingData.reminders || [];

    // Own requests this month: date → request
    const monthPrefix = empCalYear + '-' + String(empCalMonth).padStart(2,'0');
    const myRequests  = allRequests.filter(r => (r.request_date||'').startsWith(monthPrefix));
    const myMap = {};
    myRequests.forEach(r => { myMap[r.request_date.slice(0,10)] = r; });

    // Team days off: date → [names] (exclude self)
    const teamMap = {};
    const myEmpId = String((window.currentUser || {}).employee_id || '');
    (Array.isArray(teamRecords) ? teamRecords : []).forEach(r => {
      if (String(r.employee_id) === myEmpId) return;
      if (!(parseFloat(r.is_day_off) > 0)) return;
      const d = (r.record_date || '').slice(0,10);
      if (!d.startsWith(monthPrefix)) return;
      if (!teamMap[d]) teamMap[d] = [];
      const name = r.employee_name || r.name || ('Emp#' + r.employee_id);
      const firstName = name.split(' ')[0];
      if (!teamMap[d].find(n => n.full === name)) teamMap[d].push({ full: name, first: firstName });
    });

    // Store data for clickable day detail popup
    window._empCalMyMap   = myMap;
    window._empCalTeamMap = teamMap;
    window._empCalTodayStr = new Date().toLocaleDateString('en-CA');
    const todayStr = window._empCalTodayStr;

    // Calendar grid
    const firstDay    = new Date(empCalYear, empCalMonth - 1, 1);
    const daysInMonth = new Date(empCalYear, empCalMonth, 0).getDate();
    let startDow = firstDay.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;

    let gridHtml = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:8px">';
    DAYS.forEach(day => { gridHtml += '<div style="text-align:center;font:700 11px/1 var(--font-mono);color:var(--text-2);padding:6px 0;letter-spacing:.5px">' + day + '</div>'; });
    gridHtml += '</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">';

    for (let i = 0; i < startDow; i++) gridHtml += '<div></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = empCalYear + '-' + String(empCalMonth).padStart(2,'0') + '-' + String(d).padStart(2,'0');
      const rec    = myMap[dateStr];
      const team   = teamMap[dateStr] || [];
      const isToday = dateStr === todayStr;
      const isPast  = dateStr < todayStr;
      const status  = rec ? rec.status : null;

      let border = isToday ? '2px solid var(--primary)' : '1px solid var(--border)';
      let bg = isPast ? 'var(--surface)' : 'var(--surface-2)';
      let statusBar = '';
      if (status === 'pending')  { bg = '#d9770618'; border = '1px solid #fb923c55'; statusBar = '<div style="font:700 9px/1 var(--font-mono);color:#fb923c;margin-top:4px;letter-spacing:.5px;width:100%;text-align:center">PENDING</div>'; }
      else if (status === 'approved') { bg = '#6ee7d418'; border = '1px solid #6ee7b455'; statusBar = '<div style="font:700 9px/1 var(--font-mono);color:var(--primary);margin-top:4px;letter-spacing:.5px;width:100%;text-align:center">MY DAY OFF</div>'; }
      else if (status === 'declined') { bg = '#ef444412'; border = '1px solid #f8717155'; statusBar = '<div style="font:700 9px/1 var(--font-mono);color:#f87171;margin-top:4px;letter-spacing:.5px;width:100%;text-align:center">DECLINED</div>'; }

      let teamHtml = '';
      if (team.length) {
        teamHtml = team.slice(0, 3).map(n => {
          const label = n.first || n;
          return '<div style="font:600 9px/1.3 var(--font-mono);background:#7c3aed30;color:#c4b5fd;border-radius:4px;padding:2px 5px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">' + esc(label) + '</div>';
        }).join('');
        if (team.length > 3) teamHtml += '<div style="font:600 9px/1 var(--font-mono);color:var(--muted);margin-top:2px">+' + (team.length-3) + ' more</div>';
      }

      gridHtml +=
        '<div class="emp-cal-day" data-date="' + dateStr + '" style="background:' + bg + ';border:' + border + ';border-radius:8px;padding:8px 6px 6px;min-height:72px;cursor:pointer;display:flex;flex-direction:column;align-items:center;user-select:none"'
        + ' onmousedown="empDayMouseDown(event,\'' + dateStr + '\')" onmouseenter="empDayMouseEnter(\'' + dateStr + '\')" ontouchstart="empDayMouseDown(event,\'' + dateStr + '\')">' +
          '<div style="font:' + (isToday?'800':'700') + ' 15px/1 var(--font-mono);color:' + (isToday?'var(--primary)':isPast?'var(--dim)':'var(--text)') + ';width:100%;text-align:center">' + d + '</div>' +
          statusBar + teamHtml +
        '</div>';
    }
    gridHtml += '</div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font:500 11px/1 var(--font-mono);color:var(--muted)">' +
        '<span><span style="display:inline-block;width:10px;height:10px;background:#d9770618;border:1px solid #fb923c55;border-radius:3px;margin-right:4px;vertical-align:middle"></span>Pending</span>' +
        '<span><span style="display:inline-block;width:10px;height:10px;background:#6ee7d418;border:1px solid #6ee7b455;border-radius:3px;margin-right:4px;vertical-align:middle"></span>My day off</span>' +
        '<span><span style="display:inline-block;width:10px;height:10px;background:#7c3aed30;border-radius:3px;margin-right:4px;vertical-align:middle"></span>Team off</span>' +
      '</div>';

    // Upcoming panel: team day-offs + staff-visible reminders
    const MONS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

    const dayOffItems = upcomingDayOffs.slice(0, 8).map(r => {
      const rd = new Date(r.date);
      const label = parseFloat(r.is_day_off) === 0.5 ? 'Half day' : 'Day off';
      return '<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center">' +
        '<div style="width:36px;min-width:36px;text-align:center;background:#7c3aed22;border:1px solid #7c3aed44;border-radius:7px;padding:5px 0">' +
          '<div style="font:800 13px/1 var(--font-mono);color:#a78bfa">' + rd.getUTCDate() + '</div>' +
          '<div style="font:600 9px/1 var(--font-mono);color:#a78bfa;margin-top:3px">' + MONS[rd.getUTCMonth()] + '</div>' +
        '</div>' +
        '<div style="flex:1"><div style="font:600 12px/1 var(--font-sans);color:var(--text)">' + esc(r.employee_name) + '</div>' +
          '<div style="font:600 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">' + label.toUpperCase() + '</div></div>' +
      '</div>';
    }).join('');

    const remItems = upcomingReminders.slice(0, 5).map(r => {
      const rd = new Date(r.virtual_date);
      return '<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);align-items:center">' +
        '<div style="width:36px;min-width:36px;text-align:center;background:var(--accent);border:1px solid var(--accent);border-radius:7px;padding:5px 0">' +
          '<div style="font:800 13px/1 var(--font-mono);color:#fff">' + rd.getUTCDate() + '</div>' +
          '<div style="font:600 9px/1 var(--font-mono);color:rgba(255,255,255,0.75);margin-top:3px">' + MONS[rd.getUTCMonth()] + '</div>' +
        '</div>' +
        '<div style="flex:1"><div style="font:600 12px/1 var(--font-sans);color:var(--text)">' + esc(r.title) + '</div>' +
          '<div style="font:600 10px/1 var(--font-mono);color:var(--muted);margin-top:3px">' + (r.category||'').toUpperCase() + '</div></div>' +
      '</div>';
    }).join('');

    const remHtml = dayOffItems + remItems;

    container.innerHTML =
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">' +
        '<button class="btn btn-ghost" onclick="empCalPrev()">‹ Prev</button>' +
        '<div style="flex:1;text-align:center;font:700 16px/1 var(--font-sans);color:var(--text)">' + MONTHS_FULL[empCalMonth-1] + ' ' + empCalYear + '</div>' +
        '<button class="btn btn-ghost" onclick="empCalNext()">Next ›</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:3fr 2fr;gap:16px">' +
        '<div class="card">' +
          '<div class="card-header"><span class="card-title">Team Calendar</span>' +
            '<span style="font:700 11px/1 var(--font-mono);color:var(--muted)">' + myRequests.length + ' request' + (myRequests.length!==1?'s':'') + ' this month</span></div>' +
          '<div style="padding:16px">' + gridHtml + '</div>' +
          '<div style="padding:0 16px 12px;font:500 11px/1 var(--font-mono);color:var(--muted)">Click a date for details, or click-and-drag across multiple dates to request them all at once</div>' +
        '</div>' +
        '<div class="card"><div class="card-header"><span class="card-title">What\'s Coming Up</span><span style="font:700 11px/1 var(--font-mono);color:var(--muted)">NEXT 60D</span></div>' +
          '<div style="padding:4px 16px 12px">' + (remHtml || '<div style="color:var(--muted);font-size:0.82rem;padding:12px 0">No upcoming team events or days off</div>') + '</div>' +
        '</div>' +
      '</div>';

  } catch(e) {
    container.innerHTML = '<div class="alert alert-error">Failed to load calendar: ' + e.message + '</div>';
  }
}

function empDayClick(dateStr) {
  const myMap   = window._empCalMyMap || {};
  const teamMap = window._empCalTeamMap || {};
  const todayStr = window._empCalTodayStr || new Date().toLocaleDateString('en-CA');
  const rec   = myMap[dateStr];
  const team  = teamMap[dateStr] || [];
  const isPast = dateStr < todayStr;
  const status = rec ? rec.status : null;

  // Format date nicely
  const dt = new Date(dateStr + 'T12:00:00');
  const dateLabel = dt.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // Build modal content
  let body = '';

  // My status section
  if (rec) {
    const statusColor = status === 'approved' ? 'var(--primary)' : status === 'pending' ? '#fb923c' : '#f87171';
    const statusLabel = status === 'approved' ? 'Day off approved' : status === 'pending' ? 'Request pending' : 'Request declined';
    const typeLabel = parseFloat(rec.is_day_off) === 0.5 ? 'Half day' : 'Full day';
    body += '<div style="background:' + (status==='approved'?'#6ee7d410':status==='pending'?'#d9770610':'#ef444410') + ';border:1px solid ' + statusColor + '33;border-radius:8px;padding:12px 14px;margin-bottom:14px">' +
      '<div style="font:700 11px/1 var(--font-mono);color:' + statusColor + ';letter-spacing:.5px;margin-bottom:6px">YOUR REQUEST</div>' +
      '<div style="font:600 13px/1 var(--font-sans);color:var(--text)">' + statusLabel + ' · ' + typeLabel + '</div>' +
      (rec.reason ? '<div style="font:500 11px/1.4 var(--font-sans);color:var(--muted);margin-top:6px">Reason: ' + esc(rec.reason) + '</div>' : '') +
      (status === 'declined' && rec.decline_reason ? '<div style="font:500 11px/1.4 var(--font-sans);color:#f87171;margin-top:6px">Declined: ' + esc(rec.decline_reason) + '</div>' : '') +
    '</div>';
  }

  // Team members off
  if (team.length) {
    body += '<div style="font:700 11px/1 var(--font-mono);color:var(--muted);letter-spacing:.5px;margin-bottom:8px">TEAM DAYS OFF</div>';
    body += team.map(n => {
      const name = n.full || n;
      const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:#7c3aed33;color:#c4b5fd;font:700 12px/32px var(--font-mono);text-align:center;flex-shrink:0">' + initials + '</div>' +
        '<div style="font:600 13px/1 var(--font-sans);color:var(--text)">' + esc(name) + '</div>' +
      '</div>';
    }).join('');
    body += '<div style="height:8px"></div>';
  }

  // Actions
  let actions = '';
  if (!isPast && !rec) {
    actions = `<button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="closeEmpDayModal();openEmpDayOffModalDate('${dateStr}')">+ Request Day Off</button>`;
  } else if (status === 'pending') {
    actions = `<button class="btn btn-danger" style="width:100%;margin-top:4px" onclick="closeEmpDayModal();cancelEmpDayOff('${dateStr}')">Cancel My Request</button>`;
  }

  if (!rec && !team.length) {
    body = '<div style="text-align:center;padding:20px 0;color:var(--muted);font:500 13px/1.5 var(--font-mono)">Nothing booked on this day yet.</div>';
  }

  // Show modal
  let modal = document.getElementById('empDayDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'empDayDetailModal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) closeEmpDayModal(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML =
    '<div class="modal" style="max-width:400px">' +
      '<div class="modal-header">' +
        '<div>' +
          '<div style="font:700 15px/1 var(--font-sans);color:var(--text)">' + dateLabel + '</div>' +
        '</div>' +
        '<button class="modal-close" onclick="closeEmpDayModal()">×</button>' +
      '</div>' +
      '<div style="padding:20px">' + body + actions + '</div>' +
    '</div>';
  modal.style.display = 'flex';
}

function closeEmpDayModal() {
  const m = document.getElementById('empDayDetailModal');
  if (m) m.style.display = 'none';
}

function empCalPrev() { empCalMonth--; if (empCalMonth < 1) { empCalMonth = 12; empCalYear--; } loadEmployeeCalendar(); }
function empCalNext() { empCalMonth++; if (empCalMonth > 12) { empCalMonth = 1; empCalYear++; } loadEmployeeCalendar(); }

function showEmpDeclineReason(reason) {
  const existing = document.getElementById('empDeclineReasonModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'empDeclineReasonModal';
  modal.className = 'modal-overlay';
  modal.innerHTML =
    '<div class="modal" style="max-width:360px">' +
      '<div class="modal-header"><span class="modal-title" style="color:var(--negative)">✕ Request Declined</span>' +
        '<button class="modal-close" onclick="document.getElementById(\'empDeclineReasonModal\').remove()">×</button></div>' +
      '<div style="padding:20px">' +
        '<div style="font:500 11px/1 var(--font-mono);color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Reason</div>' +
        '<div style="font:500 14px/1.5 var(--font-sans);color:var(--text)">' + esc(reason) + '</div>' +
      '</div>' +
      '<div style="padding:0 20px 16px">' +
        '<button class="btn btn-ghost btn-sm" style="width:100%" onclick="document.getElementById(\'empDeclineReasonModal\').remove()">Close</button>' +
      '</div>' +
    '</div>';
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function openEmpDayOffModal() {
  const d = new Date().toISOString().slice(0,10);
  document.getElementById('empDayOffDate').value = d;
  document.getElementById('empDayOffEndDate').value = d;
  document.getElementById('empDayOffReason').value = '';
  document.getElementById('empDayOffRangeNote').classList.add('hidden');
  openModal('empDayOffModal');
}
function openEmpDayOffModalDate(date) {
  document.getElementById('empDayOffDate').value = date;
  document.getElementById('empDayOffEndDate').value = date;
  document.getElementById('empDayOffReason').value = '';
  document.getElementById('empDayOffRangeNote').classList.add('hidden');
  openModal('empDayOffModal');
}
function openEmpDayOffModalRange(startDate, endDate) {
  document.getElementById('empDayOffDate').value = startDate;
  document.getElementById('empDayOffEndDate').value = endDate;
  document.getElementById('empDayOffReason').value = '';
  const days = empDateRange(startDate, endDate).length;
  const note = document.getElementById('empDayOffRangeNote');
  note.textContent = '📅 Requesting ' + days + ' day' + (days !== 1 ? 's' : '') + ': ' + startDate + ' → ' + endDate;
  note.classList.remove('hidden');
  openModal('empDayOffModal');
}
function empDayOffSyncEnd() {
  const start = document.getElementById('empDayOffDate').value;
  const endEl = document.getElementById('empDayOffEndDate');
  if (start && (!endEl.value || endEl.value < start)) endEl.value = start;
}
function empDateRange(start, end) {
  const dates = [];
  let d = new Date(start + 'T12:00:00');
  const last = new Date(end + 'T12:00:00');
  while (d <= last) {
    dates.push(d.toISOString().slice(0,10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

async function submitEmpDayOff() {
  const start = document.getElementById('empDayOffDate').value;
  const end = document.getElementById('empDayOffEndDate').value || start;
  const is_day_off = document.getElementById('empDayOffType').value;
  const reason = (document.getElementById('empDayOffReason').value || '').trim();
  if (!start) return showToast('Please select a date', 'error');
  if (!reason) return showToast('Please add a reason for your request', 'error');
  const dates = empDateRange(start, end > start ? end : start);
  let ok = 0, fail = 0;
  for (const date of dates) {
    const res = await fetch('/api/employee/day-off', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ date, is_day_off, reason }) });
    if (res.ok) ok++; else fail++;
  }
  closeModal('empDayOffModal');
  if (ok > 0) showToast(ok === 1 ? 'Day off submitted!' : ok + ' day-off requests submitted!' + (fail ? ` (${fail} skipped — already booked)` : ''), 'success');
  else showToast('Request failed — those dates may already be booked', 'error');
  loadEmployeeCalendar();
}

// ─── Calendar drag-to-select multiple days ────────────────────────────────
let _empDragAnchor = null, _empDragCurrent = null, _empDragActive = false, _empDragListenersBound = false;

function empDayMouseDown(e, dateStr) {
  if (e.type === 'mousedown' && e.button !== 0) return;
  _empDragAnchor = dateStr; _empDragCurrent = dateStr; _empDragActive = true;
  empUpdateDragHighlight();
  if (!_empDragListenersBound) {
    _empDragListenersBound = true;
    document.addEventListener('mouseup', empDragFinish);
    document.addEventListener('touchend', empDragFinish);
    document.addEventListener('touchmove', e2 => {
      if (!_empDragActive || !e2.touches.length) return;
      const t = e2.touches[0];
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const cell = el && el.closest ? el.closest('.emp-cal-day') : null;
      if (cell && cell.dataset.date) { _empDragCurrent = cell.dataset.date; empUpdateDragHighlight(); }
    }, { passive: true });
  }
}
function empDayMouseEnter(dateStr) {
  if (!_empDragActive) return;
  _empDragCurrent = dateStr;
  empUpdateDragHighlight();
}
function empUpdateDragHighlight() {
  if (!_empDragActive || !_empDragAnchor || !_empDragCurrent) return;
  const a = _empDragAnchor < _empDragCurrent ? _empDragAnchor : _empDragCurrent;
  const b = _empDragAnchor < _empDragCurrent ? _empDragCurrent : _empDragAnchor;
  document.querySelectorAll('.emp-cal-day').forEach(el => {
    const d = el.dataset.date;
    el.classList.toggle('emp-cal-day-dragsel', !!d && d >= a && d <= b);
  });
}
function empDragFinish() {
  if (!_empDragActive) return;
  _empDragActive = false;
  document.querySelectorAll('.emp-cal-day-dragsel').forEach(el => el.classList.remove('emp-cal-day-dragsel'));
  const a = _empDragAnchor, b = _empDragCurrent;
  _empDragAnchor = null; _empDragCurrent = null;
  if (!a) return;
  if (a === b) { empDayClick(a); return; }
  const start = a < b ? a : b, end = a < b ? b : a;
  openEmpDayOffModalRange(start, end);
}

async function cancelEmpDayOff(date) {
  if (!await showConfirm('Cancel your pending day off request for ' + date + '?')) return;
  const res = await fetch('/api/employee/day-off/' + date, { method:'DELETE' });
  if (res.ok) { showToast('Request cancelled', 'success'); loadEmployeeCalendar(); }
  else showToast('Failed to cancel', 'error');
}

function openSetPinModal(empId, empName) {
  // simple prompt approach
  const pin = prompt('Set portal PIN for ' + empName + ' (min 4 characters):');
  if (!pin || pin.length < 4) { showToast('PIN must be at least 4 characters', 'error'); return; }
  fetch('/api/employees/' + empId + '/portal-pin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  }).then(r => r.json()).then(d => {
    if (d.success) showToast('Portal PIN set for ' + empName, 'success');
    else showToast(d.error || 'Failed', 'error');
  });
}

// ─── EVENT KIT ───────────────────────────────────────────────────────────────
// Each event has a team (producer, delegates, sales) and a kit: six marketing
// materials the office uploads and the team approves, plus the agendas the
// producer uploads. The office sees every event; staff see the events they
// are on. One layout serves both, with the office's controls switched on.
const EK_MATERIAL_TYPES = [
  { key: 'brochure',     label: 'Brochure',        accept: '.pdf,.png,.jpg,.jpeg' },
  { key: 'banner',       label: 'Banner',          accept: '.pdf,.png,.jpg,.jpeg' },
  { key: 'roundtable',   label: 'Roundtable card', accept: '.pdf,.png,.jpg,.jpeg' },
  { key: 'presentation', label: 'Presentation',    accept: '.pdf,.pptx,.ppt' },
  { key: 'backdrop',     label: 'Backdrop',        accept: '.pdf,.png,.jpg,.jpeg' },
  { key: 'name_badges',  label: 'Name badges',     accept: '.pdf,.png,.jpg,.jpeg' },
];
const EK_STATUS = {
  missing: { label: 'Not uploaded',         cls: 'missing' },
  pending: { label: 'Waiting for approval', cls: 'pending' },
  approved:{ label: 'Approved',             cls: 'ok' },
  changes: { label: 'Changes requested',    cls: 'changes' },
};
const EK_TEAM_ROLES = [
  { key: 'producer',  label: 'Producer',  dept: /produc/i },
  { key: 'delegates', label: 'Delegates', dept: /delegat/i },
  { key: 'sales',     label: 'Sales',     dept: /sales/i },
];
const EK_MAX_FILE = 10 * 1024 * 1024;
let _ek = { office: false, events: [], staff: [], selected: null, search: '', showPast: false, editing: null };

function ekItemStatus(kit, type) {
  if (!kit || (!kit[`${type}_url`] && !kit[`${type}_file`])) return 'missing';
  return (kit.item_reviews && kit.item_reviews[type] && kit.item_reviews[type].status) || 'pending';
}

function ekProgress(kit) {
  const st = EK_MATERIAL_TYPES.map(m => ekItemStatus(kit, m.key));
  return {
    total: st.length,
    uploaded: st.filter(x => x !== 'missing').length,
    approved: st.filter(x => x === 'approved').length,
    changes: st.filter(x => x === 'changes').length,
    team: !!(kit && kit.producer_id && kit.delegates_id && kit.sales_id),
    agenda: !!(kit && (kit.agenda_file || kit.agenda_file_2)),
  };
}

function ekIsPast(ev) {
  return ev.event_date && ev.date_tbc !== 'date' && String(ev.event_date).slice(0, 10) < today();
}

function ekMeOnTeam(kit) {
  const me = currentUser && currentUser.employee_id;
  return !!me && EK_TEAM_ROLES.some(r => kit && kit[`${r.key}_id`] === me);
}

async function loadEventKitPage() {
  const root = document.getElementById('ekRoot');
  if (!root) return;
  _ek.office = !!currentUser && currentUser.role !== 'employee';
  root.innerHTML = '<div class="ek-loading">Loading…</div>';
  try {
    const kitsRes = await fetch('/api/event-kits');
    const kits = kitsRes.ok ? await kitsRes.json() : [];
    if (_ek.office) {
      const [evRes, staffRes] = await Promise.all([fetch('/api/portfolio-events'), fetch('/api/employees/all')]);
      const evs = evRes.ok ? await evRes.json() : [];
      _ek.staff = staffRes.ok ? (await staffRes.json()).sort((a, b) => a.name.localeCompare(b.name)) : [];
      const byEvent = new Map(kits.map(k => [k.event_id, k]));
      _ek.events = (Array.isArray(evs) ? evs : []).map(e => ({
        event_id: e.id, event_name: e.name, event_date: e.event_date, date_tbc: e.date_tbc,
        programme_year: e.programme_year, location: e.location, producer_team: e.producer,
        kit: byEvent.get(e.id) || null,
      }));
    } else {
      _ek.events = kits.map(k => ({ ...k, kit: k }));
    }
    _ek.events.sort((a, b) => String(a.event_date || '9999').localeCompare(String(b.event_date || '9999')) || a.event_name.localeCompare(b.event_name));
    if (!_ek.selected || !_ek.events.some(e => e.event_id === _ek.selected)) {
      const first = _ek.events.find(e => !ekIsPast(e)) || _ek.events[0];
      _ek.selected = first ? first.event_id : null;
    }
    ekRender();
  } catch {
    root.innerHTML = '<div class="ek-loading">Could not load event kits.</div>';
  }
}
// The staff portal used to call this separately.
const loadEmployeeKitPage = loadEventKitPage;

function ekRender() {
  const root = document.getElementById('ekRoot');
  if (!_ek.events.length) {
    root.innerHTML = `<div class="ek-blank">${_ek.office
      ? 'No events yet. Add events on the Portfolio page and they appear here.'
      : 'You are not on any event team yet. When the office adds you to an event, its kit appears here.'}</div>`;
    return;
  }
  root.innerHTML = `<div class="ek-layout">
    <aside class="ek-side">
      <div class="ek-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" placeholder="Search events" value="${esc(_ek.search)}" oninput="_ek.search=this.value;ekRenderList()">
      </div>
      ${_ek.office ? `<label class="ek-past"><input type="checkbox" ${_ek.showPast ? 'checked' : ''} onchange="_ek.showPast=this.checked;ekRenderList()"> Show past events</label>` : ''}
      <div class="ek-list" id="ekList"></div>
    </aside>
    <section class="ek-main" id="ekMain"></section>
  </div>`;
  ekRenderList();
  ekRenderDetail();
}

function ekRenderList() {
  const el = document.getElementById('ekList');
  if (!el) return;
  const q = _ek.search.trim().toLowerCase();
  const list = _ek.events.filter(e => (!q || e.event_name.toLowerCase().includes(q) || (e.location || '').toLowerCase().includes(q))
    && (_ek.showPast || !_ek.office || !ekIsPast(e) || e.event_id === _ek.selected));
  el.innerHTML = list.map(e => {
    const p = ekProgress(e.kit);
    const pct = Math.round(p.approved / p.total * 100);
    const state = !e.kit ? 'No kit yet' : p.changes ? `${p.changes} change${p.changes === 1 ? '' : 's'} requested` : `${p.approved} of ${p.total} approved`;
    return `<button type="button" class="ek-ev${e.event_id === _ek.selected ? ' active' : ''}${ekIsPast(e) ? ' is-past' : ''}" onclick="ekSelect(${e.event_id})">
      <span class="ek-ev-name">${esc(e.event_name)}</span>
      <span class="ek-ev-meta">${(e.event_date || e.programme_year) ? esc(fmtEventDate(e)) : 'Date TBC'}${e.location ? ' · ' + esc(e.location) : ''}</span>
      <span class="ek-ev-bar"><span style="width:${pct}%"></span></span>
      <span class="ek-ev-state${p.changes ? ' is-changes' : ''}">${state}</span>
    </button>`;
  }).join('') || '<div class="ek-list-empty">No events match.</div>';
}

function ekSelect(eventId) {
  _ek.selected = eventId;
  _ek.editing = null;
  ekRenderList();
  ekRenderDetail();
  if (window.innerWidth < 900) document.getElementById('ekMain')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ekCurrent() { return _ek.events.find(e => e.event_id === _ek.selected) || null; }

function ekReplaceKit(kit) {
  const ev = _ek.events.find(e => e.event_id === kit.event_id);
  if (ev) ev.kit = kit;
  ekRenderList();
  ekRenderDetail();
}

function ekRenderDetail() {
  const main = document.getElementById('ekMain');
  const ev = ekCurrent();
  if (!main || !ev) return;
  const kit = ev.kit;
  const p = ekProgress(kit);
  const onTeam = ekMeOnTeam(kit);
  const step = (n, title, done, sub, warn) => `<li class="ek-step${done ? ' done' : ''}${warn ? ' warn' : ''}">
      <span class="ek-step-n">${done ? '✓' : n}</span><span><strong>${title}</strong><small>${sub}</small></span></li>`;

  main.innerHTML = `
    <header class="ek-hd">
      <div>
        <p class="ek-eyebrow">${(ev.event_date || ev.programme_year) ? esc(fmtEventDate(ev, { long: true })) : 'Date TBC'}${ev.location ? ' · ' + esc(ev.location) : ''}${ev.producer_team ? ' · ' + esc(ev.producer_team) : ''}</p>
        <h2>${esc(ev.event_name)}</h2>
      </div>
      ${_ek.office && kit ? `<button class="btn btn-ghost btn-sm ek-danger" onclick="ekDeleteKit(${ev.event_id})">Delete kit</button>` : ''}
    </header>

    <ol class="ek-steps">
      ${step(1, 'Team', p.team, p.team ? 'Producer, delegates and sales set' : 'Assign the event team')}
      ${step(2, 'Materials', p.uploaded === p.total, `${p.uploaded} of ${p.total} uploaded`)}
      ${step(3, 'Approval', p.approved === p.total, p.changes ? `${p.changes} change${p.changes === 1 ? '' : 's'} requested` : `${p.approved} of ${p.total} approved`, p.changes > 0)}
      ${step(4, 'Agenda', p.agenda, p.agenda ? 'Uploaded' : 'From the producer')}
    </ol>

    <div class="ek-cols">
      <section class="ek-card ek-materials">
        <div class="ek-card-hd"><h3>Materials</h3><span>${_ek.office ? 'Upload a file or add a link; the team approves each one.' : onTeam ? 'Open each item, then approve it or ask for changes.' : 'Shared with you to view.'}</span></div>
        ${EK_MATERIAL_TYPES.map(m => ekItemHtml(ev, m, onTeam)).join('')}
      </section>

      <div class="ek-side-cards">
        <section class="ek-card">
          <div class="ek-card-hd"><h3>Event team</h3></div>
          ${EK_TEAM_ROLES.map(r => ekTeamRowHtml(kit, r)).join('')}
          ${_ek.office ? ekSharedHtml(kit) : ''}
        </section>
        <section class="ek-card">
          <div class="ek-card-hd"><h3>Agendas</h3><span>${_ek.office || onTeam ? 'The producer uploads these.' : ''}</span></div>
          ${[1, 2].map(n => ekAgendaHtml(ev, n, _ek.office || ekStaffMaySee(kit))).join('')}
        </section>
      </div>
    </div>`;
}

function ekStaffMaySee(kit) { return !!kit && !_ek.office; }

function ekItemHtml(ev, m, onTeam) {
  const kit = ev.kit;
  const status = ekItemStatus(kit, m.key);
  const review = kit && kit.item_reviews && kit.item_reviews[m.key];
  const url = kit && kit[`${m.key}_url`];
  const file = kit && kit[`${m.key}_file`];
  const eid = ev.event_id;
  const editing = _ek.editing === `link:${m.key}`;
  const asking = _ek.editing === `changes:${m.key}`;
  const s = EK_STATUS[status];

  const files = [
    url ? `<a class="ek-asset" href="${esc(url)}" target="_blank" rel="noopener">Open link ↗</a>` : '',
    file ? `<a class="ek-asset" href="/api/event-kits/${eid}/file/${m.key}" target="_blank">${esc(file)}</a>` : '',
  ].filter(Boolean).join('');
  const who = review && review.by && (status === 'approved' || status === 'changes')
    ? `<div class="ek-review ${status === 'changes' ? 'is-changes' : ''}">${status === 'changes' ? `<strong>${esc(review.by)}:</strong> ${esc(review.note)}` : `Approved by ${esc(review.by)}`} · ${fmtDateShort(review.at)}</div>` : '';

  let actions = '';
  if (_ek.office) {
    actions = `<label class="btn btn-ghost btn-sm">${file ? 'Replace file' : 'Upload file'}<input type="file" accept="${m.accept}" hidden onchange="ekUploadItem(${eid},'${m.key}',this)"></label>
      <button class="btn btn-ghost btn-sm" onclick="ekStartEdit('link:${m.key}')">${url ? 'Edit link' : 'Add link'}</button>
      ${url || file ? `<button class="btn btn-ghost btn-sm ek-icon" title="Remove" aria-label="Remove ${m.label}" onclick="ekClearItem(${eid},'${m.key}')">✕</button>` : ''}
      ${status === 'pending' ? `<button class="btn btn-ghost btn-sm" title="Approve on the team's behalf" onclick="ekReview(${eid},'${m.key}','approved')">Mark approved</button>` : ''}`;
  } else if (onTeam && status !== 'missing') {
    actions = status === 'approved'
      ? `<button class="btn btn-ghost btn-sm" onclick="ekStartEdit('changes:${m.key}')">Request changes</button>`
      : `<button class="btn btn-primary btn-sm" onclick="ekReview(${eid},'${m.key}','approved')">Approve</button>
         <button class="btn btn-ghost btn-sm" onclick="ekStartEdit('changes:${m.key}')">Request changes</button>`;
  }

  return `<div class="ek-item">
    <div class="ek-item-top">
      <div class="ek-item-name">${m.label}</div>
      <span class="ek-pill ek-pill--${s.cls}">${s.label}</span>
    </div>
    ${files ? `<div class="ek-assets">${files}</div>` : ''}
    ${who}
    ${editing ? `<div class="ek-inline">
        <input type="url" id="ekLinkInput" placeholder="https://www.canva.com/…" value="${esc(url || '')}" onkeydown="if(event.key==='Enter')ekSaveLink(${eid},'${m.key}');if(event.key==='Escape')ekStartEdit(null)">
        <button class="btn btn-primary btn-sm" onclick="ekSaveLink(${eid},'${m.key}')">Save</button>
        <button class="btn btn-ghost btn-sm" onclick="ekStartEdit(null)">Cancel</button>
      </div>` : ''}
    ${asking ? `<div class="ek-inline ek-inline--col">
        <textarea id="ekChangesInput" rows="2" placeholder="What needs changing?"></textarea>
        <div><button class="btn btn-primary btn-sm" onclick="ekSendChanges(${eid},'${m.key}')">Send to the office</button>
        <button class="btn btn-ghost btn-sm" onclick="ekStartEdit(null)">Cancel</button></div>
      </div>` : ''}
    ${actions && !editing && !asking ? `<div class="ek-item-act">${actions}</div>` : ''}
  </div>`;
}

function ekTeamRowHtml(kit, role) {
  const id = kit && kit[`${role.key}_id`];
  const name = kit && kit[`${role.key}_name`];
  if (!_ek.office) {
    return `<div class="ek-team-row"><span>${role.label}</span><strong>${name ? esc(name) : '<em>Not set</em>'}${id && id === (currentUser && currentUser.employee_id) ? ' <small>(you)</small>' : ''}</strong></div>`;
  }
  const inDept = _ek.staff.filter(e => (e.active || e.id === id) && role.dept.test(e.department || ''));
  const rest = _ek.staff.filter(e => (e.active || e.id === id) && !role.dept.test(e.department || ''));
  const opt = e => `<option value="${e.id}"${e.id === id ? ' selected' : ''}>${esc(e.name)}${e.active ? '' : ' (left)'}</option>`;
  return `<div class="ek-team-row ek-team-row--edit">
    <label for="ekTeam_${role.key}">${role.label}</label>
    <div class="ek-team-pick">
      <select id="ekTeam_${role.key}" onchange="ekSaveTeam()">
        <option value="">Not set</option>
        ${inDept.length ? `<optgroup label="${esc([...new Set(inDept.map(e => e.department))].join(' / '))}">${inDept.map(opt).join('')}</optgroup>` : ''}
        ${rest.length ? `<optgroup label="${inDept.length ? 'Everyone else' : 'Staff'}">${rest.map(opt).join('')}</optgroup>` : ''}
      </select>
      ${id ? `<button class="btn btn-ghost btn-sm ek-icon" title="Open ${esc(name || '')}'s profile" onclick="openEmployeeProfile(${id})">↗</button>` : ''}
    </div>
  </div>`;
}

function ekSharedHtml(kit) {
  const emails = (kit && kit.access_emails) || [];
  return `<div class="ek-shared">
    <span class="ek-shared-lbl">Also shared with</span>
    <div class="ek-tags">${emails.map(e => `<span class="ek-tag">${esc(e)}<button type="button" aria-label="Remove ${esc(e)}" onclick="ekRemoveShare(${JSON.stringify(e).replace(/"/g, '&quot;')})">✕</button></span>`).join('') || '<span class="ek-muted">Only the team</span>'}</div>
    <div class="ek-inline"><input type="email" id="ekShareInput" placeholder="name@company.com" onkeydown="if(event.key==='Enter')ekAddShare()">
      <button class="btn btn-ghost btn-sm" onclick="ekAddShare()">Add</button></div>
  </div>`;
}

function ekAgendaHtml(ev, n, canUpload) {
  const kit = ev.kit;
  const file = kit && (n === 1 ? kit.agenda_file : kit.agenda_file_2);
  const by = kit && (n === 1 ? kit.agenda_uploader_name : kit.agenda_uploader_name_2);
  const type = n === 1 ? 'agenda' : 'agenda2';
  return `<div class="ek-agenda">
    <div class="ek-agenda-main">
      <span class="ek-agenda-lbl">Agenda ${n}</span>
      ${file ? `<a class="ek-asset" href="/api/event-kits/${ev.event_id}/file/${type}" target="_blank">${esc(file)}</a>${by ? `<small>by ${esc(by)}</small>` : ''}` : '<span class="ek-muted">Not uploaded</span>'}
    </div>
    ${canUpload ? `<div class="ek-item-act">
      <label class="btn btn-ghost btn-sm">${file ? 'Replace' : 'Upload'}<input type="file" accept=".pdf,.pptx,.ppt,.png,.jpg,.jpeg" hidden onchange="ekUploadAgenda(${ev.event_id},${n},this)"></label>
      ${file ? `<button class="btn btn-ghost btn-sm ek-icon" aria-label="Remove agenda ${n}" onclick="ekClearAgenda(${ev.event_id},${n})">✕</button>` : ''}
    </div>` : ''}
  </div>`;
}

function ekStartEdit(key) {
  _ek.editing = key;
  ekRenderDetail();
  const el = document.getElementById(key && key.startsWith('link') ? 'ekLinkInput' : 'ekChangesInput');
  if (el) el.focus();
}

function ekReadFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files[0];
    if (!file) return reject(new Error('No file'));
    if (file.size > EK_MAX_FILE) { input.value = ''; return reject(new Error('File too large (max 10 MB)')); }
    const r = new FileReader();
    r.onload = e => resolve({ name: file.name, data: String(e.target.result).split(',')[1] });
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

async function ekSend(url, method, body, okMsg) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.error || 'Something went wrong', 'error'); return null; }
  if (okMsg) showToast(okMsg, 'success');
  _ek.editing = null;
  ekReplaceKit(data);
  return data;
}

async function ekUploadItem(eid, type, input) {
  try {
    const f = await ekReadFile(input);
    const kit = ekCurrent()?.kit;
    await ekSend(`/api/event-kits/${eid}/items/${type}`, 'PUT', { url: (kit && kit[`${type}_url`]) || '', file: f.name, data: f.data }, 'Uploaded · sent to the team for approval');
  } catch (e) { showToast(e.message, 'error'); }
}

async function ekSaveLink(eid, type) {
  const url = (document.getElementById('ekLinkInput')?.value || '').trim();
  await ekSend(`/api/event-kits/${eid}/items/${type}`, 'PUT', { url }, url ? 'Link saved · sent to the team for approval' : 'Link removed');
}

async function ekClearItem(eid, type) {
  const m = EK_MATERIAL_TYPES.find(x => x.key === type);
  if (!await showConfirm(`Remove the ${m ? m.label.toLowerCase() : 'item'}? Its link and file are both cleared.`)) return;
  await ekSend(`/api/event-kits/${eid}/items/${type}`, 'PUT', { url: '', clear_file: true }, 'Removed');
}

async function ekReview(eid, type, decision, note) {
  await ekSend(`/api/event-kits/${eid}/items/${type}/review`, 'POST', { decision, note }, decision === 'approved' ? 'Approved' : 'Changes sent to the office');
}

async function ekSendChanges(eid, type) {
  const note = (document.getElementById('ekChangesInput')?.value || '').trim();
  if (!note) { showToast('Say what needs changing', 'error'); return; }
  await ekReview(eid, type, 'changes', note);
}

function ekTeamBody(kit, emails) {
  const body = {};
  EK_TEAM_ROLES.forEach(r => {
    const sel = document.getElementById(`ekTeam_${r.key}`);
    const v = sel ? sel.value : (kit && kit[`${r.key}_id`]);
    if (v) body[`${r.key}_id`] = parseInt(v, 10);
  });
  body.access_emails = emails;
  return body;
}

async function ekSaveTeam() {
  const ev = ekCurrent();
  if (!ev) return;
  await ekSend(`/api/event-kits/${ev.event_id}/team`, 'PATCH', ekTeamBody(ev.kit, (ev.kit && ev.kit.access_emails) || []), 'Team saved');
}

async function ekAddShare() {
  const ev = ekCurrent();
  const input = document.getElementById('ekShareInput');
  const email = (input?.value || '').trim().toLowerCase();
  if (!ev || !email) return;
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) { showToast('Enter a valid email', 'error'); return; }
  const emails = [...new Set([...((ev.kit && ev.kit.access_emails) || []), email])];
  await ekSend(`/api/event-kits/${ev.event_id}/team`, 'PATCH', ekTeamBody(ev.kit, emails), 'Shared');
}

async function ekRemoveShare(email) {
  const ev = ekCurrent();
  if (!ev) return;
  const emails = ((ev.kit && ev.kit.access_emails) || []).filter(e => e !== email);
  await ekSend(`/api/event-kits/${ev.event_id}/team`, 'PATCH', ekTeamBody(ev.kit, emails), null);
}

async function ekUploadAgenda(eid, slot, input) {
  try {
    const f = await ekReadFile(input);
    await ekSend(`/api/event-kits/${eid}/agenda`, 'PATCH', { agenda_file: f.name, agenda_data: f.data, slot },
      _ek.office ? 'Agenda uploaded' : 'Agenda uploaded · the office has been told');
  } catch (e) { showToast(e.message, 'error'); }
}

async function ekClearAgenda(eid, slot) {
  if (!await showConfirm(`Remove agenda ${slot}?`)) return;
  await ekSend(`/api/event-kits/${eid}/agenda`, 'PATCH', { agenda_file: '', agenda_data: '', slot }, 'Agenda removed');
}

async function ekDeleteKit(eid) {
  const ev = ekCurrent();
  if (!await showConfirm(`Delete the kit for "${ev ? ev.event_name : 'this event'}"? Its team, materials, approvals and agendas are removed. This cannot be undone.`)) return;
  const res = await fetch(`/api/event-kits/${eid}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Delete failed', 'error'); return; }
  showToast('Kit deleted', 'success');
  if (ev) ev.kit = null;
  ekRenderList();
  ekRenderDetail();
}

// ── Invoice Generator ──────────────────────────────────────────────────────────
// Add an event card to the invoice generator. Each event carries its own
// package and its own benefit bullet points — mirroring the deal tracker's
// custom package split (e.g. London = Exhibitor, Miami = Delegate Tickets).
function igAddEventRow(name, pkg, amount, benefits) {
  const wrap = document.getElementById('igEventsList');
  if (!wrap) return;
  const card = document.createElement('div');
  card.className = 'ig-event-card';

  // Row 1: full-width event name + remove button
  const row1 = document.createElement('div');
  row1.className = 'ig-event-row';
  const n = document.createElement('input');
  n.type = 'text'; n.className = 'ig-ev-name';
  n.placeholder = 'Event — e.g. 4th Annual CFO Summit';
  n.value = name || '';
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'ig-ev-del'; x.title = 'Remove event';
  x.textContent = '✕';
  x.onclick = () => { card.remove(); igRecalcTotals(true); };
  row1.append(n, x);

  // Row 2: package + per-event amount
  const row2 = document.createElement('div');
  row2.className = 'ig-event-row';
  const p = document.createElement('input');
  p.type = 'text'; p.className = 'ig-ev-pkg';
  p.placeholder = 'Package — e.g. Exhibitor';
  p.value = pkg || '';
  const a = document.createElement('input');
  a.type = 'text'; a.className = 'ig-ev-amt';
  a.placeholder = '£3,750';
  a.value = amount || '';
  a.oninput = () => igRecalcTotals(true);
  row2.append(p, a);

  const b = document.createElement('textarea');
  b.className = 'ig-ev-benefits'; b.rows = 3;
  b.placeholder = 'Package details for this event, one per line — e.g.\nSpeaker on a Panel (subject to availability)\n2 delegate passes';
  b.value = benefits || '';

  card.append(row1, row2, b);
  wrap.appendChild(card);
}

// Fill the generator's invoice number with the next in sequence,
// same as the deal modal's Use Next
async function igUseNextInvoice() {
  try {
    const res = await fetch('/api/deals/last-invoice');
    const d = res.ok ? await res.json() : {};
    if (d.invoice_number && d.next_number) {
      const prefix = d.invoice_number.replace(/\d+$/, '');
      document.getElementById('igInvoiceNum').value = prefix + String(d.next_number).padStart(3, '0');
      return;
    }
  } catch { /* fall through to cached value */ }
  const el = document.getElementById('dealNextInvNum');
  if (el && el.textContent) document.getElementById('igInvoiceNum').value = el.textContent;
  else showToast('No previous invoice number found', 'error');
}

function igParseMoney(v) {
  return parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')) || 0;
}

// Single source of truth for money: per-event amounts sum into Amount (ex VAT),
// and Total Due is always amount + VAT.
function igRecalcTotals(fromEvents) {
  const amts = Array.from(document.querySelectorAll('#igEventsList .ig-ev-amt'))
    .map(i => i.value.trim()).filter(Boolean);
  if (fromEvents && amts.length) {
    const sum = amts.reduce((s, v) => s + igParseMoney(v), 0);
    document.getElementById('igAmountExVat').value = sum ? sum.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '';
  }
  const ex = igParseMoney(document.getElementById('igAmountExVat').value);
  const vat = igParseMoney(document.getElementById('igVatAmount').value);
  document.getElementById('igTotalDue').value = (ex || vat) ? (ex + vat).toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '';
}

function igCollectEventObjs() {
  return Array.from(document.querySelectorAll('#igEventsList .ig-event-card')).map(c => ({
    name: c.querySelector('.ig-ev-name').value.trim(),
    pkg: c.querySelector('.ig-ev-pkg').value.trim(),
    amount: c.querySelector('.ig-ev-amt').value.trim(),
    benefits: c.querySelector('.ig-ev-benefits').value.split('\n').map(s => s.trim()).filter(Boolean)
  })).filter(e => e.name);
}

function openInvoiceGenModal(dealId) {
  const deal = dealsData.find(d => d.id === dealId);
  if (!deal) return;
  const sym = { GBP:'£', USD:'$', AED:'AED ', PHP:'₱', EUR:'€' }[deal.currency] || '£';
  const amtEx = deal.amount || '';
  const vatAmt = deal.tax_vat ? String(parseFloat(deal.tax_vat).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })) : '';
  const totalDue = (deal.amount && deal.tax_vat)
    ? (parseFloat(deal.amount) + parseFloat(deal.tax_vat)).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '';

  document.getElementById('igDealId').value = dealId;
  document.getElementById('igContact').value = '';
  document.getElementById('igCompany').value = deal.company || deal.title || '';
  document.getElementById('igAddress').value = '';
  document.getElementById('igEmail').value = '';
  document.getElementById('igInvoiceNum').value = deal.invoice_number || '';
  document.getElementById('igDate').value = new Date().toLocaleDateString('en-GB');
  // Pre-fill events from the deal's linked events, carrying over any
  // custom package allocation (label + per-event amount)
  document.getElementById('igEventsList').innerHTML = '';
  const linked = Array.isArray(deal.events) ? deal.events.filter(e => e.event_name) : [];
  if (linked.length) {
    linked.forEach(e => {
      const alloc = parseFloat(e.allocated_amount) || 0;
      igAddEventRow(e.event_name, e.package_label || '', alloc > 0 ? sym + fmt(alloc) : '', '');
    });
  } else {
    igAddEventRow();
  }
  document.getElementById('igAmountExVat').value = amtEx ? Number(amtEx).toLocaleString('en-GB') : '';
  document.getElementById('igVatAmount').value = vatAmt;
  document.getElementById('igTotalDue').value = totalDue;
  document.getElementById('igClientName').value = deal.company || deal.title || '';
  document.getElementById('igAdditionalNotes').value = '';
  igRecalcTotals(false);
  document.getElementById('invoiceGenModal').classList.add('open');
}

function closeInvoiceGenModal() {
  document.getElementById('invoiceGenModal').classList.remove('open');
}

function igCollectPayload() {
  const evs = igCollectEventObjs();

  // Events list on page 2: event names only — the price belongs on the
  // Total Cost line, not beside each event
  const eventLines = evs.map(e => e.name);

  // Benefits: a block per event — "Event — Package" header followed by its bullets
  const benefits = [];
  evs.filter(e => e.pkg || e.benefits.length).forEach(e => {
    if (benefits.length) benefits.push('');
    benefits.push(e.pkg ? `${e.name} — ${e.pkg}` : e.name);
    benefits.push(...e.benefits);
  });

  return {
    contact_name:   document.getElementById('igContact').value.trim(),
    company_name:   document.getElementById('igCompany').value.trim(),
    address:        document.getElementById('igAddress').value.trim(),
    email:          document.getElementById('igEmail').value.trim(),
    invoice_number: document.getElementById('igInvoiceNum').value.trim(),
    date:           document.getElementById('igDate').value.trim(),
    event_name:     eventLines.join('\n'),
    package_name:   '',
    amount_ex_vat:  document.getElementById('igAmountExVat').value.trim(),
    vat_amount:     document.getElementById('igVatAmount').value.trim(),
    total_due:      document.getElementById('igTotalDue').value.trim(),
    client_name:    document.getElementById('igClientName').value.trim(),
    benefits,
    additional_notes: document.getElementById('igAdditionalNotes').value.trim(),
  };
}

// On-screen replica of invoice_template.docx populated with the exact values
// that will be sent to it, so details can be checked before generating.
function previewInvoice() {
  const p = igCollectPayload();
  const benefits = p.benefits.map(b =>
    b === '' ? '<div class="ig-benefit-gap"></div>' : `<div class="ig-benefit">${esc(b)}</div>`
  ).join('');
  const amt = esc(p.amount_ex_vat || '—');

  const page1 = `<div class="ig-page">
    <div class="ig-band"><img src="/invoice_logo.png" alt="LPGP Connect"></div>
    <div class="ig-inv-title">INVOICE</div>
    <div class="ig-addr-row">
      <div class="ig-addr">
        <div class="ig-addr-co">LPGPCONNECT.COM LTD</div>
        <div>1 Oakcroft Road</div><div>Trident Court</div><div>Studio 111</div><div>KT9 1BD</div>
      </div>
      <div class="ig-date"><strong>Date:</strong> ${esc(p.date || '—')}</div>
    </div>
    <div class="ig-client">
      <div class="ig-client-hd">CLIENT</div>
      <div>Contact: ${esc(p.contact_name || '—')}</div>
      <div>Company: ${esc(p.company_name || '—')}</div>
      <div>Address: ${esc(p.address || '—')}</div>
      <div>Email: ${esc(p.email || '—')}</div>
      <div>Invoice Number: ${esc(p.invoice_number || '—')}</div>
    </div>
    <table class="ig-items">
      <thead><tr><th>Description</th><th>Unit price</th><th>Total</th></tr></thead>
      <tbody>
        <tr>
          <td><strong>Please refer to your sponsorship &amp; benefits in Page 2</strong></td>
          <td>£ ${amt}</td><td>£ ${amt}</td>
        </tr>
        <tr class="ig-sumrow"><td></td><td>SUBTOTAL</td><td>£ ${amt}</td></tr>
        <tr class="ig-sumrow"><td></td><td>VAT 20%</td><td>£ ${esc(p.vat_amount || '—')}</td></tr>
        <tr class="ig-sumrow ig-due"><td></td><td>TOTAL DUE</td><td>£ ${esc(p.total_due || '—')}</td></tr>
      </tbody>
    </table>
    <div class="ig-contact-line">If you have any questions concerning this invoice, contact accounts@lpgpconnect.com</div>
    <div class="ig-bank">
      <div>LPGPCONNECT.COM LTD</div>
      <div>Account number: 42247054</div>
      <div>Sort code: 40-26-12</div>
      <div>Swift/BIC: HBUKGB4B</div>
      <div>IBAN: GB32 HBUK40261242247054</div>
      <div>Payment Reference: ${esc(p.company_name || 'Company Name')}</div>
      <div>VAT Number: 371409111</div>
    </div>
    <div class="ig-terms-note">
      <div>Payment is due within 7 days from invoice date</div>
      <div class="ig-terms-sub">Immediate payment is due if booking has been made 30 days prior to the start of the conference date.</div>
    </div>
  </div>`;

  const page2 = `<div class="ig-page">
    <div class="ig-band"><img src="/invoice_logo.png" alt="LPGP Connect"></div>
    <div class="ig-agree-title">LPGP Connect Agreement 2026</div>
    <div class="ig-sec-hd">Sponsorship &amp; Benefits</div>
    <div class="ig-events-lbl">Events:</div>
    <div class="ig-event-name">${p.event_name ? p.event_name.split('\n').map(l => `<div>${esc(l)}</div>`).join('') : '—'}</div>
    ${benefits || '<div class="ig-benefit" style="color:#999">No package details listed</div>'}
    <div class="ig-total-cost">Total Cost - £${amt} plus VAT</div>
    ${p.additional_notes
      ? `<div class="ig-sec-hd" style="margin-top:22px">Additional Comments:</div>
         <div class="ig-comments">${esc(p.additional_notes)}</div>`
      : ''}
  </div>`;

  const page3 = `<div class="ig-page">
    <div class="ig-agree-title" style="margin-top:6px">LPGP Connect Limited Terms &amp; Conditions</div>
    <div class="ig-tc">
      <div class="ig-tc-hd">Scope of Agreement</div>
      <p>These are the conditions of the contract between you, the Sponsoring Client and LPGP Connect Limited. The above package includes the benefits to each event you are solicitated to (listed above). This agreement constitutes the entire agreement between LPGP Connect Limited and you.</p>
      <div class="ig-tc-hd">Cancellations</div>
      <p>Subject to the terms hereof, in the event of your cancellation 100% of the Total Fee is payable and non-refundable unless otherwise agreed to by LPGP Connect Limited. All cancellation requests must be submitted to us in writing…</p>
      <div class="ig-tc-hd">Force Majeure</div>
      <p>In the event that a party is prevented, hindered or delayed in or from performing any of its obligations under this agreement for any reason beyond its reasonable control… <em>(full text appears in the generated document)</em></p>
    </div>
    <div class="ig-sig">
      <div class="ig-sig-name">${esc(p.client_name || '—')}</div>
      <div class="ig-sig-line">Name</div>
      <div class="ig-sig-line" style="margin-top:26px">Signature</div>
    </div>
  </div>`;

  document.getElementById('igPreviewSheet').innerHTML =
    `<div class="ig-pageno">Page 1 — Invoice</div>${page1}` +
    `<div class="ig-pageno">Page 2 — Sponsorship &amp; Benefits</div>${page2}` +
    `<div class="ig-pageno">Page 3 — Terms &amp; Signature</div>${page3}`;
  openModal('invoicePreviewModal');
}

async function generateInvoice() {
  const btn = document.getElementById('igGenerateBtn');
  btn.disabled = true; btn.textContent = 'Generating…';

  const payload = igCollectPayload();

  try {
    const res = await fetch('/api/generate-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) { showToast('Generation failed', 'error'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LPGPCONNECTCOMLTD${payload.invoice_number || 'DRAFT'}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Invoice downloaded', 'success');
    closeInvoiceGenModal();
  } catch { showToast('Generation failed', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Generate & Download'; }
}

// ══════════════════════════════════════════
//  WASTEMAN — AI assistant (admin only)
// ══════════════════════════════════════════
window._wmHistory = window._wmHistory || [];   // [{role, content}]
window._wmSpeak = false;                        // read answers aloud
window._wmBusy = false;
let _wmRecognition = null;
let _wmListening = false;

function wmToggle() {
  const panel = document.getElementById('wmPanel');
  const launcher = document.getElementById('wmLauncher');
  if (!panel) return;
  const open = panel.classList.toggle('wm-open');
  if (launcher) launcher.classList.toggle('wm-hidden', open);
  if (open) setTimeout(() => document.getElementById('wmInput')?.focus(), 80);
}

function wmClear() {
  window._wmHistory = [];
  const body = document.getElementById('wmBody');
  if (body) body.querySelectorAll('.wm-msg').forEach(m => m.remove());
  const empty = document.getElementById('wmEmpty');
  if (empty) empty.style.display = '';
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function wmToggleSpeak() {
  window._wmSpeak = !window._wmSpeak;
  const btn = document.getElementById('wmSpeakToggle');
  if (btn) { btn.textContent = window._wmSpeak ? '🔊' : '🔇'; btn.classList.toggle('wm-on', window._wmSpeak); }
  if (!window._wmSpeak && window.speechSynthesis) window.speechSynthesis.cancel();
}

function wmAppend(role, text) {
  const body = document.getElementById('wmBody');
  const empty = document.getElementById('wmEmpty');
  if (empty) empty.style.display = 'none';
  const el = document.createElement('div');
  el.className = `wm-msg wm-msg--${role}`;
  el.textContent = text;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function wmAsk(text) {
  const input = document.getElementById('wmInput');
  if (input) input.value = text;
  wmSend();
}

async function wmSend() {
  const input = document.getElementById('wmInput');
  if (!input || window._wmBusy) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  wmAppend('user', q);

  window._wmBusy = true;
  const sendBtn = document.getElementById('wmSend');
  if (sendBtn) sendBtn.disabled = true;
  const thinking = wmAppend('bot', '…');
  thinking.classList.add('wm-thinking');

  // Abort if the server doesn't respond within 90 seconds
  const ctrl = new AbortController();
  const tmOut = setTimeout(() => ctrl.abort(), 90000);

  // Only add to history now — after we know we're actually sending
  window._wmHistory.push({ role: 'user', content: q });

  try {
    const res = await fetch('/api/wasteman', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: window._wmHistory }),
      signal: ctrl.signal
    });
    clearTimeout(tmOut);
    const data = await res.json();
    thinking.remove();
    if (!res.ok) {
      window._wmHistory.pop(); // remove the failed user message so history stays clean
      wmAppend('bot', data.error || 'Something went wrong.');
    } else {
      wmAppend('bot', data.reply);
      window._wmHistory.push({ role: 'assistant', content: data.reply });
      if (window._wmSpeak) wmSpeak(data.reply);
    }
  } catch (e) {
    clearTimeout(tmOut);
    thinking.remove();
    window._wmHistory.pop(); // remove failed user message
    wmAppend('bot', e.name === 'AbortError'
      ? 'Wasteman took too long to respond — try again or ask a simpler question.'
      : 'Could not reach Wasteman. Check your connection.');
  } finally {
    window._wmBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    document.getElementById('wmInput')?.focus();
  }
}

function wmSpeak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.pitch = 1;
  window.speechSynthesis.speak(u);
}

async function wmToggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('wmMic');
  // Firefox and others simply don't implement the API
  if (!SR) {
    showToast('Voice input isn\'t supported in this browser. Use Chrome, Edge or Safari, or type your question.', 'error', 6000);
    return;
  }

  // Brave exposes SpeechRecognition but disables Google's speech service for
  // privacy, so it never returns a transcript. Detect it and tell the user.
  try {
    if (navigator.brave && await navigator.brave.isBrave()) {
      showToast('Brave blocks voice recognition for privacy, so it can\'t convert speech here. Type your question, or use Chrome/Edge/Safari for voice.', 'error', 7000);
      return;
    }
  } catch { /* isBrave() unavailable — carry on */ }

  if (_wmListening && _wmRecognition) { _wmRecognition.stop(); return; }

  _wmRecognition = new SR();
  _wmRecognition.lang = 'en-GB';
  _wmRecognition.interimResults = true;
  _wmRecognition.continuous = false;

  let _sentThisTurn = false;
  let _lastTranscript = '';

  function _doSend() {
    if (_sentThisTurn) return;
    _sentThisTurn = true;
    const input = document.getElementById('wmInput');
    if (input && _lastTranscript) input.value = _lastTranscript;
    setTimeout(() => wmSend(), 80);
  }

  _wmRecognition.onstart = () => { _wmListening = true; _sentThisTurn = false; _lastTranscript = ''; micBtn?.classList.add('wm-mic--live'); };

  _wmRecognition.onresult = (ev) => {
    _lastTranscript = Array.from(ev.results).map(r => r[0].transcript).join('');
    const input = document.getElementById('wmInput');
    if (input) input.value = _lastTranscript;
    // Send as soon as we get a final result; onend will catch it if isFinal never fires
    if (ev.results[ev.results.length - 1].isFinal) _doSend();
  };

  _wmRecognition.onend = () => {
    _wmListening = false;
    micBtn?.classList.remove('wm-mic--live');
    // Chrome desktop can fire onend before onresult delivers the final transcript.
    // _lastTranscript holds whatever was captured regardless of ordering.
    if (_lastTranscript.trim()) {
      _doSend();
    } else if (!_sentThisTurn) {
      showToast('Didn\'t catch that — try speaking again', 'info');
    }
  };

  _wmRecognition.onerror = (ev) => {
    _wmListening = false;
    micBtn?.classList.remove('wm-mic--live');
    const reasons = {
      'not-allowed':         'Microphone blocked — click the padlock in the address bar and allow microphone access, then reload.',
      'service-not-allowed': 'Microphone blocked — allow mic access for this site in browser settings.',
      'audio-capture':       'No microphone found. Check your mic is connected and enabled.',
      'no-speech':           'No speech detected — try again and speak clearly.',
      'network':             'This browser couldn\'t reach a speech service (Brave and some browsers block it). Type your question, or use Chrome/Edge/Safari for voice.',
      'aborted':             null
    };
    const msg = reasons[ev?.error] ?? `Voice input error: ${ev?.error || 'unknown'}`;
    if (msg) showToast(msg, 'error');
  };
  try {
    _wmRecognition.start();
  } catch (e) {
    // start() throws if called while already running, or on insecure (non-HTTPS) origins
    _wmListening = false;
    micBtn?.classList.remove('wm-mic--live');
    showToast(location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'Couldn\'t start the microphone — try again.'
      : 'Voice input needs a secure (HTTPS) connection.', 'error');
  }
}
