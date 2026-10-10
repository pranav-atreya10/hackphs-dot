// SkySentry tower beacon for the Arduino UNO Q.
// Speaks Vivan's beacon protocol (VIVAN/detection/adapters/beacon.js), so the tower page's
// "Connect Arduino beacon" button and the camera station can drive it. Single letters G / Y / R / T
// still work for quick tests from the serial monitor.
//
// Protocol, laptop -> board, one line per update:
//   B <seq> <G|Y|R> <N|B|D|U> <count> <eta_s|-1> <servo_deg|-1> <flap_dHz|-1>
//   e.g. "B 42 R B 6 9 63 38" = red, flock of 6 birds, 9 s out, point at 63 deg, 3.8 Hz
// Board -> laptop: "READY beacon v1 unoq" at boot, "OK <seq>" per good line, "ERR <reason>", "ACK" on button.
//
// Wiring (same breadboard as skysentry_alert_unoq; UNO Q pins are 3.3 V, only the servo uses 5V):
//   pin 13 -> 220 ohm -> LED long leg; short leg -> GND        status LED
//   pin 9  -> buzzer signal (module I/O, or + leg of a piezo); module VCC -> 3.3V; GND -> GND
//   pin 7  -> button -> GND (diagonal legs, across the breadboard gap)
//   pin 3  -> servo signal (orange); servo red -> 5V; brown -> GND
// The built-in RGB LED shows the risk colour too.
//
// Behaviour (matches Vivan's Uno beacon):
//   green steady = clear; yellow blink = birds/unknown in view; red flash = flock, short ETA or drone
//   (drone = red/yellow alternating on the RGB LED)
//   buzzer in RED beeps faster as the ETA shrinks; two-tone for drones; button silences until things change
//   servo points at the primary threat (90 = straight ahead), parks centred when clear
//   lamp test at power-up; no message for 3 s = "offline" chase pattern, never a frozen green

#include <Arduino_RouterBridge.h>
#include <Servo.h>

const int LED_PIN = 13, BUZZ_PIN = 9, BTN_PIN = 7, SERVO_PIN = 3;
const unsigned long WATCHDOG_MS = 3000;

Servo pointer;
struct Frame { char level = 'G'; char kind = 'N'; int count = 0; int eta = -1; int servo = -1; int flap = -1; } f;
bool silenced = false, online = false, manual = false;
unsigned long lastMsg = 0, lastBeep = 0, lastPress = 0;
int servoNow = 90;
char line[64]; int lineLen = 0;

void rgb(bool r, bool g, bool b) { digitalWrite(LED3_R, r); digitalWrite(LED3_G, g); digitalWrite(LED3_B, b); }

void aim(int deg) {
  deg = constrain(deg, 0, 180);
  if (abs(deg - servoNow) >= 2) { servoNow = deg; pointer.write(deg); }   // deadband: no servo buzz
}

void apply(const Frame &n) {
  bool worse = (n.level == 'R' && f.level != 'R') || (n.level == 'Y' && f.level == 'G') || n.kind != f.kind;
  if (worse) silenced = false;                       // a new or worse threat un-silences the alarm
  if (n.level == 'Y' && f.level == 'G') tone(BUZZ_PIN, 1800, 120);
  f = n;
  aim(f.servo >= 0 ? f.servo : 90);
}

bool parseB(char *s) {                               // "B seq L K count eta servo flap"
  long seq; char L, K; int count, eta, servo, flap;
  if (sscanf(s, "B %ld %c %c %d %d %d %d", &seq, &L, &K, &count, &eta, &servo, &flap) != 7) return false;
  if (!strchr("GYR", L) || !strchr("NBDU", K)) return false;
  Frame n; n.level = L; n.kind = K; n.count = count; n.eta = eta; n.servo = servo; n.flap = flap;
  apply(n);
  Monitor.print("OK "); Monitor.println(seq);
  return true;
}

