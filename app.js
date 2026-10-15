/* GlowMart BIG storefront logic.
   Same-origin /api/* calls only. No secrets or credentials in this file.
   Auth token is stored in localStorage; the login gate blocks the shop until logged in. */

const TOKEN_KEY = "glowmart_token";
const CART_KEY = "glowmart_cart";
const WISH_KEY = "glowmart_wishlist";

let authToken = localStorage.getItem(TOKEN_KEY) || null;
let account = null; // {name, phone} after login
let products = [];
let cart = {};
try { cart = JSON.parse(localStorage.getItem(CART_KEY) || "{}"); } catch (e) { cart = {}; }
let wishlist = new Set();
try { wishlist = new Set(JSON.parse(localStorage.getItem(WISH_KEY) || "[]")); } catch (e) { wishlist = new Set(); }
let activeCategory = "সব";
let modalProduct = null;
let modalQty = 1;
let heroIdx = 0, heroTimer = null;

const $ = (id) => document.getElementById(id);

// Bangla digits for display
const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
const bn = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);
const taka = (n) => "৳" + bn(n);

const ERROR_BN = {
  login_required: "অনুগ্রহ করে আবার লগইন করুন।",
  invalid_phone: "সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)।",
  password_too_short: "পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।",
  name_required: "আপনার নাম লিখুন।",
  phone_exists: "এই নম্বরে ইতিমধ্যে অ্যাকাউন্ট আছে — লগইন করুন।",
  invalid_credentials: "মোবাইল নম্বর বা পাসওয়ার্ড ভুল হয়েছে।",
  address_required: "সম্পূর্ণ ডেলিভারি ঠিকানা লিখুন।",
  empty_cart: "কার্ট খালি — আগে পণ্য যোগ করুন।",
  invalid_delivery_area: "ডেলিভারি এলাকা বেছে নিন।",
  network: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।",
};

// Delivery areas (charges are server-computed; these are for display)
const DELIVERY_AREAS = {
  inside_dhaka: { label: "ঢাকার ভেতরে", charge: 60 },
  outside_dhaka: { label: "ঢাকার বাইরে", charge: 120 },
};
const STATUS_BN = { pending: "অপেক্ষমাণ", confirmed: "কনফার্মড", delivered: "ডেলিভার্ড", cancelled: "বাতিল" };

// Fixed category nav (only categories that have products + offers)
const CATEGORIES = ["সব", "স্কিনকেয়ার", "অফার"];
function inCategory(p, cat) {
  if (cat === "সব") return true;
  if (cat === "স্কিনকেয়ার") return ["Skincare", "Beauty & Personal Care"].includes(p.category);
  if (cat === "অফার") return /%|ছাড়/.test(p.badge || "");
  return true;
}
function isFlashSale(p) {
  return /%|বেস্ট সেলার|ছাড়/.test(p.badge || "");
}

async function api(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (authToken) headers["Authorization"] = "Bearer " + authToken;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON response */ }
  return { status: res.status, data };
}

/* ---------------- Auth gate ---------------- */
function showGate() {
  $("auth-gate").classList.remove("hidden");
  $("app").classList.add("hidden");
}

function wireGate() {
  const tabLogin = $("tab-login"), tabSignup = $("tab-signup");
  const loginForm = $("login-form"), signupForm = $("signup-form");
  tabLogin.onclick = () => {
    tabLogin.classList.add("active"); tabSignup.classList.remove("active");
    loginForm.classList.remove("hidden"); signupForm.classList.add("hidden");
    $("gate-error").textContent = "";
  };
  tabSignup.onclick = () => {
    tabSignup.classList.add("active"); tabLogin.classList.remove("active");
    signupForm.classList.remove("hidden"); loginForm.classList.add("hidden");
    $("gate-error").textContent = "";
  };

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    await doAuth("/api/auth/login", {
      phone: $("login-phone").value.trim(),
      password: $("login-password").value,
    });
  };
  signupForm.onsubmit = async (e) => {
    e.preventDefault();
    await doAuth("/api/auth/signup", {
      name: $("signup-name").value.trim(),
      phone: $("signup-phone").value.trim(),
      password: $("signup-password").value,
    });
  };
}

