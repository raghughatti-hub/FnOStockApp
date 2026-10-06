# Generic order execution service. Keep sequential trading logic in order.
import time
import math
import logging
import asyncio
import threading
from typing import Optional

# Global variables to be injected from main.py
app_state = None
manager = None

logger = logging.getLogger("uvicorn.error")

def get_tick_size(exchange: str, symbol: str) -> float:
    """Resolve tick size dynamically from token_to_info or fall back to defaults.
    Enforces exchange rules: CDS is 0.0025, and Indian equity derivatives/cash (NFO, NSE, BSE)
    strictly trade in multiples of 0.05 (5 paise). Never allow CSV errors (like 0.01) to violate this."""
    exch = exchange.upper()
    sym = symbol.upper()
    
    if exch == "CDS":
        return 0.0025

    if app_state and hasattr(app_state, 'symbol_to_token'):
        token = app_state.symbol_to_token.get((exch, sym))
        if token and hasattr(app_state, 'token_to_info'):
            info = app_state.token_to_info.get((exch, token))
            if info:
                try:
                    ts = float(info.get('TickSize', 0.05))
                    # NSE F&O & Equity rules: tick size is minimum 0.05 paise
                    if ts >= 0.05:
                        return ts
                except:
                    pass
    
    # Defaults: Currency derivatives (CDS) is 0.0025, all others (NFO, NSE, BSE, MCX) minimum 0.05
    return 0.05

def round_to_tick(price: float, tick: float, round_up: bool = False, round_down: bool = False) -> float:
    """Round price dynamically to nearest tick size."""
    if tick <= 0:
        tick = 0.05
    ticks = price / tick
    if round_up:
        rounded_ticks = math.ceil(ticks - 1e-9)
    elif round_down:
        rounded_ticks = math.floor(ticks + 1e-9)
    else:
        rounded_ticks = round(ticks)
    return round(rounded_ticks * tick, 4 if tick < 0.01 else 2)

def get_live_data(exchange: str, symbol: str) -> dict:
    """Resolve live ticker quote from app_state.live_data using various key formats."""
    if not app_state or not hasattr(app_state, 'live_data'):
        return {}
    exch = exchange.upper()
    sym = symbol.upper()
    
    # 1. Try Direct exchange|symbol
    key = f"{exch}|{sym}"
    live = app_state.live_data.get(key)
    if live and ("lp" in live or "bp1" in live or "sp1" in live):
        return live
        
    # 2. Try raw symbol
    live = app_state.live_data.get(sym)
    if live and ("lp" in live or "bp1" in live or "sp1" in live):
        return live
        
    # 3. Try token resolution
    if hasattr(app_state, 'symbol_to_token'):
        token = app_state.symbol_to_token.get((exch, sym))
        if token:
            live = app_state.live_data.get(f"{exch}|{token}") or app_state.live_data.get(str(token))
            if live and ("lp" in live or "bp1" in live or "sp1" in live):
                return live
                
    return app_state.live_data.get(key) or {}

