import pytest

from pwmanage import setup_role

from conftest import FakeConn

ARN = "arn:aws:iam::754029048553:role/Admin"


def test_dry_run_prints_the_statements_and_runs_none(capsys):
    assert setup_role.run(None, ARN, table_level=False, dry_run=True) == 0
    out = capsys.readouterr().out
    assert "CREATE ROLE playwork_manage WITH LOGIN" in out
    assert f"AWS IAM GRANT playwork_manage TO '{ARN}'" in out
    assert "GRANT UPDATE (license_type) ON licenses" in out
    assert "GRANT UPDATE (license_id, device_id, customer_id) ON sensors" in out
    assert "DELETE" not in out and "users" not in out and "devices" not in out


def test_table_level_flag_skips_the_column_attempt(capsys):
    setup_role.run(None, ARN, table_level=True, dry_run=True)
    out = capsys.readouterr().out
    assert "GRANT UPDATE ON licenses" in out and "(license_type)" not in out


def test_a_refused_column_grant_falls_back_to_the_table_grant(capsys):
    conn = FakeConn([("UPDATE (license_type)", RuntimeError("column privileges are not supported"))])
    assert setup_role.run(conn, ARN, table_level=False, dry_run=False) == 0
    assert any("GRANT UPDATE ON licenses TO playwork_manage" in s for s in conn.sql())
    assert "fallback" in capsys.readouterr().out


def test_an_existing_role_is_not_an_error(capsys):
    conn = FakeConn([("CREATE ROLE", RuntimeError('role "playwork_manage" already exists'))])
    assert setup_role.run(conn, ARN, table_level=False, dry_run=False) == 0
    assert "already there" in capsys.readouterr().out


@pytest.mark.parametrize("arn", ["", "role/x", "arn:aws:iam::1:role/x'; DROP", "arn:aws:s3:::bucket"])
def test_only_an_iam_arn_is_accepted(arn):
    with pytest.raises(SystemExit):
        list(setup_role.statements(arn, table_level=False))
