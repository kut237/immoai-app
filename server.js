const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// OpenAI Setup
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer Setup für File-Upload
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = 'uploads/';
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /pdf|jpg|jpeg|png/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        if (extname) {
            return cb(null, true);
        } else {
            cb(new Error('Nur PDF, JPG und PNG erlaubt'));
        }
    }
});

// Web Scraping Funktion
async function scrapePropertyData(url) {
    let browser;
    try {
        console.log('🔍 Starte Web-Scraping für:', url);
        browser = await puppeteer.launch({ 
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        // Bilder blockieren für schnelleres Laden
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if(req.resourceType() == 'image'){
                req.abort();
            } else {
                req.continue();
            }
        });
        
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        let propertyData = {};
        
        // IMMOBILIENSCOUT24 SCRAPER
        if (url.includes('immobilienscout24')) {
            console.log('📊 Portal: ImmobilienScout24');
            propertyData = await page.evaluate(() => {
                const getText = (selectors) => {
                    for (let selector of selectors) {
                        const el = document.querySelector(selector);
                        if (el) return el.textContent.trim();
                    }
                    return null;
                };
                
                const getNumber = (text) => {
                    if (!text) return null;
                    const cleaned = text.replace(/[^0-9.,]/g, '').replace('.', '').replace(',', '.');
                    return parseFloat(cleaned) || null;
                };
                
                return {
                    title: getText(['h1', '#expose-title']),
                    price: getNumber(getText(['.is24qa-kaufpreis', '.is24qa-gesamtmiete', '[data-qa="price"]'])),
                    livingSpace: getNumber(getText(['.is24qa-wohnflaeche', '[data-qa="area-living"]'])),
                    rooms: getNumber(getText(['.is24qa-zimmer', '[data-qa="rooms"]'])),
                    address: getText(['.address-block', '.is24qa-expose-address']),
                    yearBuilt: getNumber(getText(['.is24qa-baujahr'])),
                    energyClass: getText(['.is24qa-energieeffizienzklasse']),
                    fullText: document.body.innerText.substring(0, 3000)
                };
            });
        } 
        // KLEINANZEIGEN SCRAPER
        else if (url.includes('kleinanzeigen')) {
            console.log('📊 Portal: Kleinanzeigen');
            propertyData = await page.evaluate(() => {
                const getText = (selectors) => {
                    for (let selector of selectors) {
                        const el = document.querySelector(selector);
                        if (el) return el.textContent.trim();
                    }
                    return null;
                };
                
                const getNumber = (text) => {
                    if (!text) return null;
                    const cleaned = text.replace(/[^0-9.,]/g, '').replace('.', '').replace(',', '.');
                    return parseFloat(cleaned) || null;
                };
                
                // Attribute aus der Seite extrahieren
                const attributes = {};
                document.querySelectorAll('[class*="addetails"] li, [class*="attribute"]').forEach(el => {
                    const text = el.textContent;
                    if (text.includes('Wohnfläche')) attributes.livingSpace = getNumber(text);
                    if (text.includes('Zimmer')) attributes.rooms = getNumber(text);
                    if (text.includes('Baujahr')) attributes.yearBuilt = getNumber(text);
                });
                
                return {
                    title: getText(['h1', '#viewad-title']),
                    price: getNumber(getText(['#viewad-price', '[class*="price"]', 'h2[class*="price"]'])),
                    livingSpace: attributes.livingSpace,
                    rooms: attributes.rooms,
                    yearBuilt: attributes.yearBuilt,
                    address: getText(['#viewad-locality', '[class*="location"]']),
                    description: getText(['#viewad-description-text']),
                    fullText: document.body.innerText.substring(0, 3000)
                };
            });
        }
        // IMMOWELT SCRAPER
        else if (url.includes('immowelt')) {
            console.log('📊 Portal: ImmoWelt');
            propertyData = await page.evaluate(() => {
                const getText = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.textContent.trim() : null;
                };
                
                const getNumber = (text) => {
                    if (!text) return null;
                    const cleaned = text.replace(/[^0-9.,]/g, '').replace('.', '').replace(',', '.');
                    return parseFloat(cleaned) || null;
                };
                
                return {
                    title: getText('h1'),
                    price: getNumber(getText('[class*="price"], [data-test="price"]')),
                    livingSpace: getNumber(getText('[data-test="living-area"], [class*="living"]')),
                    rooms: getNumber(getText('[data-test="rooms"], [class*="rooms"]')),
                    address: getText('[class*="location"], [class*="address"]'),
                    fullText: document.body.innerText.substring(0, 3000)
                };
            });
        }
        // GENERISCHER SCRAPER für andere Seiten
        else {
            console.log('📊 Verwende generischen Scraper');
            propertyData = await page.evaluate(() => {
                const text = document.body.innerText;
                const title = document.title;
                
                // Versuche Muster zu erkennen
                const priceMatch = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*€)/);
                const areaMatch = text.match(/(\d{2,3})\s*m²/);
                const roomsMatch = text.match(/(\d+(?:,5)?)\s*Zimmer/i);
                
                return {
                    title: title,
                    price: priceMatch ? parseFloat(priceMatch[1].replace('.', '').replace(',', '.')) : null,
                    livingSpace: areaMatch ? parseFloat(areaMatch[1]) : null,
                    rooms: roomsMatch ? parseFloat(roomsMatch[1].replace(',', '.')) : null,
                    fullText: text.substring(0, 3000)
                };
            });
        }
        
        await browser.close();
        
        console.log('✅ Scraping erfolgreich!');
        console.log('📋 Gefundene Daten:', {
            title: propertyData.title ? '✓' : '✗',
            price: propertyData.price ? `✓ (${propertyData.price}€)` : '✗',
            livingSpace: propertyData.livingSpace ? `✓ (${propertyData.livingSpace}m²)` : '✗',
            rooms: propertyData.rooms ? `✓ (${propertyData.rooms})` : '✗'
        });
        
        return propertyData;
    } catch (error) {
        console.error('❌ Scraping-Fehler:', error.message);
        if (browser) await browser.close();
        return null;
    }
}

