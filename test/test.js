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
        it('should set test_metric value for device test-device to 20 and serve', async () => {
            app.setMetricValue('test-device', 'test_metric', 20)
            const res = await fetch(metricsUrl)
            const body = await res.text()
            expect(body).to.contain('test_metric')
            expect(body).to.contain(' 20')
        })
    })
})