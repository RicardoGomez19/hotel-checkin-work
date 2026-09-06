// ============================================================
// SERVIDOR DE CHECK-IN DIGITAL PARA HOTEL
// ------------------------------------------------------------
// 1. Configura carpetas donde se guardan los datos.
// 2. Funciones para leer/guardar la "base de datos" (archivo JSON).
// 3. Generación del PDF (incluye firma + foto de identificación).
// 4. Rutas (endpoints).
// 5. Enciende el servidor.
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const PDFDocument = require('pdfkit');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// --------------------------------------------------------------
// 1. CARPETAS DE DATOS
// --------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SIGNATURES_DIR = path.join(DATA_DIR, 'signatures');
const ID_PHOTOS_DIR = path.join(DATA_DIR, 'id-photos');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const CERTS_DIR = path.join(DATA_DIR, 'certs');

[DATA_DIR, SIGNATURES_DIR, ID_PHOTOS_DIR, PDFS_DIR, CERTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --------------------------------------------------------------
// 1.1 CERTIFICADO HTTPS LOCAL (autogenerado, sin depender de openssl
//     instalado en la máquina ni de pagar/tramitar un certificado real)
// --------------------------------------------------------------
// Los celulares necesitan que el sitio se sirva por HTTPS para que la app
// funcione sin conexión (los "service workers" de las PWA solo se activan
// en HTTPS o en localhost — nunca en una IP de red local por HTTP normal).
// Como este servidor vive en la red del hotel y no en internet, no hay
// forma de conseguir un certificado "real" firmado por una autoridad
// pública — así que se genera uno "autofirmado" la primera vez que arranca
// el servidor, válido para todas las IPs locales de esta máquina. Los
// celulares van a mostrar una advertencia de "conexión no segura" la
// primera vez que entren — hay que aceptarla una sola vez por dispositivo
// (ver instrucciones en la consola al arrancar).
function obtenerIPsLocales() {
  const ips = ['127.0.0.1', 'localhost'];
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).forEach((lista) => {
    (lista || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) ips.push(info.address);
    });
  });
  return [...new Set(ips)];
}

const CERT_PATH = path.join(CERTS_DIR, 'cert.pem');
const KEY_PATH = path.join(CERTS_DIR, 'key.pem');
const CERT_IPS_PATH = path.join(CERTS_DIR, 'ips.json');

function certificadoDesactualizado(ipsActuales) {
  if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_IPS_PATH)) return true;
  try {
    const guardadas = JSON.parse(fs.readFileSync(CERT_IPS_PATH, 'utf8'));
    // Si apareció una IP nueva (p. ej. la máquina cambió de red o el router
    // le asignó otra dirección) el certificado viejo ya no la cubre, así
    // que hay que regenerarlo para que también funcione ahí.
    return ipsActuales.some((ip) => !guardadas.includes(ip));
  } catch {
    return true;
  }
}