def get_order_status(order_id: str, is_paper: bool, params) -> Optional[dict]:
    """Retrieve details for a specific order (PAPER or REAL)."""
    if is_paper:
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        order = app_state.paper_orders.get(order_id)
        if not order:
            return None
        
        # Simulate fill for paper order if PENDING
        if order.get("status") == "PENDING":
            live_data = get_live_data(order.get('exchange', params.exchange), order.get('symbol', params.symbol))
            ltp = float(live_data.get('lp', 0.0))
            
            side = order.get("side", "BUY").upper()
            price = order.get("price", 0.0)
            
            should_fill = False
            if ltp <= 0:
                should_fill = True  # If no stream, fill immediately at order price
            elif side.startswith("B"):  # BUY
                if ltp <= price:
                    should_fill = True
            else:  # SELL
                if ltp >= price:
                    should_fill = True
            
            if should_fill:
                order["status"] = "COMPLETE"
                order["filled_qty"] = order["qty"]
                order["remaining_qty"] = 0
                
                # Determine realistic fill price by crossing the spread / LTP (capped/floored by limit price)
                fill_price = price
                if side.startswith("B"):
                    sp1 = float(live_data.get('sp1', 0.0))
                    ref_price = sp1 if sp1 > 0 else (ltp if ltp > 0 else price)
                    if ref_price > 0:
                        fill_price = min(price, ref_price)
                else:
                    bp1 = float(live_data.get('bp1', 0.0))
                    ref_price = bp1 if bp1 > 0 else (ltp if ltp > 0 else price)
                    if ref_price > 0:
                        fill_price = max(price, ref_price)
                        
                if price > 0.5 and fill_price < (price * 0.5):
                    fill_price = price
                elif fill_price <= 0.05 and price > 0.05:
                    fill_price = price

                order_exch = order.get('exchange', params.exchange)
                order_sym = order.get('symbol', params.symbol)
                fill_tick = get_tick_size(order_exch, order_sym)
                fill_price = round_to_tick(fill_price, fill_tick, round_up=side.startswith("B"), round_down=not side.startswith("B"))
                order["avg_price"] = fill_price
        
        return {
            "status": order.get("status"),
            "filled_qty": order.get("filled_qty", 0),
            "remaining_qty": order.get("remaining_qty", order.get("qty")),
            "avg_price": order.get("avg_price", 0.0),
            "rejreason": order.get("rejreason", "")
        }
    
    if not app_state or not app_state.api:
        return None
    
    try:
        res = app_state.api.single_order_history(orderno=order_id)
        if isinstance(res, list) and len(res) > 0:
            latest = res[0]
            status = latest.get("status", "").upper()
            filled_qty = int(latest.get("fillshares", 0))
            qty = int(latest.get("qty", 0))
            avg_price = float(latest.get("avgprc", 0.0))
            remaining_qty = qty - filled_qty
            
            return {
                "status": status,
                "filled_qty": filled_qty,
                "remaining_qty": remaining_qty,
                "avg_price": avg_price,
                "rejreason": latest.get("rejreason", "")
            }
        elif isinstance(res, dict):
            if res.get("stat") == "Not_Ok":
                return {
                    "status": "REJECTED",
                    "filled_qty": 0,
                    "remaining_qty": 0,
                    "avg_price": 0.0,
                    "rejreason": res.get("emsg", "")
                }
            status = res.get("status", "").upper()
            filled_qty = int(res.get("fillshares", 0))
            qty = int(res.get("qty", 0))
            avg_price = float(res.get("avgprc", 0.0))
            remaining_qty = qty - filled_qty
            return {
                "status": status,
                "filled_qty": filled_qty,
                "remaining_qty": remaining_qty,
                "avg_price": avg_price,
                "rejreason": res.get("rejreason", "")
            }
    except Exception as e:
        logger.error(f"[EXEC ENGINE] Error fetching broker order status for {order_id}: {e}")
    return None

def cancel_order(order_id: str, is_paper: bool) -> dict:
    """Request order cancellation (PAPER or REAL)."""
    if is_paper:
        if hasattr(app_state, 'paper_orders') and order_id in app_state.paper_orders:
            app_state.paper_orders[order_id]["status"] = "CANCELED"
            return {"status": "success"}
        return {"status": "error", "message": "Order not found"}
        
    from broker.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if active_broker:
        res = active_broker.cancel_order(order_id=order_id)
        if isinstance(res, dict) and res.get("status") == "error":
            return {"status": "error", "message": res.get("message", "Cancel failed")}
        return {"status": "success"}
    return {"status": "error", "message": "No active broker connected"}

def modify_open_order(order_id: str, params, new_qty: int, new_price: float, is_paper: bool) -> dict:
    """Attempt fast atomic price modification on broker before resorting to cancel-and-replace."""
    tick_sz = get_tick_size(params.exchange, params.symbol)
    side = params.buy_or_sell.upper()
    new_price = round_to_tick(new_price, tick_sz, round_up=side.startswith("B"), round_down=not side.startswith("B"))
    
    if is_paper:
        if hasattr(app_state, 'paper_orders') and order_id in app_state.paper_orders:
            app_state.paper_orders[order_id]["price"] = new_price
            app_state.paper_orders[order_id]["remaining_qty"] = new_qty
            return {"status": "success"}
        return {"status": "error", "message": "Paper order not found"}

    from broker.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if not active_broker:
        return {"status": "error", "message": "No active broker connected"}

    try:
        res = active_broker.modify_order(
            order_id=order_id,
            exchange=params.exchange,
            tradingsymbol=params.symbol,
            new_quantity=new_qty,
            new_price_type="LMT",
            new_price=new_price,
            trigger_price=None
        )
        if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
            emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Modify failed"
            return {"status": "error", "message": emsg}
        return {"status": "success"}
    except Exception as e:
        logger.warning(f"[EXEC ENGINE] modify_open_order exception: {e}")
        return {"status": "error", "message": str(e)}

