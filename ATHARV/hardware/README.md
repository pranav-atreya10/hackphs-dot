# SkySentry hardware for the Arduino UNO Q

Two sketches for the tower alert box (LED, buzzer, button, servo on a breadboard).

| Sketch | Use |
|---|---|
| `skysentry_beacon_unoq/` | **Main one.** Speaks Vivan's beacon protocol (`VIVAN/detection/adapters/beacon.js`), so the tower page's **Connect Arduino beacon** button can drive it. Servo points at the threat, buzzer beeps faster as the ETA shrinks, two-tone for drones, button silences, 3 s watchdog shows "offline". |
| `skysentry_alert_unoq/` | Simpler first version: single letters G / Y / R from the serial monitor. |

Vivan's `VIVAN/hardware/beacon/beacon.ino` is the same idea for a classic Arduino Uno (different pins: LEDs 4/5/6, buzzer 8, servo 9, button 2).

## Wiring (UNO Q pins are 3.3 V; only the servo uses 5V)
| Part | Arduino pin |
|---|---|
| LED (through a 220 Ω resistor, short leg to GND) | 13 |
| Buzzer module I/O (VCC to **3.3V**, GND to GND) | 9 |
| Button (diagonal legs, other side to GND) | 7 |
| Servo orange (red to 5V, brown to GND) | 3 |

The board's built-in RGB LED also shows the risk colour.

## Upload
Arduino IDE 2: board **Arduino UNO Q** (package "Arduino Q Boards"), libraries **Arduino_RouterBridge** and **Servo**, then Upload. Or:
```bash
arduino-cli compile --fqbn arduino:zephyr:unoq skysentry_beacon_unoq
arduino-cli upload  --fqbn arduino:zephyr:unoq -p <port> skysentry_beacon_unoq
```
Test from the serial monitor (115200): type `R`, `Y`, `G`, `T`, or a full line like `B 1 R B 6 9 63 38`.

## Not verified yet
On the UNO Q, the USB-C port goes to the board's Linux side, and `Serial`/`Monitor` messages are routed through it (RouterBridge). Uploading and compiling work; whether the tower page's Web Serial connection reaches the sketch through that port still needs testing with the board plugged in. If it doesn't, the fallback is a small script on the UNO Q's Linux side that reads the beacon line from the server over Wi-Fi.
