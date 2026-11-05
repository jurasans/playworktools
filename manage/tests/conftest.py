import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SCHEMA = [("id", "text"), ("invoice_no", "text"), ("date", "timestamp with time zone")]


class FakeCursor:
    """Records every statement; answers from `script` (substring of the SQL -> result)."""

    def __init__(self, conn):
        self.conn, self.rowcount, self.description, self._rows = conn, 1, None, []

    def execute(self, sql, params=()):
        self.conn.executed.append((" ".join(sql.split()), list(params)))
        for needle, outcome in self.conn.script:
            if needle in sql:
                if isinstance(outcome, Exception):
                    raise outcome
                self.rowcount = outcome.get("rowcount", 1)
                self.description = [(c,) for c in outcome.get("columns", [])]
                self._rows = outcome.get("rows", [])
                return
        self.rowcount, self.description, self._rows = 1, None, [(1,)]

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConn:
    def __init__(self, script=()):
        self.script, self.executed, self.commits, self.rollbacks, self.closed = list(script), [], 0, 0, False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True

    def sql(self):
        return [s for s, _ in self.executed]


@pytest.fixture
def schema():
    return list(SCHEMA)


@pytest.fixture
def conn():
    return FakeConn()