async function doAuth(path, body) {
  const errEl = $("gate-error");
  errEl.textContent = "";
  try {
    const { status, data } = await api(path, { method: "POST", body: JSON.stringify(body) });
    if ((status === 200 || status === 201) && data && data.ok) {
      authToken = data.token;
      localStorage.setItem(TOKEN_KEY, authToken);
      account = { name: data.name, phone: data.phone };
      enterSite();
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
  authToken = null;
  account = null;
  localStorage.removeItem(TOKEN_KEY);
  showGate();
}

/* ---------------- Entering the shop ---------------- */
async function enterSite() {
  $("auth-gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("user-chip").textContent = "👤 " + account.name;
  // Checkout auto-fill from the logged-in account
  $("co-name").value = account.name;
  $("co-phone").value = account.phone;
  await loadProducts();
  renderCart();
  updateWishCount();
  startHero();
  startCountdown();
}

function wireShop() {
  $("logout-btn").onclick = logout;
  $("orders-btn").onclick = openOrders;
  $("orders-close").onclick = () => $("orders-modal").classList.add("hidden");
  $("orders-modal").addEventListener("click", (e) => {
    if (e.target.id === "orders-modal") $("orders-modal").classList.add("hidden");
  });
  $("wishlist-btn").onclick = openWish;
  $("wish-close").onclick = closeWish;
  $("wish-overlay").onclick = closeWish;
  $("cart-btn").onclick = openDrawer;
  $("drawer-close").onclick = closeDrawer;
  $("drawer-overlay").onclick = closeDrawer;
  $("go-checkout").onclick = () => {
    if (Object.keys(cart).length === 0) return;
    closeDrawer();
    $("checkout-section").classList.remove("hidden");
    renderCheckoutSummary();
    $("checkout-section").scrollIntoView({ behavior: "smooth" });
  };
  $("search").addEventListener("input", renderGrid);
  $("modal-close").onclick = () => $("product-modal").classList.add("hidden");
  $("product-modal").addEventListener("click", (e) => {
    if (e.target.id === "product-modal") $("product-modal").classList.add("hidden");
  });
  $("modal-minus").onclick = () => { if (modalQty > 1) { modalQty--; $("modal-qty").textContent = bn(modalQty); } };
  $("modal-plus").onclick = () => { if (modalQty < 99) { modalQty++; $("modal-qty").textContent = bn(modalQty); } };
  $("modal-add").onclick = () => {
    if (modalProduct) { addToCart(modalProduct.id, modalQty); $("product-modal").classList.add("hidden"); openDrawer(); }
  };
  $("checkout-form").onsubmit = submitOrder;
  document.querySelectorAll('input[name="delivery_area"]').forEach((r) => {
    r.addEventListener("change", renderCheckoutSummary);
  });
  $("continue-shopping").onclick = () => {
    $("confirmation").classList.add("hidden");
    document.getElementById("catalog").scrollIntoView({ behavior: "smooth" });
  };
  // Hero dots
  document.querySelectorAll("#hero-dots button").forEach((d, i) => {
    d.onclick = () => setHero(i);
  });
}

/* ---------------- Hero carousel ---------------- */
function setHero(i) {
  const slides = document.querySelectorAll("#hero-slides .slide");
  const dots = document.querySelectorAll("#hero-dots button");
  heroIdx = (i + slides.length) % slides.length;
  slides.forEach((s, k) => s.classList.toggle("active", k === heroIdx));
  dots.forEach((d, k) => d.classList.toggle("active", k === heroIdx));
}
function startHero() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = setInterval(() => setHero(heroIdx + 1), 5000);
}

/* ---------------- Flash sale countdown (to midnight) ---------------- */
function startCountdown() {
  const el = $("flash-countdown");
  function tick() {
    const now = new Date();
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    let s = Math.max(0, Math.floor((end - now) / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    el.textContent = bn(h) + ":" + bn(m) + ":" + bn(sec);
  }
  tick();
  setInterval(tick, 1000);
}

/* ---------------- Products ---------------- */
async function loadProducts() {
  try {
    const { data } = await api("/api/products");
    products = Array.isArray(data) ? data : [];
  } catch (e) {
    products = [];
  }
  renderChips();
  renderGrid();
  renderFlash();
}

function renderChips() {
  const box = $("category-chips");
  box.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip" + (c === activeCategory ? " active" : "");
    b.textContent = c;
    b.onclick = () => { activeCategory = c; renderChips(); renderGrid(); };
    box.appendChild(b);
  });
}

function filteredProducts() {
  const q = $("search").value.trim().toLowerCase();
  return products.filter((p) =>
    inCategory(p, activeCategory) &&
    (!q || (p.name + " " + (p.description || "")).toLowerCase().includes(q))
  );
}

function badgesHtml(p) {
  let h = '<div class="badges">';
  if (p.badge) h += `<span class="badge">${escapeHtml(p.badge)}</span>`;
  if (p.sample) h += `<span class="badge sample">নমুনা</span>`;
  return h + "</div>";
}

function starsHtml(p) {
  const r = p.rating || 5;
  return `<p class="stars">★★★★★ <span class="rc">${bn(r.toFixed(1))} (${bn(p.reviews || 0)})</span></p>`;
}

function cardHtml(p) {
  const wished = wishlist.has(p.id);
  return badgesHtml(p) +
    `<button class="wish-btn${wished ? " active" : ""}" data-wish="${p.id}" aria-label="পছন্দের তালিকা">${wished ? "♥" : "♡"}</button>` +
    `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy">` +
    `<div class="card-body"><h3>${escapeHtml(p.name)}</h3>` +
    `<p class="muted small">${escapeHtml(p.size || "")}</p>` +
    starsHtml(p) +
    `<p class="price">${taka(p.price)}</p>` +
    `<div class="card-actions">` +
    `<button class="btn-outline">বিস্তারিত</button>` +
    `<button class="btn-add">কার্টে যোগ করুন</button>` +
    `</div></div>`;
}

function wireCard(card, p) {
  const wishBtn = card.querySelector(".wish-btn");
  const detailBtn = card.querySelector(".btn-outline");
  const addBtn = card.querySelector(".btn-add");
  if (wishBtn) wishBtn.onclick = (e) => { e.stopPropagation(); toggleWish(p.id); };
  if (detailBtn) detailBtn.onclick = (e) => { e.stopPropagation(); openModal(p.id); };
  if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); addToCart(p.id, 1); openDrawer(); };
  card.onclick = () => openModal(p.id);
}