// KI-Analyse Funktion
async function analyzeWithAI(scrapedData, url) {
    // Wenn kein API Key, nutze trotzdem die gescrapten Daten
    if (!process.env.OPENAI_API_KEY) {
        console.log('⚠️ Kein API Key - verwende nur Scraping-Daten');
        return {
            title: scrapedData.title || "Immobilie",
            address: scrapedData.address || "Deutschland",
            livingSpace: scrapedData.livingSpace || 80,
            rooms: scrapedData.rooms || 3,
            yearBuilt: scrapedData.yearBuilt || null,
            estimatedValue: scrapedData.price || 400000,
            pricePerSqm: scrapedData.livingSpace ? Math.round((scrapedData.price || 400000) / scrapedData.livingSpace) : 5000,
            energyClass: scrapedData.energyClass || "D",
            yield: 3.5,
            analysis: "OpenAI API Key fehlt. Für detaillierte KI-Analyse bitte API Key in .env eintragen."
        };
    }

    try {
        console.log('🤖 Starte KI-Analyse...');
        
        const prompt = `
        Analysiere diese Immobiliendaten vom deutschen Markt:
        
        URL: ${url}
        Titel: ${scrapedData.title || 'Unbekannt'}
        Preis: ${scrapedData.price ? scrapedData.price + '€' : 'Unbekannt'}
        Wohnfläche: ${scrapedData.livingSpace ? scrapedData.livingSpace + 'm²' : 'Unbekannt'}
        Zimmer: ${scrapedData.rooms || 'Unbekannt'}
        Adresse: ${scrapedData.address || 'Unbekannt'}
        Baujahr: ${scrapedData.yearBuilt || 'Unbekannt'}
        
        Weitere Details: ${scrapedData.fullText ? scrapedData.fullText.substring(0, 1500) : ''}
        
        Gib eine professionelle Immobilienbewertung als JSON:
        {
            "title": "${scrapedData.title || 'Immobilie'}",
            "address": "Nutze die echte Adresse oder schätze basierend auf URL",
            "livingSpace": ${scrapedData.livingSpace || 80},
            "rooms": ${scrapedData.rooms || 3},
            "yearBuilt": Schätze wenn nicht bekannt,
            "estimatedValue": ${scrapedData.price || 400000},
            "pricePerSqm": Berechne aus Preis/Fläche,
            "energyClass": "A-H",
            "yield": Schätze Mietrendite in %,
            "analysis": "Detaillierte Bewertung: Lage, Zustand, Preis-Leistung, Investitionspotential"
        }`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Du bist ein erfahrener deutscher Immobilienexperte. Nutze die echten Daten und ergänze fehlende professionell."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 800,
            temperature: 0.3
        });

        const response = completion.choices[0].message.content;
        console.log('✅ KI-Analyse erhalten');
        
        const parsed = JSON.parse(response);
        
        // Überschreibe mit echten Scraping-Daten wo vorhanden
        if (scrapedData.title) parsed.title = scrapedData.title;
        if (scrapedData.price) parsed.estimatedValue = scrapedData.price;
        if (scrapedData.livingSpace) parsed.livingSpace = scrapedData.livingSpace;
        if (scrapedData.rooms) parsed.rooms = scrapedData.rooms;
        if (scrapedData.address) parsed.address = scrapedData.address;
        
        // Berechne Preis/m² neu
        if (parsed.estimatedValue && parsed.livingSpace) {
            parsed.pricePerSqm = Math.round(parsed.estimatedValue / parsed.livingSpace);
        }
        
        return parsed;
        
    } catch (error) {
        console.error("❌ KI-Fehler:", error.message);
        
        // Fallback mit Scraping-Daten
        return {
            title: scrapedData.title || "Immobilie",
            address: scrapedData.address || "Deutschland",
            livingSpace: scrapedData.livingSpace || 80,
            rooms: scrapedData.rooms || 3,
            yearBuilt: scrapedData.yearBuilt || null,
            estimatedValue: scrapedData.price || 400000,
            pricePerSqm: scrapedData.livingSpace ? Math.round((scrapedData.price || 400000) / scrapedData.livingSpace) : 5000,
            energyClass: "D",
            yield: 3.5,
            analysis: "KI-Analyse fehlgeschlagen. Basis-Daten werden angezeigt."
        };
    }
}

