const { tunnel: cloudflaredTunnel } = require("cloudflared")
const cookieParser = require("cookie-parser")
const socketIO = require("socket.io")
const config = require("./config")
const express = require("express")
const tarkine = require("tarkine")
const http = require('http')

const app = express()
const server = http.createServer(app)
const io = new socketIO.Server(server)
const PORT = Number(process.env.PORT) || Number(config.port) || 3000
const isRender = Boolean(process.env.RENDER)
global.remoteURL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`

global.IO = io

app.set("view engine", "html")
app.engine("html", tarkine.renderFile)
app.use(cookieParser())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(__dirname + "/public"))
app.use(express.json())

app.use("/", require("./router"))

server.listen(PORT, async () => {
    const localURL = `http://localhost:${PORT}`

    if (!isRender) {
        try {
            const tunnel = await cloudflaredTunnel({
                "--url": localURL
            })
            global.remoteURL = tunnel.url
        } catch (error) {
            console.warn("Cloudflare tunnel not available in this environment:", error.message)
        }
    }

    console.log(`LOCAL  : ${localURL}`)
    console.log(`REMOTE : ${global.remoteURL}`)
})