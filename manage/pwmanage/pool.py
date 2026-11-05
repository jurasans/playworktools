"""One kept-open database connection per environment, for the long-running worker (server.py).

A lease behaves like the connection but its close() only ends the transaction, so the next request starts on a fresh
snapshot (DSQL reads are snapshot based) and the socket stays open. keep() and close_all() really close.
"""
from . import db


class Lease:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return self._conn.cursor()

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        try:
            self._conn.rollback()
        except Exception:  # a dead socket is dropped by the worker on the next failure
            pass


class Pool:
    def __init__(self, factory=db.connect):
        self._factory, self._conns = factory, {}

    def connect(self, env):
        if env.name not in self._conns:
            self._conns[env.name] = self._factory(env)
        return Lease(self._conns[env.name])

    def drop(self, name):
        conn = self._conns.pop(name, None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def keep(self, names):
        """Close every connection whose environment is not in `names` (an empty list closes them all)."""
        for name in [n for n in self._conns if n not in names]:
            self.drop(name)

    def close_all(self):
        self.keep([])

    def open_envs(self):
        return sorted(self._conns)
