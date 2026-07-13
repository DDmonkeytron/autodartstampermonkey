# Wiring guide

Every connection, the connector/clip used for it, and per-component detail.

## Connectors & clips used

| Connector / clip | Where | Purpose |
|---|---|---|
| **Barrel → screw-terminal adapter** (5.5×2.5 mm female) | PSU output | turns the PSU barrel plug into `+` / `−` screw terminals |
| **WAGO 221 5-way** (221-415) ×2 | power hubs | one for **+5 V**, one for **GND** — split PSU power to all devices |
| **WAGO 221 2-way** (221-412) | joins/extensions | join an extension wire to a device lead; the strip **data** line |
| **RUNCCI 3-pin solderless** (10 mm, WS2812B) | each strip's **DIN** end | breaks a strip end into 3 wires: +5V / data / GND |
| **18 AWG silicone** (red/black) | power runs | PSU → WAGO → devices |
| **22 AWG silicone** (any colour) | data runs | ESP32 GPIO → strip DIN |
| **HUB75 16-pin IDC ribbon** (from panel) | panel data | stripped at one end → screw terminals |
| **Panel power harness** (from panel) | panel power | 4-pin (5V/5V/GND/GND) → red/black wires → WAGOs |

> Rule everywhere: **ESP32 = data + shared ground only. All LED power is PSU → WAGO.** Common ground mandatory.

---

## Component 1 — PSU (COOLM 5 V 15 A)

```
 [PSU] --barrel plug 5.5x2.5-->  [barrel->screw adapter]
                                    (+) --18AWG red--> +5V WAGO (hub)
                                    (-) --18AWG black-> GND WAGO (hub)
```
- Verify polarity with a multimeter **before** connecting anything (`+` = +5 V).

## Component 2 — Power distribution (the two WAGO hubs)

```
 +5V WAGO (221-415, 5-way)          GND WAGO (221-415, 5-way)
   1 <- PSU +5V   (in)                1 <- PSU GND    (in)
   2 -> Matrix +5V                    2 -> Matrix GND
   3 -> Strip 1 +5V                   3 -> Strip 1 GND
   4 -> Strip 2 +5V                   4 -> Strip 2 GND
   5 -> (spare)                       5 -> ESP32 GND  (common ground!)
```
- Reach far devices with an **18 AWG extension** joined to the device lead by a **2-way WAGO (221-412)**.
- Keep 5 V runs short; if a run is long/high-current, use 16 AWG or inject at the far end.

## Component 3 — ESP32-S3 + terminal adapter (MRD076A)

- **Power**: USB-C (logic only). **GND**: one adapter `GND` terminal → GND WAGO.
- **HUB75 data** (top row) — from the stripped ribbon:

| HUB75 | GPIO | HUB75 | GPIO |
|---|---|---|---|
| R1 | 4 | A | 18 |
| G1 | 5 | B | 8 |
| B1 | 6 | C | 9 |
| R2 | 7 | D | 10 |
| G2 | 15 | E | 11 |
| B2 | 16 | CLK | 12 |
|    |    | LAT | 13 |
|    |    | OE | 14 |

- **Strip data**: Strip 1 DIN → **IO17**, Strip 2 DIN → **IO21** (22 AWG, via a 2-way WAGO if extended).
- Ribbon **GND** wires (pins 4 & 16) → GND WAGO.

## Component 4 — HUB75 64×64 panel

```
 [panel power 4-pin: 5V 5V GND GND] --harness--> +5V WAGO / GND WAGO
 [panel HUB75 IDC 16-pin] --ribbon (stripe=pin1)--> stripped end --> adapter top-row terminals (table above)
```
- Feed the ribbon into the panel's **INPUT** header (follow the arrow), not the output.
- Panel 5 V is ~4 A — from the PSU, never the ESP32.

## Component 5 — WS2812 strips (×2)

```
 Strip DIN end -> [RUNCCI 3-pin solderless] -> 3 wires:
        RED   (+5V)  --18AWG--> +5V WAGO   (via 2-way WAGO if extended)
        GREEN (data) --22AWG--> ESP32 IO17 / IO21  (via 2-way WAGO)
        BLACK (GND)  --18AWG--> GND WAGO
```
- Fit the connector on the **DIN** (arrow-in) end. Cut on the copper pad line; seat all 3 pads.
- One 5 m reel cut into two segments = your two strips.

---

## Full system

```
                         ┌──────────────── 5V / GND rails (WAGO hubs) ────────────────┐
                         │                                                            │
 [COOLM 5V 15A PSU]      │  +5V WAGO (221-415) ── red 18AWG ──► Matrix +5V             │
     │ barrel 5.5x2.5    │        │                        └─► Strip1 +5V (2-way WAGO) │
     ▼                   │        └────────────────────────► Strip2 +5V (2-way WAGO)   │
 [barrel→screw] ─(+)─────┘  GND WAGO (221-415) ─ black 18AWG ─► Matrix GND             │
                └─(−)─────►        │                        ├─► Strip1/Strip2 GND       │
                                   └────────────────────────┴─► ESP32 GND (common)      │
                                                                                        │
 [USB-C 5V] ──► ESP32-S3 (MRD076A adapter)                                              │
                   │  top-row terminals ◄── HUB75 ribbon (16-pin, stripe=pin1) ── [64×64 PANEL]
                   │  IO17 ─ 22AWG data ─► [RUNCCI 3-pin] ─► Strip 1 DIN                 │
                   │  IO21 ─ 22AWG data ─► [RUNCCI 3-pin] ─► Strip 2 DIN                 │
                   └  GND  ──────────────────────────────────────────────────────────► GND WAGO

 Legend:  red = +5V   black = GND   green = data   ▮ WAGO = lever clip   [ ] = connector/adapter
```

### Wire-gauge summary

| Run | Gauge | Connector at each end |
|---|---|---|
| PSU → WAGO hubs | 18 AWG | barrel→screw adapter → WAGO 5-way |
| WAGO → matrix / strips (+5V, GND) | 18 AWG | WAGO 5-way → 2-way WAGO → device lead |
| ESP32 GPIO → strip DIN | 22 AWG | screw terminal → 2-way WAGO → RUNCCI 3-pin |
| Panel data | ribbon (28 AWG) | IDC → stripped → screw terminals |
