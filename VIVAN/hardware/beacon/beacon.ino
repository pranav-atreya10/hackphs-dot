// SkySentry tower beacon - Arduino Uno
//
// Shows the detection engine's risk on real hardware:
//   green LED steady  = clear
//   yellow LED blink  = birds / unknown object in view
//   red LED flash     = flock of 5+, short ETA, or drone (drone = red/yellow alternating)
//   buzzer            = in RED, beeps faster as the corridor ETA gets shorter (parking-sensor style);
//                       two-tone for drones. Press the ACK button to silence until things change.
//   servo arrow       = points toward the primary threat
//   16x2 LCD optional = "FLOCK 6  ETA 9s" / "BIRD 3.8Hz"
//
// Safety behaviour:
//   - Lamp test on power-up (every output runs once, like an aircraft warning panel).
//   - Link watchdog: no message for 3 s -> "offline" chase pattern + one chirp, never a frozen green.
//
// Protocol (from the laptop, see detection/adapters/beacon.js):
//   B <seq> <G|Y|R> <N|B|D|U> <count> <eta_s|-1> <servo_deg|-1> <flap_dHz|-1>\n
// Replies: "READY beacon v1" at boot, "OK <seq>" per good line, "ERR <reason>" otherwise.
//
// Wiring (Uno):
//   pin 4  -> 220R -> green LED  -> GND
//   pin 5  -> 220R -> yellow LED -> GND
//   pin 6  -> 220R -> red LED    -> GND
//   pin 8  -> passive piezo buzzer (+), other leg -> GND
//   pin 9  -> servo signal (orange/yellow); servo red -> 5V, brown/black -> GND
//            (put a 100-470uF capacitor across servo 5V/GND: servo current spikes can reset the Uno)
//   pin 2  -> push button -> GND   (ACK / silence; uses the internal pull-up)
//   LCD (optional, I2C backpack): SDA -> A4, SCL -> A5, VCC -> 5V, GND -> GND
//
// Pin choice matters on the Uno: the Servo library uses Timer1, which disables PWM on 9/10,
// and tone() uses Timer2, which disables PWM on 3/11. LEDs here only blink (no PWM needed),
// so 4/5/6 are safe, and nothing else fights over the timers.

#include <Servo.h>

#define USE_LCD 0   // set to 1 if you have a 16x2 I2C LCD and the "LiquidCrystal I2C" library installed
#if USE_LCD
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);  // try 0x3F if the screen stays blank
#endif

const uint8_t PIN_GREEN = 4;
const uint8_t PIN_YELLOW = 5;
const uint8_t PIN_RED = 6;
const uint8_t PIN_BUZZER = 8;
const uint8_t PIN_SERVO = 9;
const uint8_t PIN_ACK = 2;

const unsigned long LINK_TIMEOUT_MS = 3000;  // no message this long = offline
const unsigned long SERVO_STEP_MS = 15;      // smooth servo: 1 degree every 15 ms (~65 deg/s)
const int BEEP_MIN_MS = 120;                 // fastest beep interval (ETA ~3 s)
const int BEEP_MAX_MS = 1200;                // slowest beep interval (ETA ~30 s)
const int BEEP_MS_PER_ETA_S = 40;            // interval = ETA * 40 ms, clamped to the range above

struct Frame {
  char level;     // 'G' 'Y' 'R'
  char kind;      // 'N' 'B' 'D' 'U'
  int count;
  int eta;        // seconds, -1 = none
  int servo;      // degrees, -1 = park
  int flap;       // Hz x 10, -1 = none
};

Frame cur = {'G', 'N', 0, -1, -1, -1};
Frame ackedAt = {'G', 'N', 0, -1, -1, -1};
bool muted = false;

char buf[48];
uint8_t len = 0;
unsigned long lastMsgMs = 0;
bool linkWasUp = false;

Servo arrow;
int servoPos = 90;
unsigned long lastServoStepMs = 0;
unsigned long lastBeepMs = 0;
bool droneToneHigh = false;
unsigned long lastLcdMs = 0;

void setLamps(bool g, bool y, bool r) {
  digitalWrite(PIN_GREEN, g ? HIGH : LOW);
  digitalWrite(PIN_YELLOW, y ? HIGH : LOW);
  digitalWrite(PIN_RED, r ? HIGH : LOW);
}

void lampTest() {
  setLamps(true, false, false); tone(PIN_BUZZER, 1500, 80); delay(250);
  setLamps(false, true, false); tone(PIN_BUZZER, 2000, 80); delay(250);
  setLamps(false, false, true); tone(PIN_BUZZER, 2500, 80); delay(250);
  setLamps(false, false, false);
  arrow.write(45); delay(300);
  arrow.write(135); delay(300);
  arrow.write(90); delay(300);
  servoPos = 90;
}

void setup() {
  pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_YELLOW, OUTPUT);
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_ACK, INPUT_PULLUP);
  Serial.begin(115200);
  arrow.attach(PIN_SERVO);
#if USE_LCD
  lcd.init();
  lcd.backlight();
  lcd.print("SkySentry beacon");
#endif
  lampTest();  // the only place delay() is used: before the link starts
  Serial.println(F("READY beacon v1"));
  lastMsgMs = millis();
}

