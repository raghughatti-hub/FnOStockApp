"""Regression checks against the exact pre-refactor source snapshot."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / '.refactor_baseline' / 'sources.zip'


def canonical_ast(source):
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            node.module = node.module.replace('brokers.', 'broker.')
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
                node.body.pop(0)
    return tree


def probe(original):
    with tempfile.TemporaryDirectory(prefix='fno-structural-') as folder:
        target = Path(folder)
        with zipfile.ZipFile(BASELINE) as z:
            z.extractall(target)
        instruments = target / 'Instrument'
        instruments.mkdir()
        (instruments / 'NFO_symbols.csv').write_text(
            'Exchange,Token,LotSize,Symbol,TradingSymbol,Instrument,Expiry,StrikePrice,TickSize\n'
            'NFO,1001,50,TEST,TEST99DEC100CE,OPTSTK,2099-12-31,100,0.05\n'
            'NFO,1002,50,TEST,TEST99DEC150CE,OPTSTK,2099-12-31,150,0.05\n',
            encoding='utf-8')
        if not original:
            for name in ['main.py', 'broker', 'brokers', 'models', 'services', 'utilities']:
                src = ROOT / name
                if src.is_dir():
                    shutil.copytree(src, target / name, dirs_exist_ok=True,
                                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.txt', '*.json'))
                else:
                    shutil.copy2(src, target / name)
        output = target / 'observations.json'
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'tests' / 'runtime_probe.py'), str(output)],
                             cwd=target, env=env, capture_output=True, text=True,
                             encoding='utf-8', timeout=90)
        if run.returncode:
            raise AssertionError(run.stdout + run.stderr)
        return json.loads(output.read_text(encoding='utf-8'))


class StructuralRefactorTests(unittest.TestCase):
    def test_legacy_first_imports_share_mutable_state(self):
        code = '''
import importlib
for name in ['base_broker', 'broker_manager', 'canonical_symbol_mapper',
             'flattrade_broker', 'upstox_broker', 'zebu_broker', 'execution_engine']:
    legacy = importlib.import_module('brokers.' + name)
    canonical = importlib.import_module('broker.' + name)
    assert legacy is canonical, name
    sentinel = object()
    legacy._refactor_probe = sentinel
    assert canonical._refactor_probe is sentinel, name
    del canonical._refactor_probe
assert importlib.import_module('brokers.execution_engine') is importlib.import_module('services.execution_engine')
'''
        run = subprocess.run([sys.executable, '-B', '-c', code], cwd=ROOT,
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def test_all_python_sources_compile(self):
        for path in ROOT.rglob('*.py'):
            with self.subTest(path=path.relative_to(ROOT)):
                compile(path.read_bytes(), str(path), 'exec')

    def test_protected_files_are_unchanged(self):
        manifest = json.loads((ROOT / '.refactor_baseline' / 'manifest.json').read_text(encoding='utf-8'))
        changed = {'main.py', 'README.md'}
        for name, digest in manifest.items():
            if name in changed or (name.startswith(('broker/', 'brokers/')) and name.endswith('.py')):
                continue
            with self.subTest(path=name):
                self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)

    def test_moved_function_bodies_are_unchanged(self):
        destinations = {'brokers/execution_engine.py': 'services/execution_engine.py'}
        with zipfile.ZipFile(BASELINE) as z:
            for name in z.namelist():
                if not name.startswith('brokers/') or not name.endswith('.py') or name.endswith('__init__.py'):
                    continue
                before = canonical_ast(z.read(name))
                after = canonical_ast((ROOT / destinations.get(name, name.replace('brokers/', 'broker/'))).read_bytes())
                old_defs = [n for n in before.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                new_defs = [n for n in after.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                # Only the old package-local token-removal path changes spelling.
                for node in ast.walk(after):
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'join':
                        if node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == 'LEGACY_BROKER_RESOURCE_DIR':
                            node.args[0] = ast.parse('os.path.dirname(os.path.abspath(__file__))', mode='eval').body
                with self.subTest(module=name):
                    self.assertEqual([ast.dump(n) for n in old_defs], [ast.dump(n) for n in new_defs])

            original = canonical_ast(z.read('main.py'))
            remaining = canonical_ast((ROOT / 'main.py').read_bytes())
            moved = {}
            for name in ['models/api.py', 'utilities/filters.py', 'broker/callbacks.py']:
                for node in canonical_ast((ROOT / name).read_bytes()).body:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        moved[node.name] = node
            # A list preserves the two intentionally duplicate startup definitions.
            current = [n for n in remaining.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
            index = 0
            for node in original.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                if node.name in moved:
                    other = moved[node.name]
                    if node.name.endswith('_callback'):
                        node.decorator_list = []  # Registration stays in main.py.
                else:
                    other = current[index]
                    index += 1
                with self.subTest(definition=node.name):
                    self.assertEqual(ast.dump(node), ast.dump(other))
            self.assertEqual(index, len(current))

    def test_runtime_matches_original(self):
        before, after = probe(True), probe(False)
        self.assertEqual(set(before), set(after))
        for key in before:
            with self.subTest(observation=key):
                self.assertEqual(before[key], after[key])


if __name__ == '__main__':
    unittest.main(verbosity=2)
