const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

// ---------- Configuration ----------
const CONFIG = {
  port: process.env.PORT || 3000,
  matchThreshold: Number(process.env.MATCH_THRESHOLD || 0.5), // lower = stricter
  cooldownMs: 2 * 60 * 1000,      // ignore repeat punches from same person within 2 min
  shiftStart: process.env.SHIFT_START || '09:30',
  targetHours: Number(process.env.TARGET_HOURS || 8),
  timeZone: process.env.TIMEZONE || 'Asia/Karachi',
};

// ---------- MongoDB Connection ----------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://abdulrafaykhan1017_db_user:ZkOQdlV4uSY4DFKD@cluster0.efoo79r.mongodb.net/attendance_db?retryWrites=true&w=majority';
const DB_NAME = process.env.DB_NAME || 'attendance_db';

let cachedClient = null;
let indexesCreated = false;

async function getDb() {
  try {
    if (!cachedClient) {
      cachedClient = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
      });
      await cachedClient.connect();
    }
    const db = cachedClient.db(DB_NAME);

    if (!indexesCreated) {
      try {
        await db.collection('employees').createIndex({ code: 1 });
        await db.collection('attendance').createIndex({ date: 1, employeeId: 1 });
        indexesCreated = true;
      } catch (e) {
        // index warning ignored
      }
    }

    return db;
  } catch (err) {
    cachedClient = null;
    throw err;
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}
const isValidDescriptor = d => Array.isArray(d) && d.length === 128 && d.every(Number.isFinite);
const todayStr = (ms = Date.now()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timeZone }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toLocaleDateString('en-CA');
  }
};
const timeStr = ms => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.timeZone,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
};
const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Config endpoint (used by dashboard) ----------
app.get('/api/config', (req, res) => {
  res.json({ shiftStart: CONFIG.shiftStart, targetHours: CONFIG.targetHours });
});

// ---------- Employees ----------
app.get('/api/employees', async (req, res) => {
  try {
    const db = await getDb();
    const employees = await db.collection('employees').find({}).toArray();
    res.json(employees.map(e => ({
      id: e.id || e._id.toString(),
      name: e.name,
      code: e.code,
      enrolledAt: e.enrolledAt,
      faces: (e.descriptors || []).length
    })));
  } catch (err) {
    console.error('Error fetching employees from MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to load employees') });
  }
});

app.post('/api/employees', async (req, res) => {
  try {
    const { name, code, descriptors } = req.body || {};
    if (!name || !code || !Array.isArray(descriptors) || descriptors.length === 0)
      return res.status(400).json({ error: 'Name, code and face data are required' });
    if (!descriptors.every(isValidDescriptor))
      return res.status(400).json({ error: 'Invalid face data' });

    const db = await getDb();
    const cleanCode = String(code).trim();
    const existing = await db.collection('employees').findOne({
      code: { $regex: new RegExp(`^${escapeRegex(cleanCode)}$`, 'i') }
    });
    if (existing)
      return res.status(409).json({ error: 'Employee code already exists' });

    const emp = {
      id: Date.now().toString(),
      name: String(name).trim(),
      code: cleanCode,
      descriptors,
      enrolledAt: Date.now(),
    };
    await db.collection('employees').insertOne(emp);
    res.status(201).json({ ok: true, id: emp.id });
  } catch (err) {
    console.error('Error adding employee to MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to save employee') });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const result = await db.collection('employees').deleteOne({
      $or: [{ id: id }]
    });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Employee not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting employee from MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to delete employee') });
  }
});

// ---------- Attendance ----------
app.post('/api/mark', async (req, res) => {
  try {
    const { descriptor } = req.body || {};
    if (!isValidDescriptor(descriptor)) return res.status(400).json({ error: 'Invalid face data' });

    const db = await getDb();
    const employees = await db.collection('employees').find({}).toArray();

    let best = null, bestDist = Infinity;
    for (const emp of employees) {
      for (const d of (emp.descriptors || [])) {
        const dist = distance(descriptor, d);
        if (dist < bestDist) { bestDist = dist; best = emp; }
      }
    }

    if (!best || bestDist > CONFIG.matchThreshold)
      return res.status(404).json({ error: 'Face not recognized' });

    const now = Date.now();
    const day = (req.body && req.body.date) || todayStr(now);

    const todays = await db.collection('attendance')
      .find({ employeeId: best.id, date: day })
      .sort({ time: 1 })
      .toArray();

    const last = todays[todays.length - 1];

    if (last && now - last.time < CONFIG.cooldownMs)
      return res.json({ ok: true, duplicate: true, name: best.name, code: best.code, type: last.type, timeStr: timeStr(last.time) });

    const type = !last || last.type === 'OUT' ? 'IN' : 'OUT';
    const record = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      employeeId: best.id,
      name: best.name,
      code: best.code,
      type,
      date: day,
      time: now,
    };
    await db.collection('attendance').insertOne(record);
    res.json({ ok: true, duplicate: false, name: best.name, code: best.code, type, timeStr: timeStr(now) });
  } catch (err) {
    console.error('Error marking attendance in MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to record attendance') });
  }
});

app.get('/api/attendance', async (req, res) => {
  try {
    const db = await getDb();
    const date = req.query.date || todayStr();
    const records = await db.collection('attendance')
      .find({ date })
      .sort({ time: 1 })
      .toArray();
    res.json(records.map(r => ({
      id: r.id || r._id.toString(),
      employeeId: r.employeeId,
      name: r.name,
      code: r.code,
      type: r.type,
      date: r.date,
      time: r.time,
    })));
  } catch (err) {
    console.error('Error fetching attendance from MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to load attendance records') });
  }
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
