"""The only writes this tool can make: a closed list of single-row actions (S-19).

Every statement here is fixed text. Caller text becomes a bound parameter, and the only identifiers that are
not literals in this file (customer columns) come from the database's own schema and must match it exactly.
Each action carries the value the person saw (`expected`); a row that changed since then is refused, never
overwritten. A batch runs in the caller's single transaction: one refusal undoes all of it.
"""
import re

from .config import TIERS
from .search import UserError, license_usage

ACTION_TYPES = ("set_tier", "set_license", "clear_device", "set_customer", "create_customer", "update_customer", "create_sensor")
MAX_ACTIONS = 200
MAC = re.compile(r"^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")


def normalize_mac(value):
    """Same spelling the API stores: upper case with colons."""
    if not isinstance(value, str) or not MAC.match(value.strip()):
        raise UserError(f"{value!r} is not a ball id (a MAC like AA:BB:CC:DD:EE:FF)")
    return value.strip().upper().replace("-", ":")


class Stale(UserError):
    """The row is no longer what the person saw."""


def _same(column, value):
    return (f"{column} IS NULL", []) if value is None else (f"{column} = %s", [value])


def _text(value):
    if value is not None and not isinstance(value, str):
        raise UserError("ids must be text")
    return value


def _need(action, *keys):
    missing = [k for k in keys if k not in action]
    if missing:
        raise UserError(f"{action.get('type')}: missing {', '.join(missing)}")


def _customer_cast(schema, column):
    kinds = dict(schema)
    if column not in kinds:
        raise UserError(f"customers has no column {column!r}")
    return '"' + column.replace('"', '""') + '"', kinds[column]


def validate(actions, schema):
    """Shape and whitelist checks only; no database. Raises UserError."""
    if not isinstance(actions, list) or not actions:
        raise UserError("no changes to apply")
    if len(actions) > MAX_ACTIONS:
        raise UserError(f"at most {MAX_ACTIONS} changes at once")
    new_balls = set()
    for action in actions:
        kind = action.get("type") if isinstance(action, dict) else None
        if kind not in ACTION_TYPES:
            raise UserError(f"unknown action {kind!r}")
        _validate_one(action, kind, schema)
        if kind == "create_sensor":
            if action["sensor_id"] in new_balls:
                raise UserError(f"ball {action['sensor_id']} is in the list twice")
            new_balls.add(action["sensor_id"])


def _validate_one(action, kind, schema):
    if kind == "set_tier":
        _need(action, "license_id", "expected", "new")
        if action["new"] not in TIERS:
            raise UserError(f"tier must be one of {sorted(TIERS)}")
    elif kind == "set_license":
        _need(action, "sensor_id", "expected", "new")
        if not _text(action["new"]):
            raise UserError("pick a license")
    elif kind == "clear_device":
        _need(action, "sensor_id", "expected")
        if not _text(action["expected"]):
            raise UserError("this ball has no device binding to clear")
    elif kind == "set_customer":
        _need(action, "sensor_id", "expected", "new")
    elif kind == "create_sensor":
        _need(action, "sensor_id", "license_id")
        action["sensor_id"] = normalize_mac(action["sensor_id"])  # in place: every later step sees the stored spelling
        if not _text(action["license_id"]):
            raise UserError("pick a license for the new ball")
        _text(action.get("customer_id"))
    elif kind == "create_customer":
        _need(action, "values")
        if not isinstance(action["values"], dict) or not str(action["values"].get("id") or "").strip():
            raise UserError("a new customer needs an id")
        for column in action["values"]:
            _customer_cast(schema, column)
    else:
        _need(action, "id", "expected", "new")
        if not action["new"] or set(action["new"]) != set(action["expected"]) or "id" in action["new"]:
            raise UserError("change at least one column other than id, and say what it was")
        for column in action["new"]:
            _customer_cast(schema, column)
    for key in ("license_id", "sensor_id", "id"):
        if key in action and not (isinstance(action[key], str) and action[key]):
            raise UserError(f"{kind}: {key} must be text")


def _one(cursor, sql, params):
    cursor.execute(sql, params)
    return cursor.fetchone()


