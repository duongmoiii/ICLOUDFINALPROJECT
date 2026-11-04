
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Kết nối Railway MySQL
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true
});

// Xử lý lỗi async
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const status = err.status || 500;

      if (status >= 500) {
        console.error("API error:", err.code || err.message);
      }

      res.status(status).json({
        message: err.message || "Lỗi server."
      });
    });
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Mã hóa mật khẩu bằng PBKDF2
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    10000,
    64,
    "sha512"
  ).toString("hex");

  return `${salt}:${hash}`;
}

// Kiểm tra mật khẩu
function verifyPassword(password, stored) {
  if (!stored) return false;

  const [salt, originalHash] = stored.split(":");

  if (!salt || !originalHash) return false;

  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    10000,
    64,
    "sha512"
  ).toString("hex");

  const original = Buffer.from(originalHash, "hex");
  const current = Buffer.from(hash, "hex");

  return original.length === current.length &&
    crypto.timingSafeEqual(original, current);
}

// Token đăng nhập trong bộ nhớ
const activeTokens = new Map();

function generateToken(user) {
  const token = crypto.randomBytes(32).toString("hex");

  activeTokens.set(token, {
    id: user.id,
    username: user.username,
    role: user.role
  });

  return token;
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({
      message: "Chưa đăng nhập hoặc token hết hạn."
    });
  }
  try {
    const session = activeTokens.get(token);
    let rows = [];
    if (session.role === "admin") {
      [rows] = await pool.execute(
        "SELECT role, is_locked FROM admins WHERE id=? AND role='admin'",
        [session.id]
      );
    } else {
      [rows] = await pool.execute(
        "SELECT role, is_locked FROM users WHERE id=?",
        [session.id]
      );
    }
    if (!rows[0] || rows[0].is_locked) {
      activeTokens.delete(token);
      return res.status(401).json({ message: "Tài khoản đã bị khóa." });
    }
    req.user = { ...activeTokens.get(token), role: rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Tài khoản không có quyền thực hiện thao tác này."
      });
    }
    next();
  };
}

// Kiểm tra kết nối database
app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");

  res.json({
    status: "ok",
    database: "connected"
  });
}));

// Danh sách và tìm kiếm sản phẩm
app.get("/api/products", authMiddleware, wrap(async (req, res) => {
  const keyword = String(req.query.search || "").trim();
  const fields = req.user.role === "admin"
    ? "p.*"
    : "p.id,p.product_code,p.sku,p.name,p.image,p.category_id,p.brand_id,p.price,p.quantity,p.status,p.low_stock_threshold,p.created_at,p.import_date";
  let sql = `SELECT ${fields}, c.name AS category_name, b.name AS brand_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id WHERE 1=1`;
  const params = [];
  if (keyword) {
    sql += ` AND (p.product_code LIKE ? OR COALESCE(p.sku,'') LIKE ? OR p.name LIKE ?)`;
    const search = `%${keyword}%`;
    params.push(search, search, search);
  }
  if (req.query.category) { sql += " AND p.category_id = ?"; params.push(Number(req.query.category)); }
  if (req.query.brand) { sql += " AND p.brand_id = ?"; params.push(Number(req.query.brand)); }
  if (req.query.status) { sql += " AND p.status = ?"; params.push(String(req.query.status)); }
  const sort = ({
    name_asc: "p.name ASC", name_desc: "p.name DESC",
    price_asc: "p.price ASC", price_desc: "p.price DESC",
    quantity_asc: "p.quantity ASC", quantity_desc: "p.quantity DESC",
    newest: "p.id DESC"
  })[req.query.sort] || "p.id DESC";
  sql += " ORDER BY " + sort;
  const [rows] = await pool.execute(sql, params);
  res.json(rows);
}));

