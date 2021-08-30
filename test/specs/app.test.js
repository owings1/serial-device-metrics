const {expect} = require('chai')
const {merging: {merge}} = require('@quale/term')
const fetch = require('node-fetch')
const fs = require('fs')
const fse = require('fs-extra')
const http = require('http')
const path = require('path')
const {resolve} = path
const tmp = require('tmp')
const YAML = require('yaml')

const App = require('../../src/app.js')

function newApp(configFile, opts, env) {
    configFile = resolve(__dirname, '../fixtures/configs', configFile)
    opts = merge({configFile, port: null, mock:true}, opts)
    const app = new App(opts, env)
    app.logLevel = 1
    return app
}

function getError(cb) {
    try {
        cb()
    } catch (err) {
        return err
    }
}

describe('App', () => {

    describe('#parseLabels', () => {

        it('should parse metric name only', () => {
            const input = 'test_metric'
            const res = App.parseLabels(input)
            expect(res.metricName).to.equal('test_metric')
            expect(Object.keys(res.labels)).to.have.length((0))
        })

        it('should parse metric name and labelsStr', () => {
            const input = 'test_metric{foo="bar"}'
            const res = App.parseLabels(input)
            expect(res.metricName).to.equal('test_metric')
            expect(res.labelsStr).to.equal('foo="bar"')
        })

        it('should parse label foo="bar"', () => {
            const input = 'test_metric{foo="bar"}'
            const res = App.parseLabels(input)
            expect(res.labels.foo).to.equal('bar')
        })

        it('should throw for missing end brace', () => {
            const input = 'test_metric{foo="bar"'
            const err = getError(() => App.parseLabels(input))
            expect(err.name).to.equal('ParseError')
        })

        it('should throw for missing equals', () => {
            const input = 'test_metric{foo"bar"}'
            const err = getError(() => App.parseLabels(input))
            expect(err.name).to.equal('ParseError')
        })

        it('should throw for missing label name', () => {
            const input = 'test_metric{="bar"}'
            const err = getError(() => App.parseLabels(input))
            expect(err.name).to.equal('ParseError')
        })

        it('should throw for missing open quote', () => {
            const input = 'test_metric{foo=bar}'
            const err = getError(() => App.parseLabels(input))
            expect(err.name).to.equal('ParseError')
        })

        it('should throw for missing close quote', () => {
            const input = 'test_metric{foo="bar}'
            const err = getError(() => App.parseLabels(input))
            expect(err.name).to.equal('ParseError')
        })

        it('should parse escaped quotes', () => {
            const input = 'test_metric{foo="\\\"value\\\""}'
            const res = App.parseLabels(input)
            expect(res.labels.foo).to.equal('"value"')
        })

        it('should parse label1="value1" and label2="value2"', () => {
            const input = 'test_metric{label1="value1",label2="value2"}'
            const res = App.parseLabels(input)
            expect(res.labels.label1).to.equal('value1')
            expect(res.labels.label2).to.equal('value2')
        })

        it("should parse single quotes label1='value1' and label2='value2'", () => {
            const input = "test_metric{label1='value1',label2='value2'}"
            const res = App.parseLabels(input)
            expect(res.labels.label1).to.equal('value1')
            expect(res.labels.label2).to.equal('value2')
        })

        it('should ignore spaces', () => {
            const input = 'test_metric { label1 = "value1"  , label2  = "value2" }'
            const res = App.parseLabels(input)
            expect(res.metricName).to.equal('test_metric')
            expect(res.labels.label1).to.equal('value1')
            expect(res.labels.label2).to.equal('value2')
        })
    })

    describe('01-config.yaml', () => {

        beforeEach(async function () {
            const app = this.app = newApp('01-config.yaml')
            await app.start()
            this.appUrl = 'http://localhost:' + app.httpServer.address().port
            this.metricsUrl = this.appUrl + '/metrics'
        })

        afterEach(async function () {
            await this.app.close()
        })

        it('should serve metrics', async function () {
            const res = await fetch(this.metricsUrl)
            const body = await res.text()
            expect(res.status).to.equal(200)
            expect(body).to.contain('process_cpu_seconds_total')
        })

        describe('#setMetricValue', () => {

            it('should set test_metric value for device test-device to 20 and serve', async function () {
                this.app.setMetricValue('test-device', 'test_metric', 20)
                const res = await fetch(this.metricsUrl)
                const body = await res.text()
                expect(body).to.contain('test_metric')
                expect(body).to.contain(' 20')
            })
        })

        describe('#readDeviceData', () => {

            it('should read test_metric=50 from buffer', function () {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const res = this.app.readDeviceData('test-device', data)
                expect(res.deviceName).to.equal('test-device')
                expect(res.metricName).to.equal('test_metric')
                expect(res.value).to.equal(50)
            })

            it('should fail with missing recordStart', function () {
                const data = Buffer.concat([
                    //Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => this.app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should fail with missing valueStart', function () {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    //Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => this.app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should fail with bad value', function () {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('blargh50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => this.app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should return empty for unregistered metric', function () {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric_non_existent'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const res = this.app.readDeviceData('test-device', data)
                expect(!!res).to.equal(false)
            })
        })

        describe('device#write', () => {
            it('should set test_metric to 30 for test-device', async function () {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('30'),
                    Buffer.from([0x0a])
                ])
                await new Promise((resolve, reject) => {
                    this.app.devices['test-device'].write(data, err => {
                        if (err) {
                            reject(err)
                        } else {
                            resolve()
                        }
                    })
                })
                await new Promise(resolve => setTimeout(resolve))
                expect(this.app.getLastValue('test-device', 'test_metric').value).to.equal(30)
            })
        })
    })

    describe('02-config.yaml', () => {

        beforeEach(async function () {
            this.app = newApp('02-config.yaml')
            await this.app.start()
        })

        afterEach(async function () {
            await this.app.close()
        })

        it('should write test_metric=6 to test-device-1 and =8 to test-device-2', async function () {
            const {app} = this
            const getData = value => Buffer.concat([
                Buffer.from([0x02]),
                Buffer.from('test_metric'),
                Buffer.from([0x20]),
                Buffer.from(value.toString()),
                Buffer.from([0x0a])
            ])
            await new Promise((resolve, reject) => {
                app.devices['test-device-1'].write(getData(6), err => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve()
                    }
                })
            })
            await new Promise((resolve, reject) => {
                app.devices['test-device-2'].write(getData(8), err => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve()
                    }
                })
            })
            await new Promise(resolve => setTimeout(resolve))
            expect(app.getLastValue('test-device-1', 'test_metric').value).to.equal(6)
            expect(app.getLastValue('test-device-2', 'test_metric').value).to.equal(8)
        })
    })
    
    describe('03-config.yaml', () => {


        beforeEach(async function () {
            this.app = newApp('03-config.yaml')
            await this.app.start()
        })

        afterEach(async function () {
            await this.app.close()
        })

        function getData(metricStr, value) {
            return Buffer.concat([
                Buffer.from([0x02]),
                Buffer.from(metricStr),
                Buffer.from([0x20]),
                Buffer.from(value.toString()),
                Buffer.from([0x0a])
            ])
        }
        describe('#readDeviceData', () => {
            it('should read labels', async function () {
                const {app} = this
                const data = getData('test_metric{label_name_test="test-value"}', '50')
                const res = app.readDeviceData('test-device', data)
                expect(res.labels.label_name_test).to.equal('test-value')
            })
        })

        describe('#setMetricValue', () => {
            it('should remove unregistered label', function () {
                const {app} = this
                app.setMetricValue('test-device', 'test_metric', 80, {label_name_test: 'value', unreg_label: 'value'})
                expect(Object.keys(app.getLastValue('test-device', 'test_metric').labels)).to.not.contain('unreg_label')
            })
        })

        describe('device#write', () => {
            it('should set test_metric to 30 for test-device', async function () {
                const {app} = this
                const data = getData('test_metric{label_name_test="test-value"}', '30')
                await new Promise((resolve, reject) => {
                    app.devices['test-device'].write(data, err => {
                        if (err) {
                            reject(err)
                        } else {
                            resolve()
                        }
                    })
                })
                await new Promise(resolve => setTimeout(resolve))
                expect(app.getLastValue('test-device', 'test_metric').value).to.equal(30)
                expect(app.getLastValue('test-device', 'test_metric').labels.label_name_test).to.equal('test-value')
            })
        })
    })

    describe('04-config.yaml', () => {

        beforeEach(async function () {
            this.app = newApp('04-config.yaml')
            this.lastGateway = null
            this.mockGateway =  http.createServer((req, res) => {
                this.lastGateway = {req, res}
                res.writeHead(200).end('200 OK')
            })
            this.mockGateway.listen(9091)
            await this.app.start()
        })

        afterEach(async function () {
            this.mockGateway.close()
            await this.app.close()
        })

        it('should run for 300ms and make request to gateway', async function () {
            this.timeout(2000)
            await new Promise(resolve => setTimeout(resolve, 300))
            expect(!!this.lastGateway.req).to.equal(true)
        })

        it('should add header', async function () {
            await this.app.push()
            expect(this.lastGateway.req.headers['x-authorization']).to.equal('BHSJZkTX22TALYjB')
        })
    })

    describe('05-config.yaml', () => {

        beforeEach(async function () {
            this.app = newApp('05-config.yaml')
            await this.app.start()
        })

        afterEach(async function () {
            await this.app.close()
        })

        it('should create timestamp metric', function () {
            const {app} = this
            expect(!!app.metrics.temperature_time_seconds).to.equal(true)
        })

        it('should set timestamp metric when parent is set', function () {
            const {app} = this
            app.setMetricValue('test-device', 'temperature', 32)
            expect(app.getLastValue('test-device', 'temperature_time_seconds').value).to.be.greaterThan(+new Date / 1000 - 1000)
        })
    })
})