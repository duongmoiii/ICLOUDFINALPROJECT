const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=(n)=>Number(n||0).toLocaleString("vi-VN")+" đ";
let me=null, products=[], categories=[], brands=[], editingId=null, imageData=null, toastTimer;
let cart=JSON.parse(localStorage.cart||"[]");

async function api(path,method="GET",body){
  const res=await fetch("/api"+path,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer "+(localStorage.token||"")},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(res.status===401){localStorage.removeItem("token");location.reload();}
  if(!res.ok)throw new Error(data.message||"Có lỗi xảy ra.");
  return data;
}
function toast(msg,error=false){const t=$("#toast");t.textContent=msg;t.className="toast show"+(error?" error":"");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.className="toast",2600);}
const run=fn=>async(...args)=>{try{await fn(...args)}catch(e){toast(e.message,true)}};

$("#loginForm").addEventListener("submit",run(async e=>{
  e.preventEvent?.();
  e.preventDefault();
  const r=await api("/login","POST",{username:$("#username").value,password:$("#password").value});
  localStorage.token=r.token;start(r.user);
}));
document.querySelectorAll("[data-auth]").forEach(button=>button.onclick=()=>{
  document.querySelectorAll("[data-auth]").forEach(b=>b.classList.toggle("on",b===button));
  $("#loginForm").hidden=button.dataset.auth!== "login";
  $("#registerForm").hidden=button.dataset.auth!== "register";
});
$("#registerForm").addEventListener("submit",run(async e=>{
  e.preventDefault();
  const username=$("#registerUsername").value;
  const r=await api("/register","POST",{
    full_name:$("#registerFullName").value,
    username,
    password:$("#registerPassword").value
  });
  toast(r.message);
  $("#registerForm").reset();
  document.querySelector('[data-auth="login"]').click();
  $("#username").value=username;
}));
$("#logout").onclick=()=>{localStorage.removeItem("token");location.reload()};

async function start(user){
  me=user;$("#login").hidden=true;$("#app").hidden=false;
  const names={admin:"Quản lý",warehouse:"Quản lý",viewer:"Người dùng (chỉ xem)",staff:"Người dùng (chỉ xem)"};
  $("#whoami").textContent=`${user.full_name} · ${names[user.role]||user.role}`;
  const writable=me.role==="admin";
  document.querySelectorAll(".writeRole").forEach(el=>el.classList.toggle("disabled",!writable));
  document.querySelectorAll(".writeRole").forEach(el=>el.disabled=!writable);
  document.querySelectorAll(".adminOnly").forEach(el=>el.hidden=me.role!=="admin");
  document.querySelectorAll(".customerOnly").forEach(el=>el.hidden=me.role==="admin");
  await loadCatalog();
  document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("on",b.dataset.tab==="dashboard"));
  showTab(me.role==="admin"?"dashboard":"products");
}
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
async function showTab(name){
  document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("on",b.dataset.tab===name));
  document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!==name);
  if(name==="dashboard")loadStats();
  if(name==="products")loadProducts();
  if(name==="catalog")loadCatalog();
  if(name==="inventory")loadInventory();
  if(name==="users")loadUsers();
  if(name==="orders")loadOrders();
}
(async()=>{if(localStorage.token){try{start(await api("/me"))}catch{localStorage.removeItem("token");$("#login").hidden=false}}})();

const loadStats=run(async()=>{
  const s=await api("/stats");
  $("#stats").innerHTML=`<div class="stat"><span>Tổng sản phẩm</span><b>${s.products}</b></div><div class="stat"><span>Số lượng tồn</span><b>${s.stock}</b></div><div class="stat"><span>Giá trị tồn kho</span><b>${money(s.stockValue)}</b></div><div class="stat warning"><span>Sắp hết hàng</span><b>${s.lowStock.length}</b></div>`;
  const max=Math.max(...s.chart.flatMap(d=>[d.incoming,d.outgoing]),1);
  $("#chart").innerHTML=s.chart.map(d=>`<div class="chartGroup"><i class="in" style="height:${d.incoming/max*160}px"></i><i class="out" style="height:${d.outgoing/max*160}px"></i><small>${d.label}</small></div>`).join("");
  $("#lowStock").innerHTML=s.lowStock.length?s.lowStock.map(p=>`<div class="listRow"><span>${esc(p.name)}<small>${esc(p.product_code)}</small></span><b class="low">Còn ${p.quantity}</b></div>`).join(""):"<div class='empty'>Không có sản phẩm sắp hết.</div>";
});