def place_new_order(params, qty: int, price: float, is_paper: bool) -> dict:
    """Submit a new order (PAPER or REAL)."""
    tick_sz = get_tick_size(params.exchange, params.symbol)
    side = params.buy_or_sell.upper()
    price = round_to_tick(price, tick_sz, round_up=side.startswith("B"), round_down=not side.startswith("B"))

    if is_paper:
        new_order_id = f"PAPER_CHASE_{int(time.time())}_{math.floor(time.time() * 1000) % 1000}"
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        app_state.paper_orders[new_order_id] = {
            "status": "PENDING",
            "qty": qty,
            "filled_qty": 0,
            "remaining_qty": qty,
            "price": price,
            "avg_price": 0.0,
            "symbol": params.symbol,
            "exchange": params.exchange,
            "side": params.buy_or_sell,
            "created_at": time.time()
        }
        return {"status": "success", "order_id": new_order_id}
        
    from broker.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if not active_broker:
        return {"status": "error", "message": "No active broker connected"}

    product_type = "M" if params.exchange not in ["NSE", "BSE"] else "C"
    res = active_broker.place_order(
        buy_or_sell=params.buy_or_sell[0],
        exchange=params.exchange,
        tradingsymbol=params.symbol,
        quantity=qty,
        price_type="LMT",
        price=price,
        trigger_price=None,
        product_type=product_type
    )
    if res is None or (isinstance(res, dict) and (res.get("status") == "error" or res.get("stat") == "Not_Ok")):
        emsg = res.get("message") or res.get("emsg") if isinstance(res, dict) else "Broker API returned error"
        return {"status": "error", "message": emsg}
    order_id = res.get("data", {}).get("order_id") if isinstance(res, dict) and "data" in res else (res.get("norenordno") or str(res))
    return {"status": "success", "order_id": order_id}

def broadcast_order_update(parent_order_id: str, status: str, avgprc: float, filledqty: int, symbol: str, remarks: str):
    """Broadcast virtualized parent order state to frontend clients."""
    if app_state and hasattr(app_state, 'paper_orders') and parent_order_id in app_state.paper_orders:
        app_state.paper_orders[parent_order_id].update({
            "status": status,
            "filled_qty": filledqty,
            "remaining_qty": app_state.paper_orders[parent_order_id]["qty"] - filledqty,
            "avg_price": avgprc,
            "rejreason": remarks
        })

    if not app_state or not app_state.main_loop or not manager:
        return
    data = {
        "norenordno": parent_order_id,
        "status": status,
        "avgprc": str(avgprc),
        "filledqty": str(filledqty),
        "tsym": symbol,
        "rejreason": remarks
    }
    logger.info(f"[EXEC ENGINE] Broadcasting virtual update: {data}")
    asyncio.run_coroutine_threadsafe(
        manager.broadcast("ORDER_UPDATE", data),
        app_state.main_loop
    )

