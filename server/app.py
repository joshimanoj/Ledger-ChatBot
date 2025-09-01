import os
import json
import base64
import mimetypes
import sqlite3
import random
from datetime import datetime, timedelta, timezone, date

from flask import Flask, request, jsonify, g, send_file
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# ==== PDF & invoice helpers ====
from io import BytesIO
from decimal import Decimal, ROUND_HALF_UP

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer
from reportlab.lib.enums import TA_LEFT

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, KeepTogether
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

from io import BytesIO
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime
from flask import send_file, jsonify, request

# ---------- Config ----------
DB_PATH = os.path.join(os.path.dirname(__file__), "ledger.db")
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = Flask(__name__)
CORS(app)


# ---------- DB Helpers ----------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db

def ensure_user_exists(mobile: str, name: str):
    db = get_db()
    db.execute("INSERT OR IGNORE INTO users (mobile, name) VALUES (?, ?)", (mobile, name))
    db.commit()

def clone_user_entries(src_mobile: str, dst_mobile: str):
    """Clone all entries from src to dst (same texts)."""
    db = get_db()
    # make sure dst user row exists
    ensure_user_exists(dst_mobile, f"User {dst_mobile}")
    db.execute("""
        INSERT INTO entries (mobile, product, units, revenue, credit, creditor, date)
        SELECT ?, product, units, revenue, credit, creditor, date
        FROM entries WHERE mobile = ?
    """, (dst_mobile, src_mobile))
    db.commit()


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _ensure_user_settings_columns():
    """
    Extend users table with settings columns if missing:
      store_name TEXT, store_address TEXT, store_gst TEXT, store_contact TEXT
    """
    db = get_db()
    cols = {r["name"] for r in db.execute("PRAGMA table_info(users)").fetchall()}
    to_add = []
    if "store_name" not in cols:
        to_add.append(("store_name", "TEXT"))
    if "store_address" not in cols:
        to_add.append(("store_address", "TEXT"))
    if "store_gst" not in cols:
        to_add.append(("store_gst", "TEXT"))
    if "store_contact" not in cols:
        to_add.append(("store_contact", "TEXT"))
    for name, typ in to_add:
        db.execute(f"ALTER TABLE users ADD COLUMN {name} {typ}")
    if to_add:
        db.commit()


