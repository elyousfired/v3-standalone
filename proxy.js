import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3005; // Different port for Futures Dashboard

const CONFIG_FILE = path.join(__dirname, 'config.json');
const HUNTS_FILE = path.join(__dirname, 'data', 'active_hunts.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'trades_history.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/hunts', (req, res) => {
    try {
        let hunts = [];
        let history = [];
        if (fs.existsSync(HUNTS_FILE)) hunts = JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8'));
        if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        res.json([...hunts, ...history]);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/config', (req, res) => {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
        } else {
            res.json({ enabled: true });
        }
    } catch (e) {
        res.status(500).json({ error: 'Config error' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- FUTURES V3 DASHBOARD RUNNING ---`);
    console.log(`URL: http://localhost:${PORT}/dashboard.html`);
});