function prepararCertificadoHttps() {
  const ips = obtenerIPsLocales();
  if (certificadoDesactualizado(ips)) {
    const nombrePrincipal = ips.find((ip) => ip !== 'localhost' && ip !== '127.0.0.1') || 'localhost';
    const altNames = ips.map((ip) => (
      /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? { type: 7, ip } : { type: 2, value: ip }
    ));
    const pems = selfsigned.generate([{ name: 'commonName', value: nombrePrincipal }], {
      days: 3650,
      keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.writeFileSync(CERT_PATH, pems.cert);
    fs.writeFileSync(KEY_PATH, pems.private);
    fs.writeFileSync(CERT_IPS_PATH, JSON.stringify(ips));
    console.log(`🔐 Certificado HTTPS generado para: ${ips.join(', ')}`);
  }
  return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
}

// --------------------------------------------------------------
// 2. BASE DE DATOS (SQLite — un solo archivo real de base de datos)
// --------------------------------------------------------------
// Las imágenes (firma, foto de identificación) y los PDFs siguen viviendo
// como archivos normales en disco (es más eficiente que meter imágenes
// dentro de la base de datos) — lo que guarda la base de datos es toda
// la información del huésped MÁS la ruta a esos archivos, para poder
// encontrarlos y relacionarlos.
const db = new Database(path.join(DATA_DIR, 'hotel.db'));
db.pragma('journal_mode = WAL'); // mejor rendimiento con escrituras frecuentes

db.exec(`
  CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    folio TEXT NOT NULL,
    fullName TEXT NOT NULL,
    country TEXT NOT NULL,
    idNumber TEXT NOT NULL,
    phone TEXT NOT NULL,
    room TEXT NOT NULL,
    fecha TEXT NOT NULL,
    signatureFile TEXT,
    idPhotoFile TEXT,
    pdfFile TEXT,
    ip TEXT,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migración: agrega columnas nuevas si el proyecto ya existía antes de esta
// versión. "phone" se queda en la tabla por compatibilidad (ya no se pide
// en el formulario, así que a partir de ahora siempre se guarda vacío).
const columnasCheckins = db.prepare("PRAGMA table_info(checkins)").all().map((c) => c.name);
const columnasNuevas = {
  customAnswers: 'TEXT',
  email: 'TEXT',
  nights: 'INTEGER',
  price: 'REAL',
  paymentType: 'TEXT',
  guests: 'INTEGER',
  paymentStatus: 'TEXT',
  amountPaid: 'REAL',
  platform: 'TEXT',
  updatedAt: 'TEXT',
  checkInDate: 'TEXT',
  checkOutDate: 'TEXT',
  clientId: 'TEXT',
  queuedAt: 'TEXT',
  // Pago con dos formas distintas (ej. mitad efectivo, mitad tarjeta): si el
  // huésped pagó todo con un solo método, estas tres columnas se quedan
  // vacías y "paymentType" + "price" funcionan exactamente igual que
  // siempre. Solo se usan cuando de verdad se dividió el pago.
  paymentType2: 'TEXT',
  splitAmount1: 'REAL',
  splitAmount2: 'REAL',
};
Object.entries(columnasNuevas).forEach(([col, tipo]) => {
  if (!columnasCheckins.includes(col)) {
    db.exec(`ALTER TABLE checkins ADD COLUMN ${col} ${tipo}`);
  }
});

// "clientId" es un identificador que genera el propio celular al guardar un
// registro sin conexión (para poder mandarlo después). Este índice evita
// que, si el celular reintenta el mismo envío dos veces (por ejemplo por un
// corte de red a la mitad de la respuesta), se creen dos check-ins
// duplicados — ver el manejo de idempotencia en POST /api/checkins.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_clientid ON checkins(clientId) WHERE clientId IS NOT NULL');

// NOTA sobre zona horaria: "createdAt" se guarda explícitamente con
// datetime('now','localtime') en vez de dejar el DEFAULT de la columna
// (que es CURRENT_TIMESTAMP, en UTC). Antes, un check-in hecho por la
// noche en horario de México quedaba fechado "al día siguiente" en la
// base de datos — por eso el filtro de fechas del panel de registros
// parecía no funcionar (un registro de "hoy" no aparecía al filtrar "hoy").
// Todas las comparaciones de fecha del servidor usan ahora la misma hora
// local de forma consistente (igual que "updatedAt" y el historial de ediciones).
const insertCheckin = db.prepare(`
  INSERT INTO checkins (id, folio, fullName, country, idNumber, phone, room, fecha, signatureFile, idPhotoFile, pdfFile, ip, customAnswers, email, nights, price, paymentType, guests, paymentStatus, amountPaid, platform, checkInDate, checkOutDate, clientId, queuedAt, paymentType2, splitAmount1, splitAmount2, createdAt)
  VALUES (@id, @folio, @fullName, @country, @idNumber, @phone, @room, @fecha, @signatureFile, @idPhotoFile, @pdfFile, @ip, @customAnswers, @email, @nights, @price, @paymentType, @guests, @paymentStatus, @amountPaid, @platform, @checkInDate, @checkOutDate, @clientId, @queuedAt, @paymentType2, @splitAmount1, @splitAmount2, datetime('now','localtime'))
`);

function guardarRegistro(registro) {
  insertCheckin.run(registro);
}

function leerRegistros() {
  return db.prepare(`
    SELECT id, folio, fullName, country, room, fecha, email, phone, nights, price, paymentType, guests, paymentStatus, amountPaid, platform, updatedAt, checkInDate, checkOutDate
    FROM checkins
    ORDER BY createdAt DESC
  `).all();
}

// Suma (o resta, si "dias" es negativo) días a una fecha "YYYY-MM-DD" y
// regresa el resultado en el mismo formato. Se usa para calcular la fecha
// de salida a partir de la fecha de entrada y el número de noches — tanto
// al crear el registro como al editarlo (si se agregan noches extra, la
// fecha de salida se recalcula y se extiende sola).
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
// Suma días de calendario a una fecha "YYYY-MM-DD" usando aritmética en UTC
// puro (nunca la hora local del servidor) — así el resultado es siempre el
// mismo sin importar en qué zona horaria esté configurado el servidor donde
// corra la app (a diferencia de usar la hora local, que podía adelantar o
// atrasar un día el resultado según dónde esté alojado el servidor).
function sumarDias(fechaISO, dias) {
  const d = new Date(fechaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(dias));
  return d.toISOString().slice(0, 10);
}

// Texto legible del tipo de pago — si el huésped pagó todo con una sola
// forma de pago (el caso normal), es solo su nombre ("Efectivo"). Si pagó
// con dos formas distintas, muestra ambas con lo que se pagó con cada una,
// por ejemplo: "Efectivo ($200.00) + Tarjeta crédito ($300.00)".
function formatearTipoPago(registro) {
  if (registro.paymentType2) {
    const m1 = Number(registro.splitAmount1 || 0).toFixed(2);
    const m2 = Number(registro.splitAmount2 || 0).toFixed(2);
    return `${registro.paymentType} ($${m1}) + ${registro.paymentType2} ($${m2})`;
  }
  return registro.paymentType;
}

// Listas fijas de opciones válidas (además de validarse aquí, alimentan los
// menús desplegables del formulario del huésped)
const TIPOS_HABITACION = ['Sencilla', 'Doble', 'Twin', 'Delux', 'Suite Junior', 'Suite Presidencial', 'Otro'];
const PLATAFORMAS_RESERVA = ['Booking.com', 'Expedia', 'Hostelworld', 'Airbnb', 'Directo', 'Otro'];
// "Prepago (plataforma)" es para cuando la plataforma de reservación (Booking,
// Airbnb, etc.) ya le cobró al huésped por adelantado — el hotel no cobra
// nada en ese momento, pero sigue siendo importante registrar cómo se pagó.
const TIPOS_PAGO_VALIDOS = ['Efectivo', 'Tarjeta débito', 'Tarjeta crédito', 'Transferencia', 'Prepago (plataforma)'];
const ESTADOS_PAGO_VALIDOS = ['Pagado', 'Pendiente', 'Anticipo'];

// ---- Impuestos configurables (para el reporte) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS appSettings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);
function leerImpuestos() {
  const iva = db.prepare("SELECT value FROM appSettings WHERE key = 'ivaPercent'").get();
  const municipal = db.prepare("SELECT value FROM appSettings WHERE key = 'municipalPercent'").get();
  return {
    ivaPercent: iva ? Number(iva.value) : 16,
    municipalPercent: municipal ? Number(municipal.value) : 5,
  };
}
function guardarImpuestos(ivaPercent, municipalPercent) {
  db.prepare("INSERT INTO appSettings (key, value) VALUES ('ivaPercent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(ivaPercent));
  db.prepare("INSERT INTO appSettings (key, value) VALUES ('municipalPercent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(municipalPercent));
}

// ---- Historial de ediciones ----
// Cada vez que se edita un registro (pago actualizado, noches extendidas,
// etc.) se guarda una línea aquí describiendo exactamente qué cambió y
// cuándo — así el panel puede mostrar el detalle, no solo un "Editado" genérico.
db.exec(`
  CREATE TABLE IF NOT EXISTS checkinEdits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkinId TEXT NOT NULL,
    editedAt TEXT DEFAULT (datetime('now', 'localtime')),
    summary TEXT NOT NULL
  )
`);

function registrarEdicion(checkinId, cambios) {
  // "cambios" es un arreglo de [etiqueta, valorAnterior, valorNuevo] —
  // solo se guardan los que realmente cambiaron.
  const partes = cambios
    .filter(([, antes, ahora]) => String(antes) !== String(ahora))
    .map(([etiqueta, antes, ahora]) => `${etiqueta}: ${antes} → ${ahora}`);
  if (partes.length === 0) return; // nada cambió de verdad, no se guarda una línea vacía
  db.prepare('INSERT INTO checkinEdits (checkinId, summary) VALUES (?, ?)').run(checkinId, partes.join(' · '));
}

function leerHistorialDeEdiciones(checkinId) {
  return db.prepare('SELECT editedAt, summary FROM checkinEdits WHERE checkinId = ? ORDER BY editedAt DESC').all(checkinId);
}

// ---- Cargos extra (daños, objetos rotos, desorden, etc.) ----
// Un huésped puede tener varios cargos extra durante su estancia (rompió un
// vaso el lunes, dejó un desorden el jueves...), así que se guardan como una
// lista aparte ligada al check-in, no como un solo campo que se sobreescribe.
const TIPOS_PAGO_CARGO_EXTRA = ['Efectivo', 'Tarjeta débito', 'Tarjeta crédito', 'Transferencia'];
const ESTADOS_CARGO_EXTRA = ['Pagado', 'Pendiente'];

db.exec(`
  CREATE TABLE IF NOT EXISTS cargosExtra (
    id TEXT PRIMARY KEY,
    checkinId TEXT NOT NULL,
    concepto TEXT NOT NULL,
    paymentType TEXT NOT NULL,
    monto REAL NOT NULL,
    paymentStatus TEXT NOT NULL DEFAULT 'Pendiente',
    createdAt TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);
// Migración: si la tabla ya existía de una versión anterior (sin el estado
// de pago), se le agrega la columna sin perder los cargos ya guardados.
const columnasCargosExtra = db.prepare("PRAGMA table_info(cargosExtra)").all().map((c) => c.name);
if (!columnasCargosExtra.includes('paymentStatus')) {
  db.exec("ALTER TABLE cargosExtra ADD COLUMN paymentStatus TEXT NOT NULL DEFAULT 'Pendiente'");
}

function leerCargosExtra(checkinId) {
  return db.prepare('SELECT id, concepto, paymentType, monto, paymentStatus, createdAt FROM cargosExtra WHERE checkinId = ? ORDER BY createdAt DESC').all(checkinId);
}

// ---- Correo saliente (SMTP), para poder mandarle su comprobante al huésped ----
// Nota de seguridad: estos datos (incluida la contraseña del correo) se
// guardan tal cual en tu base de datos LOCAL — nunca se mandan a ningún
// lado más que al servidor de correo que tú configures. Aun así, si usas
// Gmail u Outlook, se recomienda usar una "contraseña de aplicación" en
// vez de tu contraseña normal (la mayoría de estos servicios bloquean el
// acceso directo por seguridad y piden esa contraseña especial).
// ---- Configuración de correo saliente (SMTP) — para poder enviar el PDF al huésped ----
// Nota de seguridad: estos datos (incluida la contraseña del correo) se
// guardan tal cual en tu base de datos LOCAL — nunca se mandan a ningún
// lado más que al servidor de correo que tú configures. Aun así, si usas
// Gmail u Outlook, se recomienda usar una "contraseña de aplicación" en
// vez de tu contraseña normal (la mayoría de estos servicios bloquean el
// acceso directo por seguridad y piden esa contraseña especial).
const CAMPOS_SMTP = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'smtpFromName', 'smtpFromEmail'];
function leerConfigSmtp() {
  const config = {};
  CAMPOS_SMTP.forEach((campo) => {
    const fila = db.prepare('SELECT value FROM appSettings WHERE key = ?').get(campo);
    config[campo] = fila ? fila.value : '';
  });
  return config;
}
function guardarConfigSmtp(valores) {
  CAMPOS_SMTP.forEach((campo) => {
    if (valores[campo] === undefined) return; // no tocar lo que no venga en la petición
    db.prepare("INSERT INTO appSettings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(campo, String(valores[campo]));
  });
}
function crearTransporteCorreo() {
  const c = leerConfigSmtp();
  if (!c.smtpHost || !c.smtpUser || !c.smtpPass) return null;
  return nodemailer.createTransport({
    host: c.smtpHost,
    port: Number(c.smtpPort) || 587,
    secure: c.smtpSecure === 'true' || c.smtpSecure === '1',
    auth: { user: c.smtpUser, pass: c.smtpPass },
  });
}

// ---- Preguntas personalizadas del formulario (configurables desde /settings.html) ----
// "type" puede ser: 'text' (libre), 'numbers' (solo números), 'letters'
// (solo letras), 'email' (correo válido), o 'select' (opción múltiple,
// con las opciones guardadas como JSON en la columna "options").
const TIPOS_CAMPO_VALIDOS = ['text', 'numbers', 'letters', 'email', 'select'];
db.exec(`
  CREATE TABLE IF NOT EXISTS customFields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    fieldKey TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    sortOrder INTEGER NOT NULL DEFAULT 0
  )
`);

// Convierte una etiqueta como "Motivo del viaje" en una llave sencilla y
// única como "motivo_del_viaje" — así cada pregunta tiene un identificador
// estable aunque luego cambies el texto de la etiqueta.
function generarFieldKey(label) {
  const base = label
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'pregunta';
  let key = base;
  let contador = 1;
  while (db.prepare('SELECT 1 FROM customFields WHERE fieldKey = ?').get(key)) {
    contador += 1;
    key = `${base}_${contador}`;
  }
  return key;
}

function leerCamposPersonalizados() {
  return db.prepare('SELECT * FROM customFields ORDER BY sortOrder ASC, id ASC').all()
    .map((f) => ({ ...f, options: f.options ? JSON.parse(f.options) : [], required: Boolean(f.required) }));
}

// ---- Tabla de administrador(es) — usuarios/contraseñas editables desde el panel ----
// La contraseña NUNCA se guarda tal cual — se guarda su "hash" (una huella
// digital irreversible) junto con una "sal" aleatoria. Así, aunque alguien
// abriera el archivo hotel.db directamente, no vería la contraseña real.
//
// Antes esta tabla solo permitía UNA fila (CHECK id = 1) — un solo usuario
// para todo el hotel. Ahora soporta varios administradores. Si el archivo
// hotel.db ya existía con el esquema viejo, aquí se migra sin perder el
// usuario/contraseña que ya tenían configurados.
const infoAdmin = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='admin'").get();
if (infoAdmin && /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(infoAdmin.sql)) {
  db.exec('ALTER TABLE admin RENAME TO admin_migracion_previa');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_migracion_previa'").get()) {
  db.exec(`
    INSERT INTO admin (id, username, passwordHash, passwordSalt)
    SELECT id, username, passwordHash, passwordSalt FROM admin_migracion_previa
  `);
  db.exec('DROP TABLE admin_migracion_previa');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verificarPassword(password, salt, hashEsperado) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashEsperado, 'hex'));
  } catch {
    return false;
  }
}

