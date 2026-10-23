"""The registry and assets helpers for analysis scripts run in ctc-analysis:1.

A script records each number with rec(), writes its section's registry with
save_numbers(), and reads numbers back with reg(). The one assets script sets
each manuscript variable with put_var() and writes the files with
write_variables(). Everything lands under $CTC_OUT (default /work/output).
R scripts use the same API from lib/ctc.R, which mirrors this file.
"""
import csv
import math
import numbers
import os
import re

_numbers = {}
_variables = {}
_SECTION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
_VARIABLE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _out():
    return os.environ.get("CTC_OUT", "/work/output")


def _check_number(value):
    if isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(value):
        raise ValueError(f"{value!r} is not a finite number")


def _format(value):
    """Integer-valued numbers print bare; other numbers with 10 significant digits."""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.10g}"


def _section_path(section):
    if not _SECTION.fullmatch(section):
        raise ValueError(f'"{section}" is not a section name (letters, digits, _ and -)')
    return os.path.join(_out(), "numbers", f"{section}.csv")


def rec(key, value, note=""):
    """Record a number under key for the next save_numbers call."""
    if not isinstance(key, str) or key == "":
        raise ValueError("a key must be a non-empty string")
    _check_number(value)
    if key in _numbers:
        raise ValueError(f'"{key}" is already recorded in this section')
    _numbers[key] = (value, note)


def save_numbers(section):
    """Write the recorded numbers to numbers/<section>.csv, then clear them."""
    path = _section_path(section)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["name", "value", "note"])
        for name, (value, note) in _numbers.items():
            writer.writerow([name, _format(value), note])
    _numbers.clear()


def reg(file, key):
    """The value recorded under key in numbers/<file>.csv; raises unless exactly one row has it."""
    with open(_section_path(file), newline="", encoding="utf-8") as f:
        rows = [row for row in csv.DictReader(f) if row["name"] == key]
    if len(rows) != 1:
        raise ValueError(f'{len(rows)} rows named "{key}" in numbers/{file}.csv; expected exactly one')
    return float(rows[0]["value"])


def put_var(variable, value, source, rendered=None):
    """Set a manuscript variable: its value, the text it renders as, and its source file#key."""
    if not _VARIABLE.fullmatch(variable):
        raise ValueError(f'"{variable}" is not a variable name (letters, digits and _)')
    if variable in _variables:
        raise ValueError(f'variable "{variable}" is already set')
    _check_number(value)
    _variables[variable] = (value, _format(value) if rendered is None else str(rendered), source)


def _yaml_escape(text):
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def write_variables():
    """Write assets/_variables.yml and assets/variables_sources.csv, then clear the variables."""
    folder = os.path.join(_out(), "assets")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "_variables.yml"), "w", encoding="utf-8") as f:
        for name, (_, rendered, _source) in _variables.items():
            f.write(f'{name}: "{_yaml_escape(rendered)}"\n')
    with open(os.path.join(folder, "variables_sources.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["variable", "value", "rendered", "source"])
        for name, (value, rendered, source) in _variables.items():
            writer.writerow([name, _format(value), rendered, source])
    _variables.clear()
