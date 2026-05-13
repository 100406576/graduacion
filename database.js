const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'graduacion.json');

function leer() {
  if (!fs.existsSync(DB_PATH)) {
    const vacio = { alumnos: [] };
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(vacio, null, 2));
    return vacio;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function guardar(datos) {
  fs.writeFileSync(DB_PATH, JSON.stringify(datos, null, 2));
}

module.exports = { leer, guardar, DB_PATH };