function renderGrid() {
  const grid = $("product-grid");
  const list = filteredProducts();
  $("no-results").classList.toggle("hidden", list.length > 0);
  grid.innerHTML = "";
  list.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = cardHtml(p);
    wireCard(card, p);
    grid.appendChild(card);
  });
}

function renderFlash() {
  const box = $("flash-grid");
  box.innerHTML = "";
  products.filter(isFlashSale).forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = cardHtml(p);
    wireCard(card, p);
    box.appendChild(card);
  });
  $("flash").classList.toggle("hidden", box.children.length === 0);
}

function openModal(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  modalProduct = p;
  modalQty = 1;
  $("modal-qty").textContent = bn(1);
  $("modal-img").src = p.image;
  $("modal-img").alt = p.name;
  $("modal-name").textContent = p.name;
  $("modal-size").textContent = p.size || "";
  $("modal-price").textContent = taka(p.price);
  $("modal-desc").textContent = p.description || "";
  $("modal-usage").textContent = p.usage || "—";
  updateModalWish();
  $("modal-wish").onclick = () => toggleWish(p.id);
  $("product-modal").classList.remove("hidden");
}

/* ---------------- Cart ---------------- */
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function cartCount() {
  return Object.values(cart).reduce((a, b) => a + b, 0);
}

function cartTotal() {
  return Object.entries(cart).reduce((sum, [id, qty]) => {
    const p = products.find((x) => x.id === id);
    return sum + (p ? p.price * qty : 0);
  }, 0);
}

function addToCart(id, qty) {
  cart[id] = Math.min(99, (cart[id] || 0) + qty);
  saveCart();
  renderCart();
}

function renderCart() {
  $("cart-count").textContent = bn(cartCount());
  const box = $("cart-items");
  const ids = Object.keys(cart);
  if (ids.length === 0) {
    box.innerHTML = '<p class="empty-cart">কার্ট খালি আছে।</p>';
  } else {
    box.innerHTML = "";
    ids.forEach((id) => {
      const p = products.find((x) => x.id === id);
      if (!p) return;
      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML =
        `<img src="${p.image}" alt="${escapeHtml(p.name)}">` +
        `<div class="info"><p><strong>${escapeHtml(p.name)}</strong></p>` +
        `<p class="muted">${taka(p.price)} × ${bn(cart[id])} = ${taka(p.price * cart[id])}</p></div>` +
        `<div class="qty-ctrl"><button>−</button><span>${bn(cart[id])}</span><button>+</button></div>`;
      const [minus, plus] = row.querySelectorAll("button");
      minus.onclick = () => {
        cart[id]--;
        if (cart[id] <= 0) delete cart[id];
        saveCart(); renderCart();
      };
      plus.onclick = () => { cart[id] = Math.min(99, cart[id] + 1); saveCart(); renderCart(); };
      box.appendChild(row);
    });
  }
  $("cart-total").textContent = taka(cartTotal());
}

