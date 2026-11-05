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
