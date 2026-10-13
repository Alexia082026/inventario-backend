const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const QRCode = require("qrcode");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// En Railway puedes definir JWT_SECRET en Variables; si no existe usa la de siempre
const SECRET = process.env.JWT_SECRET || "clave_secreta_inventario";

const app = express();
app.use(bodyParser.json());
app.use(express.json());
app.use(cors());

// ======================================================
// CARPETAS DE ARCHIVOS (fotos y QR)
// ======================================================
const UPLOADS_DIR = path.join(__dirname, "uploads");
const QRS_DIR = path.join(__dirname, "qrs");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(QRS_DIR)) fs.mkdirSync(QRS_DIR, { recursive: true });

// 1. Configurar dónde se guardan las fotos
const upload = multer({ dest: UPLOADS_DIR });

// 2. Carpetas públicas (fotos y QR) -> https://TU-URL.up.railway.app/uploads/... y /qrs/...
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/qrs", express.static(QRS_DIR));

function generarQR(materialId) {
  const ruta = path.join(QRS_DIR, `${materialId}.png`);
  QRCode.toFile(
    ruta,
    String(materialId),
    {
      color: { dark: "#000000", light: "#FFFFFF" },
      margin: 2,
      width: 300,
    },
    function (err) {
      if (err) return console.error("Error generando QR:", err);
      console.log(`QR generado en: ${ruta}`);
    }
  );
}

// ======================================================
// CONEXIÓN A LA BASE DE DATOS
// En Railway usa las variables MYSQL*; en tu PC cae a XAMPP.
// Se usa un pool para que la conexión no se caiga por inactividad.
// ======================================================
const conexion = mysql.createPool({
  host: process.env.MYSQLHOST || "localhost",
  port: parseInt(process.env.MYSQLPORT || "3308", 10),
  user: process.env.MYSQLUSER || "root",
  password: process.env.MYSQLPASSWORD || "",
  database: process.env.MYSQLDATABASE || "inventario_db",
  waitForConnections: true,
  connectionLimit: 10,
});

conexion.getConnection((err, connection) => {
  if (err) {
    console.error("Error conectando a la base de datos:", err.message);
    return;
  }
  console.log("Conectado a la base de datos");
  connection.release();
});

app.get("/", (req, res) => {
  res.send("Bienvenido a Inventario API");
});

// --- Registrar Material (con foto y categoría) ---
app.post("/materiales", upload.single("foto"), (req, res) => {
  const { nombre, cantidad, estado, categoria } = req.body;
  // Guardamos la ruta relativa "uploads/archivo" (así la app arma baseUrl + "/" + foto)
  const foto = req.file ? `uploads/${req.file.filename}` : null;
  const sql =
    "INSERT INTO materiales (nombre, cantidad, estado, categoria, foto) VALUES (?, ?, ?, ?, ?)";

  conexion.query(sql, [nombre, cantidad, estado, categoria, foto], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message || String(err) });
    // Generamos el QR del material recién creado
    if (result && result.insertId) generarQR(result.insertId);
    res.json({ status: "ok", mensaje: "Material guardado con éxito" });
  });
});

// --- Consultar Materiales ---
app.get("/materiales", (req, res) => {
  const sql = "SELECT * FROM materiales";
  conexion.query(sql, (err, results) => {
    if (err) {
      res.status(500).json({ error: "Error en el servidor" });
    } else {
      res.json(results);
    }
  });
});

// --- Eliminar Material ---
app.delete("/materiales/:id", (req, res) => {
  const sql = "DELETE FROM materiales WHERE id = ?";
  conexion.query(sql, [req.params.id], (err, result) => {
    if (err) res.json({ status: "error" });
    else res.json({ status: "ok" });
  });
});

// --- Registrar Usuario (contraseña encriptada) ---
app.post("/registro", (req, res) => {
  const { nombre, correo, password, rol } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 8);
  const sql = "INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?, ?, ?, ?)";
  conexion.query(sql, [nombre, correo, hashedPassword, rol], (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message || String(err) });
    res.json({ status: "ok", mensaje: "Usuario registrado" });
  });
});

// --- Iniciar Sesión (contraseña encriptada + JWT) ---
app.post("/login", (req, res) => {
  const { correo, password } = req.body;
  const sql = "SELECT * FROM usuarios WHERE correo = ?";
  conexion.query(sql, [correo], (err, result) => {
    if (err || result.length === 0) {
      return res.json({ status: "error", mensaje: "Usuario no encontrado" });
    }

    const usuario = result[0];
    const passwordValido = bcrypt.compareSync(password, usuario.password);
    if (!passwordValido) {
      return res.json({ status: "error", mensaje: "Contraseña incorrecta" });
    }

    const token = jwt.sign({ id: usuario.id, rol: usuario.rol }, SECRET, { expiresIn: "1h" });
    res.json({ status: "ok", token, rol: usuario.rol, nombre: usuario.nombre });
  });
});

// --- Middleware de autenticación con JWT ---
function verificarToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.json({ status: "error", mensaje: "Token requerido" });

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.json({ status: "error", mensaje: "Token inválido" });
    req.usuario = decoded;
    next();
  });
}

