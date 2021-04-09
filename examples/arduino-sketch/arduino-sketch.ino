/*

*/

#define BAUD_RATE 9600
#define VMON_PIN A2

float vmain = 0;

void setup() {
  Serial.begin(BAUD_RATE);
  pinMode(VMON_PIN, INPUT);
}

void loop() {
  delay(1000);
  readVoltage();
  sendMetric("voltage{circuit='main'}", vmain);
}

void readVoltage() {
  vmain = (analogRead(VMON_PIN) * (5.0 / 1024.0)) / 0.193;
}

void sendMetric(char metricStr[], float value) {
  Serial.write(0x02);
  Serial.write(metricStr);
  Serial.write(0x20);
  Serial.print(value);
  Serial.write(0x0a);
}