import pytest

from pwmanage import search
from pwmanage.search import UserError

from conftest import FakeConn


def sensors_conn():
    return FakeConn([
        ("COUNT(*)", {"rows": [(3,)], "columns": ["count"]}),
        ("FROM sensors s", {"columns": ["id", "license_id"], "rows": [("AA:BB", "L1")]}),
    ])


@pytest.mark.parametrize("typed,expected", [
    ("5a84", "%5A84%"), ("5A:84", "%5A84%"), ("ee-16", "%EE16%"), ("  e1 ee ", "%E1EE%"),
])
def test_mac_text_ignores_case_and_separators(typed, expected):
    assert search.like_pattern(typed, ignore_separators=True) == expected


@pytest.mark.parametrize("typed,expected", [("50%", "%50\\%%"), ("a_b", "%A\\_B%"), ("a\\b", "%A\\\\B%")])
def test_wildcards_typed_by_a_person_are_literal(typed, expected):
    assert search.like_pattern(typed, ignore_separators=False) == expected


def test_partial_mac_matches_anywhere_in_the_id_and_sorts_alphabetically():
    conn = sensors_conn()
    result = search.search_sensors(conn, "5a:84", field="id")
    assert result["total"] == 3 and result["rows"][0]["id"] == "AA:BB"
    count_sql, params = conn.executed[0]
    assert "LIKE %s ESCAPE" in count_sql and params == ["%5A84%"]
    list_sql, params = conn.executed[1]
    assert "ORDER BY UPPER(s.id), s.id" in list_sql and params == ["%5A84%", 200, 0]


def test_empty_query_lists_everything():
    conn = sensors_conn()
    search.search_sensors(conn, "")
    assert "WHERE" not in conn.sql()[0] and "WHERE" not in conn.sql()[1]


def test_one_character_is_refused():
    with pytest.raises(UserError):
        search.search_sensors(sensors_conn(), "a")


def test_the_search_field_is_a_whitelist_never_caller_text():
    with pytest.raises(UserError):
        search.search_sensors(sensors_conn(), "ab", field="id; DROP TABLE sensors")
    conn = sensors_conn()
    search.search_sensors(conn, "ab", field="device_id")
    assert "UPPER(s.device_id) LIKE" in conn.sql()[0]


def test_hostile_text_only_ever_becomes_a_parameter():
    conn = sensors_conn()
    hostile = "x'; DROP TABLE sensors;--"
    search.search_sensors(conn, hostile)
    assert all("DROP" not in sql for sql in conn.sql())
    assert any("DROP" in str(p) for _, params in conn.executed for p in params)


def test_limit_is_capped_and_offset_cannot_be_negative():
    conn = sensors_conn()
    search.search_sensors(conn, "", limit=10 ** 6, offset=-5)
    assert conn.executed[1][1][-2:] == [200, 0]
    with pytest.raises(UserError):
        search.search_sensors(sensors_conn(), "", limit="many")


def test_customers_are_searched_by_id_and_invoice_number_with_whole_rows():
    conn = FakeConn([
        ("COUNT(*)", {"rows": [(1,)]}),
        ("FROM customers", {"columns": ["id", "invoice_no", "date"], "rows": [("C-1", "INV-9", "2026-01-01")]}),
    ])
    result = search.search_customers(conn, "inv")
    assert result["columns"] == ["id", "invoice_no", "date"] and result["rows"][0]["invoice_no"] == "INV-9"
    assert "SELECT * FROM customers" in conn.sql()[1]
    assert "UPPER(id) LIKE %s ESCAPE" in conn.sql()[1] and "UPPER(invoice_no) LIKE" in conn.sql()[1]
    assert conn.executed[1][1][:2] == ["%INV%", "%INV%"]


def test_licenses_are_listed_only_as_id_and_tier():
    conn = FakeConn([("FROM licenses", {"columns": ["id", "license_type"], "rows": [("L1", 2)]})])
    assert search.list_licenses(conn) == {"licenses": [{"id": "L1", "license_type": 2}]}
    assert "SELECT id, license_type FROM licenses" in conn.sql()[0]


def test_default_search_looks_in_id_license_device_and_customer_ignoring_case():
    conn = sensors_conn()
    search.search_sensors(conn, "MyPlay")
    sql, params = conn.executed[0]
    assert sql.count("LIKE %s ESCAPE") == 4 and "UPPER(s.customer_id) LIKE" in sql and "UPPER(s.license_id) LIKE" in sql
    assert params == ["%MYPLAY%"] * 4
    # separators are only ignored for the ball id, so a customer name keeps its dashes
    conn = sensors_conn()
    search.search_sensors(conn, "ab-c")
    assert conn.executed[0][1] == ["%ABC%", "%AB-C%", "%AB-C%", "%AB-C%"]


@pytest.mark.parametrize("version,tag", [(None, "v1"), (1, "v1"), (2, "v2"), (3, "v3"), ("3", "v3"), ("x", "v1")])
def test_api_tag_comes_from_the_version_column(version, tag):
    assert search.api_tag(version) == tag


def test_every_ball_row_carries_its_api_tag():
    conn = FakeConn([
        ("COUNT(*)", {"rows": [(3,)], "columns": ["count"]}),
        ("FROM sensors s", {"columns": ["id", "version"], "rows": [("A", None), ("B", 2), ("C", 3)]}),
    ])
    rows = search.search_sensors(conn, "")["rows"]
    assert [r["api"] for r in rows] == ["v1", "v2", "v3"]