def init_db():
    db = get_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          mobile TEXT PRIMARY KEY,
          name   TEXT NOT NULL,
          store_name TEXT,
          store_address TEXT,
          store_gst TEXT,
          store_contact TEXT
        );
        CREATE TABLE IF NOT EXISTS entries (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          mobile   TEXT NOT NULL,
          product  TEXT,
          units    INTEGER NOT NULL,
          revenue  INTEGER NOT NULL,
          credit   INTEGER NOT NULL,  -- 0/1
          creditor TEXT,
          date     TEXT NOT NULL,
          FOREIGN KEY (mobile) REFERENCES users(mobile)
        );
        CREATE INDEX IF NOT EXISTS idx_entries_mobile_date ON entries (mobile, date);
        CREATE INDEX IF NOT EXISTS idx_entries_mobile_product_date ON entries (mobile, product, date);
        """
    )
    db.commit()
    _ensure_user_settings_columns()


def ensure_user(mobile: str, name: str):
    db = get_db()
    db.execute("INSERT OR IGNORE INTO users (mobile, name) VALUES (?, ?)", (mobile, name))
    db.commit()


def clear_user_entries(mobile: str):
    db = get_db()
    db.execute("DELETE FROM entries WHERE mobile = ?", (mobile,))
    db.commit()


def count_entries_for_day(mobile: str, day: date) -> int:
    db = get_db()
    start_dt = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(days=1)
    start = start_dt.isoformat().replace("+00:00", "Z")
    end = end_dt.isoformat().replace("+00:00", "Z")
    cur = db.execute(
        "SELECT COUNT(*) AS c FROM entries WHERE mobile=? AND date>=? AND date<?",
        (mobile, start, end),
    )
    return int(cur.fetchone()["c"])


def insert_batch(rows):
    if not rows:
        return
    db = get_db()
    db.executemany(
        "INSERT INTO entries (mobile, product, units, revenue, credit, creditor, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    db.commit()


# ---------- Catalog & Population Generators ----------
def gen_product_catalog():
    bases = [
        "Colgate", "Close-Up", "Pepsodent", "Sensodyne", "Dabur Red", "Oral-B",
        "Surf Excel", "Ariel", "Tide", "Rin", "Nirma", "Wheel",
        "Maggi", "Yippee", "Top Ramen",
        "Dettol Soap", "Lifebuoy Soap", "Pears Soap", "Lux Soap", "Dove Soap",
        "Dettol Liquid", "Savlon Handwash", "Lifebuoy Handwash",
        "Lizol", "Harpic", "Domex",
        "Good Knight Refill", "All-Out Refill", "Mortein Coil",
        "Clinic Plus Shampoo", "Sunsilk Shampoo", "Pantene Shampoo", "Head & Shoulders",
        "Bru Coffee", "Nescafe", "Tata Tea", "Red Label Tea",
        "Basmati Rice", "Wheat Flour", "Sugar", "Salt", "Cooking Oil",
        "Kellogg's Corn Flakes", "Chocos", "Oats",
        "Parle-G", "Good Day", "Hide & Seek", "Monaco",
        "Coca-Cola", "Pepsi", "Sprite", "Fanta", "Thums Up",
        "Bisleri Water", "Kinley Water", "Aquafina Water",
        "Haldiram Bhujia", "Lays Chips", "Kurkure",
        "Amul Butter", "Amul Cheese", "Paneer",
        "Himalaya Facewash", "Ponds Cold Cream", "Vaseline",
        "Surf Excel Matic", "Ariel Matic", "Tide Plus",
        "Toor Dal", "Chana Dal", "Masoor Dal", "Moong Dal",
        "Chilli Powder", "Turmeric Powder", "Coriander Powder", "Garam Masala",
        "Pickle Mix", "Jam Mixed Fruit", "Honey",
    ]
    while len(bases) < 250:
        bases.append(f"Generic FMCG {len(bases)+1}")

    size_templates = [
        ["50g", "100g", "200g", "500g"],
        ["100 ml", "200 ml", "500 ml", "1 L"],
        ["250 g", "500 g", "1 kg"],
        ["small", "medium", "large"],
    ]

    catalog = []
    random.seed(42)
    for base in bases:
        sizes = random.choice(size_templates)
        desired = random.randint(2, 4)
        k = max(1, min(desired, len(sizes)))
        picked_sizes = random.sample(sizes, k=k)

        for sz in picked_sizes:
            base_price = 30 + len(base)
            s = sz.lower()
            factor = 1.0
            if "50" in s: factor = 0.7
            elif "100" in s: factor = 0.9
            elif "200" in s: factor = 1.2
            elif "250" in s: factor = 1.3
            elif "500" in s: factor = 2.2
            elif "1 kg" in s or "1 l" in s: factor = 3.8
            elif "small" in s: factor = 0.8
            elif "medium" in s: factor = 1.0
            elif "large" in s: factor = 1.6

            price = max(10, int(round(base_price * factor)))
            catalog.append((f"{base} {sz}", price))
    return catalog


def gen_vendors(n=12):
    names = [
        "HUL Distributor", "Metro Cash&Carry", "VR Super Distributors", "Star Wholesale",
        "Local Transporter", "Packaging Vendor", "Rent", "Electricity", "Cleaner",
        "ITC Distributor", "Nestle Distributor", "PepsiCo Distributor", "Coca-Cola Distributor",
        "Bisleri Distributor", "Tata Consumer Distributor", "Adani Wilmar Distributor",
        "Jio Business", "Airtel Fiber",
    ]
    if len(names) < n:
        for i in range(len(names)+1, n+1):
            names.append(f"Distributor {i:02d}")
    elif len(names) > n:
        names = names[:n]
    return names


def gen_customer_pool(total_target):
    pool_size = max(200, int(total_target * 0.3))
    first = ["Ramesh","Suresh","Kalyani","Anil","Sita","Ravi","Meena","Amit","Neha",
             "Pooja","Vijay","Rekha","Sunil","Prakash","Ashok","Nitin","Deepak","Raj",
             "Kiran","Manoj","Arun","Smita","Geeta","Nisha","Ayesha","Varun","Ishita",
             "Rohit","Rohan","Sahil","Harish","Payal","Priya","Kartik","Yash","Ananya"]
    last = ["Sharma","Verma","Gupta","Agarwal","Patel","Reddy","Iyer","Menon","Das",
            "Singh","Khan","Ali","Kaul","Bose","Mehta","Jain","Kapoor","Bajaj","Chopra",
            "Saxena","Shukla","Tripathi","Mishra","Kulkarni","Sawant","Shetty","Gowda"]
    names, used, i = [], set(), 0
    while len(names) < pool_size:
        nm = f"{random.choice(first)} {random.choice(last)}"
        if nm in used:
            i += 1
            nm = f"{nm} {i}"
        used.add(nm)
        names.append(nm)

    s = 1.2
    ranks = list(range(1, len(names)+1))
    weights = [1 / (r ** s) for r in ranks]
    total_w = sum(weights)
    weights = [w / total_w for w in weights]

    credit_eligible_count = max(1, int(0.10 * len(names)))
    eligible_idx = set(random.sample(range(len(names)), credit_eligible_count))
    return names, weights, eligible_idx


# ---------- Seeding ----------
def realistic_august_seed(mobile: str, name: str = None):
    random.seed(123)
    if not name:
        name = f"User {mobile}"
    ensure_user(mobile, name)

    CATALOG = gen_product_catalog()
    VENDORS = gen_vendors(12)
    total_target_for_pool = 100 * 25
    CUSTOMERS, CUST_WEIGHTS, CREDIT_ELIG_IDX = gen_customer_pool(total_target_for_pool)

    year = 2025
    month = 8
    start_day = date(year, month, 1)
    end_day = date(year, month, 25)

    ratio_sales_total = 0.85
    ratio_sales_credit_of_sales = 0.10
    ratio_expense_total = 1.0 - ratio_sales_total  # 0.15
    ratio_expense_payable = ratio_expense_total * 0.55
    ratio_expense_cash = ratio_expense_total * 0.45

    def rand_time_on_day(day_start: datetime) -> datetime:
        seconds = random.randint(0, 86399)
        return day_start + timedelta(seconds=seconds)

    def weighted_choice(items, weights):
        r = random.random()
        cum = 0.0
        for item, w in zip(items, weights):
            cum += w
            if r <= cum:
                return item
        return items[-1]

    def mk_sale_entry(day_start_utc: datetime, credit: bool):
        sku, price = random.choice(CATALOG)
        units = random.randint(1, 2)
        revenue = int(price * units)
        dt = rand_time_on_day(day_start_utc).isoformat().replace("+00:00", "Z")
        creditor = None
        if credit:
            idx = random.choice(list(CREDIT_ELIG_IDX))
            creditor = CUSTOMERS[idx]
        else:
            _ = weighted_choice(CUSTOMERS, CUST_WEIGHTS)
        return (mobile, sku, units, revenue, 1 if credit else 0, creditor, dt)

    def mk_expense_entry(day_start_utc: datetime, payable: bool):
        vendor = random.choice(VENDORS)
        amt = random.randint(200, 2000)
        show_paid_word = (not payable) and (random.random() < 0.6)
        head = vendor
        product = f"Expense: {head}{' paid' if show_paid_word else ''}"
        revenue = -amt
        dt = rand_time_on_day(day_start_utc).isoformat().replace("+00:00", "Z")
        return (mobile, product, 1, revenue, 1 if payable else 0, vendor if payable else None, dt)

    for i in range((end_day - start_day).days + 1):
        d = start_day + timedelta(days=i)
        if d.day == 15:
            continue  # holiday

        weekday = d.weekday()
        tx_target = random.randint(60, 90) if weekday < 5 else random.randint(90, 120)

        existing = count_entries_for_day(mobile, d)
        need = max(0, tx_target - existing)
        if need == 0:
            continue

        day_start_utc = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        rows = []
        for _ in range(need):
            r = random.random()
            if r < ratio_sales_total * ratio_sales_credit_of_sales:
                rows.append(mk_sale_entry(day_start_utc, credit=True))
            elif r < ratio_sales_total:
                rows.append(mk_sale_entry(day_start_utc, credit=False))
            elif r < ratio_sales_total + ratio_expense_payable:
                rows.append(mk_expense_entry(day_start_utc, payable=True))
            else:
                rows.append(mk_expense_entry(day_start_utc, payable=False))
        insert_batch(rows)


def realistic_august_seed_7042125595():
    realistic_august_seed("7042125595", "User 7042125595")


# ---------- Startup ----------
with app.app_context():
    init_db()
    realistic_august_seed_7042125595()
    # Create Hindi-flow user so /api/user/<mobile> works
    ensure_user_exists("7042125590", "User 7042125590")
    # OPTIONAL: clone entries from 7042125595 so the Hindi user has data too.
    # (Texts will be same as source. If you later want full transliteration,
    #  we can add a transliteration step.)
    clone_user_entries("7042125595", "7042125590")


# ---------- Users & Settings ----------
@app.get("/api/user/<mobile>")
def get_user(mobile):
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE mobile = ?", (mobile,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "mobile": row["mobile"],
        "name": row["name"],
        "store_name": row["store_name"],
        "store_address": row["store_address"],
        "store_gst": row["store_gst"],
        "store_contact": row["store_contact"],
    })


@app.post("/api/register")
def register():
    data = request.get_json(force=True, silent=True) or {}
    mobile = (data.get("mobile") or "").strip()
    name = (data.get("name") or "").strip()
    if not mobile or not name:
        return jsonify({"error": "mobile and name required"}), 400
    db = get_db()
    db.execute("INSERT OR REPLACE INTO users (mobile, name) VALUES (?, ?)", (mobile, name))
    db.commit()
    return jsonify({"ok": True, "mobile": mobile, "name": name})


@app.get("/api/user/<mobile>/settings")
def get_settings(mobile):
    db = get_db()
    row = db.execute("SELECT store_name, store_address, store_gst, store_contact FROM users WHERE mobile=?", (mobile,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "store_name": row["store_name"],
        "store_address": row["store_address"],
        "store_gst": row["store_gst"],
        "store_contact": row["store_contact"],
    })


@app.post("/api/user/<mobile>/settings")
def update_settings(mobile):
    data = request.get_json(force=True, silent=True) or {}
    allowed = ["store_name", "store_address", "store_gst", "store_contact"]
    # Keep only provided keys; ignore missing ones so we don't wipe them
    fields = {k: v for k, v in data.items() if k in allowed}

    if not fields:
        return jsonify({"error": "no valid fields in payload"}), 400

    db = get_db()
    # Ensure user exists
    db.execute("INSERT OR IGNORE INTO users (mobile, name) VALUES (?, ?)", (mobile, f"User {mobile}"))

    sets = ", ".join([f"{k}=?" for k in fields.keys()])
    params = list(fields.values()) + [mobile]
    db.execute(f"UPDATE users SET {sets} WHERE mobile=?", params)
    db.commit()

    return jsonify({"ok": True, "updated": list(fields.keys())})


# ---------- Entries ----------
@app.get("/api/user/<mobile>/entries")
def list_entries(mobile):
    db = get_db()
    rows = db.execute(
        "SELECT id, product, units, revenue, credit, creditor, date "
        "FROM entries WHERE mobile = ? ORDER BY datetime(date) DESC",
        (mobile,),
    ).fetchall()
    items = [
        {
            "id": r["id"],
            "product": r["product"],
            "units": r["units"],
            "revenue": r["revenue"],
            "credit": bool(r["credit"]),
            "creditor": r["creditor"],
            "date": r["date"],
        }
        for r in rows
    ]
    return jsonify({"items": items})


@app.post("/api/user/<mobile>/entries")
def add_entries(mobile):
    data = request.get_json(force=True, silent=True) or {}
    items = data.get("items") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "items array required"}), 400
    db = get_db()
    db.execute("INSERT OR IGNORE INTO users (mobile, name) VALUES (?, ?)", (mobile, f"User {mobile}"))
    to_ins = []
    now_iso = datetime.utcnow().replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    for it in items:
        product = (it.get("product") or "").strip()
        units = int(it.get("units") or 0)
        revenue = int(it.get("revenue") or 0)
        credit = 1 if it.get("credit") else 0
        creditor = (it.get("creditor") or None)
        date_str = it.get("date") or now_iso
        if revenue != 0:
            to_ins.append((mobile, product, units, revenue, credit, creditor, date_str))
    if not to_ins:
        return jsonify({"error": "no valid items"}), 422
    db.executemany(
        "INSERT INTO entries (mobile, product, units, revenue, credit, creditor, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        to_ins,
    )
    db.commit()
    return jsonify({"ok": True, "inserted": len(to_ins)})


# ... keep imports & setup same as your file ...

...
@app.post("/api/parseMessage")
def parse_message():
    data = request.get_json(force=True, silent=True) or {}
    user_message = (data.get("message") or "").strip()
    if not user_message:
        return jsonify({"error": "message is required"}), 400

    try:
        # --- repayment quick detection ---
        tokens = user_message.lower().split()

        # Customer repayment: "Ramesh paid 1000"
        if len(tokens) >= 3 and tokens[1] == "paid" and tokens[-1].isdigit():
            name = tokens[0].capitalize()
            amt = float(tokens[-1])
            return jsonify({
                "items": [{
                    "product": "Repayment",
                    "units": 0,
                    "revenue": amt,   # subtracts from receivable
                    "credit": False,
                    "creditor": name
                }]
            })

        # Vendor repayment: "Paid Dal Vendor 1250"
        if tokens[0] == "paid" and tokens[-1].isdigit():
            name = " ".join(tokens[1:-1]).title()
            amt = float(tokens[-1])
            return jsonify({
                "items": [{
                    "product": "Repayment",
                    "units": 0,
                    "revenue": +amt,   # subtracts from payable
                    "credit": True,
                    "creditor": name
                }]
            })


        # otherwise → fallback to LLM
        system = """You are a strict JSON parser. Return ONLY a JSON object with an 'items' array. 
                    Each item must have: product (string|null), units (number), revenue (number), credit (boolean), creditor (string|null).

                    SALES RULES:
                    • Parse sales like '1 kg garam masala 250 rs', '500 gm haldi masala 250 rs suresh', '1000 rs ramesh'.
                    • If a PERSON NAME appears → CREDIT SALE (credit=true, creditor=name). If no name → CASH SALE (credit=false).
                    • Price accepts '250', '250 rs', '₹250', etc.
                    • IMPORTANT: If the input is ONLY a number (e.g. "1000", "-250") with no product/units:
                        - product = null
                        - units = 0
                        - revenue = that number
                        - credit = false
                        - creditor = null

                    UNITS RULES:
                    • If user explicitly writes units (e.g. "2 colgate", "50 unit maggi pack") → use that number.
                    • If user writes "pair" → units=2, "single" → units=1.
                    • If user writes weights/sizes like "500 gm", "1 kg" → keep in product string, units=1.
                    • Otherwise, if no explicit unit → units=0.

                    EXPENSE RULES:
                    • Expenses always have revenue NEGATIVE.
                    • Example: '-1250 rs Dal vendor cash' → Expense paid immediately.
                    • Example: '-1250 rs Dal vendor' (no 'cash') → Expense payable.
                    • If vendor missing → product=null, credit=true, creditor=null.
                    • Keywords like rent, electricity, expense → treat as expenses even if not prefixed with '-'.

                    REPAYMENT RULES:
                    • "Ramesh paid 1000" → customer repayment inflow, reduces receivable:
                      { "product": null, "units": 0, "revenue": 1000, "credit": false, "creditor": "Ramesh" }
                    • "Paid Dal Vendor 1250" → vendor repayment outflow, reduces payable:
                      { "product": null, "units": 0, "revenue": -1250, "credit": false, "creditor": "Dal Vendor" }

                    NAMES VS TOKENS:
                    • Ignore tokens: rs, inr, rupee, ₹, unit, units, kg, gm, g, litre, liter, l, ml, pack, packs, packet, pair, single, of, cash, paid, to.
                    • Names = alphabetic tokens not in the above list. Join multiple words at end as creditor.

                    OUTPUT EXACTLY:
                    { "items": [ { "product": string|null, "units": number, "revenue": number, "credit": boolean, "creditor": string|null } ] }
                    """


        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_message},
            ],
            temperature=0,
            max_tokens=300,
        )

        content = resp.choices[0].message.content if resp.choices else None
        if not content:
            return jsonify({"error": "Empty LLM response"}), 502

        import json as _json, re
        try:
            obj = _json.loads(content)
        except Exception:
            m = re.search(r"\{[\s\S]*\}", content)
            if not m:
                return jsonify({"error": "Non-JSON LLM response"}), 502
            obj = _json.loads(m.group(0))

        items = obj.get("items")
        if not isinstance(items, list):
            return jsonify({"error": "LLM JSON missing 'items'"}), 502

        # normalize
        norm = []
        for it in items:
            product = (it.get("product") or None)
            try:
                units = int(float(it.get("units", 0)))
            except Exception:
                units = 0
            try:
                revenue = float(it.get("revenue", 0))
            except Exception:
                revenue = 0.0
            credit = bool(it.get("credit", False))
            creditor = it.get("creditor") or None

            norm.append({
                "product": product,
                "units": units,
                "revenue": revenue,
                "credit": credit,
                "creditor": creditor
            })

        return jsonify({"items": norm})

    except Exception as e:
        print("/api/parseMessage error:", e)
        return jsonify({"error": str(e)}), 500


# ---------- Create Invoice (PDF) ----------
def q2(val):  # 2-decimal, half-up like invoices
    return Decimal(str(val)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def fmt_inr(x):
    # keep it simple; ReportLab's base fonts may not render '₹' on all systems.
    # If your '₹' renders fine already, change 'Rs.' to '₹'
    return f"Rs. {q2(x)}"

def _biz_from_payload(payload):
    b = (payload or {}).get("business") or {}
    # expected keys: store_name, store_address, store_gst, store_contact
    return {
        "store_name": b.get("store_name") or "My Shop",
        "store_address": b.get("store_address") or "",
        "store_gst": b.get("store_gst") or "",
        "store_contact": b.get("store_contact") or "",
    }


# add near your other ReportLab imports if missing
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, KeepTogether
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

from io import BytesIO
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime
from flask import send_file, jsonify, request

# ---------- helpers ----------
def q2(val):
    return Decimal(str(val)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def fmt_inr(x):
    # keep it simple; ReportLab's base fonts may not render '₹' on all systems.
    # If your '₹' renders fine already, change 'Rs.' to '₹'
    return f"Rs. {q2(x)}"

def _biz_from_payload(payload):
    b = (payload or {}).get("business") or {}
    return {
        "store_name": b.get("store_name") or "My Shop",
        "store_address": b.get("store_address") or "",
        "store_gst": b.get("store_gst") or "",
        "store_contact": b.get("store_contact") or "",
    }

# ---------- Beautiful invoice endpoint ----------

# KEEP your existing imports/helpers (q2, fmt_inr, _biz_from_payload) and just replace the route

@app.route("/api/invoices", methods=["POST"])
def api_invoices():
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from io import BytesIO
    from decimal import Decimal, ROUND_HALF_UP
    from datetime import datetime
    from flask import send_file, jsonify, request

    try:
        data = request.get_json(force=True) or {}
        customer = (data.get("customer") or {}).get("name", "").strip()
        items = data.get("items") or []
        terms = (data.get("paymentTerms") or "").strip()
        biz = _biz_from_payload(data)

        if not customer:
            return jsonify({"error": "Customer name required"}), 400
        if not items:
            return jsonify({"error": "At least one item required"}), 400

        # compute rows
        def q2(val):
            return Decimal(str(val)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        def fmt_inr(x):
            return f"Rs. {q2(x)}"

        rows = []
        subtotal = Decimal("0"); gst_total = Decimal("0")
        for i, it in enumerate(items, start=1):
            desc = (it.get("description") or "").strip() or "-"
            price = Decimal(str(it.get("price") or 0))
            gstp = Decimal(str(it.get("gstPercent") or 0))
            gst_amt = (price * gstp / Decimal("100"))
            line_total = price + gst_amt
            subtotal += price; gst_total += gst_amt
            rows.append([
                str(i), desc, fmt_inr(price), f"{q2(gstp)}%", fmt_inr(gst_amt), fmt_inr(line_total)
            ])
        grand = subtotal + gst_total

        # meta
        now = datetime.now()
        inv_date = now.strftime("%Y-%m-%d")
        inv_no = now.strftime("INV%Y%m%d-%H%M%S")

        # doc + styles
        buf = BytesIO()
        doc = SimpleDocTemplate(
            buf, pagesize=A4,
            leftMargin=16*mm, rightMargin=16*mm,
            topMargin=16*mm, bottomMargin=16*mm
        )
        styles = getSampleStyleSheet()
        H2 = ParagraphStyle('H2', parent=styles['Heading2'],
                            fontName='Helvetica-Bold', fontSize=12, leading=16, alignment=TA_LEFT)
        NORMAL = ParagraphStyle('NORMAL', parent=styles['Normal'],
                                fontName='Helvetica', fontSize=10, leading=14)
        RIGHT = ParagraphStyle('RIGHT', parent=styles['Normal'],
                               fontName='Helvetica', fontSize=10, leading=14, alignment=TA_RIGHT)
        brand = colors.HexColor("#0F766E")   # teal-700
        band_h = 22*mm

        # single page decorator: draws header + footer
        def draw_page(canvas, _doc):
            w, h = A4
            canvas.saveState()
            # Header band
            canvas.setFillColor(brand)
            canvas.rect(0, h - band_h, w, band_h, fill=1, stroke=0)
            canvas.setFillColor(colors.white)
            canvas.setFont("Helvetica-Bold", 16)
            canvas.drawString(16*mm, h - band_h + 7*mm, biz["store_name"])
            # Header details under band
            y = h - band_h - 6*mm
            canvas.setFillColor(colors.black)
            canvas.setFont("Helvetica", 9)
            line2 = []
            if biz["store_address"]: line2.append(biz["store_address"])
            if biz["store_gst"]: line2.append(f"GSTIN: {biz['store_gst']}")
            if biz["store_contact"]: line2.append(f"Contact: {biz['store_contact']}")
            if line2:
                canvas.drawString(16*mm, y, "  |  ".join(line2))
            # Footer
            canvas.setFont("Helvetica", 9)
            canvas.setFillColor(colors.grey)
            canvas.drawRightString(w - 16*mm, 12*mm, f"Page {_doc.page}")
            canvas.drawString(16*mm, 12*mm, "Thank you for your business.")
            canvas.restoreState()

        story = []
        story.append(Spacer(1, band_h - 6*mm))  # start content below header

        # Meta table
        meta_tbl = Table([
            [
                Paragraph("<b>Invoice</b>", H2),
                Paragraph(f"<b>Invoice No:</b> {inv_no}<br/><b>Date:</b> {inv_date}", RIGHT)
            ],
            [
                Paragraph(f"<b>Billed To</b><br/>{customer}", NORMAL),
                ""
            ]
        ], colWidths=[None, 60*mm])
        meta_tbl.setStyle(TableStyle([
            ("VALIGN", (0,0), (-1,-1), "TOP"),
            ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ]))
        story.append(meta_tbl)
        story.append(Spacer(1, 6*mm))

        # Items
        table_data = [["#", "Description", "Price", "GST %", "GST Amt", "Line Total"]] + rows
        colw = [10*mm, None, 26*mm, 18*mm, 26*mm, 30*mm]
        tbl = Table(table_data, colWidths=colw, hAlign="LEFT", repeatRows=1)
        tbl.setStyle(TableStyle([
            ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
            ("FONTSIZE", (0,0), (-1,0), 10),
            ("TEXTCOLOR", (0,0), (-1,0), colors.white),
            ("BACKGROUND", (0,0), (-1,0), brand),
            ("ALIGN", (0,0), (0,-1), "CENTER"),
            ("ALIGN", (2,1), (-1,-1), "RIGHT"),
            ("ALIGN", (1,1), (1,-1), "LEFT"),
            ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
            ("INNERGRID", (0,0), (-1,-1), 0.25, colors.lightgrey),
            ("BOX", (0,0), (-1,-1), 0.5, colors.grey),
            ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.whitesmoke, colors.Color(0.98,0.98,0.98)]),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 6*mm))

        # Totals
        totals = Table([
            ["Subtotal", fmt_inr(subtotal)],
            ["GST Total", fmt_inr(gst_total)],
            ["Grand Total", fmt_inr(grand)],
        ], colWidths=[40*mm, 35*mm], hAlign="RIGHT")
        totals.setStyle(TableStyle([
            ("FONTNAME", (0,0), (-1,-2), "Helvetica"),
            ("FONTNAME", (0,-1), (-1,-1), "Helvetica-Bold"),
            ("FONTSIZE", (0,0), (-1,-1), 11),
            ("ALIGN", (0,0), (-1,-1), "RIGHT"),
            ("BACKGROUND", (0,0), (-1,-1), colors.Color(0.99,0.99,1)),
            ("BOX", (0,0), (-1,-1), 0.5, colors.HexColor("#A5B4FC")),
            ("INNERGRID", (0,0), (-1,-1), 0.25, colors.Color(0.8,0.8,1)),
            ("LEFTPADDING", (0,0), (-1,-1), 6),
            ("RIGHTPADDING", (0,0), (-1,-1), 6),
            ("TOPPADDING", (0,0), (-1,-1), 6),
            ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ]))
        story.append(totals)

        if terms:
            story.append(Spacer(1, 8*mm))
            story.append(Paragraph("<b>Payment Terms</b>", H2))
            story.append(Spacer(1, 1*mm))
            story.append(Paragraph(terms, NORMAL))

        # ✅ Correct build call (single callback)
        doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)

        buf.seek(0)
        fname = f"invoice_{inv_no}.pdf"
        return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name=fname)

    except Exception as e:
        # Optional: print(e) to your server logs for deeper debugging
        return jsonify({"error": str(e)}), 500





# ---------- (Optional) Invoice ingestion & admin/debug omitted for brevity ----------
# Keep your existing /api/ingestInvoice, /api/admin/reseed, /api/debug/mtd_vendor_summary if you already have them.


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    # Avoid re-seeding here to prevent duplicate data.
    app.run(port=port, debug=True)