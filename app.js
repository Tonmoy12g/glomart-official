/* GlowMart BIG storefront logic.
   Same-origin /api/* calls only. No secrets or credentials in this file.
   Auth token is stored in localStorage; the login gate blocks the shop until logged in. */

const TOKEN_KEY = "glowmart_token";
const CART_KEY = "glowmart_cart";

let authToken = localStorage.getItem(TOKEN_KEY) || null;
let account = null; // {name, phone} after login
let products = [];
let cart = {};
try { cart = JSON.parse(localStorage.getItem(CART_KEY) || "{}"); } catch (e) { cart = {}; }
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
  network: "নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।",
};

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
  startHero();
  startCountdown();
}

function wireShop() {
  $("logout-btn").onclick = logout;
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
  return badgesHtml(p) +
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
  const [detailBtn, addBtn] = card.querySelectorAll("button");
  detailBtn.onclick = (e) => { e.stopPropagation(); openModal(p.id); };
  addBtn.onclick = (e) => { e.stopPropagation(); addToCart(p.id, 1); openDrawer(); };
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

/* ---------------- Checkout ---------------- */
function renderCheckoutSummary() {
  const box = $("checkout-summary");
  const lines = Object.entries(cart).map(([id, qty]) => {
    const p = products.find((x) => x.id === id);
    return p ? `<p>${escapeHtml(p.name)} × ${bn(qty)} = <strong>${taka(p.price * qty)}</strong></p>` : "";
  }).join("");
  box.innerHTML = lines + `<p class="total-row">সর্বমোট: <strong>${taka(cartTotal())}</strong></p>`;
}

async function submitOrder(e) {
  e.preventDefault();
  const errEl = $("form-error");
  errEl.textContent = "";
  const address = $("co-address").value.trim();
  if (address.length < 10) { errEl.textContent = ERROR_BN.address_required; return; }
  if (Object.keys(cart).length === 0) { errEl.textContent = ERROR_BN.empty_cart; return; }

  const payload = {
    address,
    notes: $("co-notes").value.trim(),
    items: Object.entries(cart).map(([id, qty]) => ({ id, qty })),
    payment: "cod",
  };
  try {
    const { status, data } = await api("/api/orders", { method: "POST", body: JSON.stringify(payload) });
    if (status === 201 && data && data.ok) {
      cart = {};
      saveCart();
      renderCart();
      $("checkout-section").classList.add("hidden");
      $("order-id").textContent = data.order_id;
      $("confirmation").classList.remove("hidden");
      $("confirmation").scrollIntoView({ behavior: "smooth" });
      $("checkout-form").reset();
      // re-fill account info after reset
      $("co-name").value = account.name;
      $("co-phone").value = account.phone;
    } else if (status === 401) {
      logout();
    } else {
      errEl.textContent = ERROR_BN[(data && data.error)] || ERROR_BN.network;
    }
  } catch (e) {
    errEl.textContent = ERROR_BN.network;
  }
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
