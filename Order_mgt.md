# AI Agent Directive: Order Management & Risk Management (OMRM) Specification

> **System Prompt Directive for AI Agents:**
> When implementing, maintaining, modifying, or reviewing order routing, trade execution, and risk management systems in this codebase (or any derivative trading application), strictly adhere to the architecture, rules, and algorithms specified in this document. Do NOT deviate from these execution safeguards without explicit user instruction.

---

## 1. Core Execution Philosophy

Retail trading orders frequently suffer from two fatal pitfalls in volatile Indian F&O markets:
1. **Naive Market Orders**: Result in catastrophic slippage (often ₹0.50 to ₹3.00+ away from LTP on illiquid stock option strikes during volatile moves).
2. **Naive Static Limit Orders**: Suffer from low fill rates (~40–50%), getting left behind when the underlying market accelerates.

**Our Institutional Hybrid Solution:**
* **Never use unconstrained MARKET orders** for F&O contracts.
* **Always enforce Dynamic Pegged Limit Orders bounded by Strict Risk Collars**.
* **Entries are Range-Bound (Patient, No Time Expiration)** with one-click manual pull capability.
* **Exits are Adaptive 3-Stage Chasers (Passive Peg -> Aggressive Cross -> Hard Collar Guard Timeout)**.
* **Strict 0.05 Tick-Size Conformance** across all calculations, CSV masters, broker adapters, and UI inputs.

---

## 2. Global Invariant: Strict Tick Size Clamping (0.05 Rule)

In Indian equity and index derivatives (NSE / BSE F&O), tick sizes are strictly **0.05** (5 Paise). Submitting an order price with arbitrary decimals (e.g., `4.51`, `21.43`) results in broker rejection (`RMS:Rule: Price not multiple of tick size`).

### Algorithmic Standard
Every calculated price—before transmission to any broker API, paper trading engine, or UI display—MUST pass through tick clamping:

```python
def round_to_tick(price: float, tick_size: float = 0.05) -> float:
    """Clamps any price to the nearest valid exchange tick size."""
    if tick_size <= 0:
        tick_size = 0.05
    return round(round(float(price) / tick_size) * tick_size, 2)
```

**JavaScript (Frontend Equivalent):**
```javascript
function roundToTick(price, tick = 0.05) {
    if (!price || isNaN(price)) return 0;
    return Math.round(price / tick) * tick;
}
```

* **CSV Master Defense**: Ensure all loaded symbols (`NFO_symbols.csv`, `NSE_symbols.csv`, etc.) have their `tick_size` sanitized to `0.05`. If the broker sends `0.01` or invalid values, clamp it to `0.05` upon loading.

---

## 3. Entry Order Management Architecture

### 3.1 Range-Bound Patience (No Timeout Expiration)
* **Design Rationale**: When a trader establishes a setup, they want to buy within a defined, acceptable value range (`lower_bound` to `upper_bound`). Timing out an entry order after 10 seconds is counter-productive because price often takes minutes to test the entry zone.
* **Behavior**:
  1. Entry limit orders are placed at or inside the collar range.
  2. The entry order **remains resting** in the exchange/paper order queue indefinitely until:
     - It gets **FILLED** (full or partial).
     - The trader **manually cancels** it.
  3. **No automatic timeout cancellation** on entry orders.

### 3.2 Adverse Selection & The "Pndng/Cncl" Safeguard
* **Risk**: A resting entry order can suffer from *adverse selection*—if catastrophic news hits, the stock plunges, filling the resting buy order at the top of a downward crash.
* **UI Control Mandate**:
  - The UI action button in both `Trade Entry` and `Trade Terminal` must monitor order state in real time.
  - Whenever an order is `PENDING`, `OPEN`, or `SUBMITTED`, the action button must turn **Amber (`#f59e0b`)** and display **`Pndng/Cncl`**.
  - Clicking this button immediately triggers a cancellation API request to pull the resting order from the exchange.

---

## 4. Exit Order Management Architecture (3-Stage Adaptive Pegger)

Exiting a position requires a balance between **zero slippage** and **guaranteed fill certainty**. The exit engine uses a 3-stage adaptive algorithm bounded by a hard risk collar.

```
       0s                          4s                         10s
       |---------------------------|---------------------------|---> Abort / Alert
       [ Stage 1: Passive Peg ]    [ Stage 2: Aggressive Cross ]  [ Stage 3: Collar Guard ]
       Earn the spread (zero slip) Cross to Bid (fill certainty)  Prevent runaway loss
```

### 4.1 Risk Collar Calculation
Before triggering an exit, calculate the hard upper and lower collar boundaries:
* For a **SELL Exit** (Long position closing):
  - `Lower Bound = round_to_tick(Reference Price * (1 - Collar %))`
  *(Default Collar % is typically 1.5% to 2.5% for stock options, 1.0% for index).*
* **Absolute Invariant**: The exit engine is **strictly forbidden** from placing any sell order below `Lower Bound`.