void handleLine(char *s) {
  while (*s == ' ') s++;
  if (!*s) return;
  lastMsg = millis(); online = true;
  if (s[0] == 'B' && s[1] == ' ') { manual = false; if (!parseB(s)) Monitor.println("ERR bad line"); return; }
  char c = toupper(s[0]);
  if (s[1] == 0 && strchr("GYR", c)) {               // quick test: single letter
    manual = true;
    Frame n; n.level = c; n.kind = c == 'G' ? 'N' : 'B'; n.count = c == 'R' ? 6 : c == 'Y' ? 2 : 0; n.eta = c == 'R' ? 8 : -1;
    n.servo = c == 'G' ? -1 : 60;
    apply(n); Monitor.print("OK "); Monitor.println(c); return;
  }
  if (c == 'T' && s[1] == 0) { tone(BUZZ_PIN, 2000, 200); aim(150); delay(300); aim(30); delay(300); aim(f.servo >= 0 ? f.servo : 90); return; }
  Monitor.println("ERR unknown command");
}

void lampTest() {
  rgb(1, 0, 0); digitalWrite(LED_PIN, HIGH); aim(30);  tone(BUZZ_PIN, 1500, 90); delay(250);
  rgb(1, 1, 0);                              aim(150); tone(BUZZ_PIN, 1900, 90); delay(250);
  rgb(0, 1, 0);                              aim(90);  tone(BUZZ_PIN, 2300, 90); delay(250);
  rgb(0, 0, 0); digitalWrite(LED_PIN, LOW);
}

void setup() {
  pinMode(LED_PIN, OUTPUT); pinMode(LED3_R, OUTPUT); pinMode(LED3_G, OUTPUT); pinMode(LED3_B, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pointer.attach(SERVO_PIN); pointer.write(90);
  Bridge.begin();
  Monitor.begin(115200);
  lampTest();
  lastMsg = millis();
  Monitor.println("READY beacon v1 unoq");
}

void loop() {
  unsigned long now = millis();

  while (Monitor.available()) {
    char c = Monitor.read();
    if (c == '\r') continue;
    if (c == '\n') { line[lineLen] = 0; handleLine(line); lineLen = 0; }
    else if (lineLen < (int)sizeof(line) - 1) line[lineLen++] = c;
  }

  if (digitalRead(BTN_PIN) == LOW && now - lastPress > 400) {
    lastPress = now; silenced = true; noTone(BUZZ_PIN); Monitor.println("ACK");
  }

  // Link watchdog: the tower sends a heartbeat every second; manual test letters don't time out.
  if (!manual && online && now - lastMsg > WATCHDOG_MS) { online = false; tone(BUZZ_PIN, 900, 80); aim(90); }
  if (!manual && !online && lastMsg && now - lastMsg > WATCHDOG_MS) {
    int step = (now / 250) % 3;                       // chase = link lost
    rgb(step == 0, step == 1, false); digitalWrite(LED_PIN, step == 2);
    return;
  }

  // Lights
  bool blink500 = (now / 500) % 2, flash125 = (now / 125) % 2;
  if (f.level == 'G') { rgb(0, 1, 0); digitalWrite(LED_PIN, LOW); }
  if (f.level == 'Y') { rgb(blink500, blink500, 0); digitalWrite(LED_PIN, blink500); }
  if (f.level == 'R') {
    if (f.kind == 'D') rgb(1, !flash125, 0); else rgb(flash125, 0, 0);
    digitalWrite(LED_PIN, flash125);
  }

  // Red alarm: parking-sensor style, faster as the ETA shrinks; two-tone for drones.
  if (f.level == 'R' && !silenced) {
    unsigned long gap = f.eta < 0 ? 600 : constrain(map(f.eta, 0, 20, 120, 900), 120, 900);
    if (now - lastBeep > gap) {
      lastBeep = now;
      if (f.kind == 'D') tone(BUZZ_PIN, (now / gap) % 2 ? 2400 : 1600, gap / 2);
      else tone(BUZZ_PIN, 2200, min(gap / 2, 150UL));
    }
  }
}