// Parse one complete line from the laptop.
void handleLine(char *line) {
  unsigned long seq;
  char level, kind;
  int count, eta, servo, flap;
  int n = sscanf(line, "B %lu %c %c %d %d %d %d", &seq, &level, &kind, &count, &eta, &servo, &flap);
  if (n != 7 || !strchr("GYR", level) || !strchr("NBDU", kind)) {
    Serial.println(F("ERR bad line"));
    return;
  }
  Frame f = {level, kind, count, eta, servo, flap};
  // The mute covers only the red episode that was acknowledged: leaving red,
  // escalating, or a different kind of threat (bird -> drone) re-arms the buzzer.
  const char *order = "GYR";
  if (f.level != 'R' || strchr(order, f.level) > strchr(order, ackedAt.level) || f.kind != ackedAt.kind) muted = false;
  cur = f;
  lastMsgMs = millis();
  Serial.print(F("OK "));
  Serial.println(seq);
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (len > 0) {
        buf[len] = 0;
        handleLine(buf);
        len = 0;
      }
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    } else {
      len = 0;  // overlong line: drop it
      Serial.println(F("ERR too long"));
    }
  }
}

void updateLamps(unsigned long now, bool linkUp) {
  if (!linkUp) {
    uint8_t step = (now / 250) % 3;  // chase pattern = offline
    setLamps(step == 0, step == 1, step == 2);
    return;
  }
  bool slow = (now / 500) % 2;   // 1 Hz blink
  bool fast = (now / 125) % 2;   // 4 Hz flash
  if (cur.level == 'G') setLamps(true, false, false);
  else if (cur.level == 'Y') setLamps(false, slow, false);
  else if (cur.kind == 'D') setLamps(false, !fast, fast);  // drone: red/yellow alternate
  else setLamps(false, false, fast);
}

void updateBuzzer(unsigned long now, bool linkUp) {
  if (!linkUp || cur.level != 'R' || muted) return;
  if (cur.kind == 'D') {
    if (now - lastBeepMs >= 220) {  // two-tone siren for drones
      tone(PIN_BUZZER, droneToneHigh ? 2600 : 1600, 180);
      droneToneHigh = !droneToneHigh;
      lastBeepMs = now;
    }
    return;
  }
  int interval = cur.eta >= 0 ? constrain(cur.eta * BEEP_MS_PER_ETA_S, BEEP_MIN_MS, BEEP_MAX_MS) : 800;
  if (now - lastBeepMs >= (unsigned long)interval) {
    tone(PIN_BUZZER, 2200, 60);
    lastBeepMs = now;
  }
}

void updateServo(unsigned long now, bool linkUp) {
  int target = (linkUp && cur.servo >= 0) ? constrain(cur.servo, 0, 180) : 90;
  if (now - lastServoStepMs < SERVO_STEP_MS || target == servoPos) return;
  servoPos += target > servoPos ? 1 : -1;  // glide, don't jump: smoother and gentler on power
  arrow.write(servoPos);
  lastServoStepMs = now;
}

void updateAck() {
  if (digitalRead(PIN_ACK) == LOW && !muted && cur.level == 'R') {
    muted = true;
    ackedAt = cur;
    noTone(PIN_BUZZER);
  }
}

#if USE_LCD
void updateLcd(unsigned long now, bool linkUp) {
  if (now - lastLcdMs < 250) return;  // 4 Hz is plenty and keeps I2C traffic low
  lastLcdMs = now;
  char l1[17], l2[17];
  if (!linkUp) {
    snprintf(l1, sizeof(l1), "%-16s", "LINK LOST");
    snprintf(l2, sizeof(l2), "%-16s", "check laptop");
  } else {
    const char *what = cur.kind == 'D' ? "DRONE" : cur.kind == 'U' ? "UNKNOWN" : cur.kind == 'B' ? (cur.count > 1 ? "FLOCK" : "BIRD") : "CLEAR";
    if (cur.kind == 'B' && cur.count > 1) snprintf(l1, sizeof(l1), "%s %-2d %c", what, cur.count, cur.level);
    else snprintf(l1, sizeof(l1), "%-14s %c", what, cur.level);
    if (cur.eta >= 0) snprintf(l2, sizeof(l2), "ETA %3ds %s", cur.eta, muted ? "MUTE" : "");
    else if (cur.flap >= 0) snprintf(l2, sizeof(l2), "wing %d.%dHz", cur.flap / 10, cur.flap % 10);
    else snprintf(l2, sizeof(l2), "%-16s", " ");
  }
  lcd.setCursor(0, 0); lcd.print(l1);
  lcd.setCursor(0, 1); lcd.print(l2);
}
#endif

void loop() {
  unsigned long now = millis();
  readSerial();
  bool linkUp = now - lastMsgMs < LINK_TIMEOUT_MS;
  if (linkWasUp && !linkUp) tone(PIN_BUZZER, 900, 300);  // one chirp when the link drops
  linkWasUp = linkUp;
  updateAck();
  updateLamps(now, linkUp);
  updateBuzzer(now, linkUp);
  updateServo(now, linkUp);
#if USE_LCD
  updateLcd(now, linkUp);
#endif
}
