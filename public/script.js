const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => Number(n || 0).toLocaleString("vi-VN") + " đ";
const fmtDate = (s) => s ? new Date(s).toLocaleString("vi-VN") : "-";
const STATUS = { pending: "Chờ xác nhận", confirmed: "Đã xác nhận", shipping: "Đang giao", completed: "Hoàn thành", cancelled: "Đã hủy" };
const PHONE_RE = /^[0-9+\s.-]{8,20}$/;

let me = null, products = [], shopItems = [], cartProducts = new Map();
let categories = [], brands = [], cart = [];
let editingId = null, imageData = null, detailProduct = null, buyProduct = null;
let toastTimer, productTimer, shopTimer;

async function api(path, method = "GET", body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (localStorage.token || "") },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  // Đăng nhập sai cũng trả 401 nên không được tải lại trang ở trường hợp này
  if (res.status === 401 && path !== "/login") { localStorage.removeItem("token"); location.reload(); }
  if (!res.ok) throw new Error(data.message || "Có lỗi xảy ra.");
  return data;
}
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = "toast", 2800);
}
const run = fn => async (...args) => { try { await fn(...args) } catch (e) { toast(e.message, true) } };

/* ================= ĐĂNG NHẬP / ĐĂNG KÝ ================= */
async function afterAuth(token) {
  localStorage.token = token;
  await start(await api("/me"));
}
$("#loginForm").addEventListener("submit", run(async e => {
  e.preventDefault();
  const r = await api("/login", "POST", { username: $("#username").value, password: $("#password").value });
  await afterAuth(r.token);
}));
$("#registerForm").addEventListener("submit", run(async e => {
  e.preventDefault();
  const pw = $("#regPassword").value;
  if (pw !== $("#regConfirm").value) throw new Error("Mật khẩu nhập lại không khớp.");
  const username = $("#regUsername").value.trim();
  await api("/register", "POST", { username, full_name: $("#regFullName").value, password: pw });
  const r = await api("/login", "POST", { username, password: pw });
  await afterAuth(r.token);
  toast("Đăng ký thành công. Chào mừng bạn!");
}));
$("#showRegister").onclick = e => { e.preventDefault(); $("#loginForm").hidden = true; $("#registerForm").hidden = false; };
$("#showLogin").onclick = e => { e.preventDefault(); $("#registerForm").hidden = true; $("#loginForm").hidden = false; };
$("#logout").onclick = () => { localStorage.removeItem("token"); location.reload() };

function renderWho() {
  $("#whoami").textContent = `${me.full_name} · ${me.role === "admin" ? "Quản lý" : "Khách hàng"}`;
}
async function start(user) {
  me = user;
  const isAdmin = me.role === "admin";
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderWho();
  $$(".adminOnly").forEach(el => el.hidden = !isAdmin);
  $$(".customerOnly").forEach(el => el.hidden = isAdmin);
  loadCart();
  await loadCatalog();
  showTab(isAdmin ? "dashboard" : "shop");
}

/* ================= ĐIỀU HƯỚNG ================= */
const views = {
  dashboard: () => loadStats(),
  products: () => loadProducts(),
  catalog: () => loadCatalog(),
  inventory: () => loadInventory(),
  orders: () => loadAdminOrders(),
  users: () => loadUsers(),
  shop: () => loadShop(),
  cart: () => renderCart(),
  myorders: () => loadMyOrders(),
  profile: () => loadProfile()
};
$$(".tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(name) {
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  $$(".view").forEach(v => v.hidden = v.id !== name);
  views[name]?.();
}

/* ================= TỔNG QUAN (QUẢN LÝ) ================= */
const loadStats = run(async () => {
  const s = await api("/stats");
  const cards = [
    ["Tổng sản phẩm", s.products], ["Số lượng tồn", s.stock], ["Giá trị tồn kho", money(s.stockValue)],
    ["Doanh thu (đơn hoàn thành)", money(s.revenue)],
    ["Đơn chờ xác nhận", s.pendingOrders, s.pendingOrders > 0],
    ["Sắp hết hàng", s.lowStock.length, s.lowStock.length > 0]
  ];
  $("#stats").innerHTML = cards.map(([l, v, warn]) => `<div class="stat${warn ? " warning" : ""}"><span>${l}</span><b>${v}</b></div>`).join("");
  const max = Math.max(...s.chart.flatMap(d => [d.incoming, d.outgoing]), 1);
  $("#chart").innerHTML = s.chart.map(d => `<div class="chartGroup"><i class="in" style="height:${d.incoming / max * 160}px"></i><i class="out" style="height:${d.outgoing / max * 160}px"></i><small>${d.label}</small></div>`).join("");
  $("#lowStock").innerHTML = s.lowStock.length ? s.lowStock.map(p => `<div class="listRow"><span>${esc(p.name)}<small>${esc(p.product_code)}</small></span><b class="low">Còn ${p.quantity}</b></div>`).join("") : "<div class='empty'>Không có sản phẩm sắp hết.</div>";
});

