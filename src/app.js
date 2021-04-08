const fs    = require('fs').promises
const http  = require('http')
const merge = require('merge')
const path  = require('path')
const prom  = require('prom-client')
const YAML  = require('yaml')

const {resolve} = path

const Delimiter   = require('@serialport/parser-delimiter')
const MockBinding = require('@serialport/binding-mock')
const SerPortFull = require('serialport')
const SerPortMock = require('@serialport/stream')

SerPortMock.Binding = MockBinding

const Defaults = {
    config: {
        metrics : {},
        labels  : {},
        devices : {}
    },
    device: {
        type     : 'serial',
        baudRate : 9600,
        labels   : {},
        parser   : {
            recordStart : 0x02,
            valueStart  : 0x20,
            recordEnd   : 0x0a
        }
    }
}

class App {

    static defaults(env) {
        env = env || process.env
        const configFile = resolve(env.CONFIG_FILE || 'config.yaml')
        return {
            configFile,
            port  : +env.HTTP_PORT || 8080,
            quiet : !!env.QUIET,
            mock  : !!env.MOCK
        }
    }

    constructor(opts, env) {
        env = env || process.env
        this.opts = merge({}, App.defaults(env), opts)
        this.httpServer = this.createServer((req, res) => this.serve(req, res))
        this.registry = new prom.Registry
    }

    async start() {
        prom.collectDefaultMetrics({register: this.registry})
        await this.loadConfig()
        //Object.entries(this.devices).forEach(([deviceName, device]) => {
        //    
        //})

        for (var deviceName in this.devices) {
            await new Promise((resolve, reject) => {
                const name = deviceName
                const device = this.devices[name]
                const parser = this.parsers[name]
                this.log('Opening device', name)
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
                                this.setMetricValue(name, res.metricName, res.value)
                            }
                        } catch (err) {
                            this.error(err)
                        }
                    })
                    resolve()
                })
            })
        }

        this.httpServer.listen(this.opts.port)
        this.log('Listening on', this.httpServer.address())
    }

    async close() {
        this.httpServer.close()
        for (var deviceName in this.devices) {
            //this.parsers[deviceName].close()
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
                this.error(err)
            }
        })
    }

    serve(req, res) {
        if (req.url == '/ready') {
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

        const metricName = data.slice(1, valueStartPos).toString('utf-8').trim()

        if (!this.metrics[metricName]) {
            this.log('Skipping unregistered metric', metricName)
            return
        }

        const valueStr = data.slice(valueStartPos + 1).toString('utf-8').trim()
        const value = parseFloat(valueStr)
        
        if (isNaN(value)) {
            throw new ParseError('Cannot parse number', valueStr)
        }

        return {deviceName, metricName, value}
    }

    setMetricValue(deviceName, metricName, value) {
        const labels = this.buildLabels(deviceName, metricName)
        this.metrics[metricName].labels(labels).set(value)
        this.values[deviceName][metricName] = value
    }

    getMetricValue(deviceName, metricName) {
        return this.values[deviceName][metricName]
    }

    buildLabels(deviceName, metricName) {
        return merge(
            {device: deviceName},
            this.config.labels,
            this.metrics[metricName].labels,
            this.config.devices[deviceName].labels
        )
    }

    async loadConfig() {

        this.config = merge({}, Defaults.config, await this.readYamlFile(this.opts.configFile))

        this.devices = {}
        this.parsers = {}
        this.values = {}
        const deviceLabels = {}
        for (var deviceName in this.config.devices) {
            this.config.devices[deviceName] = merge.recursive(
                {}, Defaults.device, this.config.devices[deviceName]
            )
            var device = this.config.devices[deviceName]
            if (!device.path) {
                throw new ConfigError('Missing device path for ' + deviceName)
            }
            merge(deviceLabels, device.labels)
            for (var key of ['recordStart', 'valueStart', 'recordEnd']) {
                device.parser[key] = parseInt(device.parser[key])
                if (isNaN(device.parser[key])) {
                    throw new ConfigError('Invalid integer value for ' + key)
                }
            }
            this.devices[deviceName] = this.createDevice(device)
            this.parsers[deviceName] = new Delimiter({delimiter: [device.parser.recordEnd]})
            this.values[deviceName] = {}
            this.log('Created device', deviceName, 'at', device.path)
        }

        this.metrics = {}
        for (var metricName in this.config.metrics) {
            var metric = this.config.metrics[metricName]
            var labels = merge({device: true}, this.config.labels, metric.labels, deviceLabels)
            this.metrics[metricName] = new prom.Gauge({
                name       : metricName,
                help       : metric.help,
                labelNames : Object.keys(labels),
                registers  : [this.registry]
            })
        }
    }

    createDevice(device) {
        var SerialPort = SerPortFull
        if (this.opts.mock) {
            var SerialPort = SerPortMock
            MockBinding.createPort(device.path, {echo: true, readyData: []})
        }
        return new SerialPort(device.path, {baudRate: device.baudRate, autoOpen: false})
    }

    async readYamlFile(file) {
        const handle = await fs.open(file)
        try {
            return YAML.parse(await handle.readFile('utf-8'))
        } finally {
            handle.close()
        }
    }

    log(...args) {
        if (!this.opts.quiet) {
            console.log(new Date, ...args)
        }
    }

    error(...args) {
        console.error(new Date, ...args)
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