def execution_thread_worker(
    params,
    parent_order_id: str,
    initial_price: float,
    tick_size: float,
    is_paper: bool
):
    """Background thread running the trigger detection, chasing loop, and sweep safeguard."""
    # Ensure symbol subscription is live
    sub_key = f"{params.exchange}|{params.symbol}"
    from broker.broker_manager import broker_manager
    active_broker = broker_manager.get_active_broker()
    if active_broker:
        active_broker.subscribe_symbols([sub_key])
    
    execution_mode = params.execution_mode
    total_qty = params.quantity
    
    # 1. Trigger phase for Limit_Below / Limit_Above modes
    if execution_mode in ["Limit_Below", "Limit_Above"]:
        trigger_price = params.limit_price_trigger if params.limit_price_trigger and params.limit_price_trigger > 0 else params.price
        logger.info(f"[EXEC ENGINE] Order {parent_order_id} enters trigger phase: {execution_mode} at {trigger_price}")
        
        triggered = False
        start_wait = time.time()
        while time.time() - start_wait < 3600:  # 1 hour safety cutoff
            live_data = app_state.live_data.get(sub_key, {})
            ltp = float(live_data.get('lp', 0.0))
            if ltp > 0:
                if execution_mode == "Limit_Below" and ltp <= trigger_price:
                    triggered = True
                    break
                elif execution_mode == "Limit_Above" and ltp >= trigger_price:
                    triggered = True
                    break
            time.sleep(0.5)
            
        if not triggered:
            logger.warning(f"[EXEC ENGINE] Trigger timeout (1 hour elapsed) for order {parent_order_id}")
            broadcast_order_update(parent_order_id, "REJECTED", 0.0, 0, params.symbol, "Trigger Timeout")
            return
            
        logger.info(f"[EXEC ENGINE] Order {parent_order_id} triggered! LTP: {ltp}")
        initial_price = trigger_price

    # 2. Placement and Chasing loop
    fills = []  # List of tuples: (filled_qty, avg_price)
    
    # Submit first broker order
    first_res = place_new_order(params, total_qty, initial_price, is_paper)
    if first_res.get("status") != "success":
        logger.error(f"[EXEC ENGINE] Initial order placement failed: {first_res.get('message')}")
        broadcast_order_update(parent_order_id, "REJECTED", 0.0, 0, params.symbol, first_res.get("message", "Order Failed"))
        return
        
    current_order_id = first_res.get("order_id")
    
    # Map current order to parent
    app_state.order_mappings[current_order_id] = {
        "parent_order_id": parent_order_id,
        "total_qty": total_qty,
        "is_paper": is_paper,
        "symbol": params.symbol,
        "exchange": params.exchange,
        "side": params.buy_or_sell
    }
    
    # Mark chasing active
    app_state.chasing_orders[parent_order_id] = True
    
    start_time = time.time()
    retries = 0
    max_retries = params.max_retries if params.max_retries is not None else 5
    timeout = params.timeout if params.timeout is not None else 10.0
    slippage_tolerance = params.slippage_tolerance if params.slippage_tolerance is not None else 0.03
    
    current_order_price = initial_price
    is_exit_mode = (execution_mode == "Aggressive_Exit")
    
    logger.info(f"[EXEC ENGINE] Active order: {parent_order_id} -> {current_order_id} @ {current_order_price} (Mode: {execution_mode}, is_exit: {is_exit_mode})")
    
    last_status = "OPEN"
    
    while True:
        time.sleep(0.5)
        
        # User manual cancellation check
        if not app_state.chasing_orders.get(parent_order_id, False):
            logger.info(f"[EXEC ENGINE] Order {parent_order_id} stopped by user cancellation.")
            break
            
        # For exits only: enforce timeout and retry safeguards so intraday positions are never trapped
        if is_exit_mode:
            elapsed = time.time() - start_time
            if elapsed >= timeout or retries >= max_retries:
                logger.info(f"[EXEC ENGINE] Exit timeout reached ({elapsed:.1f}s / retries {retries}) for {parent_order_id}.")
                break
        
        status_info = get_order_status(current_order_id, is_paper, params)
        if not status_info:
            continue
            
        last_status = status_info.get("status", "").upper()
        filled_qty = int(status_info.get("filled_qty", 0))
        avg_price = float(status_info.get("avg_price", 0.0))
        
        sum_prev_fills = sum(q for q, _ in fills)
        unfilled_parent_qty = total_qty - sum_prev_fills
        
        if last_status == "COMPLETE":
            # The remaining quantity of the parent order was completely filled
            fill_qty = (filled_qty - sum_prev_fills) if (filled_qty > sum_prev_fills) else unfilled_parent_qty
            fills.append((fill_qty, avg_price if avg_price > 0 else current_order_price))
            logger.info(f"[EXEC ENGINE] Child order {current_order_id} filled {fill_qty} @ {avg_price or current_order_price} (Total: {sum_prev_fills + fill_qty}/{total_qty})")
            break
        elif last_status in ["REJECTED", "REJECT"]:
            logger.warning(f"[EXEC ENGINE] Child order {current_order_id} rejected: {status_info.get('rejreason')}")
            break
        elif last_status in ["CANCELED", "CANCELLED"]:
            if filled_qty > sum_prev_fills:
                fills.append((filled_qty - sum_prev_fills, avg_price if avg_price > 0 else current_order_price))
            break
        else:
            # Active (OPEN, PENDING, etc.)
            remaining_qty = unfilled_parent_qty
            if execution_mode not in ["Aggressive_Entry", "Aggressive_Exit"]:
                # True_Limit_LTP rests in the order book without chasing
                continue
                
            live_data = get_live_data(params.exchange, params.symbol)
            ltp = float(live_data.get('lp', 0.0))
            bp1 = float(live_data.get('bp1', 0.0))
            sp1 = float(live_data.get('sp1', 0.0))
            
            side = params.buy_or_sell.upper()
            elapsed = time.time() - start_time
            
            # Collar boundary definitions
            # For Exits past 4s, adaptively widen collar floor/ceiling so an exit position is never trapped
            effective_collar = slippage_tolerance
            if is_exit_mode and elapsed > 4.0:
                effective_collar = min(0.08, slippage_tolerance * 1.5)  # Safe bounded widening up to 8% max
                
            if side.startswith("B"):
                ref_anchor = max(ltp, bp1) if (ltp > 0 or bp1 > 0) else initial_price
                upper_bound = round_to_tick(ref_anchor * (1.0 + effective_collar), tick_size, round_down=True)
                
                # For long exits past 4s, cross to ask (sp1) if available, otherwise bp1 + tick
                if is_exit_mode and elapsed > 4.0 and sp1 > 0:
                    target_price = sp1
                else:
                    best_buy = bp1 if bp1 > 0 else ltp
                    target_price = best_buy + tick_size
                    
                target_price = round_to_tick(target_price, tick_size, round_up=True)
                # Cap at upper collar bound (Range-Bound Protection)
                if target_price > upper_bound:
                    target_price = upper_bound
                price_moved = (target_price > current_order_price)
            else:
                ref_anchor = min(ltp, sp1) if (ltp > 0 and sp1 > 0) else (ltp if ltp > 0 else (sp1 if sp1 > 0 else initial_price))
                lower_bound = max(tick_size, round_to_tick(ref_anchor * (1.0 - effective_collar), tick_size, round_up=True))
                
                # For short exits past 4s, cross to bid (bp1) if available, otherwise sp1 - tick
                if is_exit_mode and elapsed > 4.0 and bp1 > 0:
                    target_price = bp1
                else:
                    best_sell = sp1 if sp1 > 0 else ltp
                    target_price = best_sell - tick_size
                    
                target_price = round_to_tick(target_price, tick_size, round_down=True)
                # Floor at lower collar bound (Range-Bound Protection)
                if target_price < lower_bound:
                    target_price = lower_bound
                price_moved = (target_price < current_order_price)
                
            if price_moved and target_price != current_order_price:
                # Fast path: try atomic modify_open_order first
                logger.info(f"[EXEC ENGINE] Price adjusted to {target_price} within collar. Modifying order {current_order_id}...")
                mod_res = modify_open_order(current_order_id, params, remaining_qty, target_price, is_paper)
                if mod_res.get("status") == "success":
                    current_order_price = target_price
                    logger.info(f"[EXEC ENGINE] Order {current_order_id} successfully modified to {target_price}")
                else:
                    # Slow path fallback: cancel and replace only if retries < max_retries
                    if retries < max_retries:
                        logger.info(f"[EXEC ENGINE] Modify failed ({mod_res.get('message')}). Fallback cancel-and-replace...")
                        cancel_res = cancel_order(current_order_id, is_paper)
                        cancelled_confirmed = False
                        for _ in range(10):
                            c_status = get_order_status(current_order_id, is_paper, params)
                            if c_status and c_status.get("status") in ["CANCELED", "CANCELLED", "COMPLETE"]:
                                c_filled = int(c_status.get("filled_qty", 0))
                                c_avg = float(c_status.get("avg_price", 0.0))
                                cur_sum = sum(q for q, _ in fills)
                                if c_filled > cur_sum:
                                    fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else current_order_price))
                                cancelled_confirmed = True
                                break
                            time.sleep(0.1)
                            
                        total_filled = sum(q for q, _ in fills)
                        remaining_qty = total_qty - total_filled
                        if remaining_qty <= 0:
                            break
                            
                        retries += 1
                        current_order_price = target_price
                        new_res = place_new_order(params, remaining_qty, target_price, is_paper)
                        if new_res.get("status") == "success":
                            new_order_id = new_res.get("order_id")
                            logger.info(f"[EXEC ENGINE] Replaced order: {current_order_id} -> {new_order_id} @ {target_price}")
                            current_order_id = new_order_id
                            app_state.order_mappings[current_order_id] = {
                                "parent_order_id": parent_order_id,
                                "total_qty": total_qty,
                                "is_paper": is_paper,
                                "symbol": params.symbol,
                                "exchange": params.exchange,
                                "side": params.buy_or_sell
                            }
                        else:
                            logger.error(f"[EXEC ENGINE] Replacement order failed: {new_res.get('message')}")
                            time.sleep(0.5)

    # 3. Safeguard & Cleanup
    total_filled = sum(q for q, _ in fills)
    remaining_qty = total_qty - total_filled
    user_cancelled = not app_state.chasing_orders.get(parent_order_id, False)
    
    if remaining_qty > 0:
        if is_exit_mode and not user_cancelled:
            # Intraday Exit Safeguard: Escalating to best resting quote
            live_data = get_live_data(params.exchange, params.symbol)
            bp1 = float(live_data.get('bp1', 0.0))
            sp1 = float(live_data.get('sp1', 0.0))
            ltp = float(live_data.get('lp', 0.0))
            side = params.buy_or_sell.upper()
            
            if side.startswith("S") and bp1 > 0:
                final_price = bp1
            elif side.startswith("B") and sp1 > 0:
                final_price = sp1
            else:
                final_price = ltp if ltp > 0 else current_order_price
                
            final_price = round_to_tick(final_price, tick_size, round_up=side.startswith("B"), round_down=not side.startswith("B"))
            logger.info(f"[EXEC ENGINE] Exit timeout reached. Escalating order {current_order_id} to resting quote @ {final_price}")
            modify_open_order(current_order_id, params, remaining_qty, final_price, is_paper)
            
            # Give 2.0s for resting fill
            for _ in range(20):
                time.sleep(0.1)
                c_status = get_order_status(current_order_id, is_paper, params)
                if c_status:
                    if c_status.get("status") == "COMPLETE":
                        c_avg = float(c_status.get("avg_price", 0.0))
                        cur_sum = sum(q for q, _ in fills)
                        fill_qty = total_qty - cur_sum
                        fills.append((fill_qty, c_avg if c_avg > 0 else final_price))
                        remaining_qty = 0
                        break
                    elif int(c_status.get("filled_qty", 0)) > 0:
                        c_filled = int(c_status.get("filled_qty", 0))
                        c_avg = float(c_status.get("avg_price", 0.0))
                        cur_sum = sum(q for q, _ in fills)
                        if c_filled > cur_sum:
                            fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else final_price))
                        remaining_qty = total_qty - sum(q for q, _ in fills)
                        if remaining_qty <= 0:
                            break
                            
            if remaining_qty > 0:
                logger.warning(f"[EXEC ENGINE] Exit order {parent_order_id} could not be filled. Cancelling child order...")
                cancel_order(current_order_id, is_paper)
        elif user_cancelled:
            # User explicitly requested order cancellation
            logger.info(f"[EXEC ENGINE] Cancelling active child order {current_order_id} due to user request...")
            cancel_order(current_order_id, is_paper)
            for _ in range(10):
                c_status = get_order_status(current_order_id, is_paper, params)
                if c_status and c_status.get("status") in ["CANCELED", "CANCELLED", "COMPLETE"]:
                    c_filled = int(c_status.get("filled_qty", 0))
                    c_avg = float(c_status.get("avg_price", 0.0))
                    cur_sum = sum(q for q, _ in fills)
                    if c_filled > cur_sum:
                        fills.append((c_filled - cur_sum, c_avg if c_avg > 0 else current_order_price))
                    break
                time.sleep(0.1)
        elif last_status in ["REJECTED", "REJECT"]:
            pass
        else:
            # Only cancel if exit mode
            if is_exit_mode:
                cancel_order(current_order_id, is_paper)

    # 4. Final Compile & Broadcast
    total_filled = sum(q for q, _ in fills)
    if total_filled > 0:
        weighted_avg = sum(q * p for q, p in fills) / total_filled
        weighted_avg = round(weighted_avg, 4 if params.exchange.upper() == "CDS" else 2)
        status = "COMPLETE" if total_filled == total_qty else "PARTIAL"
        
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status=status,
            avgprc=weighted_avg,
            filledqty=total_filled,
            symbol=params.symbol,
            remarks=f"Chased, filled {total_filled}/{total_qty}"
        )
    elif last_status in ["REJECTED", "REJECT"]:
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status="REJECTED",
            avgprc=0.0,
            filledqty=0,
            symbol=params.symbol,
            remarks=status_info.get("rejreason", "Order Rejected") if 'status_info' in locals() and status_info else "Order Rejected"
        )
    else:
        remarks = "Cancelled by User" if user_cancelled else ("Exit Chasing Timeout (Collar Guard)" if is_exit_mode else "Order Cancelled")
        broadcast_order_update(
            parent_order_id=parent_order_id,
            status="CANCELED",
            avgprc=0.0,
            filledqty=0,
            symbol=params.symbol,
            remarks=remarks
        )
        
    app_state.chasing_orders.pop(parent_order_id, None)

