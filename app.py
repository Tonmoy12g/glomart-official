#!/usr/bin/env python3
"""GlowMart backend — Flask app serving the storefront + JSON API.

Run locally:
    cd backend
    pip install -r requirements.txt
    python app.py

Environment variables:
    ADMIN_PASSWORD   password for /admin and /api/admin/* (default: changeme123 — CHANGE IT)
    ORDERS_DB        path to the SQLite database file (default: backend/orders.db)
    PORT             port to listen on (default: 5000)
    PATHAO_*         Pathao courier credentials (integration is PREPARED ONLY — NOT active/tested)
"""

import hmac
import json
import os
import re
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, abort, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = BASE_DIR  # flat layout: index.html etc. sit next to app.py
PRODUCTS_PATH = os.path.join(FRONTEND_DIR, "products.json")
DB_PATH = os.environ.get("ORDERS_DB", os.path.join(BASE_DIR, "orders.db"))

# ---------------------------------------------------------------------------
# !!! SECURITY: change this before going live !!!
# Set ADMIN_PASSWORD in your hosting dashboard's environment variables.
# ---------------------------------------------------------------------------
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "changeme123")

BD_PHONE_RE = re.compile(r"^01[3-9]\d{8}$")
MIN_PASSWORD_LEN = 6

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB cap for product photo uploads


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def get_db():
    """One SQLite connection per request (sqlite3 stdlib only)."""
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               phone TEXT NOT NULL UNIQUE,
               password_hash TEXT NOT NULL,
               created_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sessions (
               token TEXT PRIMARY KEY,
               user_id INTEGER NOT NULL REFERENCES users(id),
               created_at TEXT NOT NULL
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS orders (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               order_id TEXT NOT NULL UNIQUE,
               user_id INTEGER REFERENCES users(id),
               name TEXT NOT NULL,
               phone TEXT NOT NULL,
               address TEXT NOT NULL,
               notes TEXT DEFAULT '',
               items TEXT NOT NULL,
               total INTEGER NOT NULL,
               payment TEXT NOT NULL DEFAULT 'cod',
               status TEXT NOT NULL DEFAULT 'pending',
               created_at TEXT NOT NULL
           )"""
    )
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalize_phone(raw):
    return re.sub(r"[\s\-]", "", str(raw or ""))


def err(code, status):
    return jsonify({"ok": False, "error": code}), status


def load_products():
    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def _bearer_token():
    auth = request.headers.get("Authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    q = request.args.get("token")
    return q.strip() if q else None


def current_user():
    """Return the logged-in user dict or None."""
    token = _bearer_token()
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        """SELECT u.id, u.name, u.phone FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
        (token,),
    ).fetchone()
    return dict(row) if row else None


def require_user():
    user = current_user()
    if not user:
        return None, err("login_required", 401)
    return user, None


def create_session(conn, user_id):
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
        (token, user_id, now_iso()),
    )
    return token


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------
@app.post("/api/auth/signup")
def signup():
    data = request.get_json(force=True, silent=True) or {}
    name = str(data.get("name") or "").strip()
    phone = normalize_phone(data.get("phone"))
    password = str(data.get("password") or "")

    if not name:
        return err("name_required", 400)
    if not BD_PHONE_RE.match(phone):
        return err("invalid_phone", 400)
    if len(password) < MIN_PASSWORD_LEN:
        return err("password_too_short", 400)

    conn = get_db()
    if conn.execute("SELECT 1 FROM users WHERE phone = ?", (phone,)).fetchone():
        return err("phone_exists", 409)

    # NEVER store plaintext passwords: salted PBKDF2 hash via werkzeug.
    pw_hash = generate_password_hash(password)
    cur = conn.execute(
        "INSERT INTO users (name, phone, password_hash, created_at) VALUES (?,?,?,?)",
        (name, phone, pw_hash, now_iso()),
    )
    token = create_session(conn, cur.lastrowid)
    conn.commit()
    return jsonify({"ok": True, "token": token, "name": name, "phone": phone}), 201