/* ================= DANH MỤC & THƯƠNG HIỆU ================= */
async function loadCatalog() {
  [categories, brands] = await Promise.all([api("/categories"), api("/brands")]);
  const catOpts = categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const brandOpts = brands.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  $("#categoryFilter").innerHTML = '<option value="">Tất cả danh mục</option>' + catOpts;
  $("#shopCategory").innerHTML = '<option value="">Tất cả danh mục</option>' + catOpts;
  $("#brandFilter").innerHTML = '<option value="">Tất cả thương hiệu</option>' + brandOpts;
  $("#productCategory").innerHTML = '<option value="">Không có</option>' + catOpts;
  $("#productBrand").innerHTML = '<option value="">Không có</option>' + brandOpts;
  const del = (attr, id) => me.role === "admin" ? `<button class="btn ghost sm danger" ${attr}="${id}">Xóa</button>` : "";
  $("#categories").innerHTML = categories.map(c => `<div class="listRow"><span>${esc(c.name)}</span>${del("data-delete-category", c.id)}</div>`).join("") || "<div class='empty'>Chưa có danh mục.</div>";
  $("#brands").innerHTML = brands.map(b => `<div class="listRow"><span>${esc(b.name)}</span>${del("data-delete-brand", b.id)}</div>`).join("") || "<div class='empty'>Chưa có thương hiệu.</div>";
}
const loadCatalogRun = run(loadCatalog);
$("#catalog").addEventListener("click", run(async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.deleteCategory) { await api("/categories/" + b.dataset.deleteCategory, "DELETE"); toast("Đã xóa danh mục"); loadCatalogRun() }
  if (b.dataset.deleteBrand) { await api("/brands/" + b.dataset.deleteBrand, "DELETE"); toast("Đã xóa thương hiệu"); loadCatalogRun() }
}));
$("#addCategory").onclick = run(async () => { const name = prompt("Tên danh mục"); if (name) { await api("/categories", "POST", { name }); loadCatalog(); toast("Đã thêm danh mục") } });
$("#addBrand").onclick = run(async () => { const name = prompt("Tên thương hiệu"); if (name) { await api("/brands", "POST", { name }); loadCatalog(); toast("Đã thêm thương hiệu") } });

