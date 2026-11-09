const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ---------- Configuration ----------
const CONFIG = {
  port: process.env.PORT || 3000,
  matchThreshold: Number(process.env.MATCH_THRESHOLD || 0.5), // lower = stricter
  cooldownMs: 2 * 60 * 1000,      // ignore repeat punches from same person within 2 min
  shiftStart: process.env.SHIFT_START || '09:30',
  targetHours: Number(process.env.TARGET_HOURS || 8),
  timeZone: process.env.TIMEZONE || 'Asia/Karachi',
  jwtSecret: process.env.JWT_SECRET || 'attendance_ultra_secure_jwt_secret_key_2026',
  defaultAdminUser: process.env.ADMIN_USER || 'admin',
  defaultAdminPass: process.env.ADMIN_PASS || 'admin123',
};

// ---------- MongoDB Connection ----------
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://abdulrafaykhan1017_db_user:ZkOQdlV4uSY4DFKD@cluster0.efoo79r.mongodb.net/attendance_db?retryWrites=true&w=majority';
const DB_NAME = process.env.DB_NAME || 'attendance_db';

let cachedClient = null;
let indexesCreated = false;

// Password Encryption (PBKDF2 with Salt)
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// Token Generation & Verification (HMAC-SHA256)
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', CONFIG.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', CONFIG.jwtSecret).update(`${header}.${body}`).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

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
        await db.collection('admins').createIndex({ username: 1 });

        // Ensure default admin exists
        const adminCount = await db.collection('admins').countDocuments();
        if (adminCount === 0) {
          const { salt, hash } = hashPassword(CONFIG.defaultAdminPass);
          await db.collection('admins').insertOne({
            username: CONFIG.defaultAdminUser,
            salt,
            hash,
            createdAt: Date.now(),
          });
          console.log(`Default admin user '${CONFIG.defaultAdminUser}' initialized.`);
        }
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

// ---------- Auth Middleware ----------
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7)
    : req.headers['x-admin-token'];

  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Unauthorized: Admin login required' });
  }
  req.admin = payload;
  next();
}

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

function getMinutesOfDay(ms, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || CONFIG.timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(new Date(ms));
    const h = Number(parts.find(p => p.type === 'hour').value);
    const m = Number(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
  } catch (e) {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  }
}

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Auth Routes ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const db = await getDb();
    const admin = await db.collection('admins').findOne({
      username: String(username).trim().toLowerCase()
    });
    if (!admin || !verifyPassword(password, admin.salt, admin.hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = generateToken({ username: admin.username, role: 'admin' });
    res.json({ ok: true, token, username: admin.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Login failed') });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7) : req.headers['x-admin-token'];
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }
  res.json({ ok: true, username: payload.username });
});

app.post('/api/auth/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters long' });
    }
    const db = await getDb();
    const admin = await db.collection('admins').findOne({ username: req.admin.username });
    if (!admin || !verifyPassword(currentPassword, admin.salt, admin.hash)) {
      return res.status(401).json({ error: 'Incorrect current password' });
    }
    const { salt, hash } = hashPassword(newPassword);
    await db.collection('admins').updateOne(
      { username: req.admin.username },
      { $set: { salt, hash, updatedAt: Date.now() } }
    );
    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// ---------- Config endpoint (used by dashboard & kiosk) ----------
app.get('/api/config', (req, res) => {
  res.json({
    shiftStart: CONFIG.shiftStart,
    targetHours: CONFIG.targetHours,
    timeZone: CONFIG.timeZone
  });
});