def describe(conn, actions, schema):
    """Preview for the confirm modal: what each action does, the row now, whether it went stale."""
    validate(actions, schema)
    cursor, lines, planned = conn.cursor(), [], set()
    for action in actions:
        lines.append(_describe_one(conn, cursor, action, schema, planned))
    return lines


def _describe_one(conn, cursor, action, schema, planned):
    kind = action["type"]
    line = {"type": kind, "stale": False, "text": "", "affected": None}
    if kind == "create_sensor":
        problems = []
        if _one(cursor, "SELECT 1 FROM sensors WHERE id = %s", [action["sensor_id"]]) is not None:
            problems.append("already exists")
        if _one(cursor, "SELECT 1 FROM licenses WHERE id = %s", [action["license_id"]]) is None:
            problems.append("license does not exist")
        customer = action.get("customer_id")
        if customer and customer not in planned and _one(cursor, "SELECT 1 FROM customers WHERE id = %s", [customer]) is None:
            problems.append("customer does not exist")
        line["stale"] = bool(problems)
        line["text"] = (f"Create ball {action['sensor_id']} on license {action['license_id']}"
                        f"{', customer ' + customer if customer else ''}" + (f" — {', '.join(problems)}" if problems else ""))
        return line
    if kind == "set_tier":
        row = _one(cursor, "SELECT license_type FROM licenses WHERE id = %s", [action["license_id"]])
        line["stale"] = row is None or row[0] != action["expected"]
        line["affected"] = license_usage(conn, action["license_id"])
        line["text"] = (f"License {action['license_id']}: tier {_tier(action['expected'])} -> {_tier(action['new'])}"
                        f" (changes {line['affected']} ball(s) on this license)")
    elif kind in ("set_license", "clear_device", "set_customer"):
        column = {"set_license": "license_id", "clear_device": "device_id", "set_customer": "customer_id"}[kind]
        row = _one(cursor, f"SELECT {column} FROM sensors WHERE id = %s", [action["sensor_id"]])
        line["stale"] = row is None or row[0] != action["expected"]
        new = None if kind == "clear_device" else action["new"]
        line["text"] = f"Ball {action['sensor_id']}: {column} {action['expected']!r} -> {new!r}"
    elif kind == "create_customer":
        row = _one(cursor, "SELECT 1 FROM customers WHERE id = %s", [action["values"]["id"]])
        line["stale"] = row is not None
        planned.add(action["values"]["id"])
        line["text"] = f"Create customer {action['values']['id']}: " + ", ".join(
            f"{k}={v!r}" for k, v in action["values"].items() if k != "id")
    else:
        current = _customer_now(cursor, action, schema)
        line["stale"] = current != action["expected"]
        line["text"] = f"Customer {action['id']}: " + ", ".join(
            f"{k} {action['expected'][k]!r} -> {action['new'][k]!r}" for k in action["new"])
    return line


def _tier(value):
    return f"{value} ({TIERS[value]})" if value in TIERS else repr(value)


def _customer_now(cursor, action, schema):
    columns = [_customer_cast(schema, c)[0] for c in action["new"]]
    row = _one(cursor, f"SELECT {', '.join(columns)} FROM customers WHERE id = %s", [action["id"]])
    if row is None:
        return None
    return {c: _plain(v) for c, v in zip(action["new"], row)}


def _plain(value):
    return value if value is None or isinstance(value, (str, int, float, bool)) else str(value)


def apply(conn, actions, schema):
    """Run every action in the caller's transaction (the caller commits or rolls back). Returns audit lines."""
    validate(actions, schema)
    cursor, done = conn.cursor(), []
    for index, action in enumerate(actions):
        try:
            done.append(_apply_one(cursor, action, schema))
        except Stale as stale:
            raise Stale(f"change {index + 1}: {stale}")
        except UserError as refused:
            raise UserError(f"change {index + 1}: {refused}")
    return done


def _update_one(cursor, sql, params, what):
    cursor.execute(sql, params)
    if cursor.rowcount != 1:
        raise Stale(f"{what} changed since you looked; reload and try again")


