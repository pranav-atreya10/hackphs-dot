// SkySentry tower alert box for the Arduino UNO Q.
//
// Breadboard wiring (UNO Q pins are 3.3 V; only the servo uses the 5V pin):
//   LED     pin 13 -> 220 ohm resistor -> LED long leg; LED short leg -> GND
//   Buzzer  + leg -> pin 9; other leg -> GND
//   Button  across the breadboard gap; one leg -> pin 7, diagonal leg -> GND
//   Servo   orange -> pin 3, red -> 5V, brown -> GND
// The board's built-in RGB LED (LED3) shows the risk colour too, so this works with nothing wired.
//
// Messages over the UNO Q monitor (Serial is routed through the board's Linux side by RouterBridge):
//   receives  'G' green, 'Y' yellow, 'R' red, 'T' test
//   sends     'A' when the button is pressed (alarm acknowledged), 'K' once when ready

#include <Arduino_RouterBridge.h>
#include <Servo.h>

const int LED_PIN = 13, BUZZ_PIN = 9, BTN_PIN = 7, SERVO_PIN = 3;
const int FLAG_DOWN = 10, FLAG_HALF = 60, FLAG_UP = 120;   // servo angles; adjust to your flag

Servo flag;
char risk = 'G';
bool silenced = false, ledOn = false;
unsigned long lastBlink = 0, lastBeep = 0, lastPress = 0;

void rgb(bool r, bool g, bool b) {          // built-in LED3; the core handles its active-low wiring
  digitalWrite(LED3_R, r ? HIGH : LOW);
  digitalWrite(LED3_G, g ? HIGH : LOW);
  digitalWrite(LED3_B, b ? HIGH : LOW);
}

void showColour(bool on) {
  if (!on) { rgb(false, false, false); return; }
  if (risk == 'G') rgb(false, true, false);
  if (risk == 'Y') rgb(true, true, false);
  if (risk == 'R') rgb(true, false, false);
}

void led(bool on) { digitalWrite(LED_PIN, on ? HIGH : LOW); showColour(on); ledOn = on; }

void setRisk(char r) {
  if (r == risk) return;
  risk = r;
  silenced = false;
  if (r == 'G') { flag.write(FLAG_DOWN); noTone(BUZZ_PIN); }
  if (r == 'Y') { flag.write(FLAG_HALF); tone(BUZZ_PIN, 1800, 120); }
  if (r == 'R') { flag.write(FLAG_UP); }
  Monitor.print("risk "); Monitor.println(r);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(LED3_R, OUTPUT); pinMode(LED3_G, OUTPUT); pinMode(LED3_B, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  flag.attach(SERVO_PIN);
  flag.write(FLAG_DOWN);

  Bridge.begin();
  Monitor.begin(115200);

  // Startup check: flag sweeps, LED flashes blue, two chirps.
  digitalWrite(LED_PIN, HIGH); rgb(false, false, true); flag.write(FLAG_UP);
  tone(BUZZ_PIN, 1500, 100); delay(250); tone(BUZZ_PIN, 2200, 100); delay(400);
  flag.write(FLAG_DOWN); led(false);
  Monitor.println("K SkySentry alert box ready. Type G, Y or R.");
}

void loop() {
  unsigned long now = millis();

  while (Monitor.available()) {
    char c = toupper(Monitor.read());
    if (c == 'G' || c == 'Y' || c == 'R') setRisk(c);
    if (c == 'T') { tone(BUZZ_PIN, 2000, 200); flag.write(FLAG_UP); delay(400); flag.write(risk == 'R' ? FLAG_UP : risk == 'Y' ? FLAG_HALF : FLAG_DOWN); }
  }

  // Button: silence the alarm and tell the tower it was acknowledged (debounced).
  if (digitalRead(BTN_PIN) == LOW && now - lastPress > 400) {
    lastPress = now;
    silenced = true;
    noTone(BUZZ_PIN);
    Monitor.println("A");
  }

  // Light pattern per risk level: green slow blink, yellow steady, red fast blink.
  if (risk == 'G' && now - lastBlink > (ledOn ? 80UL : 2000UL)) { led(!ledOn); lastBlink = now; }
  if (risk == 'Y' && !ledOn) led(true);
  if (risk == 'R' && now - lastBlink > 120) { led(!ledOn); lastBlink = now; }

  // Red alarm: two-tone beeping until the button is pressed or the risk drops.
  if (risk == 'R' && !silenced && now - lastBeep > 500) {
    tone(BUZZ_PIN, (now / 500) % 2 ? 2400 : 1800, 300);
    lastBeep = now;
  }
}
