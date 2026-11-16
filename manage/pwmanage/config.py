"""Environments, the one database role and the closed lists everything else is checked against (S-19)."""
import os
from dataclasses import dataclass

REGION = "eu-west-1"
ACCOUNT = "754029048553"

# The database role this tool connects as. Created once by setup_role.py, never DbConnectAdmin.
ROLE = "playwork_manage"

# licenses.license_type IS the app tier 1:1 (src/services/licenseService.ts); 3 means 3 and above.
TIERS = {1: "MyPlayBall", 2: "Basic", 3: "Premium"}

# Columns of sensors the UI shows; the row is read-only except through the actions in actions.py.
SENSOR_COLUMNS = ("id", "license_id", "device_id", "user_id", "customer_id", "name", "size", "version")

# Search fields on sensors: a key maps to a fixed SQL expression, never to caller text.
SENSOR_SEARCH = {
    "id": "UPPER(REPLACE(REPLACE(s.id, ':', ''), '-', ''))",
    "license_id": "UPPER(s.license_id)",
    "device_id": "UPPER(s.device_id)",
    "customer_id": "UPPER(s.customer_id)",
}

# Sortable columns of the balls table: a key maps to a fixed SQL expression, never to caller text.
SENSOR_SORT = {
    "id": "UPPER(s.id)",
    "api": "COALESCE(s.version, 1)",
    "license_id": "UPPER(s.license_id)",
    "device_id": "UPPER(s.device_id)",
    "customer_id": "UPPER(s.customer_id)",
}

# Users per ball a licence allows, as the backend computes it (register/user_limit.py): a licenses.max_users override
# wins, else tier 1 -> 1 and tier 2 -> 50, and tier 3 and above have no limit.
TIER_USER_LIMITS = {1: 1, 2: 50}

MAX_ROWS = 200
MIN_QUERY = 2
LOG_RETENTION_DAYS = 365


@dataclass(frozen=True)
class Env:
    name: str
    label: str
    cluster_id: str

    @property
    def host(self) -> str:
        return f"{self.cluster_id}.dsql.{REGION}.on.aws"

    @property
    def log_group(self) -> str:
        return f"/playwork/manage/{self.name}"


ENVS = {
    # stage is the PREPROD cluster of the registration-v2-stage stack
    "stage": Env("stage", "PREPROD", os.environ.get("MANAGE_STAGE_CLUSTER", "ivue7hu3fbxi2nsjyzt3f27qmy")),
    "prod": Env("prod", "PROD", os.environ.get("MANAGE_PROD_CLUSTER", "w5togrr3hb7fj6tdbit7y6oa4m")),
}


def env_for(name: str) -> Env:
    if name not in ENVS:
        raise ValueError(f"unknown environment {name!r}")
    return ENVS[name]
