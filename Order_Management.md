# Order Management System (OMS) & Execution Architecture

This document defines the comprehensive specification of the **Order Management System (OMS)**, **In-Flight Order Modification Engine**, **Pegged Limit Collar Guards**, and **Adaptive Intraday Exit Escalation** implemented across the platform.

---

## 1. System Objectives & Design Principles

1. **Zero Illiquid Sweeps**: Eliminate destructive fills into wide bid-ask spreads (e.g. executing at `13.55` Ask when LTP is `7.00` and Best Buy is `8.25`).
2. **Atomic Price Modification**: Use in-flight `modify_order` rather than `cancel-and-replace` loops, reducing adjustment latency from ~350ms to ~50ms and preserving exchange FIFO matching queue priority.
3. **Guaranteed Intraday Exits without Panic Losses**: Intraday positions must exit before market close, but without blind 10% market sweeps or rigid 3% collar abandonment.
4. **100% Parity Across All Trade Modes & Brokers**: Identical risk collars, state transitions, and safety safeguards apply equally in **REAL** mode and **PAPER** mode across **FLATTRADE**, **ZEBU**, and **UPSTOX**.
5. **Deterministic UI State Synchronization**: Eliminates optimistic ghost positions; rows display `Exiting` until verified by broker execution events (`COMPLETE`) with automatic rollback on order rejection.

---

## 2. Order Lifecycle & State Machine

```
               [ User Clicks Entry / Signal Trigger ]
                                 |
                                 v
                     [ Upper/Lower Collar Check ]
                                 |
                    +------------+------------+
             Within Collar              Exceeds Collar
                    |                         |
                    v                         v
            [ Place Pegged Limit ]       [ Order Rejected / Aborted ]
                    |
       +------------+------------+
   Filled                  Price Drifted
       |                         |
       v                         v
  [ COMPLETE ]         [ Fast-Path modify_order ]
                                 |
                    +------------+------------+
               Modify OK                 Modify Not Supported / Failed
                    |                         |
                    v                         v
           [ Updated In-Place ]        [ Confirmed Cancel-and-Replace ]
```

### Order States in UI:
- **`Inactive`**: No order submitted.
- **`Submitting`**: Order payload dispatched over REST API.
- **`Pending`**: Awaiting fills or undergoing in-flight pegging modifications.
- **`Active`**: Position open with recorded entry price (`entryAt`).
- **`Exiting`**: Exit order in flight with collar escalation.
- **`Closed`**: Position confirmed completely closed by broker WebSocket `COMPLETE` event; displays frozen P&L and strike-through.
- **`Rejected` / `Canceled`**: Clean teardown; rolls back to `Active` if position remains open.

---

## 3. Mathematical Collar Boundary Specification

To prevent aggressive orders from crossing into illiquid spreads or manipulated quotes, boundaries are computed tick-by-tick:

### 3.1 BUY Orders (Entry & Exit)
- **Reference Price**: $\text{ref} = \max(\text{LTP}, \text{Best Buy})$
- **Upper Collar Boundary**:
  $$\text{Upper Boundary} = \text{round\_to\_tick}(\text{ref} \times (1 + \text{collar\%}), \text{round\_down}=\text{True})$$
- **Aggressive Initial Order Price**:
  $$\text{Initial Price} = \min(\text{Best Buy} + \text{Tick}, \text{Upper Boundary})$$
- **Chase Invariant**: For all modification cycles, $\text{Target Price} \le \text{Upper Boundary}$.

### 3.2 SELL Orders (Entry & Exit)
- **Reference Price**: $\text{ref} = \min(\text{LTP}, \text{Best Sell})$
- **Lower Collar Boundary**:
  $$\text{Lower Boundary} = \max(\text{Tick}, \text{round\_to\_tick}(\text{ref} \times (1 - \text{collar\%}), \text{round\_up}=\text{True}))$$
- **Aggressive Initial Order Price**:
  $$\text{Initial Price} = \max(\text{Best Sell} - \text{Tick}, \text{Lower Boundary})$$
- **Chase Invariant**: For all modification cycles, $\text{Target Price} \ge \text{Lower Boundary}$.

*Default `collar%` is configurable via `#tn-exec-slippage`, defaulting to **3.0%**.*

---

## 4. Adaptive 2-Stage Intraday Exit Escalation (`Aggressive_Exit`)

When closing an active trade (either via manual **EXIT** or auto-triggers like **SL**, **Target**, or **TSL**):

| Stage | Time Elapsed | Collar Tolerance | Pricing Strategy | Objective |
| :--- | :---: | :---: | :--- | :--- |
| **Stage 1: Passive Pegging** | `0.0s - 4.0s` | Strict `collar%` (default 3%) | Best Sell - Tick (for SELL)<br>Best Buy + Tick (for BUY) | Capture favorable fills inside the spread without crossing. |
| **Stage 2: Adaptive Escalation** | `> 4.0s` | Widened up to 8% ($\min(8\%, \text{collar} \times 2)$) | Matches resting depth (`sp1` for BUY exit, `bp1` for SELL exit) | Cross the inside spread to guarantee execution before timeout. |
| **Stage 3: Timeout Safeguard** | At Timeout Expiry | Current Resting Quote | Single atomic modify to `bp1`/`sp1` with 2.0s fill confirmation | Clean teardown without destructive 10% market sweeps. |

