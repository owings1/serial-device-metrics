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
const fs  = require('fs')
const App = require('./src/app.js')

async function main(args) {

    const app = {logger} = new App()

    const inits = args[0] ? JSON.parse(fs.readFileSync(args[0], 'utf-8')) : []

    process.on('SIGINT', () => {
        logger.log('SIGINT: Shutting down')
        try {
            app.close()
        } catch (e) {
            app.error(e)
        }
    })

    await app.start()

    for (const init of inits) {
        if (init.delay) {
            await new Promise(resolve => setTimeout(resolve, init.delay))
        }
        logger.log('Executing', init)
        await app.setMetricValue(init.deviceName, init.metricName, init.value, init.labels)
    }
}

if (require.main === module) {
    main(process.argv.slice(2))
}