// La primera vez que corre el servidor (o si la tabla queda vacía por
// cualquier motivo), se crea un administrador con la contraseña de las
// variables de entorno (o la de prueba, si no configuraste nada). Las
// veces siguientes ya no se toca — desde ahí se administra todo en
// /settings/admins.html.
if (!db.prepare('SELECT 1 FROM admin').get()) {
  const { hash, salt } = hashPassword(process.env.ADMIN_PASS || 'cambia-esta-clave');
  db.prepare('INSERT INTO admin (username, passwordHash, passwordSalt) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_USER || 'admin', hash, salt);
}

// --------------------------------------------------------------
// 3. GENERACIÓN DEL PDF
// --------------------------------------------------------------
// --------------------------------------------------------------
// VALIDACIÓN POR TIPO DE DATO
// --------------------------------------------------------------
// Esto se revisa SIEMPRE en el servidor, sin importar lo que ya haya
// filtrado el navegador — cualquiera podría llamar a la API directo sin
// pasar por el formulario, así que la validación del lado del cliente
// es solo una ayuda visual, nunca la única línea de defensa.
const VALIDADORES = {
  letters: (v) => /^[A-Za-zÀ-ÖØ-öø-ÿ'\-\s]+$/.test(v),
  numbers: (v) => /^[0-9]+(\.[0-9]+)?$/.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  alphanumeric: (v) => /^[A-Za-z0-9\-\s]+$/.test(v),
  phone: (v) => /^[0-9+\-\s]{7,20}$/.test(v),
};

function generarFolio() {
  return 'CM-' + Math.floor(1000 + Math.random() * 9000);
}

// Mismo texto que se muestra en el formulario del huésped (public/index.html,
// paso de Términos) — se repite aquí para poder imprimirlo también en el PDF,
// así el comprobante muestra exactamente lo que el huésped aceptó y firmó.
const TERMINOS_TEXTO = `El check-out es a las 12:00 hrs. Cualquier daño a la habitación o al mobiliario será cargado a la tarjeta registrada. El hotel no se hace responsable por objetos de valor dejados fuera de la caja fuerte. Está prohibido fumar dentro de la habitación; se aplicará un cargo por limpieza especial en caso contrario. El huésped autoriza al hotel a conservar sus datos de contacto, identificación y firma con fines de registro conforme a la ley aplicable.`;

function generarPDF(datos, outputPath) {
  const {
    folio, fullName, country, idNumber, email, phone, room, nights, price, paymentType,
    guests, paymentStatus, amountPaid, platform, fecha, checkInDate, checkOutDate, cargosExtra,
    paymentType2, splitAmount1, splitAmount2,
    signaturePath, idPhotoPath, respuestas, camposPersonalizados,
  } = datos;

  return new Promise((resolve, reject) => {
    // A4 en vez de A5: con dos imágenes (identificación + firma) A5 se quedaba
    // corto y el contenido se encimaba o se salía de la página.
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).fillColor('#1B2430').text('Hotel Casa Marfil');
    doc.fontSize(12).fillColor('#8E6E3E').text('Comprobante de registro de huésped');
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#000').text(`Folio: ${folio}`);
    doc.text(`Fecha: ${fecha}`);
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#DCD3C0').stroke();
    doc.moveDown();

    const estadoPagoTexto = paymentStatus === 'Anticipo'
      ? `Anticipo — pagado $${Number(amountPaid || 0).toFixed(2)} de $${Number(price).toFixed(2)} (saldo $${(Number(price) - Number(amountPaid || 0)).toFixed(2)})`
      : paymentStatus;

    const filas = [
      ['Huésped', fullName],
      ['Nacionalidad', country],
      ['Identificación / pasaporte', idNumber],
      ['Correo', email],
      ['Teléfono', phone],
      ['Tipo de habitación', room],
      ['Fecha de entrada', checkInDate || '—'],
      ['Fecha de salida', checkOutDate || '—'],
      ['Número de personas', String(guests)],
      ['Número de noches', String(nights)],
      ['Plataforma de reservación', platform],
      ['Precio a pagar', `$${Number(price).toFixed(2)}`],
      ['Tipo de pago', formatearTipoPago({ paymentType, paymentType2, splitAmount1, splitAmount2 })],
      ['Estado de pago', estadoPagoTexto],
    ];
    // Las preguntas personalizadas se agregan al final de la lista de datos,
    // en el mismo formato — así el comprobante las muestra igual de claro.
    if (camposPersonalizados && respuestas) {
      camposPersonalizados.forEach((campo) => {
        const valor = respuestas[campo.fieldKey];
        if (valor) filas.push([campo.label, valor]);
      });
    }
    filas.forEach(([etiqueta, valor]) => {
      doc.fontSize(9).fillColor('#8a8071').text(etiqueta.toUpperCase());
      doc.fontSize(13).fillColor('#1B2430').text(valor || '—');
      doc.moveDown(0.4);
    });

    // Cargos extra (daños, objetos rotos, desorden, etc.) — solo se imprime
    // esta sección si el registro tiene al menos uno. Cada cargo muestra su
    // concepto, cómo se pagó (o si sigue pendiente) y el monto, más un
    // total al final para que quede clarísimo cuánto se le cobró aparte de
    // la estancia.
    if (cargosExtra && cargosExtra.length > 0) {
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#DCD3C0').stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#1B2430').text('Cargos extra (daños u objetos)');
      doc.moveDown(0.3);

      let totalCargos = 0;
      cargosExtra.forEach((c) => {
        totalCargos += Number(c.monto);
        const colorEstado = c.paymentStatus === 'Pagado' ? '#5C6F4F' : '#B0463A';
        doc.fontSize(10).fillColor('#1B2430').text(c.concepto, { continued: false, width: 495 });
        doc.fontSize(9).fillColor('#8a8071').text(`${c.paymentType} · `, { continued: true });
        doc.fillColor(colorEstado).text(c.paymentStatus, { continued: true });
        doc.fillColor('#8a8071').text(`  —  $${Number(c.monto).toFixed(2)}`);
        doc.moveDown(0.35);
      });

      doc.fontSize(10).fillColor('#1B2430').text(`Total cargos extra: $${totalCargos.toFixed(2)}`);
      doc.moveDown(0.5);
    }

    // La foto de identificación y la firma van EN COLUMNAS SEPARADAS, con
    // coordenadas x fijas y explícitas (no una debajo de la otra dependiendo
    // del flujo automático) — así es matemáticamente imposible que una se
    // encime con la otra, sin importar el tamaño o proporción de cada imagen.
    doc.moveDown();
    if (doc.y > 630) doc.addPage(); // si ya no cabe una fila de imágenes, mejor pasar de página limpio
    const colWidth = 220;
    const gap = 35;
    const colX1 = 50;
    const colX2 = colX1 + colWidth + gap;
    const labelY = doc.y;

    doc.fontSize(9).fillColor('#8a8071').text('FOTO DE IDENTIFICACIÓN', colX1, labelY, { width: colWidth });
    doc.fontSize(9).fillColor('#8a8071').text('FIRMA DEL HUÉSPED', colX2, labelY, { width: colWidth });

    const imagesY = labelY + 16;
    if (idPhotoPath && fs.existsSync(idPhotoPath)) {
      doc.image(idPhotoPath, colX1, imagesY, { fit: [colWidth, 200] });
    }
    if (signaturePath && fs.existsSync(signaturePath)) {
      doc.image(signaturePath, colX2, imagesY, { fit: [colWidth, 200] });
    }
    doc.y = imagesY + 210; // avanzar el cursor manualmente, con margen de sobra bajo ambas imágenes

    // Términos y condiciones que el huésped aceptó y firmó — se imprimen
    // completos al final, en su propia página si hace falta, para que quien
    // reciba el PDF (incluso por correo) vea exactamente lo que firmó.
    // Usamos flujo normal de texto (con "width" para que ajuste el renglón),
    // nunca coordenadas fijas superpuestas con otro contenido.
    doc.addPage();
    doc.fontSize(13).fillColor('#1B2430').text('Términos y condiciones aceptados', { width: 495 });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#2A2620').text(TERMINOS_TEXTO, { width: 495, align: 'justify', lineGap: 3 });
    doc.moveDown();
    doc.fontSize(9).fillColor('#8a8071').text(`Aceptado y firmado electrónicamente por ${fullName} el ${fecha}.`, { width: 495 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// --------------------------------------------------------------
// LOGIN PROPIO (en vez del cuadro nativo del navegador)
// --------------------------------------------------------------
// Por qué: el cuadro de usuario/contraseña "nativo" del navegador (HTTP
// Basic Auth) no se comporta igual en todos los dispositivos — en varias
// tablets y navegadores simplemente no aparece o no se puede usar. Con
// una página de login propia controlamos exactamente lo que pasa.
//
// Cómo funciona: cuando entras usuario/contraseña correctos en /login.html,
// el servidor genera un "token" (una cadena aleatoria larga) y lo guarda
// en memoria. Ese token se manda al navegador como una cookie. En cada
// petición futura, el navegador reenvía esa cookie sola, y el servidor
// solo revisa si ese token sigue siendo válido — así el huésped nunca ve
// ni puede escribir nada de esto, porque nunca tiene el token.
const activeSessions = new Map(); // token -> id del administrador dueño de esa sesión

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function estaAutenticado(req) {
  const cookies = parseCookies(req);
  return Boolean(cookies.session && activeSessions.has(cookies.session));
}

// Id del administrador dueño de la sesión actual — se usa para saber "quién
// soy" (mostrar "tú" en la lista, evitar que alguien se elimine a sí mismo).
function idAdminDeSesion(req) {
  const cookies = parseCookies(req);
  return activeSessions.get(cookies.session);
}

// Cierra la sesión de un administrador en TODOS sus dispositivos — se usa
// cuando cambia su usuario/contraseña o cuando se le elimina, para que el
// cambio quede efectivo de inmediato sin afectar a los demás administradores.
function invalidarSesionesDe(adminId) {
  for (const [token, id] of activeSessions) {
    if (id === adminId) activeSessions.delete(token);
  }
}

// Para rutas de PÁGINA (el navegador navega directo): si no hay sesión,
// lo mandamos a la pantalla de login.
function requireAuthPage(req, res, next) {
  if (estaAutenticado(req)) return next();
  return res.redirect('/login.html');
}

// Para rutas de API (llamadas por fetch/JS): si no hay sesión, respondemos
// 401 en JSON — el propio panel detecta esto y redirige al login.
function requireAuthApi(req, res, next) {
  if (estaAutenticado(req)) return next();
  return res.status(401).json({ error: 'Sesión no válida.' });
}

// --------------------------------------------------------------
// MIDDLEWARE GENERAL
// --------------------------------------------------------------
// Límite subido a 8mb: ahora viajan DOS imágenes base64 (firma + foto de ID)
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------
// 4. RUTAS (ENDPOINTS)
// --------------------------------------------------------------

function guardarImagenBase64(dataUrl, destino) {
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
  if (!match) return false;
  fs.writeFileSync(destino, match[2], 'base64');
  return true;
}

app.post('/api/checkins', async (req, res) => {
  try {
    const {
      fullName, country, idNumber, email, phone, room, nights, price, paymentType,
      guests, paymentStatus, amountPaid, platform, checkInDate,
      signatureDataUrl, idPhotoDataUrl, termsAccepted,
      customAnswers, clientId, queuedAt,
      paymentType2, splitAmount1, splitAmount2,
    } = req.body;

    // Idempotencia: si el celular ya mandó este mismo registro antes (por
    // ejemplo porque se guardó sin conexión y luego el navegador reintentó
    // el envío, o la respuesta anterior se perdió a media red), "clientId"
    // permite reconocerlo y devolver el folio que YA se creó, en vez de
    // crear un check-in duplicado del mismo huésped.
    if (clientId) {
      const yaExiste = db.prepare('SELECT id, folio, fecha, checkInDate, checkOutDate FROM checkins WHERE clientId = ?').get(clientId);
      if (yaExiste) {
        return res.json({
          id: yaExiste.id, folio: yaExiste.folio, fecha: yaExiste.fecha,
          checkInDate: yaExiste.checkInDate, checkOutDate: yaExiste.checkOutDate,
          pdfUrl: `/api/checkins/${yaExiste.id}/pdf`,
        });
      }
    }

    if (!fullName || !country || !idNumber || !email || !phone || !room || !nights || !price || !paymentType || !guests || !paymentStatus || !platform || !checkInDate) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }
    if (!FORMATO_FECHA.test(checkInDate)) {
      return res.status(400).json({ error: 'La fecha de entrada no es válida.' });
    }
    if (!VALIDADORES.letters(fullName)) {
      return res.status(400).json({ error: 'El nombre completo solo puede contener letras.' });
    }
    if (!VALIDADORES.alphanumeric(idNumber)) {
      return res.status(400).json({ error: 'El número de identificación no es válido.' });
    }
    if (!VALIDADORES.email(email)) {
      return res.status(400).json({ error: 'El correo no es válido.' });
    }
    if (!VALIDADORES.phone(phone)) {
      return res.status(400).json({ error: 'El teléfono no es válido.' });
    }
    if (!TIPOS_HABITACION.includes(room)) {
      return res.status(400).json({ error: 'El tipo de habitación no es válido.' });
    }
    if (!PLATAFORMAS_RESERVA.includes(platform)) {
      return res.status(400).json({ error: 'La plataforma de reservación no es válida.' });
    }
    if (!VALIDADORES.numbers(String(nights)) || Number(nights) < 1) {
      return res.status(400).json({ error: 'El número de noches no es válido.' });
    }
    if (!VALIDADORES.numbers(String(price)) || Number(price) <= 0) {
      return res.status(400).json({ error: 'El precio no es válido.' });
    }
    if (!VALIDADORES.numbers(String(guests)) || Number(guests) < 1) {
      return res.status(400).json({ error: 'El número de personas no es válido.' });
    }
    if (!TIPOS_PAGO_VALIDOS.includes(paymentType)) {
      return res.status(400).json({ error: 'El tipo de pago no es válido.' });
    }
    // Pago con dos formas distintas (ej. mitad efectivo, mitad tarjeta):
    // "paymentType2" solo llega cuando el huésped de verdad dividió el
    // pago. Si llega, las dos cantidades tienen que sumar exactamente el
    // precio total — si no, el comprobante quedaría con números que no
    // cuadran entre sí.
    let montoDividido1 = null;
    let montoDividido2 = null;
    if (paymentType2) {
      if (!TIPOS_PAGO_VALIDOS.includes(paymentType2)) {
        return res.status(400).json({ error: 'El segundo tipo de pago no es válido.' });
      }
      montoDividido1 = Number(splitAmount1);
      montoDividido2 = Number(splitAmount2);
      if (Number.isNaN(montoDividido1) || montoDividido1 <= 0 || Number.isNaN(montoDividido2) || montoDividido2 <= 0) {
        return res.status(400).json({ error: 'Indica cuánto se pagó con cada forma de pago.' });
      }
      if (Math.abs((montoDividido1 + montoDividido2) - Number(price)) > 0.01) {
        return res.status(400).json({ error: `Las dos cantidades ($${montoDividido1.toFixed(2)} + $${montoDividido2.toFixed(2)}) no suman el precio total ($${Number(price).toFixed(2)}).` });
      }
    }
    if (!ESTADOS_PAGO_VALIDOS.includes(paymentStatus)) {
      return res.status(400).json({ error: 'El estado de pago no es válido.' });
    }
    // El monto pagado se deriva del estado, salvo en "Anticipo" donde lo
    // indica el huésped — así siempre queda un número coherente guardado.
    let montoFinal = 0;
    if (paymentStatus === 'Pagado') montoFinal = Number(price);
    if (paymentStatus === 'Pendiente') montoFinal = 0;
    if (paymentStatus === 'Anticipo') {
      if (!VALIDADORES.numbers(String(amountPaid)) || Number(amountPaid) <= 0 || Number(amountPaid) >= Number(price)) {
        return res.status(400).json({ error: 'Indica un monto de anticipo válido (mayor a 0 y menor al precio total).' });
      }
      montoFinal = Number(amountPaid);
    }
    if (!termsAccepted) {
      return res.status(400).json({ error: 'El huésped debe aceptar los términos.' });
    }
    if (!signatureDataUrl) {
      return res.status(400).json({ error: 'Falta la firma del huésped.' });
    }
    if (!idPhotoDataUrl) {
      return res.status(400).json({ error: 'Falta la foto de identificación.' });
    }

    // Validar también las preguntas personalizadas: que estén si son
    // obligatorias, y que respeten el tipo de dato configurado.
    const camposPersonalizados = leerCamposPersonalizados();
    const respuestas = customAnswers && typeof customAnswers === 'object' ? customAnswers : {};
    for (const campo of camposPersonalizados) {
      const valor = String(respuestas[campo.fieldKey] || '').trim();
      if (campo.required && !valor) {
        return res.status(400).json({ error: `Falta responder: ${campo.label}` });
      }
      if (valor && campo.type !== 'text' && campo.type !== 'select' && VALIDADORES[campo.type] && !VALIDADORES[campo.type](valor)) {
        return res.status(400).json({ error: `La respuesta de "${campo.label}" no tiene el formato correcto.` });
      }
    }

    const id = crypto.randomUUID();
    const folio = generarFolio();
    const fecha = new Date().toLocaleString('es-MX', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    // La fecha de salida SIEMPRE se calcula en el servidor (fecha de entrada +
    // número de noches) — nunca se confía en un valor que mande el navegador.
    // Así, si más adelante se editan las noches, siempre queda consistente.
    const checkOutDate = sumarDias(checkInDate, nights);

    const signaturePath = path.join(SIGNATURES_DIR, `${id}.png`);
    if (!guardarImagenBase64(signatureDataUrl, signaturePath)) {
      return res.status(400).json({ error: 'Formato de firma inválido.' });
    }

    const idPhotoPath = path.join(ID_PHOTOS_DIR, `${id}.jpg`);
    if (!guardarImagenBase64(idPhotoDataUrl, idPhotoPath)) {
      return res.status(400).json({ error: 'Formato de foto de identificación inválido.' });
    }

    const pdfPath = path.join(PDFS_DIR, `${id}.pdf`);
    await generarPDF({
      folio, fullName, country, idNumber, email, phone, room, nights, price, paymentType,
      guests, paymentStatus, amountPaid: montoFinal, platform, fecha, checkInDate, checkOutDate,
      signaturePath, idPhotoPath, respuestas, camposPersonalizados,
    }, pdfPath);

    const registro = {
      id, folio, fullName, country, idNumber, room, fecha, phone,
      email, nights: Number(nights), price: Number(price), paymentType,
      guests: Number(guests), paymentStatus, amountPaid: montoFinal, platform,
      checkInDate, checkOutDate,
      // "clientId" solo llega cuando el registro se hizo desde el celular sin
      // conexión (ver nota de idempotencia arriba); "queuedAt" es la hora en
      // que el huésped REALMENTE llenó el formulario en el celular, que puede
      // ser bastante antes de que el servidor lo reciba y lo procese.
      clientId: clientId || null,
      queuedAt: (queuedAt && !Number.isNaN(Date.parse(queuedAt))) ? queuedAt : null,
      paymentType2: paymentType2 || null,
      splitAmount1: montoDividido1,
      splitAmount2: montoDividido2,
      signatureFile: `${id}.png`,
      idPhotoFile: `${id}.jpg`,
      pdfFile: `${id}.pdf`,
      ip: req.ip,
      customAnswers: JSON.stringify(respuestas),
    };
    guardarRegistro(registro);

    res.json({ id, folio, fecha, checkInDate, checkOutDate, pdfUrl: `/api/checkins/${id}/pdf` });
  } catch (err) {
    console.error('Error al guardar el check-in:', err);
    res.status(500).json({ error: 'Ocurrió un error al guardar el registro.' });
  }
});

// Regenera el PDF de un registro ya existente, con los datos ACTUALES de la
// base de datos — se usa cada vez que se edita un registro (pago, noches, etc.)
async function regenerarPDFDeRegistro(registro) {
  const camposPersonalizados = leerCamposPersonalizados();
  const respuestas = registro.customAnswers ? JSON.parse(registro.customAnswers) : {};
  const signaturePath = path.join(SIGNATURES_DIR, registro.signatureFile);
  const idPhotoPath = path.join(ID_PHOTOS_DIR, registro.idPhotoFile);
  const pdfPath = path.join(PDFS_DIR, registro.pdfFile);
  const cargosExtra = leerCargosExtra(registro.id);
  await generarPDF({
    folio: registro.folio, fullName: registro.fullName, country: registro.country, idNumber: registro.idNumber,
    email: registro.email, phone: registro.phone, room: registro.room, nights: registro.nights, price: registro.price,
    paymentType: registro.paymentType, guests: registro.guests, paymentStatus: registro.paymentStatus,
    amountPaid: registro.amountPaid, platform: registro.platform, fecha: registro.fecha,
    checkInDate: registro.checkInDate, checkOutDate: registro.checkOutDate, cargosExtra,
    paymentType2: registro.paymentType2, splitAmount1: registro.splitAmount1, splitAmount2: registro.splitAmount2,
    signaturePath, idPhotoPath, respuestas, camposPersonalizados,
  }, pdfPath);
}

// IMPORTANTE: esta ruta debe ir ANTES de "/api/checkins/:id" (más abajo).
// Express revisa las rutas en el orden en que se declaran, y ":id" acepta
// cualquier texto en esa posición — incluyendo la palabra "export.csv".
// Si "/api/checkins/:id" estuviera declarada primero, Express nunca
// llegaría a esta ruta: interpretaría "export.csv" como si fuera un ID de
// registro, no lo encontraría, y respondería "No encontrado" en vez de
// generar el reporte. Esto es justo lo que le pasaba al reporte antes.
//
// Fórmula de impuestos: un porcentaje directo del total que paga el
// huésped (no se "calcula hacia atrás"):
//   IVA = total × IVA%
//   Impuesto municipal = total × municipal%
//   Neto = total − IVA − impuesto municipal
app.get('/api/checkins/export.csv', requireAuthApi, (req, res) => {
  const { from, to, paymentType, q } = req.query;
  let query = 'SELECT id, folio, fullName, country, idNumber, email, phone, room, nights, price, paymentType, paymentType2, splitAmount1, splitAmount2, paymentStatus, platform, fecha, checkInDate, checkOutDate FROM checkins';
  const condiciones = [];
  const params = [];

  // Mismo criterio que la lista del panel (filtra por fecha de entrada, no
  // por fecha de registro, y por el mismo texto de búsqueda) — para que lo
  // que se ve filtrado en pantalla sea exactamente lo que sale en el CSV.
  if (from && to) {
    condiciones.push('date(checkInDate) BETWEEN date(?) AND date(?)');
    params.push(from, to);
  } else if (from) {
    condiciones.push('date(checkInDate) >= date(?)');
    params.push(from);
  } else if (to) {
    condiciones.push('date(checkInDate) <= date(?)');
    params.push(to);
  }
  if (q && q.trim()) {
    condiciones.push('fullName LIKE ?');
    params.push(`%${q.trim()}%`);
  }
  if (paymentType) {
    condiciones.push('paymentType = ?');
    params.push(paymentType);
  }
  if (condiciones.length) query += ' WHERE ' + condiciones.join(' AND ');
  query += ' ORDER BY createdAt DESC';

  const filas = db.prepare(query).all(...params);
  const { ivaPercent, municipalPercent } = leerImpuestos();

  const encabezado = [
    'Folio', 'Huésped', 'Nacionalidad', 'Identificación', 'Correo', 'Teléfono', 'Tipo de habitación', 'Fecha de entrada', 'Fecha de salida', 'Noches', 'Plataforma',
    'Tipo de pago', 'Estado de pago', `Total`, `IVA (${ivaPercent}%)`, `Impuesto municipal (${municipalPercent}%)`, 'Total impuestos', 'Neto (sin impuestos)',
    'Cargos extra (daños, objetos rotos, etc.)', 'Total cargos extra', 'Fecha',
  ];
  const escaparCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = [encabezado.map(escaparCsv).join(',')];

  let totalCargosExtraGeneral = 0;

  filas.forEach((r) => {
    const total = Number(r.price) || 0;
    const iva = total * (ivaPercent / 100);
    const municipal = total * (municipalPercent / 100);
    const totalImpuestos = iva + municipal;
    const neto = total - totalImpuestos;

    // Cargos extra de este huésped (daños, objetos rotos, etc.) — se
    // describen todos en una sola celda (separados por " | ") y aparte se
    // suma el total, para que se pueda filtrar/sumar fácil en Excel.
    const cargosExtra = leerCargosExtra(r.id);
    const detalleCargosExtra = cargosExtra
      .map((c) => `${c.concepto} ($${Number(c.monto).toFixed(2)}, ${c.paymentType}, ${c.paymentStatus})`)
      .join(' | ');
    const totalCargosExtra = cargosExtra.reduce((acc, c) => acc + Number(c.monto), 0);
    totalCargosExtraGeneral += totalCargosExtra;

    lineas.push([
      r.folio, r.fullName, r.country, r.idNumber, r.email, r.phone, r.room, r.checkInDate, r.checkOutDate, r.nights, r.platform,
      formatearTipoPago(r), r.paymentStatus, total.toFixed(2), iva.toFixed(2), municipal.toFixed(2), totalImpuestos.toFixed(2), neto.toFixed(2),
      detalleCargosExtra, totalCargosExtra > 0 ? totalCargosExtra.toFixed(2) : '', r.fecha,
    ].map(escaparCsv).join(','));
  });

  // Fila final con los totales de todo el reporte — para que el
  // administrador vea el resumen sin tener que sumar celdas en Excel.
  const totalGeneral = filas.reduce((acc, r) => acc + (Number(r.price) || 0), 0);
  const ivaGeneral = totalGeneral * (ivaPercent / 100);
  const municipalGeneral = totalGeneral * (municipalPercent / 100);
  const netoGeneral = totalGeneral - ivaGeneral - municipalGeneral;
  lineas.push('');
  lineas.push([
    'TOTALES', '', '', '', '', '', '', '', '', '', '', '', '',
    totalGeneral.toFixed(2), ivaGeneral.toFixed(2), municipalGeneral.toFixed(2), (ivaGeneral + municipalGeneral).toFixed(2), netoGeneral.toFixed(2),
    '', totalCargosExtraGeneral.toFixed(2), '',
  ].map(escaparCsv).join(','));

  // El "\uFEFF" al inicio (BOM) es para que Excel abra bien los acentos y la Ñ.
  const csv = '\uFEFF' + lineas.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="registros-${new Date().toLocaleDateString('en-CA')}.csv"`);
  res.send(csv);
});

// Obtener el detalle completo de un registro (para abrir el formulario de edición)
app.get('/api/checkins/:id', requireAuthApi, (req, res) => {
  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
  if (!registro) return res.status(404).json({ error: 'No encontrado.' });
  res.json(registro);
});

// Editar un registro existente: noches, precio, personas o estado de pago —
// para no tener que crear un check-in nuevo cuando alguien paga lo pendiente
// o extiende su estancia. El PDF se regenera solo con los datos actualizados.
app.patch('/api/checkins/:id', requireAuthApi, async (req, res) => {
  try {
    const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
    if (!registro) return res.status(404).json({ error: 'No encontrado.' });

    const { nights, price, guests, paymentStatus, amountPaid, paymentType, paymentType2, splitAmount1, splitAmount2 } = req.body || {};

    const nuevoNights = nights !== undefined ? Number(nights) : registro.nights;
    const nuevoPrice = price !== undefined ? Number(price) : registro.price;
    const nuevoGuests = guests !== undefined ? Number(guests) : registro.guests;
    const nuevoEstado = paymentStatus !== undefined ? paymentStatus : registro.paymentStatus;
    const nuevoTipoPago = paymentType !== undefined ? paymentType : registro.paymentType;

    if (Number.isNaN(nuevoNights) || nuevoNights < 1) return res.status(400).json({ error: 'Número de noches no válido.' });
    if (Number.isNaN(nuevoPrice) || nuevoPrice <= 0) return res.status(400).json({ error: 'Precio no válido.' });
    if (Number.isNaN(nuevoGuests) || nuevoGuests < 1) return res.status(400).json({ error: 'Número de personas no válido.' });
    if (!ESTADOS_PAGO_VALIDOS.includes(nuevoEstado)) return res.status(400).json({ error: 'Estado de pago no válido.' });
    if (!TIPOS_PAGO_VALIDOS.includes(nuevoTipoPago)) return res.status(400).json({ error: 'Tipo de pago no válido.' });

    // Pago con dos formas distintas — mismas reglas que al crear el
    // registro: si se manda un segundo tipo de pago, las dos cantidades
    // tienen que sumar el precio total.
    // "paymentType2: ''" (cadena vacía) es la forma en que el panel indica
    // "quitar la segunda forma de pago" — por eso se distingue de
    // "undefined" (que significa "no tocar este campo").
    let nuevoTipoPago2 = paymentType2 !== undefined ? (paymentType2 || null) : registro.paymentType2;
    let nuevoMonto1 = registro.splitAmount1;
    let nuevoMonto2 = registro.splitAmount2;
    if (nuevoTipoPago2) {
      if (!TIPOS_PAGO_VALIDOS.includes(nuevoTipoPago2)) return res.status(400).json({ error: 'El segundo tipo de pago no es válido.' });
      nuevoMonto1 = splitAmount1 !== undefined ? Number(splitAmount1) : Number(registro.splitAmount1);
      nuevoMonto2 = splitAmount2 !== undefined ? Number(splitAmount2) : Number(registro.splitAmount2);
      if (Number.isNaN(nuevoMonto1) || nuevoMonto1 <= 0 || Number.isNaN(nuevoMonto2) || nuevoMonto2 <= 0) {
        return res.status(400).json({ error: 'Indica cuánto se pagó con cada forma de pago.' });
      }
      if (Math.abs((nuevoMonto1 + nuevoMonto2) - nuevoPrice) > 0.01) {
        return res.status(400).json({ error: `Las dos cantidades ($${nuevoMonto1.toFixed(2)} + $${nuevoMonto2.toFixed(2)}) no suman el precio total ($${nuevoPrice.toFixed(2)}).` });
      }
    } else {
      nuevoMonto1 = null;
      nuevoMonto2 = null;
    }

    // Si se agregan (o quitan) noches, la fecha de salida se recalcula sola a
    // partir de la fecha de entrada original — nunca hay que editarla a mano.
    const fechaEntradaBase = FORMATO_FECHA.test(registro.checkInDate) ? registro.checkInDate : new Date().toISOString().slice(0, 10);
    const nuevoCheckOutDate = sumarDias(fechaEntradaBase, nuevoNights);

    let nuevoMonto = 0;
    if (nuevoEstado === 'Pagado') nuevoMonto = nuevoPrice;
    if (nuevoEstado === 'Pendiente') nuevoMonto = 0;
    if (nuevoEstado === 'Anticipo') {
      nuevoMonto = amountPaid !== undefined ? Number(amountPaid) : Number(registro.amountPaid);
      if (Number.isNaN(nuevoMonto) || nuevoMonto <= 0 || nuevoMonto >= nuevoPrice) {
        return res.status(400).json({ error: 'Indica un monto de anticipo válido (mayor a 0 y menor al precio total).' });
      }
    }

    db.prepare("UPDATE checkins SET nights = ?, price = ?, guests = ?, paymentStatus = ?, amountPaid = ?, checkOutDate = ?, paymentType = ?, paymentType2 = ?, splitAmount1 = ?, splitAmount2 = ?, updatedAt = datetime('now', 'localtime') WHERE id = ?")
      .run(nuevoNights, nuevoPrice, nuevoGuests, nuevoEstado, nuevoMonto, nuevoCheckOutDate, nuevoTipoPago, nuevoTipoPago2, nuevoMonto1, nuevoMonto2, req.params.id);

    // Guardar en el historial exactamente qué cambió — así el panel puede
    // mostrar "Noches: 2 → 4" en vez de solo una etiqueta genérica de "Editado".
    registrarEdicion(req.params.id, [
      ['Noches', registro.nights, nuevoNights],
      ['Precio', `$${Number(registro.price).toFixed(2)}`, `$${nuevoPrice.toFixed(2)}`],
      ['Personas', registro.guests, nuevoGuests],
      ['Estado de pago', registro.paymentStatus, nuevoEstado],
      ['Monto pagado', `$${Number(registro.amountPaid || 0).toFixed(2)}`, `$${nuevoMonto.toFixed(2)}`],
      ['Fecha de salida', registro.checkOutDate, nuevoCheckOutDate],
      ['Tipo de pago', formatearTipoPago(registro), formatearTipoPago({ paymentType: nuevoTipoPago, paymentType2: nuevoTipoPago2, splitAmount1: nuevoMonto1, splitAmount2: nuevoMonto2 })],
    ]);

    const actualizado = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
    await regenerarPDFDeRegistro(actualizado);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error al editar el registro:', err);
    res.status(500).json({ error: 'No se pudo actualizar el registro.' });
  }
});

// Historial de cambios de un registro (para mostrarlo en el modal de edición)
app.get('/api/checkins/:id/history', requireAuthApi, (req, res) => {
  res.json(leerHistorialDeEdiciones(req.params.id));
});

// ---- Cargos extra de un registro (daños, objetos rotos, desorden, etc.) ----
app.get('/api/checkins/:id/cargos-extra', requireAuthApi, (req, res) => {
  res.json(leerCargosExtra(req.params.id));
});

app.post('/api/checkins/:id/cargos-extra', requireAuthApi, async (req, res) => {
  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
  if (!registro) return res.status(404).json({ error: 'Registro no encontrado.' });

  const { concepto, paymentType, monto, paymentStatus } = req.body || {};
  if (!concepto || !concepto.trim()) {
    return res.status(400).json({ error: 'Describe brevemente el motivo del cargo (qué se rompió o dañó).' });
  }
  if (!TIPOS_PAGO_CARGO_EXTRA.includes(paymentType)) {
    return res.status(400).json({ error: 'Tipo de pago no válido.' });
  }
  if (!ESTADOS_CARGO_EXTRA.includes(paymentStatus)) {
    return res.status(400).json({ error: 'Indica si el cargo ya se pagó o sigue pendiente.' });
  }
  const montoNum = Number(monto);
  if (Number.isNaN(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: 'La cantidad a cobrar no es válida.' });
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO cargosExtra (id, checkinId, concepto, paymentType, monto, paymentStatus) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, concepto.trim(), paymentType, montoNum, paymentStatus);

  // Se refleja también en el historial general del registro, igual que
  // cualquier otro cambio (noches, pago, etc.) — para tener todo en un
  // mismo lugar cuando alguien revise qué pasó con esa estancia.
  registrarEdicion(req.params.id, [[
    'Cargo extra agregado', '—', `${concepto.trim()} · ${paymentType} · $${montoNum.toFixed(2)} · ${paymentStatus}`,
  ]]);

  // El PDF del huésped se regenera para que el cargo (y si ya se pagó o
  // sigue pendiente) quede reflejado ahí también, no solo en el panel.
  await regenerarPDFDeRegistro(registro);

  res.json({ ok: true, id });
});

// Marcar un cargo extra como pagado o pendiente (sin tener que borrarlo y
// volver a crearlo) — por ejemplo, se anota como "Pendiente" al momento del
// incidente, y luego, cuando el huésped paga, se marca como "Pagado".
app.patch('/api/cargos-extra/:id', requireAuthApi, async (req, res) => {
  const cargo = db.prepare('SELECT * FROM cargosExtra WHERE id = ?').get(req.params.id);
  if (!cargo) return res.status(404).json({ error: 'No encontrado.' });

  const { paymentStatus } = req.body || {};
  if (!ESTADOS_CARGO_EXTRA.includes(paymentStatus)) {
    return res.status(400).json({ error: 'Estado de pago no válido.' });
  }

  db.prepare('UPDATE cargosExtra SET paymentStatus = ? WHERE id = ?').run(paymentStatus, req.params.id);

  if (cargo.paymentStatus !== paymentStatus) {
    registrarEdicion(cargo.checkinId, [[
      `Cargo extra (${cargo.concepto})`, cargo.paymentStatus, paymentStatus,
    ]]);
  }

  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(cargo.checkinId);
  if (registro) await regenerarPDFDeRegistro(registro);

  res.json({ ok: true });
});

app.delete('/api/cargos-extra/:id', requireAuthApi, async (req, res) => {
  const cargo = db.prepare('SELECT * FROM cargosExtra WHERE id = ?').get(req.params.id);
  if (!cargo) return res.status(404).json({ error: 'No encontrado.' });
  db.prepare('DELETE FROM cargosExtra WHERE id = ?').run(req.params.id);
  registrarEdicion(cargo.checkinId, [[
    'Cargo extra eliminado', `${cargo.concepto} · ${cargo.paymentType} · $${Number(cargo.monto).toFixed(2)}`, '—',
  ]]);

  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(cargo.checkinId);
  if (registro) await regenerarPDFDeRegistro(registro);
  res.json({ ok: true });
});

// Opciones fijas que usa el formulario del huésped (tipos de habitación,
// plataformas de reservación) — centralizadas aquí para que el formulario
// y la validación del servidor siempre coincidan exactamente.
// Datos agregados para la sección de Gráficas — cada consulta agrupa y
// cuenta directamente en SQLite (más eficiente que traer todo y contar en JS).
// Arma el mismo filtro de fecha (últimos 30 días / mes / año) que usa la
// gráfica de check-ins, para que TODAS las demás gráficas de esta pantalla
// respeten el mismo periodo cuando el admin lo cambia — antes solo la
// gráfica de fechas se actualizaba, y las demás siempre mostraban el total
// histórico completo sin importar qué periodo estuviera seleccionado.
function filtroFechaStats(query) {
  const { view } = query;
  if (view === 'month') {
    const mesValido = /^\d{4}-\d{2}$/.test(query.month || '');
    const mes = mesValido ? query.month : new Date().toLocaleDateString('en-CA').slice(0, 7);
    return { where: "WHERE strftime('%Y-%m', checkInDate) = ?", params: [mes] };
  }
  if (view === 'year') {
    const anioValido = /^\d{4}$/.test(query.year || '');
    const anio = anioValido ? query.year : String(new Date().getFullYear());
    return { where: "WHERE strftime('%Y', checkInDate) = ?", params: [anio] };
  }
  return { where: "WHERE date(checkInDate) >= date('now', 'localtime', '-30 days')", params: [] };
}

app.get('/api/stats', requireAuthApi, (req, res) => {
  const { where, params } = filtroFechaStats(req.query);
  const byPaymentStatus = db.prepare(`SELECT paymentStatus AS label, COUNT(*) AS count FROM checkins ${where} GROUP BY paymentStatus`).all(...params);
  const byPaymentType = db.prepare(`SELECT paymentType AS label, COUNT(*) AS count FROM checkins ${where} GROUP BY paymentType ORDER BY count DESC`).all(...params);
  const byCountry = db.prepare(`SELECT country AS label, COUNT(*) AS count FROM checkins ${where} GROUP BY country ORDER BY count DESC`).all(...params);
  const byRoomType = db.prepare(`SELECT room AS label, COUNT(*) AS count FROM checkins ${where} GROUP BY room ORDER BY count DESC`).all(...params);
  const byPlatform = db.prepare(`SELECT platform AS label, COUNT(*) AS count FROM checkins ${where} GROUP BY platform ORDER BY count DESC`).all(...params);
  res.json({ byPaymentStatus, byPaymentType, byCountry, byRoomType, byPlatform });
});

const NOMBRES_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Gráfica "Check-ins por fecha de entrada" con vista cambiable: últimos 30
// días (día por día), un mes específico (día por día) o un año completo
// (mes por mes) — se agrupa por fecha de ENTRADA (checkInDate), que es la
// que le importa al hotel para ver cuándo llegan los huéspedes, no la fecha
// en que se llenó el formulario.
app.get('/api/stats/checkins', requireAuthApi, (req, res) => {
  const { view } = req.query;

  if (view === 'month') {
    const mesValido = /^\d{4}-\d{2}$/.test(req.query.month || '');
    const mes = mesValido ? req.query.month : new Date().toLocaleDateString('en-CA').slice(0, 7);
    const filas = db.prepare(`
      SELECT CAST(strftime('%d', checkInDate) AS INTEGER) AS dia, COUNT(*) AS count
      FROM checkins
      WHERE strftime('%Y-%m', checkInDate) = ?
      GROUP BY dia
    `).all(mes);
    // Se rellenan los días sin check-ins con 0 para que la gráfica muestre
    // el mes completo (del día 1 al último), no solo los días con datos.
    const [anio, mesNum] = mes.split('-').map(Number);
    const diasEnMes = new Date(anio, mesNum, 0).getDate();
    const porDia = new Map(filas.map((f) => [f.dia, f.count]));
    const resultado = [];
    for (let d = 1; d <= diasEnMes; d++) {
      resultado.push({ label: String(d).padStart(2, '0'), count: porDia.get(d) || 0 });
    }
    return res.json(resultado);
  }

  if (view === 'year') {
    const anioValido = /^\d{4}$/.test(req.query.year || '');
    const anio = anioValido ? req.query.year : String(new Date().getFullYear());
    const filas = db.prepare(`
      SELECT CAST(strftime('%m', checkInDate) AS INTEGER) AS mes, COUNT(*) AS count
      FROM checkins
      WHERE strftime('%Y', checkInDate) = ?
      GROUP BY mes
    `).all(anio);
    const porMes = new Map(filas.map((f) => [f.mes, f.count]));
    const resultado = [];
    for (let m = 1; m <= 12; m++) {
      resultado.push({ label: NOMBRES_MES[m - 1], count: porMes.get(m) || 0 });
    }
    return res.json(resultado);
  }

  // Por defecto: últimos 30 días, día por día (el comportamiento de antes).
  const filas = db.prepare(`
    SELECT date(checkInDate) AS label, COUNT(*) AS count
    FROM checkins
    WHERE date(checkInDate) >= date('now', 'localtime', '-30 days')
    GROUP BY date(checkInDate)
    ORDER BY label ASC
  `).all();
  res.json(filas);
});

app.get('/api/form-options', (req, res) => {
  res.json({ roomTypes: TIPOS_HABITACION, platforms: PLATAFORMAS_RESERVA });
});

app.get('/api/checkins', requireAuthApi, (req, res) => {
  const { from, to, paymentType, q } = req.query;
  let query = `SELECT id, folio, fullName, country, room, fecha, email, phone, nights, price, paymentType, paymentType2, splitAmount1, splitAmount2, guests, paymentStatus, amountPaid, checkInDate, checkOutDate, updatedAt, queuedAt,
    (SELECT COALESCE(SUM(monto), 0) FROM cargosExtra WHERE cargosExtra.checkinId = checkins.id AND cargosExtra.paymentStatus = 'Pendiente') AS totalCargosExtraPendientes
    FROM checkins`;
  const condiciones = [];
  const params = [];
  // El filtro "Entrada del ... al ..." compara contra la fecha de entrada del
  // huésped (checkInDate), no contra cuándo se llenó el formulario (createdAt).
  // Antes comparaba contra createdAt, así que un huésped que se registraba
  // hoy con entrada para otro día no aparecía al filtrar por su fecha de
  // entrada real — por eso el filtro (y el CSV, que usa la misma consulta)
  // parecía no funcionar.
  if (from && to) {
    condiciones.push('date(checkInDate) BETWEEN date(?) AND date(?)');
    params.push(from, to);
  } else if (from) {
    condiciones.push('date(checkInDate) >= date(?)');
    params.push(from);
  } else if (to) {
    condiciones.push('date(checkInDate) <= date(?)');
    params.push(to);
  }
  // Búsqueda por nombre: coincidencia parcial e insensible a mayúsculas
  // (LIKE de SQLite ya ignora mayúsculas/minúsculas en ASCII por defecto).
  if (q && q.trim()) {
    condiciones.push('fullName LIKE ?');
    params.push(`%${q.trim()}%`);
  }
  if (paymentType) {
    condiciones.push('paymentType = ?');
    params.push(paymentType);
  }
  if (condiciones.length) query += ' WHERE ' + condiciones.join(' AND ');
  query += ' ORDER BY createdAt DESC';
  res.json(db.prepare(query).all(...params));
});

// El PDF de un check-in específico NO requiere sesión a propósito:
// el huésped necesita poder abrir SU comprobante justo después de registrarse.
// Esto es seguro porque la URL incluye un UUID aleatorio (prácticamente
// imposible de adivinar) — es el mismo principio que un link "no listado".
// Lo que SÍ sigue protegido es la LISTA completa de registros (/api/checkins),
// porque esa sí permitiría ver a todos los huéspedes de un jalón.
app.get('/api/checkins/:id/pdf', (req, res) => {
  const pdfPath = path.join(PDFS_DIR, `${req.params.id}.pdf`);
  if (!fs.existsSync(pdfPath)) return res.status(404).send('No encontrado.');
  res.sendFile(pdfPath);
});

app.get('/api/checkins/:id/id-photo', requireAuthApi, (req, res) => {
  const photoPath = path.join(ID_PHOTOS_DIR, `${req.params.id}.jpg`);
  if (!fs.existsSync(photoPath)) return res.status(404).send('No encontrado.');
  res.sendFile(photoPath);
});

// ---- Login / logout ----
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
  if (admin && verificarPassword(password, admin.passwordSalt, admin.passwordHash)) {
    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.set(token, admin.id);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; Max-Age=${8 * 60 * 60}; SameSite=Strict`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
});

app.post('/api/logout', requireAuthApi, (req, res) => {
  const cookies = parseCookies(req);
  activeSessions.delete(cookies.session);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/registros.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'registros.html'));
});

app.get('/stats.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'stats.html'));
});

// ---- Configuración: ahora es un menú — cada sección vive en su propia página ----
app.get('/settings.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'settings.html'));
});
app.get('/settings/admins.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'settings-admins.html'));
});
app.get('/settings/fields.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'settings-fields.html'));
});
app.get('/settings/smtp.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'settings-smtp.html'));
});
app.get('/settings/taxes.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'private', 'settings-taxes.html'));
});