/* ================= THẺ SẢN PHẨM (DẠNG LƯỚI) ================= */
function productCard(p, admin) {
  const out = p.quantity <= 0;
  const low = p.quantity <= p.low_stock_threshold;
  const img = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="noimg">Chưa có ảnh</div>`;
  const meta = [p.category_name, p.brand_name].filter(Boolean).map(esc).join(" · ") || "Chưa phân loại";
  const adminBadge = admin ? `<span class="status ${p.status} cardBadge">${p.status === "inactive" ? "Ngừng bán" : "Đang bán"}</span>` : "";
  const soldOut = out ? `<span class="soldout">Hết hàng</span>` : "";
  const cost = admin ? `<small class="sub">Giá nhập: ${money(p.cost_price)}</small>` : "";
  const actions = admin
    ? `<button class="btn ghost sm" data-edit="${p.id}">Sửa</button><button class="btn ghost sm danger" data-delete="${p.id}">Xóa</button>`
    : `<button class="btn ghost sm" data-add="${p.id}" ${out ? "disabled" : ""}>Thêm vào giỏ</button><button class="btn sm" data-buy="${p.id}" ${out ? "disabled" : ""}>${out ? "Hết hàng" : "Mua ngay"}</button>`;
  return `<article class="card" data-id="${p.id}">
    <div class="cardImg">${img}${adminBadge}${soldOut}</div>
    <div class="cardBody">
      <small class="sub">${meta}</small>
      <h3>${esc(p.name)}</h3>
      <small class="sub">SKU: ${esc(p.sku || p.product_code)}</small>
      <div class="cardPrice">${money(p.price)}</div>${cost}
      <div class="cardStock${low ? " low" : ""}">Tồn: ${p.quantity}</div>
    </div>
    <div class="cardAct">${actions}</div>
  </article>`;
}

/* ================= SẢN PHẨM (QUẢN LÝ) ================= */
const loadProducts = run(async () => {
  const q = new URLSearchParams({ search: $("#productSearch").value.trim(), category: $("#categoryFilter").value, brand: $("#brandFilter").value, status: $("#statusFilter").value, sort: $("#sortFilter").value });
  products = await api("/products?" + q);
  $("#productGrid").innerHTML = products.length ? products.map(p => productCard(p, true)).join("") : "<div class='empty'>Không tìm thấy sản phẩm</div>";
});
["productSearch", "categoryFilter", "brandFilter", "statusFilter", "sortFilter"].forEach(id => $("#" + id).addEventListener(id === "productSearch" ? "input" : "change", () => { clearTimeout(productTimer); productTimer = setTimeout(loadProducts, 250) }));
$("#addProduct").onclick = () => openProduct(null);
function openProduct(p) {
  editingId = p?.id || null; imageData = p?.image || null;
  $("#productTitle").textContent = p ? "Sửa sản phẩm" : "Thêm sản phẩm";
  $("#sku").value = p?.sku || p?.product_code || ""; $("#productName").value = p?.name || "";
  $("#productCategory").value = p?.category_id || ""; $("#productBrand").value = p?.brand_id || "";
  $("#costPrice").value = p?.cost_price || 0; $("#sellingPrice").value = p?.price || "";
  $("#quantity").value = p?.quantity || 0; $("#threshold").value = p?.low_stock_threshold || 5;
  $("#productStatus").value = p?.status || "active"; $("#imagePreview").src = imageData || "";
  $("#productDialog").showModal();
}
$("#imageInput").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 480 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = img.width * k; c.height = img.height * k;
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    imageData = c.toDataURL("image/jpeg", .8);
    $("#imagePreview").src = imageData;
  };
  img.src = URL.createObjectURL(f);
};
$("#closeProduct").onclick = () => $("#productDialog").close();
$("#productForm").onsubmit = run(async e => {
  e.preventDefault();
  const b = { sku: $("#sku").value, product_code: $("#sku").value, name: $("#productName").value, category_id: Number($("#productCategory").value) || null, brand_id: Number($("#productBrand").value) || null, image: imageData, cost_price: Number($("#costPrice").value), price: Number($("#sellingPrice").value), quantity: Number($("#quantity").value), low_stock_threshold: Number($("#threshold").value), status: $("#productStatus").value };
  await api(editingId ? "/products/" + editingId : "/products", editingId ? "PUT" : "POST", b);
  $("#productDialog").close(); toast("Đã lưu sản phẩm"); loadProducts();
});
$("#productGrid").addEventListener("click", run(async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) openProduct(products.find(p => p.id == b.dataset.edit));
  if (b.dataset.delete && confirm("Xóa sản phẩm này?")) { await api("/products/" + b.dataset.delete, "DELETE"); toast("Đã xóa sản phẩm"); loadProducts() }
}));

$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = run(async e => {
  const f = e.target.files[0]; if (!f) return;
  const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(",")[1]); r.onerror = reject; r.readAsDataURL(f) });
  e.target.value = "";
  const r = await api("/products/import", "POST", { base64 });
  toast(r.message); loadProducts();
});

/* ================= TỒN KHO (QUẢN LÝ) ================= */
const loadInventory = run(async () => {
  const [rows, list] = await Promise.all([api("/inventory/movements"), api("/products?sort=name_asc")]);
  const current = $("#movementProduct").value;
  $("#movementProduct").innerHTML = list.map(p => `<option value="${p.id}">${esc(p.name)} (${p.quantity})</option>`).join("");
  if (current) $("#movementProduct").value = current;
  $("#movementRows").innerHTML = rows.map(r => `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(r.product_name)} <small>${esc(r.product_code)}</small></td><td><span class="status ${r.type === "in" ? "active" : "inactive"}">${r.type === "in" ? "Nhập" : "Xuất"}</span></td><td class="r">${r.quantity}</td><td>${esc(r.user_name || "-")}</td><td>${esc(r.note || "-")}</td></tr>`).join("") || "<tr><td colspan='6' class='empty'>Chưa có lịch sử</td></tr>";
});
$("#movementSubmit").onclick = run(async () => {
  const r = await api("/inventory/movement", "POST", { product_id: Number($("#movementProduct").value), type: $("#movementType").value, quantity: Number($("#movementQty").value), note: $("#movementNote").value });
  toast(r.message); $("#movementNote").value = ""; loadInventory();
});

/* ================= ĐƠN HÀNG ================= */
function orderCard(o, admin) {
  const final = ["completed", "cancelled"].includes(o.status);
  const items = o.items.map(i => `<div class="listRow"><span>${esc(i.product_name)}<small>${esc(i.product_code)} · ${money(i.price)} × ${i.quantity}</small></span><b>${money(i.price * i.quantity)}</b></div>`).join("");
  let actions = "";
  if (admin && !final) {
    actions = `<select data-status="${o.id}" aria-label="Trạng thái đơn">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  } else if (!admin && o.status === "pending") {
    actions = `<button class="btn ghost sm danger" data-cancel="${o.id}">Hủy đơn</button>`;
  }
  const who = admin ? `<div><small>Khách hàng</small>${esc(o.customer_username)}</div>` : "";
  return `<div class="panel order">
    <div class="row between"><div><b>Đơn #${o.id}</b> <small class="sub">${fmtDate(o.created_at)}</small></div><span class="ostatus ${o.status}">${STATUS[o.status] || o.status}</span></div>
    <div class="orderInfo">${who}<div><small>Người nhận</small>${esc(o.receiver_name)}</div><div><small>Điện thoại</small>${esc(o.phone)}</div><div><small>Địa chỉ</small>${esc(o.address)}</div>${o.note ? `<div><small>Ghi chú</small>${esc(o.note)}</div>` : ""}</div>
    ${items}
    <div class="row between orderFoot"><b>Tổng: ${money(o.total)}</b><div class="row">${actions}</div></div>
  </div>`;
}