async function loadCatalog(){
  [categories,brands]=await Promise.all([api("/categories"),api("/brands")]);
  $("#categoryFilter").innerHTML='<option value="">Tất cả danh mục</option>'+categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#brandFilter").innerHTML='<option value="">Tất cả thương hiệu</option>'+brands.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join("");
  $("#productCategory").innerHTML='<option value="">Không có</option>'+categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#productBrand").innerHTML='<option value="">Không có</option>'+brands.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join("");
  $("#categories").innerHTML=categories.map(c=>`<div class="listRow"><span>${esc(c.name)}</span>${me.role==="admin"?`<button class="btn ghost sm danger" data-delete-category="${c.id}">Xóa</button>`:""}</div>`).join("");
  $("#brands").innerHTML=brands.map(b=>`<div class="listRow"><span>${esc(b.name)}</span>${me.role==="admin"?`<button class="btn ghost sm danger" data-delete-brand="${b.id}">Xóa</button>`:""}</div>`).join("");
  $("#movementProduct").innerHTML=products.map(p=>`<option value="${p.id}">${esc(p.name)} (${p.quantity})</option>`).join("");
}
const loadCatalogRun=run(loadCatalog); $("#catalog").addEventListener("click",run(async e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.deleteCategory){await api("/categories/"+b.dataset.deleteCategory,"DELETE");toast("Đã xóa danh mục");loadCatalogRun()}if(b.dataset.deleteBrand){await api("/brands/"+b.dataset.deleteBrand,"DELETE");toast("Đã xóa thương hiệu");loadCatalogRun()}}));
$("#addCategory").onclick=run(async()=>{const name=prompt("Tên danh mục");if(name){await api("/categories","POST",{name});loadCatalog();toast("Đã thêm danh mục")}});
$("#addBrand").onclick=run(async()=>{const name=prompt("Tên thương hiệu");if(name){await api("/brands","POST",{name});loadCatalog();toast("Đã thêm thương hiệu")}});