// ---- Administradores: listar, agregar, editar y eliminar desde el panel ----
// Reemplaza la pantalla anterior de "usuario y contraseña" (una sola cuenta
// fija) por una gestión completa de varias cuentas de administrador.
app.get('/api/admins', requireAuthApi, (req, res) => {
  const miId = idAdminDeSesion(req);
  const admins = db.prepare('SELECT id, username, createdAt FROM admin ORDER BY id ASC').all();
  res.json(admins.map((a) => ({ ...a, isMe: a.id === miId })));
});

app.post('/api/admins', requireAuthApi, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'Falta el nombre de usuario.' });
  }
  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const yaExiste = db.prepare('SELECT 1 FROM admin WHERE username = ?').get(username.trim());
  if (yaExiste) {
    return res.status(400).json({ error: 'Ya existe un administrador con ese usuario.' });
  }
  const { hash, salt } = hashPassword(password.trim());
  db.prepare('INSERT INTO admin (username, passwordHash, passwordSalt) VALUES (?, ?, ?)')
    .run(username.trim(), hash, salt);
  res.json({ ok: true });
});

app.patch('/api/admins/:id', requireAuthApi, (req, res) => {
  const id = Number(req.params.id);
  const admin = db.prepare('SELECT * FROM admin WHERE id = ?').get(id);
  if (!admin) return res.status(404).json({ error: 'Administrador no encontrado.' });

  const { username, password } = req.body || {};
  let nuevoUsername = admin.username;
  if (username !== undefined && username.trim()) {
    nuevoUsername = username.trim();
    const otro = db.prepare('SELECT 1 FROM admin WHERE username = ? AND id != ?').get(nuevoUsername, id);
    if (otro) return res.status(400).json({ error: 'Ya existe otro administrador con ese usuario.' });
  }

  let { passwordHash, passwordSalt } = admin;
  if (password !== undefined && password.trim()) {
    if (password.trim().length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }
    const hashed = hashPassword(password.trim());
    passwordHash = hashed.hash;
    passwordSalt = hashed.salt;
  }

  db.prepare('UPDATE admin SET username = ?, passwordHash = ?, passwordSalt = ? WHERE id = ?')
    .run(nuevoUsername, passwordHash, passwordSalt, id);

  // Si cambió el usuario o la contraseña, se cierra la sesión de ESE
  // administrador en todos sus dispositivos (no la de los demás) — así el
  // cambio queda efectivo de inmediato.
  invalidarSesionesDe(id);
  res.json({ ok: true, loggedOutSelf: id === idAdminDeSesion(req) });
});