const loadAdminOrders = run(async () => {
  const s = $("#orderStatusFilter").value;
  const orders = await api("/orders" + (s ? "?status=" + s : ""));
  $("#adminOrders").innerHTML = orders.length ? orders.map(o => orderCard(o, true)).join("") : "<div class='panel empty'>Chưa có đơn hàng.</div>";
});
$("#orderStatusFilter").onchange = () => loadAdminOrders();
$("#adminOrders").addEventListener("change", run(async e => {
  const s = e.target.closest("select[data-status]"); if (!s) return;
  if (s.value === "cancelled" && !confirm("Hủy đơn và hoàn hàng về kho?")) { loadAdminOrders(); return }
  const r = await api("/orders/" + s.dataset.status + "/status", "PUT", { status: s.value });
  toast(r.message); loadAdminOrders();
}));

const loadMyOrders = run(async () => {
  const orders = await api("/orders");
  $("#myOrders").innerHTML = orders.length ? orders.map(o => orderCard(o, false)).join("") : "<div class='panel empty'>Bạn chưa có đơn hàng nào. <a href='#' id='goShop2'>Bắt đầu mua sắm</a></div>";
});
$("#myOrders").addEventListener("click", run(async e => {
  if (e.target.id === "goShop2") { e.preventDefault(); showTab("shop"); return }
  const b = e.target.closest("[data-cancel]"); if (!b) return;
  if (!confirm("Hủy đơn hàng này?")) return;
  const r = await api("/orders/" + b.dataset.cancel + "/cancel", "POST");
  toast(r.message); loadMyOrders();
}));

/* ================= MUA SẮM (KHÁCH HÀNG) ================= */
const loadShop = run(async () => {
  const q = new URLSearchParams({ search: $("#shopSearch").value.trim(), category: $("#shopCategory").value, sort: $("#shopSort").value });
  shopItems = await api("/products?" + q);
  $("#shopGrid").innerHTML = shopItems.length ? shopItems.map(p => productCard(p, false)).join("") : "<div class='empty'>Không tìm thấy sản phẩm phù hợp.</div>";
});
$("#shopSearch").addEventListener("input", () => { clearTimeout(shopTimer); shopTimer = setTimeout(loadShop, 250) });
$("#shopCategory").onchange = () => loadShop();
$("#shopSort").onchange = () => loadShop();
$("#shopGrid").addEventListener("click", run(async e => {
  const add = e.target.closest("[data-add]");
  if (add) { addToCart(shopItems.find(p => p.id == add.dataset.add), 1); return }
  const buy = e.target.closest("[data-buy]");
  if (buy) { openBuy(shopItems.find(p => p.id == buy.dataset.buy), 1); return }
  const card = e.target.closest(".card");
  if (card) openDetail(Number(card.dataset.id));
}));

