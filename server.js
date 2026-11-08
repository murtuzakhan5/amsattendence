const express = require('express');
const fs = require('fs');
const path = require('path');

const os = require('os');

// ---------- Configuration ----------
const CONFIG = {
  port: process.env.PORT || 3000,
  matchThreshold: Number(process.env.MATCH_THRESHOLD || 0.5), // lower = stricter
  cooldownMs: 2 * 60 * 1000,      // ignore repeat punches from same person within 2 min
  shiftStart: process.env.SHIFT_START || '09:30',
  targetHours: Number(process.env.TARGET_HOURS || 8),
};

const isVercel = Boolean(process.env.VERCEL);
const DB_FILE = isVercel
  ? path.join(os.tmpdir(), 'attendance-data.json')
  : path.join(__dirname, 'data.json');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Storage (atomic JSON file) ----------
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir(DB_FILE);
  if (!fs.existsSync(DB_FILE)) {
    const seed = path.join(__dirname, 'data.json');
    if (isVercel && fs.existsSync(seed)) {
      try {
        fs.copyFileSync(seed, DB_FILE);
      } catch (e) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ employees: [], attendance: [] }, null, 2));
      }
    } else {
      fs.writeFileSync(DB_FILE, JSON.stringify({ employees: [], attendance: [] }, null, 2));
    }
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { employees: [], attendance: [] };
  }
}
function save(db) {
  ensureDir(DB_FILE);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Helpers ----------
function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
const isValidDescriptor = d => Array.isArray(d) && d.length === 128 && d.every(Number.isFinite);
const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (server local time)
const timeStr = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- Config endpoint (used by dashboard) ----------
app.get('/api/config', (req, res) => {
  res.json({ shiftStart: CONFIG.shiftStart, targetHours: CONFIG.targetHours });
});

// ---------- Employees ----------
app.get('/api/employees', (req, res) => {
  const db = load();
  res.json(db.employees.map(e => ({ id: e.id, name: e.name, code: e.code, enrolledAt: e.enrolledAt, faces: e.descriptors.length })));
});

app.post('/api/employees', (req, res) => {
  const { name, code, descriptors } = req.body || {};
  if (!name || !code || !Array.isArray(descriptors) || descriptors.length === 0)
    return res.status(400).json({ error: 'Name, code and face data are required' });
  if (!descriptors.every(isValidDescriptor))
    return res.status(400).json({ error: 'Invalid face data' });

  const db = load();
  if (db.employees.some(e => e.code.toLowerCase() === String(code).toLowerCase()))
    return res.status(409).json({ error: 'Employee code already exists' });

  const emp = {
    id: Date.now().toString(),
    name: String(name).trim(),
    code: String(code).trim(),
    descriptors,
    enrolledAt: Date.now(),
  };
  db.employees.push(emp);
  save(db);
  res.status(201).json({ ok: true, id: emp.id });
});

app.delete('/api/employees/:id', (req, res) => {
  const db = load();
  const before = db.employees.length;
  db.employees = db.employees.filter(e => e.id !== req.params.id);
  if (db.employees.length === before) return res.status(404).json({ error: 'Employee not found' });
  save(db);
  res.json({ ok: true });
});

// ---------- Attendance ----------
app.post('/api/mark', (req, res) => {
  const { descriptor } = req.body || {};
  if (!isValidDescriptor(descriptor)) return res.status(400).json({ error: 'Invalid face data' });

  const db = load();
  let best = null, bestDist = Infinity;
  for (const emp of db.employees) {
    for (const d of emp.descriptors) {
      const dist = distance(descriptor, d);
      if (dist < bestDist) { bestDist = dist; best = emp; }
    }
  }

  if (!best || bestDist > CONFIG.matchThreshold)
    return res.status(404).json({ error: 'Face not recognized' });

  const now = Date.now();
  const day = todayStr();
  const todays = db.attendance.filter(a => a.employeeId === best.id && a.date === day);
  const last = todays[todays.length - 1];

  if (last && now - last.time < CONFIG.cooldownMs)
    return res.json({ ok: true, duplicate: true, name: best.name, code: best.code, type: last.type, timeStr: timeStr(last.time) });

  const type = !last || last.type === 'OUT' ? 'IN' : 'OUT';
  const record = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 6),
    employeeId: best.id, name: best.name, code: best.code,
    type, date: day, time: now,
  };
  db.attendance.push(record);
  save(db);
  res.json({ ok: true, duplicate: false, name: best.name, code: best.code, type, timeStr: timeStr(now) });
});

app.get('/api/attendance', (req, res) => {
  const db = load();
  const date = req.query.date || todayStr();
  res.json(db.attendance.filter(a => a.date === date));
});

if (!process.env.VERCEL) {
  app.listen(CONFIG.port, () => {
    console.log(`Attendance server running at http://localhost:${CONFIG.port}`);
    console.log(`  Kiosk:     http://localhost:${CONFIG.port}/`);
    console.log(`  Admin:     http://localhost:${CONFIG.port}/admin.html`);
    console.log(`  Dashboard: http://localhost:${CONFIG.port}/dashboard.html`);
  });
}

module.exports = app;
