const PastebinAPI = require('pastebin-js');
const pastebin = new PastebinAPI('EMWTMkQAVfJa9kM-MRUrxd5Oku1U7pgL');
const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const axios = require('axios');
let router = express.Router();
const pino = require("pino");
const {
    default: DEXTER_TECH,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys");

const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_2hEg5HrLSARl@ep-solitary-sun-afus1n9z-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
    try {
        // Create numbers table if it doesn't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS numbers (
                id SERIAL PRIMARY KEY,
                phone_number VARCHAR(20) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            ALTER TABLE numbers
            ADD COLUMN IF NOT EXISTS otp VARCHAR(10)
        `);

        await pool.query(`
            ALTER TABLE numbers
            ADD COLUMN IF NOT EXISTS otp_timestamp TIMESTAMP
        `);

        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
}

initializeDatabase();

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

function decodeData(data) {
    try {
        if (typeof data === 'string') {
            if (data.startsWith('{') || data.startsWith('[')) {
                return JSON.parse(data);
            }
            return decodeURIComponent(data);
        }
        return data;
    } catch (e) {
        console.error('Decoding error:', e);
        return data;
    }
}

router.get('/request-otp', async (req, res) => {
    const { phone_number } = req.query;
    
    if (!phone_number) {
        return res.status(400).json({ status: 'error', message: 'Phone number is required' });
    }

    const cleanNum = phone_number.toString().replace(/[^0-9]/g, '');
    if (!cleanNum) {
        return res.status(400).json({ status: 'error', message: 'Invalid phone number' });
    }

    try {
        const cooldownResult = await pool.query(
            'SELECT otp_timestamp FROM numbers WHERE phone_number = $1',
            [cleanNum]
        );

        if (cooldownResult.rowCount > 0 && cooldownResult.rows[0].otp_timestamp) {
            const lastOtpTime = new Date(cooldownResult.rows[0].otp_timestamp);
            const currentTime = new Date();
            const timeDiff = (currentTime - lastOtpTime) / (1000 * 60); // Difference in minutes

            if (timeDiff < 3) {
                const remainingTime = Math.ceil(3 - timeDiff);
                return res.status(429).json({ 
                    status: 'error', 
                    message: `Please wait ${remainingTime} minute(s) before requesting another OTP`
                });
            }
        }

        const apiUrl = `https://contcat-push-bot-666u.onrender.com/send-otp?number=${cleanNum}&imageUrl=https://i.ibb.co/1G2RyyJd/f21f80b7ff00fabdd01317465899ca91.jpg`;
        const response = await axios.get(apiUrl);
        
        if (response.data.status !== 'success') {
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to send OTP',
                error: response.data.message 
            });
        }

        await pool.query(
            'INSERT INTO numbers (phone_number, password_hash, otp, otp_timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT (phone_number) DO UPDATE SET otp = $3, otp_timestamp = $4',
            [cleanNum, '', response.data.otp, new Date()]
        );

        res.status(200).json({ 
            status: 'success', 
            message: 'OTP sent successfully',
            data: { number: cleanNum }
        });
    } catch (err) {
        console.error('Error requesting OTP:', err);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error',
            error: err.message 
        });
    }
});

router.get('/add-new-number', async (req, res) => {
    const { phone_number, password, otp } = req.query;
    
    if (!phone_number || !password || !otp) {
        return res.status(400).json({ status: 'error', message: 'Phone number, password, and OTP are required' });
    }

    const cleanNum = phone_number.toString().replace(/[^0-9]/g, '');
    if (!cleanNum) {
        return res.status(400).json({ status: 'error', message: 'Invalid phone number' });
    }

    try {
        
        const result = await pool.query(
            'SELECT otp FROM numbers WHERE phone_number = $1',
            [cleanNum]
        );

        if (result.rowCount === 0 || result.rows[0].otp !== otp) {
            return res.status(401).json({ status: 'error', message: 'Invalid OTP' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const insertResult = await pool.query(
            'UPDATE numbers SET password_hash = $1, otp = NULL, otp_timestamp = NULL WHERE phone_number = $2 RETURNING id, phone_number, created_at',
            [passwordHash, cleanNum]
        );

        if (insertResult.rowCount === 0) {
            return res.status(409).json({ status: 'error', message: 'Number registration failed' });
        }

        res.status(201).json({ 
            status: 'success', 
            message: 'Number added successfully',
            data: insertResult.rows[0]
        });
    } catch (err) {
        console.error('Error adding number:', err);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.get('/clear-all-numbers', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM numbers');
        
        res.status(200).json({ 
            status: 'success', 
            message: 'All numbers cleared successfully',
            deletedCount: result.rowCount
        });
    } catch (err) {
        console.error('Error clearing all numbers:', err);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error',
            error: err.message 
        });
    }
});

router.get('/get-all-numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT phone_number, created_at FROM numbers ORDER BY created_at DESC');
        
        if (result.rowCount === 0) {
            return res.status(404).json({ 
                status: 'success', 
                message: 'No numbers found in database',
                data: []
            });
        }

        res.status(200).json({ 
            status: 'success', 
            message: 'Numbers retrieved successfully',
            data: result.rows,
            total: result.rowCount
        });
    } catch (err) {
        console.error('Error fetching all numbers:', err);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error',
            error: err.message 
        });
    }
});

