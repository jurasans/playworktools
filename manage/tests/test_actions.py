import pytest

from pwmanage import actions
from pwmanage.search import UserError

from conftest import FakeConn

TIER = {"type": "set_tier", "license_id": "L1", "expected": 2, "new": 3}
MOVE = {"type": "set_license", "sensor_id": "AA:BB", "expected": "L1", "new": "L2"}
CLEAR = {"type": "clear_device", "sensor_id": "AA:BB", "expected": "dev-1"}
ASSIGN = {"type": "set_customer", "sensor_id": "AA:BB", "expected": None, "new": "C-1"}
CREATE = {"type": "create_customer", "values": {"id": "C-2", "invoice_no": "INV-1", "date": "2026-01-01"}}
EDIT = {"type": "update_customer", "id": "C-1", "expected": {"invoice_no": "A"}, "new": {"invoice_no": "B"}}


@pytest.mark.parametrize("bad", [
    None, [], "x", [{}], [{"type": "delete_sensor"}], [{"type": "set_tier"}],
    [{**TIER, "new": 9}], [{**TIER, "new": "3"}], [{"type": "set_license", "sensor_id": "a", "expected": None, "new": ""}],
    [{"type": "clear_device", "sensor_id": "a", "expected": None}],
    [{"type": "create_customer", "values": {"invoice_no": "x"}}],
    [{"type": "create_customer", "values": {"id": "x", "password": "y"}}],
    [{"type": "update_customer", "id": "C-1", "expected": {"id": "a"}, "new": {"id": "b"}}],
    [{"type": "update_customer", "id": "C-1", "expected": {"invoice_no": "a"}, "new": {"date": "b"}}],
    [{"type": "update_customer", "id": "C-1", "expected": {"nope": "a"}, "new": {"nope": "b"}}],
    [{"type": "update_customer", "id": "C-1", "expected": {}, "new": {}}],
    [dict(TIER)] * 201,
])
def test_anything_outside_the_closed_list_is_refused(bad, schema):
    with pytest.raises(UserError):
        actions.validate(bad, schema)


def test_the_tier_dropdown_values_are_the_apps_tiers(schema):
    for tier in (1, 2, 3):
        actions.validate([{**TIER, "new": tier}], schema)


def run(acts, schema, script=()):
    conn = FakeConn([*script, ("SELECT 1 FROM", {"rows": [(1,)]})])
    return conn, actions.apply(conn, acts, schema)


def test_each_action_is_one_fixed_parameterised_statement(schema):
    conn, done = run([TIER, MOVE, CLEAR, ASSIGN], schema)
    updates = [(s, p) for s, p in conn.executed if s.startswith("UPDATE")]
    assert updates == [
        ("UPDATE licenses SET license_type = %s WHERE id = %s AND license_type = %s", [3, "L1", 2]),
        ("UPDATE sensors SET license_id = %s WHERE id = %s AND license_id = %s", ["L2", "AA:BB", "L1"]),
        ("UPDATE sensors SET device_id = NULL WHERE id = %s AND device_id = %s", ["AA:BB", "dev-1"]),
        ("UPDATE sensors SET customer_id = %s WHERE id = %s AND customer_id IS NULL", ["C-1", "AA:BB"]),
    ]
    assert len(done) == 4


def test_a_row_that_changed_since_it_was_shown_is_refused_not_overwritten(schema):
    conn = FakeConn([("UPDATE licenses", {"rowcount": 0})])
    with pytest.raises(actions.Stale):
        actions.apply(conn, [TIER], schema)


def test_the_target_license_and_customer_must_exist(schema):
    missing = [("SELECT 1 FROM licenses", {"rows": []})]
    with pytest.raises(UserError, match="does not exist"):
        run([MOVE], schema, missing)
    with pytest.raises(UserError, match="does not exist"):
        run([ASSIGN], schema, [("SELECT 1 FROM customers", {"rows": []})])


def test_a_customer_can_be_unassigned(schema):
    conn, _ = run([{**ASSIGN, "expected": "C-1", "new": None}], schema)
    assert conn.executed[-1] == ("UPDATE sensors SET customer_id = %s WHERE id = %s AND customer_id = %s",
                                 [None, "AA:BB", "C-1"])


def test_creating_a_customer_casts_to_the_columns_own_types(schema):
    conn, _ = run([CREATE], schema, [("SELECT 1 FROM customers", {"rows": []})])
    sql, params = conn.executed[-1]
    assert sql == ('INSERT INTO customers ("id", "invoice_no", "date") VALUES '
                   '(CAST(%s AS text), CAST(%s AS text), CAST(%s AS timestamp with time zone))')
    assert params == ["C-2", "INV-1", "2026-01-01"]


def test_an_existing_customer_id_is_not_overwritten(schema):
    with pytest.raises(UserError, match="already exists"):
        run([CREATE], schema)