app.delete('/api/admins/:id', requireAuthApi, (req, res) => {
  const id = Number(req.params.id);
  const miId = idAdminDeSesion(req);
  if (id === miId) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta mientras tienes la sesión abierta.' });
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM admin').get().n;
  if (total <= 1) {
    return res.status(400).json({ error: 'Debe quedar al menos un administrador.' });
  }
  const admin = db.prepare('SELECT id FROM admin WHERE id = ?').get(id);
  if (!admin) return res.status(404).json({ error: 'Administrador no encontrado.' });
  db.prepare('DELETE FROM admin WHERE id = ?').run(id);
  invalidarSesionesDe(id);
  res.json({ ok: true });
});

// ---- Preguntas personalizadas: el huésped las ve en el formulario, el
// administrador las agrega/quita desde /settings.html ----
app.get('/api/fields', (req, res) => {
  res.json(leerCamposPersonalizados());
});

app.post('/api/settings/fields', requireAuthApi, (req, res) => {
  const { label, type, options, required } = req.body || {};
  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'Escribe el texto de la pregunta.' });
  }
  if (!TIPOS_CAMPO_VALIDOS.includes(type)) {
    return res.status(400).json({ error: 'Tipo de pregunta no válido.' });
  }
  let opcionesJson = null;
  if (type === 'select') {
    const lista = Array.isArray(options) ? options.filter((o) => o && o.trim()) : [];
    if (lista.length < 2) {
      return res.status(400).json({ error: 'Una pregunta de opción múltiple necesita al menos 2 opciones.' });
    }
    opcionesJson = JSON.stringify(lista);
  }
  const fieldKey = generarFieldKey(label.trim());
  const maxOrder = db.prepare('SELECT MAX(sortOrder) AS m FROM customFields').get();
  db.prepare('INSERT INTO customFields (label, fieldKey, type, options, required, sortOrder) VALUES (?, ?, ?, ?, ?, ?)')
    .run(label.trim(), fieldKey, type, opcionesJson, required ? 1 : 0, (maxOrder.m || 0) + 1);
  res.json({ ok: true });
});

