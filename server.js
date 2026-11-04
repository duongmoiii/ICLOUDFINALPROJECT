
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({
      message: "Chưa đăng nhập hoặc token hết hạn."
    });
  }

  req.user = activeTokens.get(token);
  next();
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
app.get("/api/products", wrap(async (req, res) => {
  const keyword = String(req.query.search || "").trim();

  let sql = `
    SELECT
      id,
      product_code,
      name,
      price,
      quantity,
      created_at
    FROM products
  `;

  const params = [];

  if (keyword) {
    sql += `
      WHERE product_code LIKE ?
      OR name LIKE ?
    `;

    const search = `%${keyword}%`;
    params.push(search, search);
  }

  sql += " ORDER BY id DESC";

  const [rows] = await pool.execute(sql, params);

  res.json(rows);
}));

// Thêm sản phẩm
app.post("/api/products", wrap(async (req, res) => {
  const { product_code, name, price, quantity } = req.body;

  const code = String(product_code || "").trim();
  const productName = String(name || "").trim();
  const productPrice = Number(price);
  const productQuantity = Number(quantity);

  if (
    !code ||
    !productName ||
    !Number.isFinite(productPrice) ||
    productPrice <= 0 ||
    !Number.isInteger(productQuantity) ||
    productQuantity < 0
  ) {
    throw httpError(
      400,
      "Vui lòng nhập mã, tên, giá hợp lệ và số lượng không âm."
    );
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO products
       (product_code, name, price, quantity)
       VALUES (?, ?, ?, ?)`,
      [code, productName, productPrice, productQuantity]
    );

    res.status(201).json({
      message: "Thêm sản phẩm thành công.",
      id: result.insertId
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      throw httpError(409, "Mã sản phẩm đã tồn tại.");
    }

    throw error;
  }
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
      [username, fullName, passwordHash, "staff"]
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

  const [rows] = await pool.execute(
    `SELECT id, username, full_name, password_hash, role
     FROM users
     WHERE username = ?`,
    [username]
  );

  const user = rows[0];

  if (!user || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Sai tên đăng nhập hoặc mật khẩu.");
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
  const [rows] = await pool.execute(
    `SELECT id, username, full_name, role
     FROM users
     WHERE id = ?`,
    [req.user.id]
  );

  const user = rows[0];

  if (!user) {
    throw httpError(404, "Không tìm thấy người dùng.");
  }

  res.json(user);
}));

// Thống kê dashboard
app.get("/api/stats", authMiddleware, wrap(async (req, res) => {
  const [rows] = await pool.execute(`
    SELECT
      COUNT(*) AS total_products,
      COALESCE(SUM(quantity), 0) AS total_stock
    FROM products
  `);

  const [lowStock] = await pool.execute(`
    SELECT id, product_code, name, price, quantity, created_at
    FROM products
    WHERE quantity < 5
    ORDER BY quantity ASC
  `);

  const last7days = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    last7days.push({
      label: d.toLocaleDateString("vi-VN", {
        weekday: "short",
        day: "numeric",
        month: "numeric"
      }),
      total: 0
    });
  }

  res.json({
    revenue: 0,
    todayRevenue: 0,
    orders: 0,
    products: Number(rows[0].total_products),
    stock: Number(rows[0].total_stock),
    last7days,
    topProducts: [],
    lowStock
  });
}));

// Danh sách tài khoản - chỉ admin
app.get("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") {
    throw httpError(403, "Không có quyền.");
  }

  const [rows] = await pool.execute(`
    SELECT id, username, full_name, role, created_at
    FROM users
    ORDER BY id DESC
  `);

  res.json(rows);
}));

// Admin tạo tài khoản
app.post("/api/users", authMiddleware, wrap(async (req, res) => {
  if (req.user.role !== "admin") {
    throw httpError(403, "Không có quyền.");
  }

  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.full_name || "").trim();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "staff";

  if (!username || !fullName || password.length < 6) {
    throw httpError(400, "Thiếu thông tin hoặc mật khẩu quá ngắn.");
  }

  try {
    await pool.execute(
      `INSERT INTO users
       (username, full_name, password_hash, role)
       VALUES (?, ?, ?, ?)`,
      [username, fullName, hashPassword(password), role]
    );

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

  const updateData = {};

  if (req.body.role && req.user.role === "admin") {
    updateData.role = req.body.role === "admin" ? "admin" : "staff";
  }

  if (req.body.password) {
    const password = String(req.body.password);

    if (password.length < 6) {
      throw httpError(400, "Mật khẩu phải có ít nhất 6 ký tự.");
    }

    updateData.password_hash = hashPassword(password);
  }

  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updateData)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) {
    return res.json({
      message: "Không có thông tin cần cập nhật."
    });
  }

  values.push(targetId);

  const [result] = await pool.execute(
    `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw httpError(404, "Không tìm thấy tài khoản.");
  }

  res.json({
    message: "Cập nhật thành công."
  });
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

  const [result] = await pool.execute(
    "DELETE FROM users WHERE id = ?",
    [targetId]
  );

  if (result.affectedRows === 0) {
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

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        full_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'staff',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

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