function openDrawer() {
  renderCart();
  $("cart-drawer").classList.remove("hidden");
  $("drawer-overlay").classList.remove("hidden");
}
function closeDrawer() {
  $("cart-drawer").classList.add("hidden");
  $("drawer-overlay").classList.add("hidden");
}

/* ---------------- Wishlist (localStorage, works with/without login) ---------------- */
function saveWishlist() {
  localStorage.setItem(WISH_KEY, JSON.stringify([...wishlist]));
}

function toggleWish(id) {
  if (wishlist.has(id)) wishlist.delete(id);
  else wishlist.add(id);
  saveWishlist();
  updateWishCount();
  renderGrid();
  renderFlash();
  updateModalWish();
  if (!$("wish-drawer").classList.contains("hidden")) renderWish();
}

function updateWishCount() {
  $("wish-count").textContent = bn(wishlist.size);
}

function updateModalWish() {
  const b = $("modal-wish");
  if (!modalProduct || !b) return;
  const on = wishlist.has(modalProduct.id);
  b.textContent = on ? "♥" : "♡";
  b.classList.toggle("active", on);
}

function renderWish() {
  const box = $("wish-items");
  const ids = [...wishlist].map((id) => products.find((p) => p.id === id)).filter(Boolean);
  if (ids.length === 0) {
    box.innerHTML = '<p class="wish-empty">পছন্দের তালিকা খালি আছে।<br>পণ্যের ♡ চাপলে এখানে জমা হবে।</p>';
    return;
  }
  box.innerHTML = "";
  ids.forEach((p) => {
    const row = document.createElement("div");
    row.className = "wish-item";
    row.innerHTML =
      `<img src="${p.image}" alt="${escapeHtml(p.name)}">` +
      `<div class="info"><p><strong>${escapeHtml(p.name)}</strong></p>` +
      `<p class="price">${taka(p.price)}</p>` +
      `<div class="row">` +
      `<button class="btn-add">কার্টে যোগ করুন</button>` +
      `<button class="btn-outline">✕ মুছুন</button>` +
      `</div></div>`;
    const [addBtn, delBtn] = row.querySelectorAll("button");
    addBtn.onclick = () => { addToCart(p.id, 1); openDrawer(); };
    delBtn.onclick = () => toggleWish(p.id);
    box.appendChild(row);
  });
}

function openWish() {
  renderWish();
  $("wish-drawer").classList.remove("hidden");
  $("wish-overlay").classList.remove("hidden");
}
function closeWish() {
  $("wish-drawer").classList.add("hidden");
  $("wish-overlay").classList.add("hidden");
}

/* ---------------- Checkout ---------------- */
function selectedDeliveryArea() {
  const r = document.querySelector('input[name="delivery_area"]:checked');
  return r ? r.value : "inside_dhaka";
}
function deliveryChargeFor() {
  const a = DELIVERY_AREAS[selectedDeliveryArea()];
  return a ? a.charge : 0;
}
function orderTotal() {
  return cartTotal() + deliveryChargeFor();
}

function renderCheckoutSummary() {
  const box = $("checkout-summary");
  const area = DELIVERY_AREAS[selectedDeliveryArea()] || DELIVERY_AREAS.inside_dhaka;
  const lines = Object.entries(cart).map(([id, qty]) => {
    const p = products.find((x) => x.id === id);
    return p ? `<p>${escapeHtml(p.name)} × ${bn(qty)} = <strong>${taka(p.price * qty)}</strong></p>` : "";
  }).join("");
  box.innerHTML = lines +
    `<p class="summary-line"><span>সাবটোটাল</span><span>${taka(cartTotal())}</span></p>` +
    `<p class="summary-line"><span>ডেলিভারি চার্জ (${area.label})</span><span>${taka(area.charge)}</span></p>` +
    `<p class="total-row summary-line"><span>সর্বমোট</span><strong>${taka(orderTotal())}</strong></p>`;
}