// --- Ejemplo: ruta protegida, solo administrador ---
app.get("/admin/reportes", verificarToken, (req, res) => {
  if (req.usuario.rol !== "admin") {
    return res.json({ status: "error", mensaje: "Acceso denegado" });
  }
  res.json({ status: "ok", mensaje: "Bienvenido administrador" });
});

// --- Lista de maestros (para el dropdown "Docente" por nombre) ---
app.get("/usuarios/maestros", (req, res) => {
  const sql = "SELECT id, nombre FROM usuarios WHERE rol = 'maestro'";
  conexion.query(sql, (err, results) => {
    if (err) res.status(500).json(err);
    else res.json(results);
  });
});

// --- Registrar Préstamo (por nombre de maestro, validando permiso) ---
app.post("/prestamos", (req, res) => {
  const { material_id, fecha_prestamo, maestro } = req.body;
  // La app del QR manda fecha ISO completa (2026-10-13T10:00:00.000); nos quedamos con AAAA-MM-DD
  const fecha = fecha_prestamo ? String(fecha_prestamo).split("T")[0] : null;

  const sqlPermiso =
    "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE";

  conexion.query(sqlPermiso, [maestro, material_id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else if (result.length === 0) {
      res.json({ status: "fail", mensaje: "No tienes permiso para prestar este material" });
    } else {
      const sql = "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, ?, ?)";
      conexion.query(sql, [material_id, fecha, maestro], (err2, result2) => {
        if (err2) {
          res.json({ status: "error", mensaje: err2.message || String(err2) });
        } else {
          res.json({ status: "ok", mensaje: "Préstamo registrado" });
        }
      });
    }
  });
});

// --- Asignar permisos a un maestro sobre un material ---
app.post("/permisos", (req, res) => {
  const { maestro, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;
  const sql =
    "INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, ?, ?, ?)";
  conexion.query(
    sql,
    [maestro, material_id, puede_ver, puede_prestar, puede_devolver],
    (err, result) => {
      if (err) {
        res.json({ status: "error", mensaje: err.message || String(err) });
      } else {
        res.json({ status: "ok", mensaje: "Permiso asignado" });
      }
    }
  );
});

// --- Consultar Préstamos (JOIN con materiales, por nombre) ---
app.get("/prestamos", (req, res) => {
  const sql = `
    SELECT p.id, m.nombre AS material, p.maestro,
    p.fecha_prestamo, p.fecha_devolucion
    FROM prestamos p
    INNER JOIN materiales m ON p.material_id = m.id
  `;
  conexion.query(sql, (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message || String(err) });
    res.json(result);
  });
});

// --- Actualizar préstamo (fecha de devolución manual) ---
app.put("/prestamos/:id", (req, res) => {
  const { fecha_devolucion } = req.body;
  const sql = "UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?";
  conexion.query(sql, [fecha_devolucion, req.params.id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json({ status: "ok", mensaje: "Préstamo actualizado" });
    }
  });
});

// ======================================================
// DEVOLUCIONES
// OJO: tu Flutter llama a estas dos rutas (con /id/ y /qr/), que en tu
// server.js original NO existían y devolvían 404. Aquí quedan definidas.
// ======================================================

// --- Marcar devolución por ID de préstamo (botón verde de ListaPrestamos) ---
app.put("/prestamos/devolver/id/:id", (req, res) => {
  const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
  conexion.query(sql, [req.params.id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json({ status: "ok", mensaje: "Material devuelto" });
    }
  });
});

// --- Entrega vía QR (por material_id) ---
app.put("/prestamos/devolver/qr/:material_id", (req, res) => {
  const sql =
    "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL";
  conexion.query(sql, [req.params.material_id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else if (result.affectedRows === 0) {
      res.json({ status: "fail", mensaje: "No hay un préstamo pendiente para este material" });
    } else {
      res.json({ status: "ok", mensaje: "Entrega registrada" });
    }
  });
});

// --- Ruta antigua (Guía 5), se deja por compatibilidad ---
app.put("/prestamos/devolver/:id", (req, res) => {
  const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
  conexion.query(sql, [req.params.id], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json({ status: "ok", mensaje: "Material devuelto" });
    }
  });
});

// --- Total de préstamos ---
app.get("/reportes/total", (req, res) => {
  const sql = "SELECT COUNT(*) AS total FROM prestamos";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err.message || String(err) });
    else res.json(result[0]);
  });
});

// --- Préstamos pendientes (sin devolución) ---
app.get("/reportes/pendientes", (req, res) => {
  const sql = "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err.message || String(err) });
    else res.json(result[0]);
  });
});

// --- Préstamos devueltos ---
app.get("/reportes/devueltos", (req, res) => {
  const sql = "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL";
  conexion.query(sql, (err, result) => {
    if (err) res.json({ status: "error", mensaje: err.message || String(err) });
    else res.json(result[0]);
  });
});