let productTimer;
const loadProducts=run(async()=>{
  const q=new URLSearchParams({search:$("#productSearch").value.trim(),category:$("#categoryFilter").value,brand:$("#brandFilter").value,status:$("#statusFilter").value,sort:$("#sortFilter").value});
  products=await api("/products?"+q);
  $("#productGrid").hidden=me.role==="admin";
  $("#productGrid").innerHTML=me.role==="admin"?"":products.length?products.filter(p=>p.status==="active"&&p.quantity>0).map(p=>`
    <article class="productCard">
      <div class="productImage">${p.image?`<img src="${esc(p.image)}" alt="${esc(p.name)}">`:"<span class='productImagePlaceholder'>Chưa có ảnh</span>"}</div>
      <div class="productInfo">
        <h3>${esc(p.name)}</h3>
        <div class="productMeta">${esc(p.category_name||"Chưa phân danh mục")} · ${esc(p.brand_name||"")}</div>
        <div class="productBottom"><strong class="productPrice">${money(p.price)}</strong><button class="btn" data-add-cart="${p.id}" ${p.quantity<=0?"disabled":""}>Thêm giỏ</button></div>
      </div>
    </article>`).join(""):`<div class="empty">Không tìm thấy sản phẩm</div>`;
  const costColumn=me.role==="admin"?'<th class="r">Giá nhập</th>':"";
  const brandColumn=me.role==="admin"?'<th>Thương hiệu</th>':"";
  const thead=$("#productRows").parentElement.querySelector("thead tr");
  thead.innerHTML='<th>Ảnh</th><th>SKU</th><th>Tên</th><th>Danh mục</th>'+brandColumn+costColumn+'<th class="r">Giá bán</th><th class="r">Tồn</th><th>Trạng thái</th><th></th>';
  $("#productRows").innerHTML=products.length?products.map(p=>{
    const cost=me.role==="admin"?`<td class="r">${money(p.cost_price)}</td>`:"";
    const brand=me.role==="admin"?`<td>${esc(p.brand_name||"-")}</td>`:"";
    const actions=me.role==="admin"?`<button class="btn ghost sm" data-edit="${p.id}">Sửa</button><button class="btn ghost sm danger" data-delete="${p.id}">Xóa</button>`:"";
    return `<tr><td>${p.image?`<img class="thumb" src="${esc(p.image)}">`:"<span class='thumb'></span>"}</td><td>${esc(p.sku||p.product_code)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.category_name||"-")}</td>${brand}${cost}<td class="r">${money(p.price)}</td><td class="r ${p.quantity<=p.low_stock_threshold?"low":""}">${p.quantity}</td><td><span class="status ${p.status}">${p.status==="inactive"?"Ngừng bán":"Đang bán"}</span></td><td class="act">${actions}</td></tr>`;
  }).join(""):`<tr><td colspan='${me.role==="admin"?10:7}' class='empty'>Không tìm thấy sản phẩm</td></tr>`;
  $("#movementProduct").innerHTML=products.map(p=>`<option value="${p.id}">${esc(p.name)} (${p.quantity})</option>`).join("");
});
["productSearch","categoryFilter","brandFilter","statusFilter","sortFilter"].forEach(id=>$("#"+id).addEventListener(id==="productSearch"?"input":"change",()=>{clearTimeout(productTimer);productTimer=setTimeout(loadProducts,250)}));
$("#addProduct").onclick=()=>openProduct(null);
function openProduct(p){
  editingId=p?.id||null;imageData=p?.image||null;$("#productTitle").textContent=p?"Sửa sản phẩm":"Thêm sản phẩm";
  $("#sku").value=p?.sku||p?.product_code||"";$("#productName").value=p?.name||"";$("#productCategory").value=p?.category_id||"";$("#productBrand").value=p?.brand_id||"";$("#costPrice").value=p?.cost_price||0;$("#sellingPrice").value=p?.price||"";$("#quantity").value=p?.quantity||0;$("#threshold").value=p?.low_stock_threshold||5;$("#productStatus").value=p?.status||"active";$("#imagePreview").src=imageData||"";
  $("#productDialog").showModal();
}
$("#imageInput").onchange=e=>{const f=e.target.files[0];if(!f)return;const img=new Image();img.onload=()=>{const k=Math.min(1,480/Math.max(img.width,img.height));const c=document.createElement("canvas");c.width=img.width*k;c.height=img.height*k;c.getContext("2d").drawImage(img,0,0,c.width,c.height);imageData=c.toDataURL("image/jpeg",.8);$("#imagePreview").src=imageData};img.src=URL.createObjectURL(f)};
$("#closeProduct").onclick=()=>$("#productDialog").close();
$("#productForm").onsubmit=run(async e=>{e.preventDefault();const b={sku:$("#sku").value,product_code:$("#sku").value,name:$("#productName").value,category_id:Number($("#productCategory").value)||null,brand_id:Number($("#productBrand").value)||null,image:imageData,cost_price:Number($("#costPrice").value),price:Number($("#sellingPrice").value),quantity:Number($("#quantity").value),low_stock_threshold:Number($("#threshold").value),status:$("#productStatus").value};await api(editingId?"/products/"+editingId:"/products",editingId?"PUT":"POST",b);$("#productDialog").close();toast("Đã lưu sản phẩm");loadProducts();loadStats()});
$("#productRows").addEventListener("click",run(async e=>{const b=e.target.closest("button");if(!b)return;if(b.dataset.edit)openProduct(products.find(p=>p.id==b.dataset.edit));if(b.dataset.delete&&confirm("Xóa sản phẩm này?")){await api("/products/"+b.dataset.delete,"DELETE");toast("Đã xóa sản phẩm");loadProducts();loadStats()}}));

