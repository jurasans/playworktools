"""Manual run against the STAGE cluster only: python tests/stage_integration.py (never collected by pytest)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pwmanage import db, service  # noqa: E402
from pwmanage.config import ENVS  # noqa: E402

ENV = ENVS["stage"]
L1, L2, BALL, CUST = "PlayBallBasic", "PlayBallPremium", "ZZ:TE:ST:00:00:01", "ZZ-TEST-CUSTOMER"  # the same license ids as prod
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def admin(sql, params=()):
    conn = db.connect(ENV, admin=True)
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall() if cur.description else None
        conn.commit()
        return rows
    finally:
        conn.close()


def call(op, **kw):
    return service.handle({"env": "stage", "actor": "integration-test", "op": op, **kw})


def cleanup():
    admin("DELETE FROM sensors WHERE id = %s", (BALL,))
    admin("DELETE FROM customers WHERE id = %s", (CUST,))


def main():
    cleanup()
    admin("INSERT INTO sensors (id, license_id, device_id) VALUES (%s, %s, 'dev-x')", (BALL, L1))
    try:
        r = call("search_sensors", query="st:00:00:01")
        check("partial mac from the middle, colons ignored", r["ok"] and any(x["id"] == BALL for x in r["rows"]), r)
        r = call("search_sensors", query="zz te st")
        check("separators and case ignored", r["ok"] and any(x["id"] == BALL for x in r["rows"]), r)
        r = call("search_sensors", query="z")
        check("one character refused", not r["ok"] and r["kind"] == "refused", r)
        r = call("search_sensors", query="")
        check("empty query lists rows, sorted", r["ok"] and [x["id"].upper() for x in r["rows"]] == sorted(x["id"].upper() for x in r["rows"]), r)
        lic = {x["id"]: x["license_type"] for x in call("list_licenses")["licenses"]}
        check("prod license ids and tiers present", lic.get("MyPlayBall") == 1 and lic.get(L1) == 2 and lic.get(L2) == 3, lic)

        wrong = [{"type": "set_license", "sensor_id": BALL, "expected": L2, "new": L1}]
        r = call("apply", actions=wrong)
        check("stale expected value refused and nothing changed", not r["ok"] and r["kind"] == "stale", r)

        batch = [
            {"type": "set_license", "sensor_id": BALL, "expected": L1, "new": L2},
            {"type": "create_customer", "values": {"id": CUST, "invoice_no": "INV-TEST"}},
            {"type": "set_customer", "sensor_id": BALL, "expected": None, "new": CUST},
            {"type": "clear_device", "sensor_id": BALL, "expected": "dev-x"},
        ]
        r = call("apply", actions=batch)
        row = admin("SELECT license_id, device_id, customer_id FROM sensors WHERE id=%s", (BALL,))[0]
        check("batch applied together", r["ok"] and tuple(row) == (L2, None, CUST), (r, row))

        bad = [{"type": "set_license", "sensor_id": BALL, "expected": L2, "new": L1},
               {"type": "clear_device", "sensor_id": BALL, "expected": "not-the-device"}]
        r = call("apply", actions=bad)
        row = admin("SELECT license_id FROM sensors WHERE id=%s", (BALL,))[0][0]
        check("all-or-nothing: a stale second change rolls back the first", not r["ok"] and row == L2, (r, row))

        r = call("search_customers", query="inv-te")
        check("customer search by invoice", r["ok"] and any(x["id"] == CUST for x in r["rows"]), r)
        edit = [{"type": "update_customer", "id": CUST, "expected": {"invoice_no": "INV-TEST"}, "new": {"invoice_no": "INV-2"}}]
        r = call("apply", actions=edit)
        check("customer edit", r["ok"] and admin("SELECT invoice_no FROM customers WHERE id=%s", (CUST,))[0][0] == "INV-2", r)
        r = call("apply", actions=[{"type": "create_customer", "values": {"id": CUST}}])
        check("duplicate customer id refused", not r["ok"], r)

        conn = db.connect(ENV)
        try:
            for sql in ("DELETE FROM sensors WHERE id = 'nope'", "SELECT * FROM users LIMIT 1", "UPDATE sensors SET name = 'x' WHERE id = 'nope'",
                        "DELETE FROM customers WHERE id = 'nope'"):
                try:
                    conn.cursor().execute(sql)
                    check(f"role refused: {sql}", False, "was allowed")
                except Exception:
                    conn.rollback()
                    check(f"role refused: {sql}", True)
        finally:
            conn.close()
    finally:
        cleanup()
    print("\nFAILURES:" if failures else "\nall passed", failures or "")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
