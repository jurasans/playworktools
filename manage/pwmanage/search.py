"""Read-only lookups. Every statement is fixed text with parameters; caller text only ever becomes a parameter."""
from .config import MAX_ROWS, MIN_QUERY, SENSOR_COLUMNS, SENSOR_SEARCH, SENSOR_SORT, TIER_USER_LIMITS


class UserError(ValueError):
    """A request the tool refuses; its message is safe to show to the person using the tab."""


def like_pattern(text: str, ignore_separators: bool) -> str:
    """'%text%' with LIKE wildcards in the text escaped, so a '%' or '_' typed by a person is literal."""
    text = text.strip().upper()
    if ignore_separators:
        text = text.replace(":", "").replace("-", "").replace(" ", "")
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _check_query(query: str) -> str:
    query = (query or "").strip()
    if query and len(query) < MIN_QUERY:
        raise UserError(f"type at least {MIN_QUERY} characters (or leave the box empty to list)")
    return query


def _limit(limit, offset):
    try:
        limit, offset = int(limit or MAX_ROWS), int(offset or 0)
    except (TypeError, ValueError):
        raise UserError("limit and offset must be numbers")
    return max(1, min(limit, MAX_ROWS)), max(0, offset)


def _direction(direction) -> str:
    if direction in (None, "", "asc"):
        return "ASC"
    if direction == "desc":
        return "DESC"
    raise UserError("sort direction must be asc or desc")


def _rows(cursor):
    columns = [c[0] for c in cursor.description]
    return columns, [dict(zip(columns, row)) for row in cursor.fetchall()]


def api_tag(version) -> str:
    """Which API generation last registered this ball, from sensors.version: empty = v1 (anonymous), 2 = v2, 3 = v3."""
    if version is None:
        return "v1"
    try:
        return f"v{int(version)}"
    except (TypeError, ValueError):
        return "v1"


# Fixed SQL per API tag; a missing version counts as v1 (same rule as api_tag).
_VERSION_SQL = {"v1": "(s.version IS NULL OR s.version = 1)", "v2": "s.version = 2", "v3": "s.version = 3"}


def search_sensors(conn, query="", field="any", limit=None, offset=None, sort=None, direction=None):
    """Balls matching a partial text, case ignored, in one field or (any) in id, license, device, customer or API tag."""
    if field not in ("any", "version") and field not in SENSOR_SEARCH:
        raise UserError(f"cannot search sensors by {field!r}")
    query, (limit, offset) = _check_query(query), _limit(limit, offset)
    if sort and sort not in SENSOR_SORT:
        raise UserError(f"cannot sort sensors by {sort!r}")
    order = f"{SENSOR_SORT[sort]} {_direction(direction)} NULLS LAST, " if sort else ""
    version_sql = _VERSION_SQL.get(query.strip().lower()) if field in ("any", "version") else None
    if field == "version" and query and not version_sql:
        raise UserError("search the API version as v1, v2 or v3")
    fields = [] if field == "version" else list(SENSOR_SEARCH) if field == "any" else [field]
    where, params = "", []
    if query:
        like = " ESCAPE '\\'"
        parts = [f"{SENSOR_SEARCH[f]} LIKE %s{like}" for f in fields]
        params = [like_pattern(query, ignore_separators=f == "id") for f in fields]
        if version_sql:
            parts.append(version_sql)
        where = "WHERE " + " OR ".join(parts)
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) FROM sensors s {where}", params)
    total = cursor.fetchone()[0]
    columns = ", ".join(f"s.{c}" for c in SENSOR_COLUMNS)
    cursor.execute(
        f"SELECT {columns}, l.license_type FROM sensors s LEFT JOIN licenses l ON l.id = s.license_id "
        f"{where} ORDER BY {order}UPPER(s.id), s.id LIMIT %s OFFSET %s",
        params + [limit, offset],
    )
    rows = _rows(cursor)[1]
    usage = _usage(conn, [r["id"] for r in rows], {r["license_id"] for r in rows if r.get("license_id")})
    for row in rows:
        row["api"] = api_tag(row.get("version"))
        row["capacity"] = None if usage is None else capacity(
            row.get("license_type"), usage["max_users"].get(row.get("license_id")), usage["balls"].get(row["id"]))
    return {"total": total, "rows": rows}


def capacity(license_type, max_users, used):
    """{limit, used, remaining, devices} for one ball; limit/remaining are None when unlimited, all None when unknown.

    `used` is the sum of the latest count of every tablet that reported for the ball; `devices` is how many tablets.
    """
    limit = max_users if max_users is not None else TIER_USER_LIMITS.get(license_type)
    users, devices = used if used else (0, 0)
    return {"limit": limit, "used": users, "devices": devices, "remaining": None if limit is None else limit - users}


def _usage(conn, ball_ids, license_ids):
    """Per-ball (users, devices) and per-licence max_users. Read apart from the main query so a database that has no
    sensor_devices table, a missing grant or no max_users column yet (migration 003 not applied) only blanks the figures (None)."""
    out = {"balls": {}, "max_users": {}}
    if not ball_ids:
        return out
    try:
        cursor = conn.cursor()
        marks = ",".join(["%s"] * len(ball_ids))
        cursor.execute(
            f"SELECT sensor_id, SUM(user_count), COUNT(*) FROM sensor_devices WHERE sensor_id IN ({marks}) GROUP BY sensor_id",
            list(ball_ids))
        out["balls"] = {sid: (int(users), int(devices)) for sid, users, devices in cursor.fetchall()}
        if license_ids:
            marks = ",".join(["%s"] * len(license_ids))
            cursor.execute(f"SELECT id, max_users FROM licenses WHERE id IN ({marks})", list(license_ids))
            out["max_users"] = {lid: m for lid, m in cursor.fetchall() if m is not None}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return None
    return out


def list_licenses(conn):
    """License ids with their tier, only to fill the move-to-license dropdown (licenses are not browsable)."""
    cursor = conn.cursor()
    cursor.execute("SELECT id, license_type FROM licenses ORDER BY UPPER(id), id")
    return {"licenses": _rows(cursor)[1]}


def license_usage(conn, license_id):
    """How many balls share a license, shown in the confirm modal before a tier change."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM sensors WHERE license_id = %s", [license_id])
    return cursor.fetchone()[0]


def search_customers(conn, query="", limit=None, offset=None, sort=None, direction=None):
    """Whole customer rows whose id or invoice number contains the text, sorted by id."""
    query, (limit, offset) = _check_query(query), _limit(limit, offset)
    where, params = "", []
    if query:
        where = "WHERE UPPER(id) LIKE %s ESCAPE '\\' OR UPPER(invoice_no) LIKE %s ESCAPE '\\'"
        pattern = like_pattern(query, ignore_separators=False)
        params += [pattern, pattern]
    order = ""
    if sort:
        if sort not in {name for name, _ in customer_schema(conn)}:  # column names come only from the database
            raise UserError(f"cannot sort customers by {sort!r}")
        order = f'"{sort}" {_direction(direction)} NULLS LAST, '
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) FROM customers {where}", params)
    total = cursor.fetchone()[0]
    cursor.execute(f"SELECT * FROM customers {where} ORDER BY {order}UPPER(id), id LIMIT %s OFFSET %s",
                   params + [limit, offset])
    columns, rows = _rows(cursor)
    return {"total": total, "columns": columns, "rows": rows}


def customer_schema(conn):
    """(column, data_type) of customers as the database reports them: the only source of column names."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = 'customers' ORDER BY ordinal_position"
    )
    return [(name, kind) for name, kind in cursor.fetchall()]