$("#importBtn").onclick=()=>$("#importFile").click();
$("#importFile").onchange=run(async e=>{const f=e.target.files[0];if(!f)return;const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(",")[1]);r.onerror=reject;r.readAsDataURL(f)});const r=await api("/products/import","POST",{base64});toast(r.message);loadProducts()});

const loadInventory=run(async()=>{
  const rows=await api("/inventory/movements");
  $("#movementRows").innerHTML=rows.map(r=>`<tr><td>${esc(r.created_at)}</td><td>${esc(r.product_name)} <small>${esc(r.product_code)}</small></td><td><span class="status ${r.type==="in"?"active":"inactive"}">${r.type==="in"?"Nhập":"Xuất"}</span></td><td class="r">${r.quantity}</td><td>${esc(r.user_name||"-")}</td><td>${esc(r.note||"-")}</td></tr>`).join("")||"<tr><td colspan='6' class='empty'>Chưa có lịch sử</td></tr>";
});
$("#movementSubmit").onclick=run(async()=>{
  const r=await api("/inventory/movement","POST",{product_id:Number($("#movementProduct").value),type:$("#movementType").value,quantity:Number($("#movementQty").value),note:$("#movementNote").value});toast(r.message);$("#movementNote").value="";loadProducts();loadInventory();loadStats();
});

const loadUsers=run(async()=>{$("#userRows").innerHTML=(await api("/users")).map(u=>{
  const role=u.role==="admin"?"Quản lý":"Người dùng (chỉ xem)";
  const actions=u.id===me.id&&u.account_type==="admin"?"":`<button class="btn ghost sm" data-role="${u.id}" data-account="${u.account_type}" data-current="${esc(u.role)}">Đổi quyền</button><button class="btn ghost sm danger" data-lock="${u.id}" data-account="${u.account_type}" data-locked="${u.is_locked?1:0}">${u.is_locked?"Mở khóa":"Khóa"}</button>`;
  return `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${role}</td><td>${u.is_locked?"Đã khóa":"Đang hoạt động"}</td><td>${actions}</td></tr>`;
}).join("")});
$("#addUser").onclick=()=>$("#userDialog").showModal();$("#closeUser").onclick=()=>$("#userDialog").close();
$("#userForm").onsubmit=run(async e=>{e.preventDefault();await api("/users","POST",{username:$("#newUsername").value,full_name:$("#newFullName").value,password:$("#newPassword").value,role:$("#newRole").value});$("#userDialog").close();toast("Đã tạo tài khoản");loadUsers()});
$("#userRows").addEventListener("click",run(async e=>{
  const b=e.target.closest("button[data-role]");
  if(b){
  const role=prompt("Nhập quyền mới: admin hoặc viewer",b.dataset.current||"viewer");
  if(!["admin","viewer"].includes(role||""))return toast("Quyền không hợp lệ.",true);
  await api("/users/"+b.dataset.role,"PUT",{role,account_type:b.dataset.account});
  toast("Đã đổi quyền.");loadUsers();
  }
  const lock=e.target.closest("button[data-lock]");
  if(lock){
    await api("/users/"+lock.dataset.lock,"PUT",{is_locked:lock.dataset.locked==="0",account_type:lock.dataset.account});
    toast(lock.dataset.locked==="0"?"Đã khóa tài khoản":"Đã mở khóa tài khoản");loadUsers();
  }
}));

