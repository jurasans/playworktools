import io
import json

from pwmanage import server
from pwmanage.config import ENVS
from pwmanage.pool import Pool

from conftest import FakeConn, SCHEMA


class Tracked(FakeConn):
    def __init__(self, script=()):
        super().__init__(script)
        self.really_closed = False

    def close(self):
        self.really_closed = True


class Sink:
    def write(self, event):
        pass


def pool_of(made):
    def factory(env):
        made.append(Tracked([("COUNT(*)", {"rows": [(0,)]}), ("FROM sensors s", {"columns": ["id"], "rows": []})]))
        return made[-1]
    return Pool(factory)


def test_one_connection_is_reused_and_a_lease_close_only_ends_the_transaction():
    made = []
    pool = pool_of(made)
    first = pool.connect(ENVS["stage"])
    first.close()
    pool.connect(ENVS["stage"]).close()
    assert len(made) == 1 and not made[0].really_closed and made[0].rollbacks == 2


def test_keep_closes_every_environment_not_listed_and_empty_closes_all():
    made = []
    pool = pool_of(made)
    pool.connect(ENVS["stage"])
    pool.connect(ENVS["prod"])
    pool.keep(["prod"])
    assert [c.really_closed for c in made] == [True, False] and pool.open_envs() == ["prod"]
    pool.keep([])
    assert made[1].really_closed and pool.open_envs() == []


def run_worker(lines, pool):
    out = io.StringIO()
    handler = server.make_handler(pool, audit_for=lambda env: Sink())
    server.serve([json.dumps(x) + "\n" for x in lines], out, pool, handler)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_requests_share_a_connection_ids_are_echoed_and_stdin_end_closes_it():
    made = []
    pool = pool_of(made)
    ask = {"env": "stage", "op": "search_sensors", "query": "ab"}
    answers = run_worker([{"id": 1, **ask}, {"id": 2, **ask}, {"id": 3, "op": "keep", "envs": ["stage"]}], pool)
    assert [a["id"] for a in answers] == [1, 2, 3] and all(a["ok"] for a in answers)
    assert len(made) == 1 and made[0].really_closed  # closed when stdin ended


def test_keep_with_no_environments_closes_the_connection_at_once():
    made = []
    pool = pool_of(made)
    ask = {"env": "stage", "op": "search_sensors", "query": "ab"}
    answers = run_worker([{"id": 1, **ask}, {"id": 2, "op": "keep", "envs": []}], pool)
    assert answers[1]["open"] == [] and made[0].really_closed


def test_a_dead_socket_is_dropped_and_a_read_is_retried_on_a_new_connection():
    made = []

    def factory(env):
        conn = Tracked([("COUNT(*)", RuntimeError("InterfaceError: connection is closed"))] if not made
                       else [("COUNT(*)", {"rows": [(0,)]}), ("FROM sensors s", {"columns": ["id"], "rows": []})])
        made.append(conn)
        return conn
    answers = run_worker([{"id": 1, "env": "stage", "op": "search_sensors", "query": "ab"}], Pool(factory))
    assert answers[0]["ok"] and len(made) == 2 and made[0].really_closed


def test_a_write_on_a_dead_socket_is_not_replayed():
    made = []

    def factory(env):
        conn = Tracked([("information_schema.columns", {"rows": SCHEMA}), ("UPDATE sensors", RuntimeError("InterfaceError: connection is closed"))])
        made.append(conn)
        return conn
    move = {"type": "set_license", "sensor_id": "AA:BB", "expected": "L1", "new": "L2"}
    answers = run_worker([{"id": 1, "env": "stage", "op": "apply", "actions": [move]}], Pool(factory))
    assert not answers[0]["ok"] and len(made) == 1


def test_a_missing_role_is_not_mistaken_for_a_dead_socket():
    assert not server.looks_dead({"kind": "no_role", "error": "28000"})
    assert not server.looks_dead({"kind": "failed", "error": "InterfaceError: {'C': '28000'}"})
    assert server.looks_dead({"kind": "failed", "error": "InterfaceError: network error"})


def test_warm_opens_the_connection_at_unlock_and_reports_a_missing_role():
    made = []
    pool = pool_of(made)
    answers = run_worker([{"id": 1, "env": "stage", "op": "warm"}, {"id": 2, "env": "mars", "op": "warm"}], pool)
    assert answers[0]["ok"] and answers[0]["open"] == ["stage"] and len(made) == 1
    assert answers[1]["kind"] == "refused"

    def refused(env):
        raise RuntimeError("InterfaceError: {'C': '28000'}")
    assert run_worker([{"id": 1, "env": "prod", "op": "warm"}], Pool(refused))[0]["kind"] == "no_role"
