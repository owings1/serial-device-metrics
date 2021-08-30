/**
 * serial-device-metrics
 *
 * Copyright (c) 2021 Doug Owings
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const {objects: {update}} = require('@quale/core')
const {Logger, merging: {merge}} = require('@quale/term')
const fs    = require('fs').promises
const http  = require('http')
const path  = require('path')
const prom  = require('prom-client')
const YAML  = require('yaml')

const {resolve} = path

const Delimiter   = require('@serialport/parser-delimiter')
const MockBinding = require('@serialport/binding-mock')
const SerPortFull = require('serialport')
const SerPortMock = require('@serialport/stream')

const Defaults = {
    config: {
        collectDefaultMetrics: false,
        metrics : {},
        labels  : {},
        devices : {},
        pushgateway: {
            jobName      : 'push',
            pushInterval : 60000,
            request      : {},
        },
    },
    metric: {
        labelNames : [],
        timestamp  : {
            milliseconds: false,
        },
    },
    device: {
        type     : 'serial',
        baudRate : 9600,
        labels   : {},
        parser   : {
            recordStart : 0x02,
            valueStart  : 0x20,
            recordEnd   : 0x0a,
        },
    },
}

function loggerPrefix(level) {
    return [
        new Date().toISOString(),
        `[${this.name}]`,
        `[${this.chalks[level].prefix(level.toUpperCase())}]`,
    ]
}

class App {

    static defaults(env) {
        env = env || process.env
        const configFile = resolve(env.CONFIG_FILE || 'config.yaml')
        return {
            configFile,
            port : +env.HTTP_PORT || 8080,
            mock : !!env.MOCK,
        }
    }

    constructor(opts, env) {
        env = env || process.env
        this.opts = merge(App.defaults(env), opts)
        this.logger = new Logger({
            name: this.constructor.name,
            prefix: loggerPrefix,
        })
        this.httpServer = this.createServer((req, res) => this.serve(req, res))
        this.registry = new prom.Registry
    }

    get logLevel() {
        return this.logger.logLevel
    }

    set logLevel(n) {
        this.logger.logLevel = n
    }

    async start() {

        await this.loadConfig()

        if (this.config.collectDefaultMetrics) {
            prom.collectDefaultMetrics({register: this.registry})
        }

        if (this.config.pushgateway.url) {
            const pushgateway = this.config.pushgateway
            this.gateway = new prom.Pushgateway(pushgateway.url, pushgateway.request, this.registry)
            const pushIntervalMs = Math.max(100, +pushgateway.pushInterval || 0)
            this.logger.info('Pushing to', pushgateway.url, 'every', pushIntervalMs, 'ms')
            this.pushInterval = setInterval(() => {
                this.push().catch(err => this.logger.error(err))
            }, pushIntervalMs)
        }

        for (const deviceName in this.devices) {
            await new Promise((resolve, reject) => {
                const name = deviceName
                const device = this.devices[name]
                const parser = this.parsers[name]
                this.logger.info('Opening device', name)
                device.open(err => {
                    if (err) {
                        reject(err)
                        return
                    }
                    device.pipe(parser)
                    parser.on('data', data => {
                        try {
                            const res = this.readDeviceData(name, data)
                            if (res) {
                                this.setMetricValue(name, res.metricName, res.value, res.labels)
                            }
                        } catch (err) {
                            this.logger.error(err)
                        }
                    })
                    resolve()
                })
            })
        }

        this.httpServer.listen(this.opts.port)
        this.logger.info('Listening on', this.httpServer.address())
    }

    async close() {
        clearInterval(this.pushInterval)
        this.httpServer.close()
        for (const deviceName in this.devices) {
            this.devices[deviceName].close()
        }
        this.registry.clear()
    }

    createServer(handler) {
        return http.createServer((req, res) => {
            try {
                handler(req, res)
            } catch (err) {
                res.writeHead(500).end('500 Internal Error')
                this.logger.error(err)
            }
        })
    }

    serve(req, res) {
        if (req.url === '/ready') {
            res.writeHead(200).end('OK Ready')
            return
        }
        res.setHeader('Content-Type', this.registry.contentType)
        this.registry.metrics().then(metrics => res.writeHead(200).end(metrics))
    }

    readDeviceData(deviceName, data) {

        const parser = this.config.devices[deviceName].parser

        if (data.indexOf(parser.recordStart) !== 0) {
            throw new ParseError('Invalid start character')
        }

        const valueStartPos = data.indexOf(parser.valueStart)

        if (valueStartPos < 0) {
            throw new ParseError('Missing value start character 0x' + parser.valueStart.toString(16))
        }

        const metricStr = data.slice(1, valueStartPos).toString('utf-8').trim()
        const {metricName, labels} = App.parseLabels(metricStr)

        if (!this.metrics[metricName]) {
            this.logger.warn('Skipping unregistered metric', metricName)
            return
        }

        const valueStr = data.slice(valueStartPos + 1).toString('utf-8').trim()
        const value = parseFloat(valueStr)
        
        if (isNaN(value)) {
            throw new ParseError('Cannot parse number', valueStr)
        }

        return {deviceName, metricName, value, labels}
    }

    setMetricValue(deviceName, metricName, value, labels) {
        labels = this.buildLabels(deviceName, metricName, labels)
        this.metrics[metricName].labels(labels).set(value)
        this.lastValues[deviceName][metricName] = {value, labels}
        const ts = this.config.metrics[metricName].timestamp
        if (ts.name) {
            let tsValue = +new Date
            if (!ts.milliseconds) {
                tsValue = Math.floor(tsValue / 1000)
            }
            this.metrics[ts.name].labels(labels).set(tsValue)
            this.lastValues[deviceName][ts.name] = {value: tsValue, labels}
        }
    }

    push() {
        return new Promise((resolve, reject) => {
            const {jobName} = this.config.pushgateway
            this.gateway.push({jobName}, (err, res, body) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(res, body)
                }
            })
        })
    }

    getLastValue(deviceName, metricName) {
        return this.lastValues[deviceName][metricName]
    }

    buildLabels(deviceName, metricName, labels) {

        const registeredLabels = {}
        for (const labelName of this.config.metrics[metricName].labelNames) {
            if (labelName in labels) {
                registeredLabels[labelName] = labels[labelName]
            }
        }

        return merge(
            registeredLabels,
            {device: deviceName},
            this.config.labels,
            this.config.metrics[metricName].labels,
            this.config.devices[deviceName].labels
        )
    }

    async loadConfig() {
        const loaded = await App.readYamlFile(this.opts.configFile)
        this.config = merge(Defaults.config, loaded)
        this.devices = {}
        this.parsers = {}
        this.lastValues = {}
        const deviceLabels = {}
        for (const deviceName in this.config.devices) {
            this.config.devices[deviceName] = merge(
                Defaults.device, this.config.devices[deviceName]
            )
            const device = this.config.devices[deviceName]
            if (!device.path) {
                throw new ConfigError('Missing device path for ' + deviceName)
            }
            update(deviceLabels, device.labels)
            for (const key of ['recordStart', 'valueStart', 'recordEnd']) {
                device.parser[key] = parseInt(device.parser[key])
                if (isNaN(device.parser[key])) {
                    throw new ConfigError('Invalid integer value for ' + key)
                }
            }
            this.devices[deviceName] = this.createDevice(device)
            this.parsers[deviceName] = new Delimiter({delimiter: [device.parser.recordEnd]})
            this.lastValues[deviceName] = {}
            this.logger.info('Created device', deviceName, 'at', device.path)
        }
        this.metrics = {}
        for (const metricName in this.config.metrics) {
            this.config.metrics[metricName] = merge(
                Defaults.metric, this.config.metrics[metricName]
            )
            const metric = this.config.metrics[metricName]
            const labels = merge({device: true}, this.config.labels, metric.labels, deviceLabels)
            for (const labelName of metric.labelNames) {
                labels[labelName] = true
            }
            const labelNames = Object.keys(labels)
            this.metrics[metricName] = new prom.Gauge({
                name       : metricName,
                help       : metric.help,
                registers  : [this.registry],
                labelNames
            })
            if (metric.timestamp.name) {
                if (this.metrics[metric.timestamp.name]) {
                    throw new ConfigError('Duplicate name for timestamp metric ' + metric.timestamp.name)
                }
                this.metrics[metric.timestamp.name] = new prom.Gauge({
                    name      : metric.timestamp.name,
                    help      : metric.timestamp.help || (metric.help + ' last read timestamp'),
                    registers : [this.registry],
                    labelNames,
                })
            }
        }
    }

    createDevice(device) {
        let SerialPort = SerPortFull
        if (this.opts.mock) {
            SerPortMock.Binding = MockBinding
            SerialPort = SerPortMock
            MockBinding.createPort(device.path, {echo: true, readyData: []})
        }
        return new SerialPort(device.path, {baudRate: device.baudRate, autoOpen: false})
    }

    static async readYamlFile(file) {
        const handle = await fs.open(file)
        try {
            return YAML.parse(await handle.readFile('utf-8'))
        } finally {
            handle.close()
        }
    }

    static parseLabels(input) {

        const res = {labels: {}}

        const openIdx = input.indexOf('{')

        if (openIdx < 0) {
            res.metricName = input.trim()
            return res
        }

        if (input[input.length - 1] != '}') {
            throw new ParseError('Unterminated label expression')
        }

        res.metricName = input.substring(0, openIdx).trim()
        res.labelsStr = input.substring(openIdx + 1, input.length - 1)

        let str = res.labelsStr

        while (str.length) {

            const eqIdx = str.indexOf('=')

            if (eqIdx < 1) {
                throw new ParseError('Missing or unexpected = in label expression')
            }

            const labelName = str.substring(0, eqIdx).trim()
            str = str.substring(eqIdx + 1).trim()

            var quoteChar = str[0]
            if (quoteChar !== '"' && quoteChar !== "'") {
                throw new ParseError('Missing open quote for label value')
            }
            str = str.substring(1)

            let value = ''
            let valueEndIdx = 0
            while (str[valueEndIdx] !== quoteChar) {

                if (valueEndIdx > str.length - 1) {
                    throw new ParseError('Missing close quote for label value')
                }

                if (str[valueEndIdx] === '\\') {
                    valueEndIdx += 1
                }

                value += str[valueEndIdx]
                valueEndIdx += 1
            }

            res.labels[labelName] = value
            str = str.substring(valueEndIdx + 1).trim()

            if (str[0] === ',') {
                str = str.substring(1).trim()
            }
        }

        return res
    }
}

class BaseError extends Error {
    constructor(...args) {
        super(...args)
        this.name = this.constructor.name
    }
}

class ConfigError extends BaseError {}
class ParseError extends BaseError {}

module.exports = App