### 4.2 Stage 1: Passive Pegging (Elapsed: 0s to 4.0s)
* **Goal**: Earn the bid-ask spread and avoid paying liquidity-taker fees/slippage.
* **Pricing Logic (SELL)**:
  - `Target Price = max(Best Ask - 0.05, Lower Bound)`
  *(If Best Ask is not available, use LTP).*
* The order is submitted as a `LIMIT` order at `Target Price`.
* If the market moves away or spread shifts, update the limit order to maintain the 1-tick lead.

### 4.3 Stage 2: Adaptive Aggressive Crossing (Elapsed: 4.0s to 10.0s)
* **Goal**: If passive placement has not filled within 4 seconds, market momentum requires aggressive crossing of the spread to guarantee exit before adverse movement worsens.
* **Pricing Logic (SELL)**:
  - `Target Price = max(Best Bid, Lower Bound)`
* Crosses the spread directly to the top available buyer, ensuring immediate execution.
* If Best Bid has fallen below `Lower Bound`, clamp `Target Price = Lower Bound`.

### 4.4 Stage 3: Collar Guard Timeout (Elapsed: > 10.0s)
* **Goal**: Protect capital from flash crashes or liquidity voids.
* **Condition**: If the order remains unfilled after 10 seconds (because the market has plunged entirely through the `Lower Bound`):
  1. **Immediately cancel** any open child/exchange orders.
  2. Mark status as `TIMEOUT` / `REJECTED_COLLAR`.
  3. Emit an audio/visual warning to the trader: *"Exit aborted: Market fell below safety collar limit."*
  4. **DO NOT blindly dump at MARKET**. Forcing a market order into a vacuum causes catastrophic balance drawdowns.

---

## 5. Order State Machine & Reconciliation Rules

To prevent duplicate ghost orders, phantom fills, or infinite cancellation loops:

### 5.1 Parent-Child Architecture
* **Parent Order (`PARENT_<ts>_<id>`)**:
  - Serves as the tracking umbrella for the trade instruction.
  - `Price`: Stores the initial anchor/trigger reference price when the user clicked the button.
  - `Avg Price`: Updated to the actual final volume-weighted fill price upon completion.
* **Child Chase Order (`PAPER_CHASE_...` or Exchange Order ID)**:
  - The live, working limit order currently placed on the order book.
  - `Price`: The dynamically pegged limit price.
  - `Avg Price`: The executed fill price.

### 5.2 Safe Revision Protocol (Cancel-Before-Replace)
* When updating a price during Stage 1 or Stage 2:
  1. Send **Cancel Request** for existing working child order.
  2. **Wait for cancellation confirmation** from broker/paper engine.
  3. Query filled quantity on the cancelled order.
  4. Update `Remaining Qty = Total Qty - Cumulative Filled Qty`.
  5. If `Remaining Qty > 0`, place new child order for `Remaining Qty` at new target price.
  6. **Never** submit a new order while the old order is still pending/unconfirmed.

### 5.3 Accurate Partial Fill Accounting (Zero-Fill Bug Prevention)
* When receiving broker updates:
  ```python
  # CORRECT:
  if order_status == "COMPLETE":
      # Ensure filled_qty is set to requested order qty, NOT appended with 0 remaining
      filled_this_step = order.quantity - order.previously_filled
      cumulative_filled += filled_this_step
  ```
* **Critical Trap to Avoid**: Never append `remaining_qty` (which becomes `0` on completion) to the filled list, as this causes the engine to falsely record `0 fills` and erroneously cancel completed trades.

---

## 6. Risk Management Directives & Guardrails

| Risk Metric | Setting / Rule | Enforcement Point |
| :--- | :--- | :--- |
| **Tick Size** | Strictly `0.05` | Pre-submission clamp in all modules |
| **Default Collar (Options)** | `2.0%` (Configurable 1.0%-5.0%) | Execution engine init |
| **Default Collar (Futures)** | `0.5%` to `1.0%` | Execution engine init |
| **Max Chaser Timeout (Exit)** | `10.0 seconds` | Background execution worker |
| **Entry Expiration** | `None` (Rests until filled or cancelled) | Entry worker / order loop |
| **UI Emergency Pull** | `Pndng/Cncl` one-click abort | Frontend UI Trade & Order tabs |
| **Runaway Market Fills** | **Forbidden** (Never route raw MARKET) | Order router adapter |

---

## 7. AI Agent Checklist for Code Changes

Before marking any order execution or risk management task complete, verify:
- [ ] Are all prices passed through `round_to_tick(price, 0.05)`?
- [ ] Are entry orders left active without 10s auto-cancellation timeouts?
- [ ] Does the exit engine execute Stage 1 (0-4s passive) and Stage 2 (4-10s aggressive)?
- [ ] Does Stage 3 stop execution without falling back to a raw market dump?
- [ ] Does the UI render the Amber `Pndng/Cncl` button when orders are resting?
- [ ] Are both codebase copies (`brokers/` and `broker/`) kept synchronized?
- [ ] Does Order Book accurately reflect Parent Reference vs Child Pegged prices?