// ---------- Employees (Protected by requireAdmin) ----------
app.get('/api/employees', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const employees = await db.collection('employees').find({}).toArray();
    res.json(employees.map(e => ({
      id: e.id || e._id.toString(),
      name: e.name,
      code: e.code,
      shiftStart: e.shiftStart || CONFIG.shiftStart || '09:30',
      shiftEnd: e.shiftEnd || '18:00',
      lateGraceMinutes: e.lateGraceMinutes !== undefined ? Number(e.lateGraceMinutes) : 15,
      absentGraceHours: e.absentGraceHours !== undefined ? Number(e.absentGraceHours) : 2,
      enrolledAt: e.enrolledAt,
      faces: (e.descriptors || []).length
    })));
  } catch (err) {
    console.error('Error fetching employees from MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to load employees') });
  }
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      code,
      descriptors,
      shiftStart = '09:30',
      shiftEnd = '18:00',
      lateGraceMinutes = 15,
      absentGraceHours = 2
    } = req.body || {};

    if (!name || !code || !Array.isArray(descriptors) || descriptors.length === 0)
      return res.status(400).json({ error: 'Name, code and face data are required' });
    if (!descriptors.every(isValidDescriptor))
      return res.status(400).json({ error: 'Invalid face data' });

    const db = await getDb();
    const cleanCode = String(code).trim();

    // 1. Check if employee code already exists
    const existing = await db.collection('employees').findOne({
      code: { $regex: new RegExp(`^${escapeRegex(cleanCode)}$`, 'i') }
    });
    if (existing)
      return res.status(409).json({ error: `Employee code '${cleanCode}' is already assigned to ${existing.name}` });

    // 2. Check if this FACE is already registered under ANY employee!
    const allEmployees = await db.collection('employees').find({}).toArray();
    let matchedEmp = null;
    let closestDist = Infinity;

    for (const emp of allEmployees) {
      for (const existingD of (emp.descriptors || [])) {
        for (const newD of descriptors) {
          const d = distance(newD, existingD);
          if (d < closestDist) closestDist = d;
          if (d < CONFIG.matchThreshold) {
            matchedEmp = emp;
            break;
          }
        }
        if (matchedEmp) break;
      }
      if (matchedEmp) break;
    }

    if (matchedEmp) {
      return res.status(409).json({
        error: `Face already registered! You are already added as "${matchedEmp.name}" (Code: ${matchedEmp.code}).`
      });
    }

    const emp = {
      id: Date.now().toString(),
      name: String(name).trim(),
      code: cleanCode,
      shiftStart: String(shiftStart || '09:30').trim(),
      shiftEnd: String(shiftEnd || '18:00').trim(),
      lateGraceMinutes: Math.max(0, Number(lateGraceMinutes) || 15),
      absentGraceHours: Math.max(0.5, Number(absentGraceHours) || 2),
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

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
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

// ---------- Attendance (Public Kiosk Route) ----------
// Rule: Exactly 2 punches per employee per day (1 Check-In + 1 Check-Out)
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
      return res.status(404).json({ error: 'Face not recognized. Please face the camera clearly.' });

    const now = Date.now();
    const day = (req.body && req.body.date) || todayStr(now);

    const todays = await db.collection('attendance')
      .find({ employeeId: best.id, date: day })
      .sort({ time: 1 })
      .toArray();

    const inPunch = todays.find(p => p.type === 'IN');
    const outPunch = todays.find(p => p.type === 'OUT');

    // RULE 1: Daily limit - only 2 punches per day (1 Check-In + 1 Check-Out)
    if (inPunch && outPunch) {
      return res.json({
        ok: false,
        completed: true,
        name: best.name,
        code: best.code,
        timeStr: timeStr(now),
        inTime: timeStr(inPunch.time),
        outTime: timeStr(outPunch.time),
        message: `Today's attendance completed! Checked IN at ${timeStr(inPunch.time)} and OUT at ${timeStr(outPunch.time)}. No more punches allowed today.`
      });
    }

    // Cooldown check for repeat rapid scans
    const last = todays[todays.length - 1];
    if (last && now - last.time < CONFIG.cooldownMs) {
      return res.json({
        ok: true,
        duplicate: true,
        name: best.name,
        code: best.code,
        type: last.type,
        timeStr: timeStr(last.time),
        arrivalStatus: last.arrivalStatus || 'ON_TIME',
        statusNote: last.statusNote || '',
        message: `Already recorded ${last.type} at ${timeStr(last.time)}. Please wait before scanning again.`
      });
    }

    // Determine punch type:
    // If no punch today -> 'IN'
    // If IN already recorded -> 'OUT'
    const type = !inPunch ? 'IN' : 'OUT';

    // Compute arrival status & late/absent rule for IN punch based on employee's custom settings
    let arrivalStatus = 'ON_TIME';
    let statusNote = 'On Time';

    if (type === 'IN') {
      const shiftStr = best.shiftStart || CONFIG.shiftStart || '09:30';
      const [shH, shM] = shiftStr.split(':').map(Number);
      const shiftStartMin = (shH * 60) + (shM || 0);
      const punchMin = getMinutesOfDay(now, CONFIG.timeZone);

      const lateGrace = best.lateGraceMinutes !== undefined ? Number(best.lateGraceMinutes) : 15;
      const absentGraceHrs = best.absentGraceHours !== undefined ? Number(best.absentGraceHours) : 2;

      const lateLimitMin = shiftStartMin + lateGrace;
      const absentLimitMin = shiftStartMin + (absentGraceHrs * 60);

      if (punchMin <= lateLimitMin) {
        arrivalStatus = 'ON_TIME';
        statusNote = 'On Time';
      } else if (punchMin <= absentLimitMin) {
        const lateBy = punchMin - shiftStartMin;
        arrivalStatus = 'LATE';
        statusNote = `Late by ${lateBy} mins`;
      } else {
        const lateByHrs = ((punchMin - shiftStartMin) / 60).toFixed(1);
        arrivalStatus = 'ABSENT';
        statusNote = `Absent (Arrived ${lateByHrs}h late)`;
      }
    } else {
      // OUT punch: calculate total duration worked
      const diffMs = now - inPunch.time;
      const hours = (diffMs / (1000 * 60 * 60)).toFixed(1);
      const mins = Math.round(diffMs / (1000 * 60));
      arrivalStatus = inPunch.arrivalStatus || 'ON_TIME';
      statusNote = `Completed day (${hours} hrs worked)`;
    }

    const record = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      employeeId: best.id,
      name: best.name,
      code: best.code,
      type,
      date: day,
      time: now,
      arrivalStatus,
      statusNote,
      shiftStart: best.shiftStart || '09:30',
      lateGraceMinutes: best.lateGraceMinutes ?? 15,
      absentGraceHours: best.absentGraceHours ?? 2,
    };

    await db.collection('attendance').insertOne(record);

    res.json({
      ok: true,
      duplicate: false,
      completed: type === 'OUT',
      name: best.name,
      code: best.code,
      type,
      timeStr: timeStr(now),
      arrivalStatus,
      statusNote,
      remainingPunches: type === 'IN' ? 1 : 0
    });
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
      arrivalStatus: r.arrivalStatus || 'ON_TIME',
      statusNote: r.statusNote || ''
    })));
  } catch (err) {
    console.error('Error fetching attendance from MongoDB:', err);
    res.status(500).json({ error: 'Database error: ' + (err.message || 'Failed to load attendance records') });
  }
});

if (!process.env.VERCEL) {
  app.listen(CONFIG.port, () => {
    console.log(`Attendance server running at http://localhost:${CONFIG.port}`);
    console.log(`  Kiosk (Public): http://localhost:${CONFIG.port}/`);
    console.log(`  Admin Login:    http://localhost:${CONFIG.port}/login.html`);
    console.log(`  Employees:      http://localhost:${CONFIG.port}/admin.html`);
    console.log(`  Dashboard:      http://localhost:${CONFIG.port}/dashboard.html`);
  });
}

module.exports = app;
