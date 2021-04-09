/*

*/

void setup() {
  Serial.begin(9600);
}

void loop() {
  delay(1000);
  sendMetric("test_metric{test_label='test_value'}", random(1000));
}

void sendMetric(char metricStr[], float value) {
  Serial.write(0x02);
  Serial.write(metricStr);
  Serial.write(0x20);
  Serial.print(value);
  Serial.write(0x0a);
}