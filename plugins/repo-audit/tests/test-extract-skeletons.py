#!/usr/bin/env python3
"""Tests for extract-skeletons.py

Verifies Python AST extraction: function/class/import extraction,
syntax error handling, and empty directory behavior.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SCRIPT_UNDER_TEST = os.path.join(REPO_ROOT, "scripts", "extract-skeletons.py")

PASS_COUNT = 0
FAIL_COUNT = 0


def assert_eq(desc, expected, actual):
    global PASS_COUNT, FAIL_COUNT
    if expected == actual:
        print(f"  PASS: {desc}")
        PASS_COUNT += 1
    else:
        print(f"  FAIL: {desc}")
        print(f"    expected: {expected}")
        print(f"    actual:   {actual}")
        FAIL_COUNT += 1


def assert_true(desc, condition):
    global PASS_COUNT, FAIL_COUNT
    if condition:
        print(f"  PASS: {desc}")
        PASS_COUNT += 1
    else:
        print(f"  FAIL: {desc}")
        FAIL_COUNT += 1


def assert_contains(desc, needle, haystack):
    global PASS_COUNT, FAIL_COUNT
    if needle in haystack:
        print(f"  PASS: {desc}")
        PASS_COUNT += 1
    else:
        print(f"  FAIL: {desc}")
        print(f"    expected to contain: {needle}")
        print(f"    actual: {haystack}")
        FAIL_COUNT += 1


# ======================================================================
# Test 1: Extract functions, classes, and imports from valid Python files
# ======================================================================
print("=== Test 1: Function, class, and import extraction ===")

tmpdir = tempfile.mkdtemp()
try:
    # Create a sample Python file with known structure
    sample_dir = os.path.join(tmpdir, "mypackage")
    os.makedirs(sample_dir)

    sample_file = os.path.join(sample_dir, "models.py")
    with open(sample_file, "w") as f:
        f.write("""\
import os
from typing import List, Optional
from dataclasses import dataclass


@dataclass
class User:
    name: str
    email: str

    def validate(self):
        return "@" in self.email

    def display_name(self):
        return self.name.title()


class AdminUser(User):
    def has_permission(self, perm):
        return True


def create_user(name: str, email: str) -> User:
    user = User(name=name, email=email)
    return user


async def fetch_user(user_id: int) -> Optional[User]:
    pass
