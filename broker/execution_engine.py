"""Compatibility import: share the implementation module and its mutable state."""
from importlib import import_module as _import_module
import sys as _sys

_sys.modules[__name__] = _import_module("services.execution_engine")