@pytest.mark.parametrize("typed,fragment", [
    ("v1", "s.version IS NULL OR s.version = 1"), ("V2", "s.version = 2"), (" v3 ", "s.version = 3"),
])
def test_typing_v1_v2_v3_also_matches_the_api_version(typed, fragment):
    conn = sensors_conn()
    search.search_sensors(conn, typed)
    sql = conn.executed[0][0]
    assert fragment in sql and " OR " in sql and "UPPER(s.customer_id) LIKE" in sql


def test_other_text_adds_no_version_condition():
    conn = sensors_conn()
    search.search_sensors(conn, "v4")
    assert "s.version" not in conn.executed[0][0]


def test_version_field_searches_only_the_version_column():
    conn = sensors_conn()
    search.search_sensors(conn, "v3", field="version")
    sql, params = conn.executed[0]
    assert "s.version = 3" in sql and "LIKE" not in sql and params == []
    with pytest.raises(UserError):
        search.search_sensors(sensors_conn(), "banana", field="version")


@pytest.mark.parametrize("key,expr", [
    ("id", "UPPER(s.id)"), ("api", "COALESCE(s.version, 1)"), ("license_id", "UPPER(s.license_id)"),
    ("device_id", "UPPER(s.device_id)"), ("customer_id", "UPPER(s.customer_id)"),
])
@pytest.mark.parametrize("direction,word", [("asc", "ASC"), ("desc", "DESC"), (None, "ASC")])
def test_balls_sort_by_a_whitelisted_column_in_the_database(key, expr, direction, word):
    conn = sensors_conn()
    search.search_sensors(conn, "", sort=key, direction=direction)
    assert f"ORDER BY {expr} {word} NULLS LAST, UPPER(s.id), s.id" in conn.sql()[1]


def test_no_sort_keeps_the_default_order():
    conn = sensors_conn()
    search.search_sensors(conn, "")
    assert "ORDER BY UPPER(s.id), s.id" in conn.sql()[1]


@pytest.mark.parametrize("sort,direction", [("id; DROP TABLE sensors", "asc"), ("version", "asc"), ("id", "sideways")])
def test_sort_column_and_direction_are_whitelisted_never_caller_text(sort, direction):
    with pytest.raises(UserError):
        search.search_sensors(sensors_conn(), "", sort=sort, direction=direction)


def test_customers_sort_only_by_a_column_the_database_reports():
    conn = FakeConn([
        ("information_schema", {"columns": ["column_name", "data_type"], "rows": [("id", "text"), ("invoice_no", "text")]}),
        ("COUNT(*)", {"rows": [(1,)], "columns": ["count"]}),
        ("FROM customers", {"columns": ["id"], "rows": [("c1",)]}),
    ])
    search.search_customers(conn, "", sort="invoice_no", direction="desc")
    assert 'ORDER BY "invoice_no" DESC NULLS LAST, UPPER(id), id' in conn.sql()[-1]
    with pytest.raises(UserError):
        search.search_customers(conn, "", sort='id"; DROP TABLE customers;--')


@pytest.mark.parametrize("tier,override,used,expected", [
    (1, None, (1, 1), (1, 0)), (2, None, (30, 2), (50, 20)), (2, None, None, (50, 50)),
    (3, None, (500, 4), (None, None)), (3, 7, (2, 1), (7, 5)), (1, None, (2, 2), (1, -1)), (None, None, None, (None, None)),
])
def test_capacity_is_remaining_over_limit_with_the_tablet_count(tier, override, used, expected):
    c = search.capacity(tier, override, used)
    assert (c["limit"], c["remaining"]) == expected
    assert c["devices"] == (used[1] if used else 0)


def capacity_conn(usage, maxes):
    return FakeConn([
        ("FROM sensor_devices", usage),
        ("FROM licenses WHERE id IN", maxes),
        ("COUNT(*)", {"rows": [(1,)], "columns": ["count"]}),
        ("FROM sensors s", {"columns": ["id", "license_id", "version", "license_type"], "rows": [("AA:BB", "L1", 3, 2)]}),
    ])


def test_rows_carry_remaining_limit_and_tablet_count():
    conn = capacity_conn({"rows": [("AA:BB", 12, 2)], "columns": ["a", "b", "c"]}, {"rows": [("L1", None)], "columns": ["a", "b"]})
    cap = search.search_sensors(conn, "")["rows"][0]["capacity"]
    assert cap == {"limit": 50, "used": 12, "devices": 2, "remaining": 38}


def test_a_max_users_override_beats_the_tier():
    conn = capacity_conn({"rows": [], "columns": ["a", "b", "c"]}, {"rows": [("L1", 5)], "columns": ["a", "b"]})
    assert search.search_sensors(conn, "")["rows"][0]["capacity"]["limit"] == 5


def test_unreadable_usage_blanks_the_figure_instead_of_failing_the_search():
    conn = capacity_conn(RuntimeError("permission denied for table sensor_devices"), {"rows": []})
    result = search.search_sensors(conn, "")
    assert result["rows"][0]["capacity"] is None and conn.rollbacks == 1
