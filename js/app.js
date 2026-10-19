/* uventoy - vanilla JS UI for the Ventoy2Disk.sh backend */
'use strict';
const $ = id => document.getElementById(id);

const T = {
  ready: 'Ready', ok: 'OK', no: 'Cancel', warn: 'Warning', info: 'Info', err: 'Error',
  empty: 'No removable devices found — plug in a USB drive, then hit refresh.',
  updTip: d => `Safe upgrade of ${d}, ISO files unchanged.\nContinue?`,
  insTip: d => `${d} will be formatted, ALL data lost!\nContinue?`,
  insTip2: d => `Double check: ALL data on ${d} will be lost!\nReally continue?`,
  ndTip: d => `Ventoy will try a non-destructive install on ${d}.\nExisting data may be kept.\nContinue?`,
  insOk: 'Congratulations! Ventoy installed successfully.',
  updOk: 'Congratulations! Ventoy updated successfully.',
  insFail: 'Install failed. Replug the USB and check the log.',
  updFail: 'Update failed. Replug the USB and check the log.',
  badSpace: 'Invalid value for reserved space (MiB)',
  badLabel: 'Invalid label. Use 1-11 letters, numbers, spaces, dot, dash or underscore.',
  already: 'This device already contains Ventoy. Use Update to keep your files, or choose Force install to erase it.',
  ndAlready: 'This device already contains Ventoy; non-destructive install is not needed. Use Update instead.',
  busy: 'A task is running, please wait…',
  noRoot: 'Warning: the server is not running as root — install/update will fail.',
};

let devices = [], sel = -1, busy = false, partStyle = 0, pollTimer = null;

async function api(url, body) {
  const opt = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const r = await fetch(url, opt);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok || !j || j.ok === false) {
    throw new Error((j && (j.error || j.msg)) || ('HTTP ' + r.status));
  }
  return j;
}

function toast(msg, isErr) {
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

function confirmDlg(title, msg) {
  return new Promise(res => {
    const dlg = $('dlg');
    $('dlgTitle').textContent = title;
    $('dlgMsg').textContent = msg;
    $('dlgOk').textContent = T.ok;
    $('dlgNo').textContent = T.no;
    $('dlgNo').style.display = '';
    if (!dlg.open) dlg.showModal();
    $('dlgOk').onclick = () => { dlg.close(); res(true); };
    $('dlgNo').onclick = () => { dlg.close(); res(false); };
    dlg.oncancel = () => { dlg.close(); res(false); };
  });
}

function alertDlg(title, msg) {
  const dlg = $('dlg');
  $('dlgTitle').textContent = title;
  $('dlgMsg').textContent = msg;
  $('dlgOk').textContent = T.ok;
  $('dlgNo').style.display = 'none';
  if (!dlg.open) dlg.showModal();
  $('dlgOk').onclick = () => dlg.close();
  dlg.oncancel = () => dlg.close();
}

function setBar(p, stage) {
  const n = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
  $('bar').style.width = n + '%';
  $('pctTxt').textContent = n + '%';
  $('statusTxt').textContent = stage || (n === 0 ? T.ready : `Working… ${n}%`);
}

function fullDesc(d) {
  const t = d.transport ? ' • ' + d.transport.toUpperCase() : '';
  return `${d.path} [${d.size}] ${d.model || ''}${t}`;
}

function lockBtns(b) {
  busy = b;
  $('devList').disabled = b;
  $('refreshBtn').disabled = b;
  renderSel();
}

function fillDevs(prevPath) {
  const s = $('devList');
  s.innerHTML = '';
  if (!devices.length) {
    const o = document.createElement('option');
    o.textContent = T.empty;
    o.disabled = true;
    s.appendChild(o);
  }
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = fullDesc(d);
    o.title = o.textContent;
    s.appendChild(o);
  });
  sel = -1;
  if (prevPath) sel = devices.findIndex(d => d.path === prevPath);
  if (sel < 0) sel = devices.length ? 0 : -1;
  renderSel();
}

function renderSel() {
  const d = curDev();
  if (sel >= 0) $('devList').value = String(sel);

  $('selInfo').textContent = d ? fullDesc(d) : (devices.length ? '' : T.empty);
  $('installBtn').disabled = !d || busy;
  $('updateBtn').disabled = !d || busy || !(d.ventoy && d.ventoy.valid);

  if (!d) {
    $('devVer').textContent = '—';
    $('devPart').textContent = '—';
    $('devLock').hidden = true;
    return;
  }
  if (d.ventoy && d.ventoy.valid) {
    $('devVer').textContent = d.ventoy.version || '—';
    $('devPart').textContent = d.ventoy.partstyle ? 'GPT' : 'MBR';
    $('devLock').hidden = !d.ventoy.secure_boot;
  } else {
    $('devVer').textContent = '—';
    $('devPart').textContent = '—';
    $('devLock').hidden = true;
  }
}

function curDev() {
  return (sel >= 0 && sel < devices.length) ? devices[sel] : null;
}

function setSecure(v) {
  $('secureBoot').checked = !!v;
  $('localLock').hidden = !v;
}

function setPart(v) {
  partStyle = v ? 1 : 0;
  $('mbrBtn').classList.toggle('on', !partStyle);
  $('gptBtn').classList.toggle('on', !!partStyle);
  $('localPart').textContent = partStyle ? 'GPT' : 'MBR';
}

async function loadDevices() {
  const prevPath = devices[sel] ? devices[sel].path : null;
  const j = await api('/api/devices');
  devices = Array.isArray(j.devices) ? j.devices : [];
  fillDevs(prevPath);
}