// Thêm sản phẩm
app.post("/api/products", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const { product_code, sku, name, category_id, brand_id, image, status,
    cost_price, price, quantity, low_stock_threshold, import_date } = req.body;
  const code = String(sku || product_code || "").trim();
  const productName = String(name || "").trim();
  const productPrice = Number(price);
  const productCost = Number(cost_price || 0);
  const productQuantity = Number(quantity);
  if (
    !code ||
    !productName ||
    !Number.isFinite(productPrice) ||
    productPrice <= 0 ||
    !Number.isInteger(productQuantity) ||
    productQuantity < 0
  ) {
    throw httpError(400, "Vui lòng nhập mã SKU, tên, giá bán và số lượng hợp lệ.");
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO products
       (product_code, sku, name, category_id, brand_id, image, cost_price, price,
        quantity, status, low_stock_threshold, import_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, code, productName, category_id || null, brand_id || null, image || null,
       productCost, productPrice, productQuantity, status === "inactive" ? "inactive" : "active",
       Number(low_stock_threshold || 5), import_date || null]
    );
    res.status(201).json({ message: "Thêm sản phẩm thành công.", id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      throw httpError(409, "Mã sản phẩm đã tồn tại.");
    }

    throw error;
  }
}));

app.put("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const quantity = Number(b.quantity);
  const price = Number(b.price);
  const cost = Number(b.cost_price || 0);
  if (!Number.isInteger(quantity) || quantity < 0 || !Number.isFinite(price) || price <= 0) {
    throw httpError(400, "Giá bán và số lượng không hợp lệ.");
  }
  await pool.execute(`
    UPDATE products SET product_code=?, sku=?, name=?, category_id=?, brand_id=?, image=?,
    cost_price=?, price=?, quantity=?, status=?, low_stock_threshold=?, import_date=? WHERE id=?`,
    [b.sku || b.product_code, b.sku || b.product_code, String(b.name || "").trim(),
     b.category_id || null, b.brand_id || null, b.image || null, cost, price, quantity,
     b.status === "inactive" ? "inactive" : "active", Number(b.low_stock_threshold || 5),
     b.import_date || null, id]
  );
  res.json({ message: "Cập nhật sản phẩm thành công." });
}));

app.delete("/api/products/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM products WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa sản phẩm." });
}));

app.get("/api/categories", wrap(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM categories ORDER BY name");
  res.json(rows);
}));
app.post("/api/categories", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Tên danh mục không được để trống.");
  await pool.execute("INSERT INTO categories (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Đã tạo danh mục." });
}));
app.delete("/api/categories/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM categories WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa danh mục." });
}));

app.get("/api/brands", wrap(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM brands ORDER BY name");
  res.json(rows);
}));
app.post("/api/brands", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) throw httpError(400, "Tên thương hiệu không được để trống.");
  await pool.execute("INSERT INTO brands (name) VALUES (?)", [name]);
  res.status(201).json({ message: "Đã tạo thương hiệu." });
}));
app.delete("/api/brands/:id", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  await pool.execute("DELETE FROM brands WHERE id=?", [Number(req.params.id)]);
  res.json({ message: "Đã xóa thương hiệu." });
}));

