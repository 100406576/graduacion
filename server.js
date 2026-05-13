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
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
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
    .map(a => ({
      id: a.id,
      nombre: a.nombre,
      apellidos: a.apellidos,
      token: a.token,
      num_entradas: a.num_entradas,
      num_caterings: a.num_caterings,
      descargada: a.descargada,
      usada: a.usada
    }));
  res.json(resultado);
});

app.post('/api/alumnos', requireLogin, (req, res) => {
  const { nombre, apellidos, num_entradas, num_caterings } = req.body;
  if (!nombre || !apellidos || !num_entradas || num_entradas < 1) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  if (num_caterings > num_entradas) {
    return res.status(400).json({ error: 'El número de caterings no puede superar al de entradas' });
  }

  const db = leer();
  const alumnoId = uuidv4();

  db.alumnos.push({
    id: alumnoId,
    nombre: nombre.trim(),
    apellidos: apellidos.trim(),
    token: uuidv4(),
    codigo_qr: uuidv4(),
    num_entradas: parseInt(num_entradas),
    num_caterings: parseInt(num_caterings) || 0,
    descargada: false,
    usada: false,
    usada_en: null,
    creado_en: new Date().toISOString()
  });

  guardar(db);
  res.json({ id: alumnoId });
});

app.delete('/api/alumnos/:id', requireLogin, (req, res) => {
  const { id } = req.params;
  const db = leer();

  const alumno = db.alumnos.find(a => a.id === id);
  if (!alumno) return res.status(404).json({ error: 'No encontrado' });

  if (alumno.usada) {
    return res.status(400).json({ error: 'No se puede eliminar: la entrada ya fue usada' });
  }

  db.alumnos = db.alumnos.filter(a => a.id !== id);
  guardar(db);
  res.json({ ok: true });
});

// ── Familia ──────────────────────────────────────────────
app.get('/entrada/:token', (req, res) => {
  const db = leer();
  const alumno = db.alumnos.find(a => a.token === req.params.token);
  if (!alumno) return res.status(404).send('Enlace no válido');

  alumno.descargada = true;
  guardar(db);
  res.sendFile(path.join(__dirname, 'public', 'entrada.html'));
});

app.get('/api/entrada/:token', async (req, res) => {
  const db = leer();
  const alumno = db.alumnos.find(a => a.token === req.params.token);
  if (!alumno) return res.status(404).json({ error: 'No encontrado' });

  const qr = await QRCode.toDataURL(alumno.codigo_qr, { width: 300, margin: 2 });
  res.json({
    nombre: alumno.nombre,
    apellidos: alumno.apellidos,
    num_entradas: alumno.num_entradas,
    num_caterings: alumno.num_caterings,
    usada: alumno.usada,
    qr
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
  const alumno = db.alumnos.find(a => a.codigo_qr === codigo_qr);
  if (!alumno) return res.json({ ok: false, motivo: 'no_existe' });

  if (alumno.usada) {
    return res.json({
      ok: false,
      motivo: 'ya_usada',
      usada_en: alumno.usada_en,
      alumno: `${alumno.nombre} ${alumno.apellidos}`
    });
  }

  alumno.usada = true;
  alumno.usada_en = new Date().toLocaleString('es-ES');
  guardar(db);

  res.json({
    ok: true,
    alumno: `${alumno.nombre} ${alumno.apellidos}`,
    num_entradas: alumno.num_entradas,
    num_caterings: alumno.num_caterings
  });
});

// ── Backup / Importar ────────────────────────────────────
app.get('/api/backup', requireLogin, (req, res) => {
  res.download(DB_PATH, 'graduacion_backup.json');
});

app.post('/api/importar', requireLogin, (req, res) => {
  const datos = req.body;
  if (!Array.isArray(datos.alumnos)) {
    return res.status(400).json({ error: 'Fichero no válido' });
  }
  guardar({ alumnos: datos.alumnos });
  res.json({ ok: true, alumnos: datos.alumnos.length });
});

app.listen(PORT, () => {
  console.log(`Servidor arrancado en http://localhost:${PORT}`);
  console.log(`Panel admin:   http://localhost:${PORT}/admin`);
  console.log(`Validación:    http://localhost:${PORT}/validar`);
});