async function refresh() {
  if (busy) return;
  $('refreshBtn').classList.add('loading');
  $('refreshBtn').disabled = true;
  try {
    await loadDevices();
  } catch (e) {
    toast(e.message, 1);
  } finally {
    $('refreshBtn').classList.remove('loading');
    $('refreshBtn').disabled = busy;
  }
}

function reserveMiB() {
  if (!$('preserveCk').checked) return 0;
  const v = ($('preserveVal').value || '').trim();
  if (!/^\d{1,7}$/.test(v) || +v <= 0) {
    alertDlg(T.err, T.badSpace);
    throw 0;
  }
  return +v;
}

function labelValue() {
  const v = ($('labelVal').value || '').trim() || 'Ventoy';
  if (v.length > 11 || !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(v)) {
    alertDlg(T.err, T.badLabel);
    throw 0;
  }
  return v;
}

function applyJob(j) {
  if (!j || j.none) return;
  setBar(j.percent, j.stage);
  if (Array.isArray(j.lines)) {
    const pre = $('logTxt');
    const nearBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = j.lines.join('\n');
    if (nearBottom) pre.scrollTop = pre.scrollHeight;
  }
}

function schedulePoll(j) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (j && j.running) pollTimer = setTimeout(pollJob, 600);
}

async function pollJob() {
  try {
    const j = await api('/api/job');
    applyJob(j);
    if (j.running) { schedulePoll(j); return; }

    lockBtns(false);
    let refreshError = null;
    try { await loadDevices(); } catch (e) { refreshError = e; }

    if (j.success === true) {
      setBar(100, 'Done');
      alertDlg(T.info, j.type === 'update' ? T.updOk : T.insOk);
    } else if (j.success === false) {
      alertDlg(T.err, (j.error || '').trim() || (j.type === 'update' ? T.updFail : T.insFail));
    }
    if (refreshError) toast(refreshError.message, 1);
  } catch (e) {
    lockBtns(false);
    toast(e.message, 1);
  }
}

function beginPoll(j) {
  applyJob(j);
  if (j && j.running) schedulePoll(j);
}

async function doInstall() {
  const d = curDev();
  if (!d || busy) return;

  let reserve, label;
  try { reserve = reserveMiB(); label = labelValue(); } catch { return; }

  const mode = $('installMode').value;
  if (mode === 'install' && d.ventoy && d.ventoy.valid) {
    alertDlg(T.err, T.already);
    return;
  }
  if (mode === 'nondestructive' && d.ventoy && d.ventoy.valid) {
    alertDlg(T.err, T.ndAlready);
    return;
  }
  if (mode === 'nondestructive') {
    if (!await confirmDlg(T.warn, T.ndTip(fullDesc(d)))) return;
  } else {
    if (!await confirmDlg(T.warn, T.insTip(fullDesc(d)))) return;
    if (!await confirmDlg(T.warn, T.insTip2(fullDesc(d)))) return;
  }

  let j;
  try {
    j = await api('/api/install', {
      disk: d.path,
      mode,
      secure_boot: $('secureBoot').checked,
      gpt: partStyle === 1,
      reserve_mb: reserve,
      label,
    });
  } catch (e) {
    alertDlg(T.err, e.message);
    return;
  }
  lockBtns(true);
  beginPoll(j.job);
}

async function doUpdate() {
  const d = curDev();
  if (!d || busy) return;
  if (!d.ventoy || !d.ventoy.valid) return;
  if (!await confirmDlg(T.info, T.updTip(fullDesc(d)))) return;

  let j;
  try {
    j = await api('/api/update', {
      disk: d.path,
      secure_boot: $('secureBoot').checked,
    });
  } catch (e) {
    alertDlg(T.err, e.message);
    return;
  }
  lockBtns(true);
  beginPoll(j.job);
}

/* events */
$('devList').onchange = e => { sel = +e.target.value; renderSel(); };
$('refreshBtn').onclick = refresh;
$('mbrBtn').onclick = () => setPart(0);
$('gptBtn').onclick = () => setPart(1);
$('secureBoot').onchange = e => setSecure(e.target.checked);
$('preserveCk').onchange = e => { $('preserveVal').disabled = !e.target.checked; };
$('installMode').onchange = () => {
  const nd = $('installMode').value === 'nondestructive';
  $('preserveCk').disabled = nd;
  if (nd) { $('preserveCk').checked = false; $('preserveVal').disabled = true; }
  else { $('preserveVal').disabled = !$('preserveCk').checked; }
};
$('installBtn').onclick = doInstall;
$('updateBtn').onclick = doUpdate;

function syncThemeIcon() {
  const light = document.documentElement.dataset.th === 'light';
  $('icoSun').style.display = light ? 'none' : '';
  $('icoMoon').style.display = light ? '' : 'none';
}
$('themeBtn').onclick = () => {
  const h = document.documentElement;
  h.dataset.th = h.dataset.th === 'light' ? '' : 'light';
  syncThemeIcon();
};
if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.th = 'light';
syncThemeIcon();

/* boot */
(async () => {
  setPart(0);
  setSecure(true);
  try {
    const s = await api('/api/sysinfo');
    $('localVer').textContent = s.version || '…';
    $('pkgLine').textContent = 'Ventoy ' + (s.version || '');
    if (s.root === false) toast(T.noRoot, 1);
    await loadDevices();

    const j = await api('/api/job');
    if (j && !j.none) {
      applyJob(j);
      if (j.running) {
        lockBtns(true);
        schedulePoll(j);
      }
    }
  } catch (e) {
    $('selInfo').textContent = T.err + ': cannot reach the uventoy server (' + e.message + ')';
    $('selInfo').classList.add('sys');
    toast(T.err + ': cannot reach the uventoy server', 1);
  }
})();