app.post("/api/inventory/movement", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const productId = Number(req.body.product_id);
  const type = req.body.type === "out" ? "out" : "in";
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
    throw httpError(400, "Thông tin nhập/xuất kho không hợp lệ.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT quantity FROM products WHERE id=? FOR UPDATE", [productId]);
    if (!rows[0]) throw httpError(404, "Không tìm thấy sản phẩm.");
    const nextQuantity = type === "in" ? rows[0].quantity + quantity : rows[0].quantity - quantity;
    if (nextQuantity < 0) throw httpError(400, "Số lượng xuất vượt quá tồn kho.");
    await connection.execute("UPDATE products SET quantity=? WHERE id=?", [nextQuantity, productId]);
    await connection.execute(
      "INSERT INTO inventory_movements (product_id,type,quantity,note,user_id) VALUES (?,?,?,?,?)",
      [productId, type, quantity, String(req.body.note || "").trim(), req.user.id]
    );
    await connection.commit();
    res.json({ message: type === "in" ? "Đã nhập kho." : "Đã xuất kho.", quantity: nextQuantity });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

app.get("/api/inventory/movements", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT m.*, p.name AS product_name, p.product_code, u.full_name AS user_name
    FROM inventory_movements m
    JOIN products p ON p.id=m.product_id
    LEFT JOIN users u ON u.id=m.user_id
    ORDER BY m.created_at DESC LIMIT 300
  `);
  res.json(rows);
}));

app.post("/api/products/import", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const workbook = XLSX.read(req.body.base64, { type: "base64" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  let imported = 0;
  for (const row of rows) {
    const code = String(row.SKU || row.sku || row["Mã SKU"] || "").trim();
    const name = String(row["Tên sản phẩm"] || row.name || "").trim();
    const price = Number(row["Giá bán"] || row.price || 0);
    const cost = Number(row["Giá nhập"] || row.cost_price || 0);
    const quantity = Number(row["Số lượng"] || row.quantity || 0);
    if (!code || !name || !Number.isFinite(price) || price <= 0 || !Number.isInteger(quantity) || quantity < 0) continue;
    await pool.execute(`
      INSERT INTO products (product_code,sku,name,cost_price,price,quantity,status,low_stock_threshold)
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE name=VALUES(name),cost_price=VALUES(cost_price),price=VALUES(price),quantity=VALUES(quantity)
    `, [code, code, name, cost, price, quantity, "active", 5]);
    imported++;
  }
  res.json({ message: `Đã nhập ${imported} sản phẩm.`, imported });
}));

// Đăng ký tài khoản
app.post("/api/register", wrap(async (req, res) => {
  const username = String(req.body.username || "")
    .trim()
    .slice(0, 50);

  const fullName = String(req.body.full_name || "")
    .trim()
    .slice(0, 100);

  const password = String(req.body.password || "");

  if (!username || !fullName || password.length < 6) {
    throw httpError(
      400,
      "Nhập đủ họ tên, tên đăng nhập và mật khẩu từ 6 ký tự."
    );
  }

  const passwordHash = hashPassword(password);

  try {
    await pool.execute(
      `INSERT INTO users
       (username, full_name, password_hash, role)
       VALUES (?, ?, ?, ?)`,
      [username, fullName, passwordHash, "viewer"]
    );

    res.status(201).json({
      message: "Đăng ký thành công."
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      throw httpError(409, "Tên đăng nhập đã tồn tại.");
    }

    throw error;
  }
}));

// Đăng nhập
app.post("/api/login", wrap(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const [adminRows] = await pool.execute(
    `SELECT id, username, full_name, password_hash, role, is_locked
     FROM admins WHERE username=?`,
    [username]
  );
  if (adminRows[0]) {
    const admin = adminRows[0];
    if (!verifyPassword(password, admin.password_hash)) {
      throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
    }
    if (admin.is_locked) {
      throw httpError(403, "Tài khoản đã bị khóa.");
    }
    const token = generateToken(admin);
    return res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        full_name: admin.full_name,
        role: "admin"
      }
    });
  }

  const [rows] = await pool.execute(
    `SELECT id, username, full_name, password_hash, role, is_locked
     FROM users
     WHERE username = ?`,
    [username]
  );

  const user = rows[0];

  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
  }
  if (user.is_locked) {
    throw httpError(403, "Tài khoản đã bị khóa.");
  }

  const token = generateToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    }
  });
}));

// Thông tin người dùng hiện tại
app.get("/api/me", authMiddleware, wrap(async (req, res) => {
  const [rows] = req.user.role === "admin"
    ? await pool.execute(
      `SELECT id, username, full_name, 'admin' AS role
       FROM admins WHERE id=?`,
      [req.user.id]
    )
    : await pool.execute(
      `SELECT id, username, full_name, role
       FROM users WHERE id=?`,
      [req.user.id]
    );

  const user = rows[0];

  if (!user) {
    throw httpError(404, "Không tìm thấy người dùng.");
  }

  res.json(user);
}));

// Thống kê dashboard
app.get("/api/stats", authMiddleware, requireRoles("admin"), wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT
      COUNT(*) AS total_products,
      COALESCE(SUM(quantity), 0) AS total_stock,
      COALESCE(SUM(quantity * cost_price), 0) AS stock_value
    FROM products
  `);
  const [lowStock] = await pool.execute(`
    SELECT id, product_code, name, price, quantity, low_stock_threshold, created_at
    FROM products
    WHERE quantity <= low_stock_threshold
    ORDER BY quantity ASC
  `);
  const [movementRows] = await pool.execute(`
    SELECT DATE(created_at) AS day,
      SUM(CASE WHEN type='in' THEN quantity ELSE 0 END) AS incoming,
      SUM(CASE WHEN type='out' THEN quantity ELSE 0 END) AS outgoing
    FROM inventory_movements
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
    GROUP BY DATE(created_at)
    ORDER BY day ASC
  `);
  const chart = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("sv-SE");
    const found = movementRows.find((r) => String(r.day).slice(0, 10) === key);
    chart.push({ label: d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }),
      incoming: Number(found?.incoming || 0), outgoing: Number(found?.outgoing || 0) });
  }
  res.json({
    products: Number(rows[0].total_products),
    stock: Number(rows[0].total_stock),
    stockValue: Number(rows[0].stock_value),
    chart,
    lowStock
  });
}));

