"""Isolated, offline observations of either the original or refactored source.

Run by test_structural_refactor in a disposable directory. Network calls fail
closed, logging does not touch files, and production threads never start.
"""
import asyncio
import contextlib
import importlib
import io
import json
import logging
from pathlib import Path
import socket
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path.cwd()))


def forbidden(*args, **kwargs):
    raise AssertionError("External I/O is forbidden in the offline probe")


_socket_connect = socket.socket.connect


def local_connect(sock, address):
    # Windows asyncio implements its internal socketpair with a loopback socket.
    if isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1'):
        return _socket_connect(sock, address)
    return forbidden(sock, address)


async def observe(main):
    from fastapi.testclient import TestClient
    from starlette.requests import Request
    import pandas as pd

    result = {}
    client = TestClient(main.app)
    result['schema'] = main.app.openapi()
    result['routes'] = [
        [r.path, sorted(getattr(r, 'methods', []) or []), r.name]
        for r in main.app.routes
    ]
    result['startup_handlers'] = [f.__name__ for f in main.app.router.on_startup]
    result['http'] = {}
    for url in ['/api/brokers', '/api/status', '/api/subscriptions', '/api/live_data', '/']:
        response = client.get(url)
        result['http'][url] = {
            'status': response.status_code,
            'body': response.text,
            'cache': {k: response.headers.get(k) for k in ['cache-control', 'pragma', 'expires']},
        }
    response = client.post('/api/place_order', json={})
    result['invalid_order'] = [response.status_code, response.json()]

    # Compare operator output AND errors, including existing edge-case behavior.
    frame = pd.DataFrame({'x': ['1', '2', '', '-', None, 'NaN', 'abc', '0']})
    result['filters'] = []
    for field in ['x', 'missing']:
        for op in ['>', '<', 'between', '!=0', 'isNum', '=', '!=null', 'contains', 'unknown']:
            try:
                value = main.evaluate_condition_pandas(frame, field, op, '1', '2').tolist()
            except Exception as exc:
                value = [type(exc).__name__, str(exc)]
            result['filters'].append([field, op, value])

    # Broker callbacks: no-code error, relay, and resolved-future branches.
    req = Request({'type': 'http', 'method': 'GET', 'scheme': 'http',
                   'path': '/flattrade/callback', 'query_string': b'',
                   'server': ('127.0.0.1', 8095), 'headers': []})
    result['callbacks'] = []
    for future, code in [(None, None), (asyncio.get_running_loop().create_future(), None),
                         (asyncio.get_running_loop().create_future(), 'offline-code')]:
        main.app_state.flattrade_auth_code_future = future
        response = await main.flattrade_callback(req, request_code=code)
        result['callbacks'].append([response.status_code, response.body.decode(),
                                    response.headers.get('location'),
                                    future.result() if future and future.done() else None])
    response = await main.upstox_callback(req)
    result['callbacks'].append([response.status_code, response.body.decode()])

    engine = importlib.import_module('brokers.execution_engine')
    if Path('services/execution_engine.py').exists():
        for name in ['base_broker', 'broker_manager', 'canonical_symbol_mapper',
                     'flattrade_broker', 'upstox_broker', 'zebu_broker', 'execution_engine']:
            assert importlib.import_module('brokers.' + name) is importlib.import_module('broker.' + name)
        assert engine is importlib.import_module('services.execution_engine')
    result['rounding'] = [engine.round_to_tick(price, tick, up, down)
                          for price in [0, 0.025, 7.13, 100.001, -1.23]
                          for tick in [0, .05, .0025]
                          for up, down in [(False, False), (True, False), (False, True)]]
    state = main.app_state
    state.live_data = {'NFO|TEST': {'lp': '7', 'bp1': '6.95', 'sp1': '7.05'}}
    state.symbol_to_token = {('NFO', 'TEST'): '123'}
    state.token_to_info = {('NFO', '123'): {'TickSize': .01}}
    result['tick_sizes'] = [engine.get_tick_size('NFO', 'TEST'), engine.get_tick_size('CDS', 'TEST')]
    result['quotes'] = [engine.get_live_data('nfo', 'test')]
    for quotes in [{'TEST': {'lp': '8'}}, {'NFO|123': {'lp': '9'}}, {'123': {'lp': '10'}}, {}]:
        state.live_data = quotes
        result['quotes'].append(engine.get_live_data('NFO', 'TEST'))

    state.live_data = {'NFO|TEST': {'lp': '7', 'bp1': '6.95', 'sp1': '7.05'}}
    result['parents'] = []
    for mode in ['Aggressive_Entry', 'Aggressive_Exit', 'True_Limit_LTP', 'Limit_Below', 'Limit_Above']:
        for side in ['BUY', 'SELL']:
            state.paper_orders = {}
            params = main.TradeOrderParams(exchange='NFO', symbol='TEST', quantity=50,
                                          buy_or_sell=side, order_type='LIMIT', price=7.0,
                                          execution_mode=mode)
            with patch.object(engine.time, 'time', return_value=1700000000.125), patch.object(threading.Thread, 'start'):
                reply = engine.start_execution_engine(params, True)
            result['parents'].append([mode, side, reply, dict(state.paper_orders)])

    result['paper_lifecycle'] = []
    for side in ['BUY', 'SELL']:
        for ltp in ['0', '6.9', '7.0', '7.1']:
            state.paper_orders = {}
            state.live_data = {'NFO|TEST': {'lp': ltp, 'bp1': '6.95', 'sp1': '7.05'}}
            params = main.TradeOrderParams(exchange='NFO', symbol='TEST', quantity=50,
                                          buy_or_sell=side, order_type='LIMIT', price=7.0)
            with patch.object(engine.time, 'time', return_value=1700000000.125):
                placed = engine.place_new_order(params, 50, 7.0, True)
            order_id = placed['order_id']
            status = engine.get_order_status(order_id, True, params)
            modified = engine.modify_open_order(order_id, params, 25, 7.023, True)
            cancelled = engine.cancel_order(order_id, True)
            result['paper_lifecycle'].append([side, ltp, placed, status, modified, cancelled,
                                              dict(state.paper_orders)])
    result['paper_missing'] = [engine.cancel_order('absent', True),
                               engine.modify_open_order('absent', params, 1, 7, True),
                               engine.get_order_status('absent', True, params)]

    # Evaluate both registered startup handlers with background work captured.
    tasks = []
    def capture(coro):
        tasks.append(coro.cr_code.co_name)
        coro.close()
    with patch.object(main, 'disable_quick_edit'), patch.object(main.asyncio, 'create_task', capture):
        for handler in main.app.router.on_startup:
            await handler()
    result['startup_tasks'] = tasks
    result['startup_loop_bound'] = state.main_loop is asyncio.get_running_loop()
    result['wiring'] = [main.flattrade_broker.app_state is state,
                        main.flattrade_broker.manager is main.manager,
                        main.upstox_plugin.app_state is state,
                        main.zebu_plugin.app_state is state,
                        engine.app_state is state, engine.manager is main.manager]
    result['resource_paths'] = {}
    for module, names in [('upstox_broker', ['UPSTOX_CACHE_FILE', 'ROOT_CACHE_FILE', 'UPSTOX_CREDS_FILE']),
                          ('zebu_broker', ['ZEBU_CACHE_FILE', 'ROOT_CACHE_FILE', 'ZEBU_CREDS_FILE']),
                          ('flattrade_broker', ['HISTORICAL_CACHE_FILE'])]:
        mod = importlib.import_module('brokers.' + module)
        result['resource_paths'][module] = {n: Path(getattr(mod, n)).relative_to(Path.cwd()).as_posix() for n in names}

    # Exercise real ASGI lifespan and instrument worker with disposable fixtures.
    # Only console changes are suppressed here; framework tasks/threads run.
    state.symbol_to_token = {}
    state.token_to_info = {}
    with patch.object(main, 'disable_quick_edit'):
        with TestClient(main.app) as started:
            deadline = time.monotonic() + 10
            while ('NFO', '1002') not in state.token_to_info and time.monotonic() < deadline:
                time.sleep(.01)
            assert ('NFO', '1002') in state.token_to_info, 'Instrument startup worker did not complete'
            result['lifespan'] = {
                'http_status': started.get('/api/status').status_code,
                'home_status': started.get('/').status_code,
                'loaded_tokens': sorted([list(k) for k in state.token_to_info]),
                'strike_rows': len(state.fno_spot_df),
            }
    return result


if __name__ == '__main__':
    import requests
    import config.logging_config
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink), \
         patch.object(socket.socket, 'connect', local_connect), \
         patch.object(requests.sessions.Session, 'request', forbidden), \
         patch.object(config.logging_config, 'setup_logging', return_value=logging.getLogger('offline')):
        with patch.object(threading.Thread, 'start'):
            import main
        observed = asyncio.run(observe(main))
    Path(sys.argv[1]).write_text(json.dumps(observed, sort_keys=True, indent=2), encoding='utf-8')