function openDetail(id) {
  const p = shopItems.find(x => x.id === id); if (!p) return;
  detailProduct = p;
  $("#dImg").src = p.image || ""; $("#dImg").hidden = !p.image;
  $("#dName").textContent = p.name;
  $("#dMeta").textContent = [p.category_name, p.brand_name, "SKU " + (p.sku || p.product_code)].filter(Boolean).join(" · ");
  $("#dPrice").textContent = money(p.price);
  $("#dStock").textContent = p.quantity > 0 ? `Còn ${p.quantity} sản phẩm` : "Hết hàng";
  $("#dQty").value = 1; $("#dQty").max = p.quantity;
  $("#dAdd").disabled = p.quantity <= 0;
  $("#dBuy").disabled = p.quantity <= 0;
  $("#detailDialog").showModal();
}
$("#dAdd").onclick = run(async () => {
  const q = Number($("#dQty").value);
  if (!Number.isInteger(q) || q < 1) throw new Error("Số lượng không hợp lệ.");
  addToCart(detailProduct, q);
  $("#detailDialog").close();
});
$("#dBuy").onclick = run(async () => {
  const q = Number($("#dQty").value);
  if (!Number.isInteger(q) || q < 1) throw new Error("Số lượng không hợp lệ.");
  const p = detailProduct;
  $("#detailDialog").close();
  openBuy(p, q);
});
$("#dClose").onclick = () => $("#detailDialog").close();