// === API ENDPOINTS ===

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        openai: !!process.env.OPENAI_API_KEY,
        version: '1.0.0'
    });
});

// URL-Analyse Endpoint
app.post('/api/analyze-url', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL erforderlich' });
        }
        
        console.log('\n════════════════════════════════');
        console.log('🏠 Neue Analyse:', url.substring(0, 50) + '...');
        
        // 1. Scrape Website
        const scrapedData = await scrapePropertyData(url);
        
        let result;
        if (scrapedData && scrapedData.title) {
            // 2. Analysiere mit KI
            result = await analyzeWithAI(scrapedData, url);
        } else {
            // Fallback wenn Scraping fehlschlägt
            console.log('⚠️ Scraping fehlgeschlagen');
            result = {
                title: "Immobilie",
                address: "Deutschland",
                livingSpace: 80,
                rooms: 3,
                yearBuilt: null,
                estimatedValue: 400000,
                pricePerSqm: 5000,
                energyClass: "D",
                yield: 3.5,
                analysis: "Automatische Extraktion fehlgeschlagen. Bitte versuchen Sie es später erneut."
            };
        }
        
        // 3. Sende Ergebnis
        result.source = url;
        result.timestamp = new Date().toISOString();
        
        console.log('✅ Analyse abgeschlossen');
        console.log('════════════════════════════════\n');
        
        res.json(result);
        
    } catch (error) {
        console.error('❌ Fehler:', error);
        res.status(500).json({ 
            error: 'Analyse fehlgeschlagen',
            message: error.message 
        });
    }
});

// File-Upload Endpoint
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen' });
        }

        console.log('📄 Datei-Upload:', req.file.originalname);
        
        // Basis-Analyse für Dateien
        const result = {
            title: "Immobilie aus " + req.file.originalname,
            address: "Aus Exposé",
            livingSpace: 90,
            rooms: 3,
            yearBuilt: 2015,
            estimatedValue: 450000,
            pricePerSqm: 5000,
            energyClass: "B",
            yield: 3.8,
            analysis: "Exposé-Analyse. Für beste Ergebnisse nutzen Sie bitte die URL-Funktion mit einem Online-Inserat."
        };
        
        // Cleanup
        await fs.unlink(req.file.path).catch(console.error);
        
        res.json(result);
        
    } catch (error) {
        console.error('Upload-Fehler:', error);
        res.status(500).json({ error: 'Upload fehlgeschlagen' });
    }
});

// Server starten
app.listen(PORT, () => {
    console.clear();
    console.log('╔═══════════════════════════════════════╗');
    console.log('║                                       ║');
    console.log('║       🏠 ImmoAI Server Ready 🏠       ║');
    console.log('║                                       ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🤖 AI Model: gpt-4o-mini`);
    console.log(`📊 Status: ${process.env.OPENAI_API_KEY ? '✅ OpenAI verbunden' : '⚠️  Demo-Modus (kein API Key)'}`);
    console.log('');
    console.log('Unterstützte Portale:');
    console.log('  • ImmobilienScout24');
    console.log('  • Kleinanzeigen');
    console.log('  • ImmoWelt');
    console.log('  • Weitere (automatisch)');
    console.log('');
    console.log('Bereit für Anfragen...');
    console.log('────────────────────────────────────────');
});