@app.post("/api/auth/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    phone = normalize_phone(data.get("phone"))
    password = str(data.get("password") or "")

    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return err("invalid_credentials", 401)

    token = create_session(conn, row["id"])
    conn.commit()
    return jsonify({"ok": True, "token": token, "name": row["name"], "phone": row["phone"]})


@app.get("/api/auth/me")
def me():
    user = current_user()
    if not user:
        return err("login_required", 401)
    return jsonify({"ok": True, "name": user["name"], "phone": user["phone"]})


@app.post("/api/auth/logout")
def logout():
    token = _bearer_token()
    if token:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Storefront API
# ---------------------------------------------------------------------------
@app.get("/api/products")
def api_products():
    # Catalog is public data; the login gate lives in the frontend UI.
    return jsonify(load_products())


def new_order_id(conn):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    for _ in range(20):
        oid = "GM-" + "".join(secrets.choice(alphabet) for _ in range(6))
        if not conn.execute("SELECT 1 FROM orders WHERE order_id = ?", (oid,)).fetchone():
            return oid
    raise RuntimeError("could not generate a unique order id")


@app.post("/api/orders")
def create_order():
    # Orders require a logged-in account; name/phone come from the account.
    user, error = require_user()
    if error:
        return error

    data = request.get_json(force=True, silent=True) or {}
    address = str(data.get("address") or "").strip()
    notes = str(data.get("notes") or "").strip()
    items_in = data.get("items") or []
    payment = str(data.get("payment") or "cod").strip().lower()

    if len(address) < 10:
        return err("address_required", 400)
    if payment != "cod":
        return err("unsupported_payment", 400)

    products = {p["id"]: p for p in load_products()}
    items, total = [], 0
    for it in items_in:
        pid = it.get("id")
        qty = it.get("qty")
        if pid not in products or not isinstance(qty, int) or not 1 <= qty <= 99:
            return err("invalid_items", 400)
        price = int(products[pid]["price"])
        items.append(
            {"id": pid, "name": products[pid]["name"], "price": price, "qty": qty}
        )
        total += price * qty
    if not items:
        return err("empty_cart", 400)

    conn = get_db()
    order_id = new_order_id(conn)
    conn.execute(
        """INSERT INTO orders
           (order_id, user_id, name, phone, address, notes, items, total, payment, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            order_id,
            user["id"],
            user["name"],
            user["phone"],
            address,
            notes,
            json.dumps(items, ensure_ascii=False),
            total,
            "cod",
            "pending",
            now_iso(),
        ),
    )
    conn.commit()
    return jsonify({"ok": True, "order_id": order_id, "total": total}), 201


# ---------------------------------------------------------------------------
# Admin (password-protected)
# ---------------------------------------------------------------------------
def admin_authorized():
    pw = request.args.get("password", "")
    if not pw and request.is_json:
        pw = (request.get_json(silent=True) or {}).get("password", "")
    return hmac.compare_digest(str(pw), ADMIN_PASSWORD)


@app.get("/api/admin/orders")
def admin_orders():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    rows = conn.execute("SELECT * FROM orders ORDER BY id DESC").fetchall()
    orders = []
    for r in rows:
        o = dict(r)
        try:
            o["items"] = json.loads(o["items"])
        except (TypeError, ValueError):
            o["items"] = []
        orders.append(o)
    return jsonify({"ok": True, "orders": orders})


@app.post("/api/admin/pathao/test")
def admin_pathao_test():
    if not admin_authorized():
        return err("unauthorized", 401)
    # Pathao is prepared but NOT active/tested — never claim otherwise.
    from pathao import create_consignment  # noqa: F401  (import keeps module importable)

    return jsonify(
        {"active": False, "message": "Pathao integration is prepared but NOT active/tested."}
    )


@app.get("/admin")
def admin_page():
    return send_from_directory(BASE_DIR, "admin.html")


# ---------------------------------------------------------------------------
# Admin: dashboard stats, customers, order status, product management
# ---------------------------------------------------------------------------
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
ALLOWED_PHOTO_EXT = {"jpg", "jpeg", "png", "webp"}
ORDER_STATUSES = ("pending", "confirmed", "delivered", "cancelled")


@app.get("/api/admin/stats")
def admin_stats():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    total_orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    total_revenue = conn.execute("SELECT COALESCE(SUM(total),0) FROM orders").fetchone()[0]
    total_customers = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return jsonify({
        "ok": True,
        "total_orders": total_orders,
        "total_revenue": total_revenue,
        "total_customers": total_customers,
        "total_products": len(load_products()),
    })


@app.get("/api/admin/customers")
def admin_customers():
    if not admin_authorized():
        return err("unauthorized", 401)
    conn = get_db()
    rows = conn.execute(
        """SELECT u.name, u.phone, u.created_at,
                  (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
           FROM users u ORDER BY u.id DESC"""
    ).fetchall()
    return jsonify({"ok": True, "customers": [dict(r) for r in rows]})


@app.post("/api/admin/orders/<order_id>/status")
def admin_order_status(order_id):
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    status = str(data.get("status") or "").strip().lower()
    if status not in ORDER_STATUSES:
        return err("invalid_status", 400)
    conn = get_db()
    cur = conn.execute(
        "UPDATE orders SET status = ? WHERE order_id = ?", (status, order_id)
    )
    conn.commit()
    if cur.rowcount == 0:
        return err("order_not_found", 404)
    return jsonify({"ok": True})


def save_products(products):
    """Atomic write so a crash never leaves a half-written catalog."""
    tmp = PRODUCTS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(products, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PRODUCTS_PATH)


def make_product_id(name, existing_ids):
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:40] or "product"
    for _ in range(10):
        pid = "%s-%s" % (slug, secrets.token_hex(3))
        if pid not in existing_ids:
            return pid
    raise RuntimeError("could not generate a unique product id")


def validate_product_payload(data, partial=False):
    """Validate admin product input. Returns (cleaned_dict, error_code)."""
    required = ["name", "size", "category", "price", "image", "description", "usage"]
    cleaned = {}
    if not partial:
        for field in required:
            if data.get(field) in (None, ""):
                return None, "missing_" + field
    if data.get("price") is not None:
        try:
            price = float(data.get("price"))
        except (TypeError, ValueError):
            return None, "invalid_price"
        if price <= 0:
            return None, "invalid_price"
        cleaned["price"] = int(price) if price.is_integer() else price
    for field in ["name", "size", "category", "image", "description", "usage", "badge"]:
        if data.get(field) not in (None, ""):
            cleaned[field] = str(data.get(field)).strip()
    if "sample" in data:
        cleaned["sample"] = bool(data.get("sample"))
    return cleaned, None


@app.get("/api/admin/products")
def admin_product_list():
    if not admin_authorized():
        return err("unauthorized", 401)
    return jsonify({"ok": True, "products": load_products()})


@app.post("/api/admin/products")
def admin_product_create():
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    cleaned, error = validate_product_payload(data)
    if error:
        return err(error, 400)
    products = load_products()
    pid = make_product_id(cleaned["name"], {p["id"] for p in products})
    product = {"id": pid}
    product.update(cleaned)
    products.append(product)
    save_products(products)
    return jsonify({"ok": True, "product": product}), 201


@app.put("/api/admin/products/<pid>")
def admin_product_update(pid):
    if not admin_authorized():
        return err("unauthorized", 401)
    data = request.get_json(force=True, silent=True) or {}
    cleaned, error = validate_product_payload(data, partial=True)
    if error:
        return err(error, 400)
    products = load_products()
    for p in products:
        if p["id"] == pid:
            p.update(cleaned)
            save_products(products)
            return jsonify({"ok": True, "product": p})
    return err("product_not_found", 404)


@app.delete("/api/admin/products/<pid>")
def admin_product_delete(pid):
    if not admin_authorized():
        return err("unauthorized", 401)
    products = load_products()
    removed = [p for p in products if p["id"] == pid]
    if not removed:
        return err("product_not_found", 404)
    img = str(removed[0].get("image") or "")
    if img.startswith("uploads/"):
        # Only delete files inside our uploads dir (no path traversal).
        target = os.path.abspath(os.path.join(BASE_DIR, img))
        if target.startswith(os.path.abspath(UPLOAD_DIR) + os.sep) and os.path.isfile(target):
            os.remove(target)
    save_products([p for p in products if p["id"] != pid])
    return jsonify({"ok": True})


@app.post("/api/admin/products/upload")
def admin_product_upload():
    if not admin_authorized():
        return err("unauthorized", 401)
    file = request.files.get("photo")
    if not file or not file.filename:
        return err("no_photo", 400)
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXT:
        return err("bad_extension", 400)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    safe = secure_filename(file.filename) or ("photo." + ext)
    fname = "%s-%s" % (uuid.uuid4().hex[:12], safe)
    file.save(os.path.join(UPLOAD_DIR, fname))
    return jsonify({"ok": True, "image": "uploads/" + fname}), 201


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:filename>")
def frontend_files(filename):
    # Never expose backend code, the database, or dotfiles.
    if filename.startswith("backend/") or filename.startswith(".") or "/." in "/" + filename:
        abort(404)
    return send_from_directory(FRONTEND_DIR, filename)


# init_db() must run at import time: gunicorn imports this module
# (so __main__ never runs there) and the DB tables must exist.
init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