// --- Notificaciones del administrador: todos los préstamos pendientes ---
// (tu Flutter llama a /notificaciones cuando entra el admin)
app.get("/notificaciones", (req, res) => {
  const sql = "SELECT * FROM prestamos WHERE fecha_devolucion IS NULL";
  conexion.query(sql, (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json(result);
    }
  });
});

// --- Notificaciones: préstamos pendientes de un maestro específico ---
app.get("/notificaciones/:maestro", (req, res) => {
  const sql = "SELECT * FROM prestamos WHERE maestro = ? AND fecha_devolucion IS NULL";
  conexion.query(sql, [req.params.maestro], (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json(result);
    }
  });
});

// --- Reportes filtrados en PDF ---
app.get("/reportes/pdf", (req, res) => {
  const { maestro, fecha_inicio, fecha_fin } = req.query;

  let sql = `SELECT p.id, m.nombre as material, p.maestro, p.fecha_prestamo
             FROM prestamos p
             INNER JOIN materiales m ON p.material_id = m.id WHERE 1=1`;
  let params = [];

  if (maestro) { sql += " AND p.maestro LIKE ?"; params.push(`%${maestro}%`); }
  if (fecha_inicio) { sql += " AND p.fecha_prestamo >= ?"; params.push(fecha_inicio); }
  if (fecha_fin) { sql += " AND p.fecha_prestamo <= ?"; params.push(fecha_fin); }

  conexion.query(sql, params, (err, results) => {
    if (err) return res.status(500).json(err);

    const doc = new PDFDocument();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=reporte.pdf");

    doc.pipe(res);
    doc.fontSize(20).text("Reporte de Inventario", { align: "center" });
    doc.moveDown();
    doc
      .fontSize(12)
      .text(
        `Filtros: Maestro: ${maestro || "Todos"}, Inicio: ${fecha_inicio || "N/A"}, Fin: ${fecha_fin || "N/A"}`
      );
    doc.moveDown();

    results.forEach((row) => {
      doc.text(
        `ID: ${row.id} | Material: ${row.material} | Maestro: ${row.maestro} | Fecha: ${row.fecha_prestamo}`
      );
      doc.moveDown(0.5);
    });

    doc.end();
  });
});

// --- Reportes filtrados en Excel ---
app.get("/reportes/excel", (req, res) => {
  const { maestro, fecha_inicio, fecha_fin } = req.query;

  let sql = `SELECT p.id, m.nombre as material, p.maestro, p.fecha_prestamo
             FROM prestamos p
             INNER JOIN materiales m ON p.material_id = m.id WHERE 1=1`;
  let params = [];

  if (maestro) { sql += " AND p.maestro LIKE ?"; params.push(`%${maestro}%`); }
  if (fecha_inicio) { sql += " AND p.fecha_prestamo >= ?"; params.push(fecha_inicio); }
  if (fecha_fin) { sql += " AND p.fecha_prestamo <= ?"; params.push(fecha_fin); }

  conexion.query(sql, params, async (err, results) => {
    if (err) return res.status(500).json(err);

    let workbook = new ExcelJS.Workbook();
    let worksheet = workbook.addWorksheet("Reporte");

    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Material", key: "material", width: 30 },
      { header: "Maestro", key: "maestro", width: 30 },
      { header: "Fecha Préstamo", key: "fecha", width: 20 },
    ];

    results.forEach((row) => {
      worksheet.addRow({
        id: row.id,
        material: row.material,
        maestro: row.maestro,
        fecha: row.fecha_prestamo,
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=reporte.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  });
});

// --- Métricas del Dashboard ---
app.get("/dashboard", (req, res) => {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM materiales) AS total_materiales,
      (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NULL) AS prestados,
      (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NOT NULL) AS devueltos,
      (SELECT COUNT(*) FROM materiales WHERE estado = 'dañado') AS danados
  `;
  conexion.query(sql, (err, result) => {
    if (err) {
      res.json({ status: "error", mensaje: err.message || String(err) });
    } else {
      res.json(result[0]);
    }
  });
});

// --- Historial de préstamos (filtrado por maestro, material y fechas) ---
app.get("/historial", (req, res) => {
  const { maestro, material, fecha_inicio, fecha_fin } = req.query;
  let sql = `
    SELECT p.id, m.nombre AS material, p.maestro AS docente,
           p.fecha_prestamo, p.fecha_devolucion
    FROM prestamos p
    INNER JOIN materiales m ON p.material_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (maestro) {
    sql += " AND p.maestro = ?";
    params.push(maestro);
  }
  if (material) {
    sql += " AND m.nombre = ?";
    params.push(material);
  }
  if (fecha_inicio && fecha_fin) {
    sql += " AND p.fecha_prestamo BETWEEN ? AND ?";
    params.push(fecha_inicio, fecha_fin);
  }

  sql += " ORDER BY p.fecha_prestamo DESC";

  conexion.query(sql, params, (err, result) => {
    if (err) return res.json({ status: "error", mensaje: err.message || String(err) });
    res.json(result);
  });
});

// ======================================================
// ARRANQUE: Railway asigna el puerto en process.env.PORT
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
