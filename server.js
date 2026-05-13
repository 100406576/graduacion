const express = require('express');
const path = require('path');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { leer, guardar, DB_PATH } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'graduacion2025';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || uuidv4(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireLogin(req, res, next) {
  if (req.session.admin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
  res.redirect('/login');
}

// ── Login ────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Admin ────────────────────────────────────────────────
app.get('/admin', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/alumnos', requireLogin, (req, res) => {
  const db = leer();
  const resultado = db.alumnos
    .sort((a, b) => a.apellidos.localeCompare(b.apellidos) || a.nombre.localeCompare(b.nombre))
    .map(a => {
      const entradas = db.entradas.filter(e => e.alumno_id === a.id);
      return {
        id: a.id,
        nombre: a.nombre,
        apellidos: a.apellidos,
        token: a.token,
        total_entradas: entradas.length,
        descargadas: entradas.filter(e => e.descargada).length,
        usadas: entradas.filter(e => e.usada).length
      };
    });
  res.json(resultado);
});

app.post('/api/alumnos', requireLogin, (req, res) => {
  const { nombre, apellidos, num_entradas } = req.body;
  if (!nombre || !apellidos || !num_entradas || num_entradas < 1) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const db = leer();
  const token = uuidv4();
  const alumnoId = uuidv4();

  db.alumnos.push({
    id: alumnoId,
    nombre: nombre.trim(),
    apellidos: apellidos.trim(),
    token,
    creado_en: new Date().toISOString()
  });

  for (let i = 1; i <= num_entradas; i++) {
    db.entradas.push({
      id: uuidv4(),
      alumno_id: alumnoId,
      codigo_qr: uuidv4(),
      numero: i,
      descargada: false,
      usada: false,
      usada_en: null,
      creado_en: new Date().toISOString()
    });
  }

  guardar(db);
  res.json({ id: alumnoId, token });
});

app.delete('/api/alumnos/:id', requireLogin, (req, res) => {
  const { id } = req.params;
  const db = leer();

  const tieneUsadas = db.entradas.some(e => e.alumno_id === id && e.usada);
  if (tieneUsadas) {
    return res.status(400).json({ error: 'No se puede eliminar: hay entradas ya usadas' });
  }

  db.entradas = db.entradas.filter(e => e.alumno_id !== id);
  db.alumnos = db.alumnos.filter(a => a.id !== id);
  guardar(db);
  res.json({ ok: true });
});

// ── Familia ──────────────────────────────────────────────
app.get('/entrada/:token', (req, res) => {
  const db = leer();
  const alumno = db.alumnos.find(a => a.token === req.params.token);
  if (!alumno) return res.status(404).send('Enlace no válido');

  db.entradas.forEach(e => {
    if (e.alumno_id === alumno.id) e.descargada = true;
  });
  guardar(db);
  res.sendFile(path.join(__dirname, 'public', 'entrada.html'));
});

app.get('/api/entrada/:token', async (req, res) => {
  const db = leer();
  const alumno = db.alumnos.find(a => a.token === req.params.token);
  if (!alumno) return res.status(404).json({ error: 'No encontrado' });

  const entradas = db.entradas
    .filter(e => e.alumno_id === alumno.id)
    .sort((a, b) => a.numero - b.numero);

  const entradasConQR = await Promise.all(entradas.map(async (e) => {
    const qr = await QRCode.toDataURL(e.codigo_qr, { width: 300, margin: 2 });
    return { id: e.id, numero: e.numero, usada: e.usada, qr };
  }));

  res.json({
    nombre: alumno.nombre,
    apellidos: alumno.apellidos,
    total: entradas.length,
    entradas: entradasConQR
  });
});

// ── Validación ───────────────────────────────────────────
app.get('/validar', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'validar.html'));
});

app.post('/api/validar', (req, res) => {
  const { codigo_qr } = req.body;
  if (!codigo_qr) return res.json({ ok: false, motivo: 'no_existe' });

  const db = leer();
  const entrada = db.entradas.find(e => e.codigo_qr === codigo_qr);
  if (!entrada) return res.json({ ok: false, motivo: 'no_existe' });

  const alumno = db.alumnos.find(a => a.id === entrada.alumno_id);
  const totalAlumno = db.entradas.filter(e => e.alumno_id === entrada.alumno_id).length;

  if (entrada.usada) {
    return res.json({
      ok: false,
      motivo: 'ya_usada',
      usada_en: entrada.usada_en,
      alumno: `${alumno.nombre} ${alumno.apellidos}`
    });
  }

  entrada.usada = true;
  entrada.usada_en = new Date().toLocaleString('es-ES');
  guardar(db);

  res.json({
    ok: true,
    alumno: `${alumno.nombre} ${alumno.apellidos}`,
    numero: entrada.numero,
    total: totalAlumno
  });
});

// ── Backup ───────────────────────────────────────────────
app.get('/api/backup', requireLogin, (req, res) => {
  res.download(DB_PATH, 'graduacion_backup.json');
});

app.listen(PORT, () => {
  console.log(`Servidor arrancado en http://localhost:${PORT}`);
  console.log(`Panel admin:   http://localhost:${PORT}/admin`);
  console.log(`Validación:    http://localhost:${PORT}/validar`);
});
