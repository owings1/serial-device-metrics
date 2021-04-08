const {expect} = require('chai')
const fetch = require('node-fetch')
const fs = require('fs')
const fse = require('fs-extra')
const http = require('http')
const merge = require('merge')
const path = require('path')
const {resolve} = path
const tmp = require('tmp')
const YAML = require('yaml')

const App = require('../src/app')

const appUrl = 'http://localhost:' + (+process.env.HTTP_PORT || 8080)

function newApp(configFile, opts, env) {
    configFile = resolve(__dirname, 'configs', configFile)
    opts = merge({}, {configFile, port: null, mock:true, quiet: true}, opts)
    const app = new App(opts, env)
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

    describe('01-config.yaml', () => {

        var app
        var appUrl
        var metricsUrl

        beforeEach(async () => {
            app = newApp('01-config.yaml')
            await app.start()
            appUrl = 'http://localhost:' + app.httpServer.address().port
            metricsUrl = appUrl + '/metrics'
        })

        afterEach(async () => {
            await app.close()
        })

        it('should serve metrics', async () => {
            const res = await fetch(metricsUrl)
            const body = await res.text()
            expect(res.status).to.equal(200)
            expect(body).to.contain('process_cpu_seconds_total')
        })

        describe('#setMetricValue', () => {
            it('should set test_metric value for device test-device to 20 and serve', async () => {
                app.setMetricValue('test-device', 'test_metric', 20)
                const res = await fetch(metricsUrl)
                const body = await res.text()
                expect(body).to.contain('test_metric')
                expect(body).to.contain(' 20')
            })
        })

        describe('#readDeviceData', () => {

            it('should read test_metric=50 from buffer', () => {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const res = app.readDeviceData('test-device', data)
                expect(res.deviceName).to.equal('test-device')
                expect(res.metricName).to.equal('test_metric')
                expect(res.value).to.equal(50)
            })

            it('should fail with missing recordStart', () => {
                const data = Buffer.concat([
                    //Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should fail with missing valueStart', () => {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    //Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should fail with bad value', () => {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('blargh50'),
                    Buffer.from([0x0a])
                ])
                const err = getError(() => app.readDeviceData('test-device', data))
                expect(err.name).to.equal('ParseError')
            })

            it('should return empty for unregistered metric', () => {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric_non_existent'),
                    Buffer.from([0x20]),
                    Buffer.from('50'),
                    Buffer.from([0x0a])
                ])
                const res = app.readDeviceData('test-device', data)
                expect(!!res).to.equal(false)
            })
        })

        describe('device#write', () => {
            it('should set test_metric to 30 for test-device', async () => {
                const data = Buffer.concat([
                    Buffer.from([0x02]),
                    Buffer.from('test_metric'),
                    Buffer.from([0x20]),
                    Buffer.from('30'),
                    Buffer.from([0x0a])
                ])
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
                expect(app.getMetricValue('test-device', 'test_metric')).to.equal(30)
            })
        })
    })
})