""")

    # Run the script
    result = subprocess.run(
        [sys.executable, SCRIPT_UNDER_TEST, tmpdir],
        capture_output=True,
        text=True,
    )

    assert_eq("Exit code is 0", 0, result.returncode)

    output_file = os.path.join(tmpdir, "sdlc-audit", "data", "skeletons", "python.json")
    assert_true("Output file created", os.path.exists(output_file))

    with open(output_file) as f:
        data = json.load(f)

    # Find our file in the results (path is relative to project root)
    relpath = os.path.join("mypackage", "models.py")
    assert_true(f"File {relpath} in results", relpath in data)

    entry = data[relpath]

    # Check functions
    func_names = [fn["name"] for fn in entry["functions"]]
    assert_contains("create_user function extracted", "create_user", func_names)
    assert_contains("fetch_user function extracted", "fetch_user", func_names)
    assert_contains("validate method extracted", "validate", func_names)

    # Check async detection
    async_funcs = [fn for fn in entry["functions"] if fn.get("is_async")]
    async_names = [fn["name"] for fn in async_funcs]
    assert_contains("fetch_user detected as async", "fetch_user", async_names)

    # Check create_user args and return
    create_user_fn = [fn for fn in entry["functions"] if fn["name"] == "create_user"][0]
    assert_contains("create_user has 'name' arg", "name", create_user_fn["args"])
    assert_contains("create_user has 'email' arg", "email", create_user_fn["args"])
    assert_eq("create_user returns User", "User", create_user_fn["returns"])

    # Check that 'self' is excluded from args
    validate_fn = [fn for fn in entry["functions"] if fn["name"] == "validate"][0]
    assert_true("'self' excluded from validate args", "self" not in validate_fn["args"])

    # Check classes
    class_names = [cls["name"] for cls in entry["classes"]]
    assert_contains("User class extracted", "User", class_names)
    assert_contains("AdminUser class extracted", "AdminUser", class_names)

    # Check AdminUser inherits from User
    admin_cls = [cls for cls in entry["classes"] if cls["name"] == "AdminUser"][0]
    assert_contains("AdminUser inherits User", "User", admin_cls["bases"])

    # Check User methods
    user_cls = [cls for cls in entry["classes"] if cls["name"] == "User"][0]
    assert_contains("User has validate method", "validate", user_cls["methods"])
    assert_contains("User has display_name method", "display_name", user_cls["methods"])

    # Check imports
    import_froms = [imp["from"] for imp in entry["imports"]]
    assert_contains("os import extracted", "os", import_froms)
    assert_contains("typing import extracted", "typing", import_froms)
    assert_contains("dataclasses import extracted", "dataclasses", import_froms)

    # Check line count
    assert_eq("Line count is 29", 29, entry["line_count"])

    # Check decorators
    user_cls_in_funcs = [fn for fn in entry["functions"] if fn["name"] == "create_user"][0]
    # create_user has no decorators
    assert_eq("create_user has no decorators", [], user_cls_in_funcs["decorators"])

finally:
    shutil.rmtree(tmpdir)

# ======================================================================
# Test 2: Syntax error handling
# ======================================================================
print("=== Test 2: Syntax error handling ===")

tmpdir = tempfile.mkdtemp()
try:
    os.makedirs(os.path.join(tmpdir, "broken"))

    # File with valid Python
    with open(os.path.join(tmpdir, "broken", "good.py"), "w") as f:
        f.write("def hello():\n    return 'world'\n")

    # File with syntax error
    with open(os.path.join(tmpdir, "broken", "bad.py"), "w") as f:
        f.write("def broken(:\n    this is not valid python syntax\n")

    result = subprocess.run(
        [sys.executable, SCRIPT_UNDER_TEST, tmpdir],
        capture_output=True,
        text=True,
    )

    # Should NOT crash (exit code 0)
    assert_eq("Exit code is 0 despite syntax error", 0, result.returncode)

    output_file = os.path.join(tmpdir, "sdlc-audit", "data", "skeletons", "python.json")
    assert_true("Output file created", os.path.exists(output_file))

    with open(output_file) as f:
        data = json.load(f)

    good_path = os.path.join("broken", "good.py")
    bad_path = os.path.join("broken", "bad.py")

    # Good file should be fully parsed
    assert_true("Good file in results", good_path in data)
    good_funcs = [fn["name"] for fn in data[good_path]["functions"]]
    assert_contains("hello function from good file", "hello", good_funcs)

    # Bad file should have an error entry, not be missing
    assert_true("Bad file in results", bad_path in data)
    assert_eq("Bad file has syntax_error", "syntax_error", data[bad_path].get("error"))

    # Verify the error output mentions errors
    assert_contains("Output mentions errors", "1 errors", result.stdout)

finally:
    shutil.rmtree(tmpdir)

# ======================================================================
# Test 3: Empty directory - no .py files
# ======================================================================
print("=== Test 3: Empty directory ===")

tmpdir = tempfile.mkdtemp()
try:
    # Create directories but no .py files
    os.makedirs(os.path.join(tmpdir, "emptydir"))
    # Put a non-Python file to make directory non-empty
    with open(os.path.join(tmpdir, "emptydir", "readme.txt"), "w") as f:
        f.write("No Python here\n")

    result = subprocess.run(
        [sys.executable, SCRIPT_UNDER_TEST, tmpdir],
        capture_output=True,
        text=True,
    )

    assert_eq("Exit code is 0 for empty", 0, result.returncode)
    assert_contains("Skip message printed", "No Python files found", result.stdout)

    # Output file should NOT be created
    output_file = os.path.join(tmpdir, "sdlc-audit", "data", "skeletons", "python.json")
    assert_true("No output file for empty dir", not os.path.exists(output_file))

finally:
    shutil.rmtree(tmpdir)

# ======================================================================
# Test 4: Excluded directories are skipped
# ======================================================================
print("=== Test 4: Excluded directories skipped ===")

tmpdir = tempfile.mkdtemp()
try:
    # Create file in __pycache__ (should be excluded)
    cache_dir = os.path.join(tmpdir, "__pycache__")
    os.makedirs(cache_dir)
    with open(os.path.join(cache_dir, "cached.py"), "w") as f:
        f.write("x = 1\n")

    # Create file in .venv (should be excluded)
    venv_dir = os.path.join(tmpdir, ".venv", "lib")
    os.makedirs(venv_dir)
    with open(os.path.join(venv_dir, "site.py"), "w") as f:
        f.write("y = 2\n")

    # Create a valid file that should be included
    src_dir = os.path.join(tmpdir, "src")
    os.makedirs(src_dir)
    with open(os.path.join(src_dir, "app.py"), "w") as f:
        f.write("def main():\n    pass\n")

    result = subprocess.run(
        [sys.executable, SCRIPT_UNDER_TEST, tmpdir],
        capture_output=True,
        text=True,
    )

    assert_eq("Exit code is 0", 0, result.returncode)

    output_file = os.path.join(tmpdir, "sdlc-audit", "data", "skeletons", "python.json")
    with open(output_file) as f:
        data = json.load(f)

    # Only the src/app.py should be in results
    assert_eq("Only 1 file extracted (excluded dirs skipped)", 1, len(data))
    app_path = os.path.join("src", "app.py")
    assert_true("src/app.py in results", app_path in data)

finally:
    shutil.rmtree(tmpdir)

# ======================================================================
# Summary
# ======================================================================
print()
print(f"extract-skeletons: {PASS_COUNT} passed, {FAIL_COUNT} failed")

sys.exit(1 if FAIL_COUNT > 0 else 0)
