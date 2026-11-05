"""Read-only lookups. Every statement is fixed text with parameters; caller text only ever becomes a parameter."""
from .config import MAX_ROWS, MIN_QUERY, SENSOR_COLUMNS, SENSOR_SEARCH


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


def _rows(cursor):
    columns = [c[0] for c in cursor.description]
    return columns, [dict(zip(columns, row)) for row in cursor.fetchall()]


def search_sensors(conn, query="", field="any", limit=None, offset=None):
    """Balls matching a partial text, upper/lower case ignored, in one field or (any) in id, license, device or customer."""
    if field != "any" and field not in SENSOR_SEARCH:
        raise UserError(f"cannot search sensors by {field!r}")
    query, (limit, offset) = _check_query(query), _limit(limit, offset)
    fields = list(SENSOR_SEARCH) if field == "any" else [field]
    where, params = "", []
    if query:
        like = " ESCAPE '\\'"
        where = "WHERE " + " OR ".join(f"{SENSOR_SEARCH[f]} LIKE %s{like}" for f in fields)
        params = [like_pattern(query, ignore_separators=f == "id") for f in fields]
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) FROM sensors s {where}", params)
    total = cursor.fetchone()[0]
    columns = ", ".join(f"s.{c}" for c in SENSOR_COLUMNS)
    cursor.execute(
        f"SELECT {columns}, l.license_type FROM sensors s LEFT JOIN licenses l ON l.id = s.license_id "
        f"{where} ORDER BY UPPER(s.id), s.id LIMIT %s OFFSET %s",
        params + [limit, offset],
    )
    return {"total": total, "rows": _rows(cursor)[1]}


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


def search_customers(conn, query="", limit=None, offset=None):
    """Whole customer rows whose id or invoice number contains the text, sorted by id."""
    query, (limit, offset) = _check_query(query), _limit(limit, offset)
    where, params = "", []
    if query:
        where = "WHERE UPPER(id) LIKE %s ESCAPE '\\' OR UPPER(invoice_no) LIKE %s ESCAPE '\\'"
        pattern = like_pattern(query, ignore_separators=False)
        params += [pattern, pattern]
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) FROM customers {where}", params)
    total = cursor.fetchone()[0]
    cursor.execute(f"SELECT * FROM customers {where} ORDER BY UPPER(id), id LIMIT %s OFFSET %s",
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