function saveCart(){localStorage.cart=JSON.stringify(cart);renderCart();}
function cartTotal(){return cart.reduce((sum,item)=>sum+Number(item.price)*Number(item.quantity),0);}
function renderCart(){
  const count=cart.reduce((sum,item)=>sum+Number(item.quantity),0);
  $("#cartCount").textContent=count;
  $("#cartItems").innerHTML=cart.length?cart.map(item=>`
    <div class="cartItem">
      ${item.image?`<img src="${esc(item.image)}" alt="">`:"<span class='cartPlaceholder'></span>"}
      <div><strong>${esc(item.name)}</strong><small>${money(item.price)}</small><div class="qty"><button data-cart-dec="${item.id}" aria-label="Giảm số lượng">−</button><span>${item.quantity}</span><button data-cart-inc="${item.id}" aria-label="Tăng số lượng">+</button></div></div>
      <button class="iconButton" data-cart-remove="${item.id}" aria-label="Xóa sản phẩm">×</button>
    </div>`).join(""):"<div class='empty'>Giỏ hàng đang trống</div>";
  $("#cartTotal").textContent=money(cartTotal());
  $("#checkoutTotal").textContent=money(cartTotal());
  $("#checkoutButton").disabled=!cart.length;
}
$("#productGrid").addEventListener("click",e=>{
  const b=e.target.closest("[data-add-cart]");
  if(!b)return;
  const p=products.find(item=>item.id==b.dataset.addCart);
  if(!p||p.status==="inactive")return;
  const existing=cart.find(item=>item.id===p.id);
  if(existing&&existing.quantity>=p.quantity)return toast("Số lượng vượt quá tồn kho.",true);
  if(existing)existing.quantity++;
  else cart.push({id:p.id,name:p.name,price:p.price,image:p.image,quantity:1});
  saveCart();toast("Đã thêm vào giỏ hàng");
});
$("#cartButton").onclick=()=>$("#cartDialog").showModal();
$("#closeCart").onclick=()=>$("#cartDialog").close();
$("#cartItems").addEventListener("click",e=>{
  const dec=e.target.closest("[data-cart-dec]");
  const inc=e.target.closest("[data-cart-inc]");
  const remove=e.target.closest("[data-cart-remove]");
  if(dec){const item=cart.find(x=>x.id==dec.dataset.cartDec);if(item.quantity<=1)cart=cart.filter(x=>x.id!=item.id);else item.quantity--;saveCart();}
  if(inc){const item=cart.find(x=>x.id==inc.dataset.cartInc);const stock=products.find(p=>p.id==item?.id)?.quantity||0;if(item&&item.quantity<stock)item.quantity++;else toast("Số lượng vượt quá tồn kho.",true);saveCart();}
  if(remove){cart=cart.filter(x=>x.id!=remove.dataset.cartRemove);saveCart();}
});
$("#checkoutButton").onclick=()=>{
  if(!cart.length)return toast("Giỏ hàng đang trống.",true);
  $("#cartDialog").close();
  $("#checkoutName").value=me.full_name||"";
  $("#checkoutTotal").textContent=money(cartTotal());
  $("#checkoutDialog").showModal();
};
$("#closeCheckout").onclick=()=>$("#checkoutDialog").close();
$("#checkoutForm").addEventListener("submit",run(async e=>{
  e.preventEvent?.();
  e.preventDefault();
  const r=await api("/checkout","POST",{
    items:cart.map(item=>({product_id:item.id,quantity:item.quantity})),
    customer_name:$("#checkoutName").value,
    phone:$("#checkoutPhone").value,
    address:$("#checkoutAddress").value,
    payment_method:$("#paymentMethod").value
  });
  cart=[];saveCart();$("#checkoutDialog").close();toast(`${r.message} Mã đơn: ${r.order_code}`);
  loadProducts();loadOrders();
}));
const loadOrders=run(async()=>{
  const orders=await api("/orders");
  const labels={pending:"Chờ xử lý",paid:"Đã thanh toán",shipped:"Đang giao",completed:"Hoàn tất",cancelled:"Đã hủy"};
  $("#orderList").innerHTML=orders.length?orders.map(o=>`
    <article class="orderCard">
      <div class="orderHead"><div><strong>${esc(o.order_code)}</strong><small class="muted"> · ${esc(o.created_at)}</small></div><span class="status active">${labels[o.status]||esc(o.status)}</span></div>
      <ul>${o.items.map(i=>`<li>${esc(i.name)} × ${i.quantity} — ${money(i.price*i.quantity)}</li>`).join("")}</ul>
      <div class="cartSummary"><span>Thanh toán: ${esc(o.payment_method==="cod"?"COD":o.payment_method==="bank"?"Chuyển khoản":"Thẻ")}</span><strong>${money(o.total_amount)}</strong></div>
    </article>`).join(""):"<div class='empty'>Bạn chưa có đơn hàng nào</div>";
});
renderCart();