app.delete('/api/settings/fields/:id', requireAuthApi, (req, res) => {
  db.prepare('DELETE FROM customFields WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Impuestos configurables para el reporte ----
app.get('/api/settings/taxes', requireAuthApi, (req, res) => {
  res.json(leerImpuestos());
});

app.post('/api/settings/taxes', requireAuthApi, (req, res) => {
  const { ivaPercent, municipalPercent } = req.body || {};
  const iva = Number(ivaPercent);
  const municipal = Number(municipalPercent);
  if (Number.isNaN(iva) || Number.isNaN(municipal) || iva < 0 || municipal < 0 || iva > 100 || municipal > 100) {
    return res.status(400).json({ error: 'Los porcentajes deben ser números entre 0 y 100.' });
  }
  guardarImpuestos(iva, municipal);
  res.json({ ok: true });
});

// ---- Correo saliente (SMTP) ----
app.get('/api/settings/smtp', requireAuthApi, (req, res) => {
  const config = leerConfigSmtp();
  // La contraseña nunca se manda de vuelta al navegador — solo si ya hay una guardada.
  res.json({ ...config, smtpPass: undefined, hasPassword: Boolean(config.smtpPass) });
});

app.post('/api/settings/smtp', requireAuthApi, (req, res) => {
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFromName, smtpFromEmail } = req.body || {};
  const valores = { smtpHost, smtpPort, smtpSecure: smtpSecure ? 'true' : 'false', smtpUser, smtpFromName, smtpFromEmail };
  if (smtpPass && smtpPass.trim()) valores.smtpPass = smtpPass.trim(); // solo se cambia si mandaron una nueva
  guardarConfigSmtp(valores);
  res.json({ ok: true });
});

// Enviar el comprobante PDF de un check-in al correo del huésped
app.post('/api/checkins/:id/send-email', requireAuthApi, async (req, res) => {
  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
  if (!registro) return res.status(404).json({ error: 'Registro no encontrado.' });
  if (!registro.email) return res.status(400).json({ error: 'Este registro no tiene correo guardado.' });

  const transporte = crearTransporteCorreo();
  if (!transporte) {
    return res.status(400).json({ error: 'Configura el correo saliente en Configuración antes de poder enviar.' });
  }

  const pdfPath = path.join(PDFS_DIR, registro.pdfFile);
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'El PDF de este registro no se encuentra.' });

  const c = leerConfigSmtp();
  try {
    await transporte.sendMail({
      from: `"${c.smtpFromName || 'Hotel Casa Marfil'}" <${c.smtpFromEmail || c.smtpUser}>`,
      to: registro.email,
      subject: `Tu comprobante de check-in — Folio ${registro.folio}`,
      text: `Hola ${registro.fullName},\n\nAdjunto tu comprobante de registro (folio ${registro.folio}).\n\n¡Gracias por hospedarte con nosotros!`,
      attachments: [{ filename: `comprobante-${registro.folio}.pdf`, path: pdfPath }],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando correo:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el correo. Revisa la configuración SMTP.' });
  }
});

// ---- Borrar registros (uno por uno, o limpieza periódica por antigüedad) ----
function eliminarArchivosDeRegistro(registro) {
  [
    [SIGNATURES_DIR, registro.signatureFile],
    [ID_PHOTOS_DIR, registro.idPhotoFile],
    [PDFS_DIR, registro.pdfFile],
  ].forEach(([dir, archivo]) => {
    if (!archivo) return;
    const p = path.join(dir, archivo);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

app.delete('/api/checkins/:id', requireAuthApi, (req, res) => {
  const registro = db.prepare('SELECT * FROM checkins WHERE id = ?').get(req.params.id);
  if (!registro) return res.status(404).json({ error: 'No encontrado.' });
  eliminarArchivosDeRegistro(registro);
  db.prepare('DELETE FROM checkins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/checkins/cleanup', requireAuthApi, (req, res) => {
  const dias = Number(req.body && req.body.olderThanDays);
  if (!dias || dias <= 0) {
    return res.status(400).json({ error: 'Indica un número de días válido.' });
  }
  const antiguos = db.prepare(`SELECT * FROM checkins WHERE datetime(createdAt) < datetime('now', 'localtime', ?)`).all(`-${dias} days`);
  antiguos.forEach(eliminarArchivosDeRegistro);
  const resultado = db.prepare(`DELETE FROM checkins WHERE datetime(createdAt) < datetime('now', 'localtime', ?)`).run(`-${dias} days`);
  res.json({ ok: true, eliminados: resultado.changes });
});

// (la ruta de exportación CSV se movió arriba, justo antes de "/api/checkins/:id",
// para que Express no la confunda con esa ruta genérica — ver nota ahí)

// --------------------------------------------------------------
// 4.5 MANEJO DE ERRORES DE CONEXIÓN (celulares que se cortan a medias)
// --------------------------------------------------------------
// Como el formulario ahora le pone un límite de tiempo a sus envíos (para no
// quedarse "trabado" con datos móviles que no alcanzan al servidor — ver la
// nota del lado del celular), es NORMAL y ESPERADO que de vez en cuando el
// celular corte la conexión a la mitad de un envío. Sin este manejador,
// Express reacciona a eso con un error feo en la consola (BadRequestError:
// request aborted) que no significa que algo esté roto — solo que ese
// intento en particular no llegó a tiempo, y el celular ya lo va a
// reintentar solo. Aquí se registra en un solo renglón tranquilo, y el
// servidor sigue trabajando normal para todo lo demás.
app.use((err, req, res, next) => {
  if (err && (err.type === 'request.aborted' || err.message === 'request aborted')) {
    console.log(`⚠️  Un celular cortó la conexión a medio envío (normal si tenía mala señal) — ${req.method} ${req.originalUrl}`);
    return; // el cliente ya no está ahí para recibir una respuesta, no hay nada más que hacer
  }
  console.error('Error no manejado:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' });
  }
});

// Red de seguridad final: si algo se escapa de los manejadores de arriba
// (un error dentro de una función async sin su propio try/catch, por
// ejemplo), esto evita que TODO el servidor se caiga por un solo error —
// se registra y el servidor sigue funcionando para el resto del hotel.
process.on('uncaughtException', (err) => {
  console.error('⚠️  Error inesperado (el servidor sigue funcionando):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  Error inesperado en una operación asíncrona (el servidor sigue funcionando):', err);
});

// --------------------------------------------------------------
// 5. ENCENDER EL SERVIDOR
// --------------------------------------------------------------
// Solo hay UN servidor real ahora: el de HTTPS. El de HTTP existe nada más
// para REDIRIGIR automáticamente a la versión https — nunca sirve la app
// directamente.
//
// ¿Por qué el cambio? Antes ambos servían la misma app por separado, y para
// el navegador (y para el almacenamiento sin conexión del celular)
// "http://192.168.1.50:3000" y "https://192.168.1.50:3443" son DOS
// direcciones completamente distintas, con su propio cajón de guardado
// aparte — si alguien entraba por una y después revisaba por la otra, los
// registros guardados sin conexión "desaparecían" (en realidad seguían ahí,
// nada más que en el cajón de la otra dirección). Con la redirección
// automática, siempre se termina usando la misma dirección real sin
// importar cuál se haya escrito, así que ese problema ya no puede pasar.
const ipsLocales = obtenerIPsLocales().filter((ip) => ip !== 'localhost' && ip !== '127.0.0.1');
const httpsOptions = prepararCertificadoHttps();

http.createServer((req, res) => {
  const host = (req.headers.host || 'localhost').split(':')[0];
  res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
  res.end();
}).listen(PORT, () => {
  const totalAdmins = db.prepare('SELECT COUNT(*) AS n FROM admin').get().n;
  console.log(`✅ Servidor de check-in corriendo`);
  console.log(`   Administradores configurados: ${totalAdmins} (gestiónalos en /settings/admins.html)`);
  console.log('');
  console.log(`   Entra SIEMPRE por HTTPS (en esta PC o desde cualquier celular/tablet`);
  console.log(`   de la misma red) — si escribes por accidente la versión http, se`);
  console.log(`   redirige sola, pero es mejor guardar directo el enlace https:`);
  console.log(`     https://localhost:${HTTPS_PORT}/`);
  ipsLocales.forEach((ip) => console.log(`     https://${ip}:${HTTPS_PORT}/`));
  console.log(`     Panel de registros: https://localhost:${HTTPS_PORT}/registros.html`);
  console.log('');
  console.log(`   La primera vez, el navegador va a mostrar una advertencia de`);
  console.log(`   "conexión no segura" — es normal (es un certificado propio, no de`);
  console.log(`   una autoridad pública, porque el servidor no vive en internet).`);
  console.log(`   Hay que tocar "Avanzado" → "Continuar de todos modos" una sola vez,`);
  console.log(`   y siempre usando la MISMA dirección de ahí en adelante.`);
});

https.createServer(httpsOptions, app).listen(HTTPS_PORT);