def start_execution_engine(params, is_paper: bool) -> dict:
    """Create a parent order entry and spawn the background chasing thread."""
    # Generate unique parent order ID
    parent_order_id = f"PARENT_{int(time.time())}_{math.floor(time.time() * 1000) % 1000}"
    
    # Resolve tick size
    tick_size = get_tick_size(params.exchange, params.symbol)
    
    # Calculate price based on mode if not triggering
    initial_price = params.price
    execution_mode = params.execution_mode
    slippage_tolerance = params.slippage_tolerance if params.slippage_tolerance is not None else 0.03
    
    if execution_mode not in ["Limit_Below", "Limit_Above"]:
        live_data = get_live_data(params.exchange, params.symbol)
        ltp = float(live_data.get('lp', 0.0))
        bp1 = float(live_data.get('bp1', 0.0))
        sp1 = float(live_data.get('sp1', 0.0))
        
        side = params.buy_or_sell.upper()
        
        if execution_mode in ["Aggressive_Entry", "Aggressive_Exit"]:
            if side.startswith("B"):  # BUY: Best Buy + tick, capped at Upper Boundary = max(LTP, Best Buy) * (1 + collar%)
                ref_anchor = max(ltp, bp1) if (ltp > 0 or bp1 > 0) else float(params.price or 0)
                upper_bound = round_to_tick(ref_anchor * (1.0 + slippage_tolerance), tick_size, round_down=True)
                target_px = (bp1 + tick_size) if bp1 > 0 else (ltp if ltp > 0 else float(params.price or 0))
                initial_price = min(target_px, upper_bound) if upper_bound > 0 else target_px
            else:  # SELL: Best Sell - tick, floored at Lower Boundary = min(LTP, Best Sell) * (1 - collar%)
                ref_anchor = min(ltp, sp1) if (ltp > 0 and sp1 > 0) else (ltp if ltp > 0 else (sp1 if sp1 > 0 else float(params.price or 0)))
                lower_bound = max(tick_size, round_to_tick(ref_anchor * (1.0 - slippage_tolerance), tick_size, round_up=True))
                target_px = (sp1 - tick_size) if sp1 > 0 else (ltp if ltp > 0 else float(params.price or 0))
                initial_price = max(target_px, lower_bound)
        elif execution_mode == "True_Limit_LTP":
            initial_price = ltp if ltp > 0 else float(params.price or 0)
            
        initial_price = round_to_tick(
            initial_price,
            tick_size,
            round_up=side.startswith("B"),
            round_down=not side.startswith("B")
        )
        
    ref_px = float(params.price or 0)
    side_str = params.buy_or_sell.upper()
    if side_str.startswith("B"):
        if ref_px > 0.5 and initial_price < (ref_px * 0.5):
            initial_price = ref_px
        elif initial_price <= 0.05 and ref_px > 0:
            initial_price = ref_px
    else:
        if initial_price <= 0.05 and ref_px > 0:
            initial_price = max(tick_size, ref_px)
        
    # Initialize mock paper order record if PAPER trading
    if is_paper:
        if not hasattr(app_state, 'paper_orders'):
            app_state.paper_orders = {}
        app_state.paper_orders[parent_order_id] = {
            "status": "PENDING",
            "qty": params.quantity,
            "filled_qty": 0,
            "remaining_qty": params.quantity,
            "price": initial_price,
            "avg_price": 0.0,
            "symbol": params.symbol,
            "exchange": params.exchange,
            "side": params.buy_or_sell,
            "created_at": time.time()
        }
        
    # Spawn chasing daemon thread
    t = threading.Thread(
        target=execution_thread_worker,
        args=(params, parent_order_id, initial_price, tick_size, is_paper),
        daemon=True
    )
    t.start()
    
    return {"status": "success", "order_id": parent_order_id}
