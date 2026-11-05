import pytest

from pwmanage import service

from conftest import FakeConn, SCHEMA

MOVE = {"type": "set_license", "sensor_id": "AA:BB", "expected": "L1", "new": "L2"}
SCHEMA_ROWS = ("information_schema.columns", {"rows": SCHEMA})


class Sink:
    def __init__(self, fail=False):
        self.events, self.fail = [], fail

    def write(self, event):
        if self.fail:
            raise RuntimeError("logs are down")
        self.events.append(event)


def request(**extra):
    return {"env": "stage", "actor": "admin", "op": "apply", "actions": [MOVE], **extra}


def test_a_write_is_logged_before_it_runs_and_again_when_done():
    sink, conn = Sink(), FakeConn([SCHEMA_ROWS])
    answer = service.handle(request(), connect=lambda env: conn, audit=sink)
    assert answer["ok"] and answer["applied"] == 1 and conn.commits == 1 and conn.closed
    assert [e["stage"] for e in sink.events] == ["intent", "done"]
    assert sink.events[0]["actions"] == [MOVE] and sink.events[0]["who"]["user"] == "admin"


def test_a_write_that_cannot_be_logged_is_refused_and_never_touches_the_database():
    calls = []
    answer = service.handle(request(), connect=lambda env: calls.append(env), audit=Sink(fail=True))
    assert not answer["ok"] and answer["kind"] == "failed" and calls == []


def test_a_stale_row_rolls_the_whole_batch_back():
    conn = FakeConn([SCHEMA_ROWS, ("UPDATE sensors", {"rowcount": 0})])
    answer = service.handle(request(), connect=lambda env: conn, audit=(sink := Sink()))
    assert answer["kind"] == "stale" and conn.commits == 0 and conn.rollbacks == 1
    assert sink.events[-1]["stage"] == "failed"


def test_a_database_conflict_is_retried_then_succeeds():
    conns = [FakeConn([SCHEMA_ROWS, ("UPDATE sensors", RuntimeError("OC000 change conflicts"))]),
             FakeConn([SCHEMA_ROWS])]
    answer = service.handle(request(), connect=lambda env: conns.pop(0), audit=Sink())
    assert answer["ok"] and conns == []


def test_conflicts_give_up_after_three_tries():
    made = []

    def connect(env):
        made.append(1)
        return FakeConn([SCHEMA_ROWS, ("UPDATE sensors", RuntimeError("40001"))])
    answer = service.handle(request(), connect=connect, audit=Sink())
    assert not answer["ok"] and len(made) == 3


def test_an_audit_failure_after_the_commit_is_a_warning_not_a_failure():
    class Flaky(Sink):
        def write(self, event):
            if event["stage"] == "done":
                raise RuntimeError("down")
            super().write(event)
    answer = service.handle(request(), connect=lambda env: FakeConn([SCHEMA_ROWS]), audit=Flaky())
    assert answer["ok"] and "audit line not written" in answer["audit_warning"]


def test_a_read_still_answers_when_the_audit_is_down():
    conn = FakeConn([("COUNT(*)", {"rows": [(0,)]}), ("FROM sensors s", {"columns": ["id"], "rows": []})])
    answer = service.handle({"env": "stage", "op": "search_sensors", "query": "ab"},
                            connect=lambda env: conn, audit=Sink(fail=True))
    assert answer == {"ok": True, "total": 0, "rows": []}


@pytest.mark.parametrize("bad", [{}, {"op": "drop"}, {"op": "apply", "env": "mars"}, {"op": "search_sensors"}])
def test_unknown_operations_and_environments_are_refused(bad):
    answer = service.handle(bad, connect=lambda env: pytest.fail("must not connect"), audit=Sink())
    assert answer["ok"] is False and answer["kind"] == "refused"


def test_info_lists_the_tiers_and_environments_without_a_database():
    answer = service.handle({"op": "info", "env": "stage"})
    assert answer["tiers"] == {1: "MyPlayBall", 2: "Basic", 3: "Premium"}
    assert answer["envs"]["stage"]["label"] == "PREPROD" and answer["envs"]["prod"]["label"] == "PROD"
