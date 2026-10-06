"""Preserve existing resource lookup locations during source reorganization.

The active application historically used brokers/. In particular its Zebu
credential file differs from broker/Zebu_Creds.txt. Moving source must not
select different credentials or caches. Do not change this path in a refactor.
"""
import os

LEGACY_BROKER_RESOURCE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "brokers"
)