---

## 5. Multi-Broker Implementation Details

All brokers conform to the standard interface in `brokers/base_broker.py`:

```python
class BaseBroker(ABC):
    @abstractmethod
    def place_order(self, buy_or_sell, exchange, tradingsymbol, quantity, price_type, price, trigger_price=None, product_type=None): ...
    @abstractmethod
    def cancel_order(self, order_id): ...
    def modify_order(self, order_id, exchange, tradingsymbol, new_quantity, new_price_type, new_price, trigger_price=None): ...
```

### Broker Implementation Matrix:

| Feature | **Flattrade** (`FlattradeBroker`) | **Zebu** (`ZebuBroker`) | **Upstox** (`UpstoxBroker`) | **Paper Trading** (`paper_orders`) |
| :--- | :---: | :---: | :---: | :---: |
| **Native Order Placement** | `PlaceOrder` REST | `placeOrder` REST | `POST /order/place` | Virtual Order Queue |
| **Native In-Flight Modification** | `ModifyOrder` REST | `modifyOrder` REST | `PUT /order/modify` | In-memory atomic update |
| **Cancellation** | `CancelOrder` REST | `cancelOrder` REST | `DELETE /order/cancel` | Status set to `CANCELED` |
| **Real-Time Fills** | WebSocket `ORDER_UPDATE` | WebSocket `ORDER_UPDATE` | WebSocket / REST Polling | Depth Crossing Simulation |
| **Queue Priority Preservation** | Yes | Yes | Yes | N/A |

---

## 6. Real vs. Paper Trading Guarantee

1. **Exact Code Path**: The execution loop in `brokers/execution_engine.py` runs the identical chasing, collar recalculation, and adaptive escalation logic regardless of `is_paper`.
2. **Paper Simulation Depth**: Paper trading does not give unrealistic instantaneous fills; it validates fills against `live_data.lp`, `sp1`, and `bp1`.
3. **Zero Risk Drift**: Moving from Paper to Real introduces no algorithmic divergence.

---

## 7. Exit Order In-Flight Guard & Infinite Loop Safeguard

### 7.1 The Mechanism
When a stop-loss, trailing SL, target, or manual exit is hit:
1. `evaluateTradeExit` and `evaluateTerminalExit` monitor ticks continuously (multiple times per second).
2. Prior to submitting the exit order, the row status is immediately shifted to `Exiting`.
3. Strict guards are enforced:
   - `evaluateTradeExit`: `if (item.status !== 'Active') return;`
   - `exitTrade`: `if (!item || item.status === 'Closed' || item.status === 'Exiting') return;`
   - `exitTerminalTrade`: `if (!item || item.status === 'Closed' || item.status === 'Exiting') return;`
4. This ensures that while an exit order (`PARENT_...`) is actively chasing fills in the background, incoming WebSocket ticks cannot re-evaluate exit thresholds or trigger duplicate exit orders.
5. In Paper Mode and across all brokers, multi-key quote resolution (`get_live_data`) guarantees that paper orders fill against live market quotes without timing out into infinite retry loops.

---

## 8. Entry vs. Exit Execution Lifecycle & Strict Tick-Size Conformance

### 8.1 Entry Orders: Range-Bound Only (No Timeout Cancellation)
- **Zero Time-Bound Cutoffs**: Entry orders (`Aggressive_Entry`, `Limit_Below`, `Limit_Above`, `True_Limit_LTP`) are **never cancelled due to elapsed time**.
- **Range-Bound Collar Enforcement**:
  - The order dynamically tracks inside liquidity up to the collar ceiling/floor ($\text{ref} \times (1 \pm \text{collar\%})$).
  - If the market runs away beyond the collar boundary, the order **rests passively at the collar limit** in the exchange order book rather than cancelling.
  - The order remains active until filled by market pullbacks, rejected by the exchange, or explicitly cancelled by the user via the UI.

### 8.2 Exit Orders: Guaranteed Square-Off
- Unlike entries, intraday exits (`Aggressive_Exit`) must close out to eliminate overnight risk.
- Retains the 10.0s adaptive escalation:
  - 0.0s - 4.0s: Inside spread pegging.
  - \> 4.0s: Collar widening up to 8% to match order book depth.
  - Timeout expiry: Escalation to resting quote (`bp1`/`sp1`) with 2.0s fill confirmation.

### 8.3 Strict Tick-Size Conformance (0.05 Paise Minimum)
- Indian derivatives and cash markets (NFO, NSE, BSE, MCX) mandate tick sizes in multiples of **0.05** (5 paise). Currency derivatives (CDS) trade in **0.0025** ticks.
- Erroneous `0.01` tick entries from broker CSV master files are strictly sanitized across:
  1. **Master CSV Files**: Sanitized `Instrument/*.csv` so contracts (e.g., `ONGC`, `PNB`) specify `TickSize = 0.05`.
  2. **Memory Symbol Loader (`main.py`)**: Automatic clamp: non-CDS tick sizes are enforced to $\ge 0.05$.
  3. **Execution Engine (`brokers/execution_engine.py`)**: `get_tick_size` and `round_to_tick` enforce mathematical precision.
  4. **Frontend UI (`static/app.js`)**: Real-time entry/exit price calculations strictly round to 0.05 tick boundaries.