def _apply_one(cursor, action, schema):
    kind = action["type"]
    if kind == "set_tier":
        where, where_params = _same("license_type", action["expected"])
        _update_one(cursor, f"UPDATE licenses SET license_type = %s WHERE id = %s AND {where}",
                    [action["new"], action["license_id"]] + where_params, f"license {action['license_id']}")
    elif kind == "set_license":
        if _one(cursor, "SELECT 1 FROM licenses WHERE id = %s", [action["new"]]) is None:
            raise UserError(f"license {action['new']!r} does not exist")
        where, where_params = _same("license_id", action["expected"])
        _update_one(cursor, f"UPDATE sensors SET license_id = %s WHERE id = %s AND {where}",
                    [action["new"], action["sensor_id"]] + where_params, f"ball {action['sensor_id']}")
    elif kind == "clear_device":
        _update_one(cursor, "UPDATE sensors SET device_id = NULL WHERE id = %s AND device_id = %s",
                    [action["sensor_id"], action["expected"]], f"ball {action['sensor_id']}")
    elif kind == "set_customer":
        if action["new"] is not None and _one(cursor, "SELECT 1 FROM customers WHERE id = %s", [action["new"]]) is None:
            raise UserError(f"customer {action['new']!r} does not exist")
        where, where_params = _same("customer_id", action["expected"])
        _update_one(cursor, f"UPDATE sensors SET customer_id = %s WHERE id = %s AND {where}",
                    [action["new"], action["sensor_id"]] + where_params, f"ball {action['sensor_id']}")
    elif kind == "create_sensor":
        _create_sensor(cursor, action)
    elif kind == "create_customer":
        _create_customer(cursor, action, schema)
    else:
        _update_customer(cursor, action, schema)
    return {k: v for k, v in action.items()}


def _create_sensor(cursor, action):
    if _one(cursor, "SELECT 1 FROM sensors WHERE id = %s", [action["sensor_id"]]) is not None:
        raise UserError(f"ball {action['sensor_id']} already exists")
    if _one(cursor, "SELECT 1 FROM licenses WHERE id = %s", [action["license_id"]]) is None:
        raise UserError(f"license {action['license_id']!r} does not exist")
    customer = action.get("customer_id")
    if customer and _one(cursor, "SELECT 1 FROM customers WHERE id = %s", [customer]) is None:
        raise UserError(f"customer {customer!r} does not exist")
    cursor.execute("INSERT INTO sensors (id, license_id, customer_id) VALUES (%s, %s, %s)",
                   [action["sensor_id"], action["license_id"], customer or None])


def _create_customer(cursor, action, schema):
    values = action["values"]
    if _one(cursor, "SELECT 1 FROM customers WHERE id = %s", [values["id"]]) is not None:
        raise UserError(f"customer {values['id']!r} already exists")
    names, marks = [], []
    for column, value in values.items():
        quoted, kind = _customer_cast(schema, column)
        names.append(quoted)
        marks.append(f"CAST(%s AS {kind})")
    created = dict(schema).get("created_at")
    if created and "created_at" not in values:  # stamped with the time of creation, never typed
        names.append('"created_at"')
        marks.append(f"CAST(now() AS {created})")
    cursor.execute(f"INSERT INTO customers ({', '.join(names)}) VALUES ({', '.join(marks)})", list(values.values()))


def _update_customer(cursor, action, schema):
    # Compared here, not in SQL: the database's text form of a date differs from the one the person saw.
    # A concurrent writer still cannot slip in: DSQL aborts the later commit and the batch is retried.
    if _customer_now(cursor, action, schema) != action["expected"]:
        raise Stale(f"customer {action['id']} changed since you looked; reload and try again")
    sets, params = [], []
    for column, new in action["new"].items():
        quoted, kind = _customer_cast(schema, column)
        sets.append(f"{quoted} = CAST(%s AS {kind})")
        params.append(new)
    _update_one(cursor, f"UPDATE customers SET {', '.join(sets)} WHERE id = %s",
                params + [action["id"]], f"customer {action['id']}")