// Danh sách tài khoản - chỉ admin
app.get("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") {
    throw httpError(403, "Không có quyền.");
  }

  const [rows] = await pool.execute(`
    SELECT id, username, full_name, 'user' AS account_type, role, is_locked, created_at
    FROM users
    ORDER BY id DESC
  `);
  const [adminRows] = await pool.execute(`
    SELECT id, username, full_name, 'admin' AS account_type, role, is_locked, created_at
    FROM admins
    ORDER BY id DESC
  `);
  res.json([...adminRows, ...rows]);
}));

// Admin tạo tài khoản
app.post("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") {
    throw httpError(403, "Không có quyền.");
  }

  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.full_name || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "viewer";

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Thiếu thông tin hoặc mật khẩu quá ngắn.");
  }

  try {
    const passwordHash = hashPassword(password);
    if (role === "admin") {
      await pool.execute(
        `INSERT INTO admins
         (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', FALSE)`,
        [username, fullName, passwordHash]
      );
    } else {
      await pool.execute(
        `INSERT INTO users
         (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'viewer', FALSE)`,
        [username, fullName, passwordHash]
      );
    }

    res.status(201).json({
      message: "Tạo tài khoản thành công."
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      throw httpError(409, "Tên đăng nhập đã tồn tại.");
    }

    throw error;
  }
}));

