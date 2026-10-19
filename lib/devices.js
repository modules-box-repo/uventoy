/* uventoy device scan — lsblk based, zero dependencies.
 *
 * Lists whole removable disks only:
 *   lsblk -J -b -o NAME,SIZE,MODEL,RM,TYPE,TRAN,VENDOR
 *
 * A device is kept when its type is "disk" and its RM (removable) flag is set.
 * This covers USB flash drives, USB card readers, and external SD cards.
 */
'use strict';
const { execFile } = require('child_process');

const LSBLK = () => process.env.LSBLK || 'lsblk';
const FIELDS = 'NAME,SIZE,MODEL,RM,TYPE,TRAN,VENDOR';
const FIELDS_MIN = 'NAME,SIZE,MODEL,RM,TYPE';

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && String(stderr).trim()) || err.message;
        reject(new Error(msg));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

function asBool(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

function str(v) {
  return String(v == null ? '' : v).trim();
}

function kindOf(d) {
  const tran = str(d.tran).toLowerCase();
  if (tran === 'usb') return 'usb';
  if (tran === 'mmc' || /^mmcblk/.test(str(d.name))) return 'sd';
  return 'removable';
}

async function lsblkJson(fields) {
  const out = await execFileAsync(LSBLK(), ['-J', '-b', '-o', fields]);
  let data;
  try {
    data = JSON.parse(out);
  } catch (e) {
    throw new Error('lsblk returned invalid JSON');
  }
  return Array.isArray(data.blockdevices) ? data.blockdevices : [];
}

async function listLocalDevices() {
  let rows;
  try {
    rows = await lsblkJson(FIELDS);
  } catch (e) {
    // Older lsblk builds may not know TRAN/VENDOR; retry with the core fields.
    try {
      rows = await lsblkJson(FIELDS_MIN);
    } catch {
      throw e;
    }
  }

  const seen = new Set();
  const list = [];
  for (const d of rows) {
    if (str(d.type).toLowerCase() !== 'disk') continue;
    if (!asBool(d.rm)) continue;
    const name = str(d.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({
      name,
      path: '/dev/' + name,
      size: fmtSize(d.size),
      bytes: Number(d.size) || 0,
      model: str(d.model) || str(d.vendor) || 'Removable device',
      transport: str(d.tran).toLowerCase(),
      kind: kindOf(d),
      removable: true,
      source: 'lsblk',
    });
  }
  return list;
}

module.exports = { listLocalDevices, fmtSize };