async function submitOrder(e) {
  e.preventDefault();
  const errEl = $("form-error");
  errEl.textContent = "";
  const address = $("co-address").value.trim();
  if (address.length < 10) { errEl.textContent = ERROR_BN.address_required; return; }
  if (Object.keys(cart).length === 0) { errEl.textContent = ERROR_BN.empty_cart; return; }
  const deliveryArea = selectedDeliveryArea();
  if (!DELIVERY_AREAS[deliveryArea]) { errEl.textContent = ERROR_BN.invalid_delivery_area; return; }

  const payload = {
    address,
    notes: $("co-notes").value.trim(),
    items: Object.entries(cart).map(([id, qty]) => ({ id, qty })),
    payment: "cod",
    delivery_area: deliveryArea,
  };
  try {
    const { status, data } = await api("/api/orders", { method: "POST", body: JSON.stringify(payload) });
    if (status === 201 && data && data.ok) {
      const area = DELIVERY_AREAS[data.delivery_area] || DELIVERY_AREAS.inside_dhaka;
      cart = {};
      saveCart();
      renderCart();
      $("checkout-section").classList.add("hidden");
      $("order-id").textContent = data.order_id;
      $("confirm-breakdown").innerHTML =
        `<p class="summary-line"><span>সাবটোটাল</span><span>${taka(data.total - data.delivery_charge)}</span></p>` +
        `<p class="summary-line"><span>ডেলিভারি চার্জ (${area.label})</span><span>${taka(data.delivery_charge)}</span></p>` +
        `<p class="total-row summary-line"><span>সর্বমোট (COD)</span><strong>${taka(data.total)}</strong></p>`;
      $("confirmation").classList.remove("hidden");
      $("confirmation").scrollIntoView({ behavior: "smooth" });
      $("checkout-form").reset();
      // re-fill account info after reset
      $("co-name").value = account.name;
      $("co-phone").value = account.phone;
      renderCheckoutSummary();
    } else if (status === 401) {
      logout();
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
}

/* ---------------- My orders (customer tracking) ---------------- */
function stepperHtml(status) {
  // cancelled orders show no forward progress
  const steps = [["অর্ডার", "pending"], ["কনফার্মড", "confirmed"], ["ডেলিভার্ড", "delivered"]];
  const order = ["pending", "confirmed", "delivered"];
  const cur = status === "cancelled" ? -1 : order.indexOf(status);
  return '<div class="stepper">' + steps.map(([label, s], i) => {
    const done = cur >= 0 && i <= cur;
    return `<div class="step${done ? " done" : ""}"><div class="dot">${done ? "✓" : bn(i + 1)}</div>${label}</div>`;
  }).join("") + "</div>";
}

async function openOrders() {
  const box = $("my-orders");
  box.innerHTML = '<p class="muted center">লোড হচ্ছে…</p>';
  $("orders-modal").classList.remove("hidden");
  try {
    const { status, data } = await api("/api/orders/mine");
    if (status === 401) { logout(); return; }
    const orders = (data && data.orders) || [];
    if (orders.length === 0) {
      box.innerHTML = '<p class="wish-empty">📦<br>এখনো কোনো অর্ডার নেই।<br>পছন্দের পণ্য কার্টে যোগ করে অর্ডার করুন!</p>';
      return;
    }
    box.innerHTML = "";
    orders.forEach((o) => {
      const area = DELIVERY_AREAS[o.delivery_area];
      const card = document.createElement("div");
      card.className = "order-card";
      card.innerHTML =
        `<p><span class="oid">${escapeHtml(o.order_id)}</span></p>` +
        `<p class="odate">${fmtDateBn(o.created_at)}${area ? " • " + area.label : ""}</p>` +
        `<span class="ostatus ${escapeHtml(o.status)}">${STATUS_BN[o.status] || escapeHtml(o.status)}</span>` +
        stepperHtml(o.status) +
        `<div class="oitems">${(o.items || []).map((i) => `${escapeHtml(i.name)} × ${bn(i.qty)}`).join("<br>")}</div>` +
        `<div class="ototal"><span>সর্বমোট (ডেলিভারিসহ)</span><span>${taka(o.total)}</span></div>`;
      box.appendChild(card);
    });
  } catch (e) {
    box.innerHTML = '<p class="error center">নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।</p>';
  }
}

function fmtDateBn(iso) {
  try { return new Date(iso).toLocaleString("bn-BD"); } catch (e) { return ""; }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- Boot ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  wireGate();
  wireShop();
  if (!authToken) { showGate(); return; }
  try {
    const { status, data } = await api("/api/auth/me");
    if (status === 200 && data && data.ok) {
      account = { name: data.name, phone: data.phone };
      enterSite();
    } else {
      authToken = null;
      localStorage.removeItem(TOKEN_KEY);
      showGate();
    }
  } catch (e) {
    showGate();
  }
});