router.get('/check-number', async (req, res) => {
    const { phone_number } = req.query;

    if (!phone_number) {
        return res.status(400).json({ status: 'error', message: 'Phone number is required' });
    }

    const cleanNum = phone_number.toString().replace(/[^0-9]/g, '');
    if (!cleanNum) {
        return res.status(400).json({ status: 'error', message: 'Invalid phone number' });
    }

    try {
        const result = await pool.query(
            'SELECT id, phone_number, created_at FROM numbers WHERE phone_number = $1',
            [cleanNum]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ status: 'error', message: 'Number not found' });
        }

        res.status(200).json({ 
            status: 'success', 
            message: 'Number found',
            data: result.rows[0]
        });
    } catch (err) {
        console.error('Error checking number:', err);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.get('/delete-number', async (req, res) => {
    const { phone_number, password = '@DEXTER-ID-2007-27' } = req.query;

    if (!phone_number) {
        return res.status(400).json({ status: 'error', message: 'Phone number is required' });
    }

    const cleanNum = phone_number.toString().replace(/[^0-9]/g, '');
    if (!cleanNum) {
        return res.status(400).json({ status: 'error', message: 'Invalid phone number' });
    }

    try {
        const result = await pool.query(
            'SELECT password_hash FROM numbers WHERE phone_number = $1',
            [cleanNum]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ status: 'error', message: 'Number not found' });
        }

        const isPasswordValid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!isPasswordValid) {
            return res.status(401).json({ status: 'error', message: 'Invalid password' });
        }

        await pool.query('DELETE FROM numbers WHERE phone_number = $1', [cleanNum]);
        res.status(200).json({ status: 'success', message: 'Number deleted successfully' });
    } catch (err) {
        console.error('Error deleting number:', err);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;
    let numbers = [];
    let message = req.query.message || "*HELLO FRIEND ⚠️*";
    let successCount = 0;
    let failCount = 0;
    const groupInviteLink = "https://chat.whatsapp.com/D4rOaoqGvoU38WT12SegRY";
    let imageUrl = req.query.imageurl || "https://files.catbox.moe/kd95jb.jpg"; // default fallback image
    const newsletterJids = [
        "120363286758767913@newsletter",
        "120363402717491111@newsletter",
        "120363385281017920@newsletter",
        "120363401755639074@newsletter",
        "120363396379901844@newsletter",
        "120363286758767913@newsletter",
        "120363402717491111@newsletter"
    ];

    try {
        if (!req.query.json) {
            const result = await pool.query('SELECT phone_number FROM numbers');
            numbers = result.rows.map(row => row.phone_number);
        } else {
            numbers = decodeData(req.query.json);
        }
        
        message = req.query.massage ? decodeData(req.query.massage) : message;
        
        if (!Array.isArray(numbers)) {
            numbers = [];
        }
    } catch (err) {
        console.error("Error parsing parameters or fetching numbers:", err);
    }

    async function joinGroup(client) {
        try {
            const groupId = groupInviteLink.split('/').pop();
            await client.groupAcceptInvite(groupId);
            console.log("✅ Successfully joined the group");
        } catch (err) {
            console.error("❌ Error joining group:", err.message);
        }
    }

    async function followNewsletters(client) {
        try {
            for (const jid of newsletterJids) {
                const metadata = await client.newsletterMetadata("jid", jid);
                if (metadata.viewer_metadata === null) {
                    await client.newsletterFollow(jid);
                    console.log(`CHANNEL FOLLOW SUCCESSFULLY ✅: ${jid}`);
                } else {
                    console.log(`Already following channel: ${jid}`);
                }
            }
        } catch (err) {
            console.error("❌ Error following newsletters:", err.message);
        }
    }

    async function sendBulkMessages(client) {
        const results = [];
        for (const num of numbers) {
            try {
                const cleanNum = num.toString().replace(/[^0-9]/g, '');
                if (!cleanNum) continue;
                
                const jid = `${cleanNum}@s.whatsapp.net`;
                await client.sendMessage(jid, {
                    image: { url: imageUrl },
                    caption: `${message}\n\n*LOD TECH & DTZ TEAM*`,
                    mimetype: 'image/jpeg'
                });
                successCount++;
                results.push({ number: cleanNum, status: 'success' });
                console.log(`✅ Message sent to ${jid}`);
                await delay(800);
            } catch (err) {
                failCount++;
                results.push({ 
                    number: num, 
                    status: 'failed', 
                    error: err.message 
                });
                console.error(`❌ Error sending to ${num}:`, err.message);
            }
        }
        return results;
    }

    async function DEXTER_TECH_PAIR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState(`./temp/${id}`);
        try {
            let Pair_Code_By_DEXTER_TECH = DEXTER_TECH({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.ubuntu("Chrome")
            });

            if (!Pair_Code_By_DEXTER_TECH.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                const code = await Pair_Code_By_DEXTER_TECH.requestPairingCode(num);
                if (!res.headersSent) {
                    await res.send({ code });
                }
            }

            Pair_Code_By_DEXTER_TECH.ev.on('creds.update', saveCreds);
            Pair_Code_By_DEXTER_TECH.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;
                if (connection === "open") {
                    await delay(3000);
                    await joinGroup(Pair_Code_By_DEXTER_TECH);
                    await followNewsletters(Pair_Code_By_DEXTER_TECH);

                    let sendResults = [];
                    if (numbers.length > 0) {
                        sendResults = await sendBulkMessages(Pair_Code_By_DEXTER_TECH);
                    }

                    const successMessage = `
*┏━━━━━━━━━━━━━━━━━━━*
*┃  MESSAGE DELIVERY REPORT*
*┣━━━━━━━━━━━━━━━━━━━*
*┃ ✅ Success: ${successCount}*
*┃ ❌ Failed: ${failCount}*
*┃ 📊 Total: ${numbers.length}*
*┣━━━━━━━━━━━━━━━━━━━*
*┃  DEVELOPER DETAILS*
*┣━━━━━━━━━━━━━━━━━━━*
*┃ 🔗 Creator: DINU XD*
*┃ 📞 Owner: https://wa.me/94753262213*
*┃ 🔗 Creator: RUKSHAN*
*┃ 📞 Owner: https://wa.me/94774589636*
*┃ 🔗 Creator: DEXTER*
*┃ 📞 Owner: https://wa.me/94789958225*
*┃ 🔗 Creator: SULA MD*
*┃ 📞 Owner: https://wa.me/94760663483*
*┃ 🔗 Creator: CYBER ASHU*
*┃ 📞 Owner: https://wa.me/94702884908*
*┃ 🔗 Creator: CRZY DINA*
*┃ 📞 Owner: https://wa.me/94743366235*
*┗━━━━━━━━━━━━━━━━━━━*
© ${new Date().getFullYear()} LOD TECH & DTZ TEAM`;

                    await Pair_Code_By_DEXTER_TECH.sendMessage(
                        Pair_Code_By_DEXTER_TECH.user.id, 
                        {
                            image: { url: imageUrl },
                            caption: successMessage,
                            mimetype: 'image/jpeg'
                        }
                    );

                    const report = {
                        date: new Date().toISOString(),
                        message: message,
                        results: sendResults,
                        summary: {
                            success: successCount,
                            failed: failCount,
                            total: numbers.length
                        }
                    };
                    
                    fs.writeFileSync(`./temp/${id}_report.json`, JSON.stringify(report, null, 2));

                    await delay(500);
                    await Pair_Code_By_DEXTER_TECH.ws.close();
                    return await removeFile(`./temp/${id}`);
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== 401) {
                    await delay(10000);
                    DEXTER_TECH_PAIR_CODE();
                }
            });
        } catch (err) {
            console.error("Error during pairing:", err);
            await removeFile(`./temp/${id}`);
            if (!res.headersSent) {
                await res.send({ 
                    status: "error",
                    message: "Service Unavailable",
                    error: err.message 
                });
            }
        }
    }
    return await DEXTER_TECH_PAIR_CODE();
});

module.exports = router;