/* ================= MUA NGAY (đặt hàng trực tiếp, không qua giỏ) ================= */
function openBuy(p, qty) {
  if (!p) return;
  if (p.quantity <= 0) throw new Error("Sản phẩm đã hết hàng.");
  buyProduct = p;
  $("#bImg").src = p.image || "";
  $("#bName").textContent = p.name;
  $("#bPrice").textContent = money(p.price);
  $("#bStock").textContent = `Còn ${p.quantity} sản phẩm`;
  $("#bQty").max = p.quantity;
  $("#bQty").value = Math.max(1, Math.min(qty, p.quantity));
  $("#byName").value = me.full_name || "";
  $("#byPhone").value = me.phone || "";
  $("#byAddress").value = me.address || "";
  $("#byNote").value = "";
  $("#buyError").hidden = true;
  $("#buySubmit").disabled = false;
  updateBuyTotal();
  $("#buyDialog").showModal();
}
function updateBuyTotal() {
  const q = Number($("#bQty").value);
  $("#bTotal").textContent = money(buyProduct && Number.isInteger(q) && q > 0 ? buyProduct.price * q : 0);
}
$("#bQty").addEventListener("input", updateBuyTotal);
$("#bClose").onclick = () => $("#buyDialog").close();
$("#buyForm").onsubmit = async e => {
  e.preventDefault();
  const err = $("#buyError");
  err.hidden = true;
  const btn = $("#buySubmit");
  try {
    const qty = Number($("#bQty").value);
    if (!Number.isInteger(qty) || qty < 1) throw new Error("Số lượng không hợp lệ.");
    if (qty > buyProduct.quantity) throw new Error(`Chỉ còn ${buyProduct.quantity} sản phẩm trong kho.`);
    const phone = $("#byPhone").value.trim();
    if (!PHONE_RE.test(phone)) throw new Error("Số điện thoại không hợp lệ.");
    btn.disabled = true;
    const r = await api("/orders", "POST", {
      items: [{ product_id: buyProduct.id, quantity: qty }],
      receiver_name: $("#byName").value,
      phone,
      address: $("#byAddress").value,
      note: $("#byNote").value
    });
    $("#buyDialog").close();
    toast(r.message);
    showTab("myorders");
  } catch (ex) {
    // Hiện lỗi ngay trong hộp thoại vì thông báo nổi bị hộp thoại che mất
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
};

/* ================= GIỎ HÀNG (lưu trên trình duyệt theo từng tài khoản) ================= */
const cartKey = () => "cart_" + me.id;
function loadCart() {
  try { cart = JSON.parse(localStorage.getItem(cartKey()) || "[]") } catch { cart = [] }
  updateCartBadge();
}
function saveCart() { localStorage.setItem(cartKey(), JSON.stringify(cart)); updateCartBadge() }
function updateCartBadge() {
  const n = cart.reduce((s, i) => s + i.quantity, 0);
  $("#cartBadge").textContent = n; $("#cartBadge").hidden = !n;
}
function addToCart(p, qty) {
  if (!p) return;
  const line = cart.find(i => i.id === p.id);
  if ((line ? line.quantity : 0) + qty > p.quantity) throw new Error(`Chỉ còn ${p.quantity} sản phẩm trong kho.`);
  if (line) line.quantity += qty; else cart.push({ id: p.id, quantity: qty });
  saveCart(); toast("Đã thêm vào giỏ hàng");
}

// Giá và tồn kho luôn lấy mới từ server khi mở giỏ hàng
const renderCart = run(async () => {
  const all = await api("/products?sort=newest");
  cartProducts = new Map(all.map(p => [p.id, p]));
  const count = () => cart.length + cart.reduce((s, i) => s + i.quantity, 0);
  const before = count();
  cart = cart.filter(i => cartProducts.has(i.id))
    .map(i => ({ id: i.id, quantity: Math.min(i.quantity, cartProducts.get(i.id).quantity) }))
    .filter(i => i.quantity > 0);
  if (count() !== before) toast("Giỏ hàng đã được cập nhật theo tồn kho mới nhất.");
  saveCart();
  drawCart();
  if (!$("#coName").value) $("#coName").value = me.full_name || "";
  if (!$("#coPhone").value) $("#coPhone").value = me.phone || "";
  if (!$("#coAddress").value) $("#coAddress").value = me.address || "";
});
function drawCart() {
  const lines = cart.map(i => ({ i, p: cartProducts.get(i.id) })).filter(x => x.p);
  const total = lines.reduce((s, { i, p }) => s + p.price * i.quantity, 0);
  $("#cartItems").innerHTML = lines.length ? lines.map(({ i, p }) => `<div class="cartRow" data-id="${p.id}">
    ${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : "<span class='thumb'></span>"}
    <div><b>${esc(p.name)}</b><small class="sub">${esc(p.sku || p.product_code)} · ${money(p.price)}</small></div>
    <div class="qty"><button type="button" data-dec aria-label="Giảm">−</button><span>${i.quantity}</span><button type="button" data-inc aria-label="Tăng">+</button></div>
    <b class="lineTotal">${money(p.price * i.quantity)}</b>
    <button type="button" class="btn ghost sm danger" data-remove>Xóa</button>
  </div>`).join("") : "<div class='empty'>Giỏ hàng đang trống. <a href='#' id='goShop'>Đi mua sắm</a></div>";
  $("#cartTotal").textContent = money(total);
  $("#checkoutForm").hidden = !lines.length;
}
$("#cartItems").addEventListener("click", e => {
  if (e.target.id === "goShop") { e.preventDefault(); showTab("shop"); return }
  const row = e.target.closest(".cartRow"); if (!row) return;
  const id = Number(row.dataset.id), line = cart.find(i => i.id === id), p = cartProducts.get(id);
  if (!line || !p) return;
  if (e.target.closest("[data-inc]")) {
    if (line.quantity >= p.quantity) return toast(`Chỉ còn ${p.quantity} sản phẩm trong kho.`, true);
    line.quantity++;
  } else if (e.target.closest("[data-dec]")) {
    line.quantity--;
    if (line.quantity <= 0) cart = cart.filter(i => i !== line);
  } else if (e.target.closest("[data-remove]")) {
    cart = cart.filter(i => i !== line);
  } else return;
  saveCart(); drawCart();
});
$("#checkoutForm").onsubmit = run(async e => {
  e.preventDefault();
  if (!cart.length) throw new Error("Giỏ hàng đang trống.");
  const phone = $("#coPhone").value.trim();
  if (!PHONE_RE.test(phone)) throw new Error("Số điện thoại không hợp lệ.");
  const r = await api("/orders", "POST", {
    items: cart.map(i => ({ product_id: i.id, quantity: i.quantity })),
    receiver_name: $("#coName").value, phone, address: $("#coAddress").value, note: $("#coNote").value
  });
  cart = []; saveCart(); $("#coNote").value = "";
  toast(r.message); showTab("myorders");
});

/* ================= CÁ NHÂN ================= */
const loadProfile = run(async () => {
  me = await api("/me");
  renderWho();
  $("#pfUsername").value = me.username; $("#pfName").value = me.full_name || "";
  $("#pfPhone").value = me.phone || ""; $("#pfAddress").value = me.address || "";
  if (me.role !== "admin") {
    const orders = await api("/orders");
    const valid = orders.filter(o => o.status !== "cancelled");
    $("#profileStats").innerHTML = `<div class="stat"><span>Đơn hàng đã đặt</span><b>${valid.length}</b></div><div class="stat"><span>Tổng chi tiêu (không tính đơn hủy)</span><b>${money(valid.reduce((s, o) => s + o.total, 0))}</b></div>`;
  }
});
$("#profileForm").onsubmit = run(async e => {
  e.preventDefault();
  const phone = $("#pfPhone").value.trim();
  if (phone && !PHONE_RE.test(phone)) throw new Error("Số điện thoại không hợp lệ.");
  const r = await api("/profile", "PUT", { full_name: $("#pfName").value, phone, address: $("#pfAddress").value });
  toast(r.message); loadProfile();
});
$("#passwordForm").onsubmit = run(async e => {
  e.preventDefault();
  if ($("#pwNew").value !== $("#pwConfirm").value) throw new Error("Mật khẩu mới nhập lại không khớp.");
  const r = await api("/profile/password", "POST", { current_password: $("#pwOld").value, new_password: $("#pwNew").value });
  $("#passwordForm").reset(); toast(r.message);
});

/* ================= TÀI KHOẢN (QUẢN LÝ) ================= */
const loadUsers = run(async () => {
  $("#userRows").innerHTML = (await api("/users")).map(u => {
    const role = u.role === "admin" ? "Quản lý" : "Khách hàng";
    const actions = u.id === me.id && u.account_type === "admin" ? "" : `<button class="btn ghost sm" data-role="${u.id}" data-account="${u.account_type}" data-current="${esc(u.role)}">Đổi quyền</button><button class="btn ghost sm danger" data-lock="${u.id}" data-account="${u.account_type}" data-locked="${u.is_locked ? 1 : 0}">${u.is_locked ? "Mở khóa" : "Khóa"}</button>`;
    return `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${role}</td><td>${u.is_locked ? "Đã khóa" : "Đang hoạt động"}</td><td class="act">${actions}</td></tr>`;
  }).join("")
});
$("#addUser").onclick = () => $("#userDialog").showModal(); $("#closeUser").onclick = () => $("#userDialog").close();
$("#userForm").onsubmit = run(async e => {
  e.preventDefault();
  await api("/users", "POST", { username: $("#newUsername").value, full_name: $("#newFullName").value, password: $("#newPassword").value, role: $("#newRole").value });
  $("#userDialog").close(); $("#userForm").reset(); toast("Đã tạo tài khoản"); loadUsers();
});
$("#userRows").addEventListener("click", run(async e => {
  const b = e.target.closest("button[data-role]");
  if (b) {
    const role = prompt("Nhập quyền mới: admin (quản lý) hoặc viewer (khách hàng)", b.dataset.current || "viewer");
    if (!["admin", "viewer"].includes(role || "")) return toast("Quyền không hợp lệ.", true);
    await api("/users/" + b.dataset.role, "PUT", { role, account_type: b.dataset.account });
    toast("Đã đổi quyền."); loadUsers();
  }
  const lock = e.target.closest("button[data-lock]");
  if (lock) {
    await api("/users/" + lock.dataset.lock, "PUT", { is_locked: lock.dataset.locked === "0", account_type: lock.dataset.account });
    toast(lock.dataset.locked === "0" ? "Đã khóa tài khoản" : "Đã mở khóa tài khoản"); loadUsers();
  }
}));

/* ================= KHỞI ĐỘNG ================= */
(async () => {
  if (localStorage.token) {
    try { await start(await api("/me")) }
    catch { localStorage.removeItem("token"); $("#login").hidden = false; $("#app").hidden = true }
  }
})();