def test_editing_a_customer_compares_in_python_then_updates_by_id_only(schema):
    current = [("SELECT", {"rows": [("A",)]})]
    conn, _ = run([EDIT], schema, current)
    assert conn.executed[-1] == ('UPDATE customers SET "invoice_no" = CAST(%s AS text) WHERE id = %s', ["B", "C-1"])
    with pytest.raises(actions.Stale):
        run([EDIT], schema, [("SELECT", {"rows": [("SOMEONE ELSE",)]})])


def test_customer_column_names_come_from_the_schema_and_are_quoted(schema):
    odd = [("id", "text"), ('we"ird', "text")]
    conn, _ = run([{"type": "create_customer", "values": {"id": "x", 'we"ird': "v"}}], odd,
                  [("SELECT 1 FROM customers", {"rows": []})])
    assert '"we""ird"' in conn.executed[-1][0]


def test_adversarial_text_is_only_ever_a_parameter(schema):
    hostile = "x'); DROP TABLE sensors;--"
    conn, _ = run([{**MOVE, "sensor_id": hostile, "new": hostile}, {**CREATE, "values": {"id": hostile}}], schema,
                  [("SELECT 1 FROM customers", {"rows": []})])
    assert all("DROP" not in sql for sql in conn.sql())


def test_a_failure_reports_which_change_and_the_batch_stays_uncommitted(schema):
    conn = FakeConn([("UPDATE sensors SET device_id", {"rowcount": 0})])
    with pytest.raises(actions.Stale, match="change 2"):
        actions.apply(conn, [TIER, CLEAR], schema)
    assert conn.commits == 0  # the caller never commits a half-applied batch


def test_preview_flags_stale_rows_and_counts_balls_on_a_license(schema):
    conn = FakeConn([
        ("SELECT license_type FROM licenses", {"rows": [(1,)]}),
        ("COUNT(*)", {"rows": [(7,)]}),
    ])
    lines = actions.describe(conn, [TIER], schema)
    assert lines[0]["stale"] is True and lines[0]["affected"] == 7
    assert "7 ball(s)" in lines[0]["text"] and "2 (Basic) -> 3 (Premium)" in lines[0]["text"]


def test_a_new_customer_is_stamped_with_now_when_the_table_has_created_at():
    odd = [("id", "text"), ("created_at", "timestamp without time zone")]
    conn, _ = run([{"type": "create_customer", "values": {"id": "x"}}], odd, [("SELECT 1 FROM customers", {"rows": []})])
    sql, params = conn.executed[-1]
    assert sql.endswith('(CAST(%s AS text), CAST(now() AS timestamp without time zone))') and params == ["x"]


SENSOR = {"type": "create_sensor", "sensor_id": "aa-bb-cc-dd-ee-ff", "license_id": "L1", "customer_id": "C-1"}


def test_new_balls_are_inserted_with_id_license_and_customer_only(schema):
    conn, done = run([SENSOR], schema, [("SELECT 1 FROM sensors", {"rows": []})])
    assert conn.executed[-1] == ("INSERT INTO sensors (id, license_id, customer_id) VALUES (%s, %s, %s)",
                                 ["AA:BB:CC:DD:EE:FF", "L1", "C-1"])
    assert done[0]["sensor_id"] == "AA:BB:CC:DD:EE:FF"


@pytest.mark.parametrize("bad", [
    {**SENSOR, "sensor_id": "not a mac"}, {**SENSOR, "sensor_id": "AA:BB:CC:DD:EE"}, {**SENSOR, "license_id": ""},
    {**SENSOR, "customer_id": 5},
])
def test_bad_new_ball_input_is_refused(bad, schema):
    with pytest.raises(UserError):
        actions.validate([bad], schema)


def test_the_same_ball_twice_in_one_batch_is_refused(schema):
    with pytest.raises(UserError, match="twice"):
        actions.validate([SENSOR, {**SENSOR, "sensor_id": "AA:BB:CC:DD:EE:FF"}], schema)


def test_an_existing_ball_or_missing_license_is_refused_and_nothing_inserted(schema):
    with pytest.raises(UserError, match="already exists"):
        run([SENSOR], schema)
    conn = FakeConn([("SELECT 1 FROM sensors", {"rows": []}), ("SELECT 1 FROM licenses", {"rows": []})])
    with pytest.raises(UserError, match="license"):
        actions.apply(conn, [SENSOR], schema)
    assert not any(s.startswith("INSERT") for s in conn.sql())


def test_preview_allows_a_customer_created_earlier_in_the_same_batch(schema):
    conn = FakeConn([("SELECT 1 FROM sensors", {"rows": []}), ("SELECT 1 FROM customers", {"rows": []})])
    lines = actions.describe(conn, [{"type": "create_customer", "values": {"id": "C-9"}},
                                    {**SENSOR, "customer_id": "C-9"}], schema)
    assert lines[1]["stale"] is False
