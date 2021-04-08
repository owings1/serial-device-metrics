const fs    = require('fs').promises
const http  = require('http')
const merge = require('merge')
const path  = require('path')
const prom  = require('prom-client')
const YAML  = require('yaml')

const {resolve} = path

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
            quiet : false,
            mock  : false
        }
    }

    constructor(opts, env) {
        env = env || process.env
        this.opts = merge({}, App.defaults(env), opts)
        this.httpServer = this.createServer((req, res) => this.serve(req, res))
    }

    async start() {
        await this.loadConfig()
        this.httpServer.listen(this.opts.port)
        this.log('Listening on', this.httpServer.address())
    }

    async close() {
        this.httpServer.close()
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

    setMetricValue(deviceName, metricName, value) {
        const labels = this.buildLabels(deviceName, metricName)
        this.metrics[metricName].labels(labels).set(value)
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
        const handle = await fs.open(this.opts.configFile)
        try {
            const conf = YAML.parse(await handle.readFile('utf-8'))
            this.config = merge({}, Defaults.config, conf)
        } finally {
            handle.close()
        }

        var deviceLabels = {}
        for (var deviceName in this.config.devices) {
            this.config.devices[deviceName] = merge.recursive(
                {}, Defaults.device, this.config.devices[deviceName]
            )
            var device = this.config.devices[deviceName]
            merge(deviceLabels, device.labels)
            for (var key of ['recordStart', 'valueStart', 'recordEnd']) {
                device.parser[key] = parseInt(device.parser[key])
                if (isNaN(device.parser[key])) {
                    throw new ConfigError('Invalid integer value for ' + key)
                }
            }
            
        }

        this.registry = new prom.Registry
        prom.collectDefaultMetrics({register: this.registry})

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

module.exports = App