// Cập nhật tài khoản
app.put("/api/users/:id", authMiddleware, wrap(async (req, res) => {
  const targetId = Number(req.params.id);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "ID không hợp lệ.");
  }

  if (req.user.role !== "admin" && req.user.id !== targetId) {
    throw httpError(403, "Không có quyền.");
  }

  let source = null;
  const requestedType = req.body.account_type === "admin" ? "admin" : req.body.account_type === "user" ? "user" : null;
  if (requestedType !== "user") {
    const [adminRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM admins WHERE id=?",
      [targetId]
    );
    if (adminRows[0]) source = { type: "admin", ...adminRows[0] };
  }
  if (!source && requestedType !== "admin") {
    const [userRows] = await pool.execute(
      "SELECT id, username, full_name, password_hash FROM users WHERE id=?",
      [targetId]
    );
    if (userRows[0]) source = { type: "user", ...userRows[0] };
  }
  if (!source) {
    throw httpError(404, "Không tìm thấy tài khoản.");
  }

  const password = req.body.password ? String(req.body.password) : "";
  if (password && password.length < 6) {
    throw httpError(400, "Mật khẩu phải có ít nhất 6 ký tự.");
  }
  const passwordHash = password ? hashPassword(password) : source.password_hash;

  if (req.user.role === "admin" && req.body.role) {
    const desiredType = req.body.role === "admin" ? "admin" : "user";
    if (source.type !== desiredType) {
      if (desiredType === "admin") {
        await pool.execute(
          `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM users WHERE id=?", [targetId]);
      } else {
        await pool.execute(
          `INSERT INTO users (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'viewer', FALSE)`,
          [source.username, source.full_name, passwordHash]
        );
        await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
      }
      return res.json({ message: "Cập nhật vai trò thành công." });
    }
  }

  const updateData = { password_hash: passwordHash };
  if (typeof req.body.is_locked === "boolean" && req.user.role === "admin") {
    updateData.is_locked = req.body.is_locked ? 1 : 0;
  }
  const fields = Object.keys(updateData).map((key) => `${key}=?`);
  const values = [...Object.values(updateData), targetId];
  await pool.execute(
    `UPDATE ${source.type === "admin" ? "admins" : "users"} SET ${fields.join(",")} WHERE id=?`,
    values
  );
  res.json({ message: "Cập nhật thành công." });
}));

// Xóa tài khoản
app.delete("/api/users/:id", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") {
    throw httpError(403, "Không có quyền.");
  }

  const targetId = Number(req.params.id);

  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw httpError(400, "ID không hợp lệ.");
  }

  if (req.user.id === targetId) {
    throw httpError(
      400,
      "Không thể tự xóa tài khoản của chính mình."
    );
  }

  const [adminResult] = await pool.execute("DELETE FROM admins WHERE id=?", [targetId]);
  const [userResult] = await pool.execute("DELETE FROM users WHERE id=?", [targetId]);

  if (adminResult.affectedRows === 0 && userResult.affectedRows === 0) {
    throw httpError(404, "Không tìm thấy tài khoản.");
  }

  res.json({
    message: "Đã xóa tài khoản."
  });
}));

// Tạo bảng MySQL và khởi động server
async function startServer() {
  try {
    console.log("Đang kết nối Railway MySQL...");

    const connection = await pool.getConnection();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_code VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        quantity INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const productColumns = [
      ["sku", "VARCHAR(100) NULL"],
      ["image", "LONGTEXT NULL"],
      ["category_id", "INT NULL"],
      ["brand_id", "INT NULL"],
      ["cost_price", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
      ["status", "VARCHAR(20) NOT NULL DEFAULT 'active'"],
      ["low_stock_threshold", "INT NOT NULL DEFAULT 5"],
      ["import_date", "DATE NULL"]
    ];
    for (const [column, definition] of productColumns) {
      const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = ?`,
        [column]
      );
      if (!rows[0].total) {
        await connection.execute(`ALTER TABLE products ADD COLUMN ${column} ${definition}`);
      }
    }
    await connection.execute("UPDATE products SET sku=product_code WHERE sku IS NULL OR sku=''");

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS brands (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        type VARCHAR(10) NOT NULL,
        quantity INT NOT NULL,
        note VARCHAR(255),
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_product_movement (product_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'admin',
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    const [adminLockColumn] = await connection.execute(
      `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'is_locked'`
    );
    if (!adminLockColumn[0].total) {
      await connection.execute("ALTER TABLE admins ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE");
    }
    const [lockColumn] = await connection.execute(
      `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_locked'`
    );
    if (!lockColumn[0].total) {
      await connection.execute("ALTER TABLE users ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE");
    }
    await connection.execute("UPDATE users SET role='admin' WHERE role IN ('admin')");
    await connection.execute("UPDATE users SET role='viewer' WHERE role IN ('staff','warehouse')");
    await connection.execute(
      "UPDATE users SET is_locked=FALSE WHERE role='admin'"
    );

    const [legacyAdmins] = await connection.execute(
      "SELECT username, full_name, password_hash, is_locked FROM users WHERE role='admin'"
    );
    for (const legacyAdmin of legacyAdmins) {
      await connection.execute(
        `INSERT INTO admins (username, full_name, password_hash, role, is_locked)
         VALUES (?, ?, ?, 'admin', ?)
         ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), password_hash=VALUES(password_hash), is_locked=VALUES(is_locked)`,
        [legacyAdmin.username, legacyAdmin.full_name, legacyAdmin.password_hash, Boolean(legacyAdmin.is_locked)]
      );
      await connection.execute("DELETE FROM users WHERE username=?", [legacyAdmin.username]);
    }

    const adminUsername = String(process.env.ADMIN_USERNAME || "admin").trim();
    const adminPassword = String(process.env.ADMIN_PASSWORD || "Admin123456");
    if (adminUsername && adminPassword.length >= 6) {
      const [adminRows] = await connection.execute(
        "SELECT id FROM admins WHERE username=?",
        [adminUsername]
      );
      if (adminRows.length === 0) {
        await connection.execute(
          `INSERT INTO admins
           (username, full_name, password_hash, role, is_locked)
           VALUES (?, ?, ?, 'admin', FALSE)`,
          [adminUsername, "Quản lý hệ thống", hashPassword(adminPassword)]
        );
        console.log(`Default admin account created: ${adminUsername}`);
      } else {
        console.log(`Admin account ready: ${adminUsername}`);
      }
    }

    connection.release();

    await pool.query("SELECT 1");

    console.log("MySQL connected successfully.");
    console.log("Products and users tables are ready.");

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });

  } catch (error) {
    console.error("Application startup failed:");
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);

    process.exit(1);
  }
}

startServer();
