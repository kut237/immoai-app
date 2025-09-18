const express = require('express');
const cors = require('cors');
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

// Web Scraping Funktion

function parseEuroToNumber(str) {
  if (!str) return null;
  return parseFloat(
    String(str)
      .replace(/\s/g,'')
      .replace(/\./g,'')
      .replace(',', '.')
      .replace(/[^\d.]/g,'')
  ) || null;
}

// ----- KI-Extractor: nur Miete (Monat/Jahr) aus Volltext -----

function stripJsonFence(s='') {
  return String(s).trim().replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
}

function extractJsonObject(text = "") {
  // Fences entfernen (``` / ```json)
  text = stripJsonFence(String(text));

  // 1) Direkt versuchen
  try { return JSON.parse(text); } catch (_) {}

  // 2) Erste balancierte {...}-Struktur herausschneiden
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const cand = text.slice(start, i + 1);
          try { return JSON.parse(cand); } catch (_) {}
          break;
        }
      }
    }
  }
  return null; // nichts brauchbares gefunden
}


function toNumberEuro(n) {
  if (n == null) return null;
  if (typeof n === 'number') return n;
  const s = String(n).replace(/\./g,'').replace(',', '.').replace(/[^\d.]/g,'');
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}
function plausibleMonthly(v) {
  return typeof v === 'number' && v >= 100 && v <= 20000;
}

/**
 * Liest den gesamten Inserats-Text und extrahiert NUR die Miete.
 * Bevorzugt Monats-Kaltmiete; erkennt p.a. und rechnet um.
 */
async function aiExtractRent(scrapedData, url) {
  const fullText = (scrapedData.fullText || '').slice(0, 12000);
  const desc = scrapedData.description || '';
  const title = scrapedData.title || '';
  const attrs = [
    scrapedData.address ? `Adresse: ${scrapedData.address}` : '',
    scrapedData.rooms ? `Zimmer: ${scrapedData.rooms}` : '',
    scrapedData.livingSpace ? `Wohnfläche: ${scrapedData.livingSpace} m²` : '',
    scrapedData.yearBuilt ? `Baujahr: ${scrapedData.yearBuilt}` : '',
  ].filter(Boolean).join('\n');

  const system = {
    role: "system",
    content: "Du bist ein Extraktionsspezialist. Extrahiere NUR Mietangaben (Kaltmiete), keine Kaufpreise."
  };

  const user = {
    role: "user",
    content:
`Lies das folgende Immobilien-Inserat (deutsch) und extrahiere Mietangaben.

WICHTIG:
- Bevorzuge NETTO-KALTMIETE pro Monat ("Kaltmiete", "Nettokaltmiete", "Miete kalt").
- Erkenne auch "Mieteinnahmen monatlich". Wenn NUR Jahresmiete (p.a.) genannt wird, rechne in Monatsmiete um.
- IGNORIERE €/m², Hausgeld/Warmmiete/Nebenkosten, Kaufpreis, Kaufpreis/m².
- Wenn mehrere Werte vorkommen, nimm den eindeutigsten/aktuellsten.
- Antworte AUSSCHLIESSLICH als JSON-Objekt (keine Kommentare, keine Code-Fences).

Schema:
{
  "rent_monthly_cold": number|null,   // Monats-Kaltmiete in EUR (gerundet)
  "rent_annual_cold": number|null,    // Jahres-Nettokaltmiete in EUR
  "confidence": number,               // 0..1
  "source": "monthly|annual|both|null",
  "context_snippet": string           // kurzer Originalsatz mit der Zahl
}

Meta:
URL: ${url}
Titel: ${title}
${attrs}

Beschreibung (Kurz):
${desc ? desc.slice(0, 1500) : ''}

Volltext:
${fullText}`
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 300,
    messages: [system, user]
  });

  let raw = completion.choices?.[0]?.message?.content || "";
  raw = stripJsonFence(raw);

  let out;
  try { out = JSON.parse(raw); } catch { return null; }

  const m = toNumberEuro(out.rent_monthly_cold);
  const y = toNumberEuro(out.rent_annual_cold);

  let rentMonthly = m;
  let rentAnnual  = y;

  if (!plausibleMonthly(rentMonthly) && rentAnnual && rentAnnual > 1000) {
    const m2 = Math.round(rentAnnual / 12);
    if (plausibleMonthly(m2)) rentMonthly = m2;
  }

  if (!plausibleMonthly(rentMonthly)) rentMonthly = null;
  if (rentAnnual && typeof rentAnnual === 'number' && rentAnnual < 1200) rentAnnual = null;

  return {
    rentMonthly,
    rentAnnual: rentAnnual || (rentMonthly ? rentMonthly * 12 : null),
    confidence: typeof out.confidence === 'number' ? out.confidence : null,
    source: out.source || null,
    context_snippet: out.context_snippet || null
  };
}

// Sucht Monats- und Jahresmiete in Fließtext
function extractRentFromText(text) {
  if (!text) return {};
  const t = text.replace(/\u00A0/g, ' ').replace(/\s+/g,' ');
  let rentMonthly = null, rentAnnual = null, rentSource = null;

  // Jahresmiete / Mieteinnahmen
  const y1 = t.match(/(?:jahres(?:netto)?kaltmiete|jahresmiete|(?:soll|ist)[-\s]?mieteinnahmen|mieteinnahmen)(?:\s*(?:p\.?\s*a\.?|pro\s*jahr))?\s*[:\-]?\s*([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)/i);
  if (y1) { rentAnnual = parseEuroToNumber(y1[1]); rentSource = 'text:p.a.'; }

  // Kaltmiete monatlich (klar bevorzugen)
  const mStrong = t.match(/\b(?:nkm|kaltmiete|netto[-\s]?kaltmiete|miete\s*kalt)\b[^\n:]{0,20}[:\-]?\s*([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)(?![^]{0,40}m²)/i);
  if (mStrong) { rentMonthly = parseEuroToNumber(mStrong[1]); rentSource = rentSource || 'text:kalt'; }

  // Generische Monatsangabe (€/Monat) – aber KEIN €/m² und KEIN Hausgeld
  if (!rentMonthly) {
  const mGen = t.match(/([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)\s*(?:\/|pro)?\s*(?:monat|mtl\.|m|monatlich|p\.?\s*m\.?)(?![^]{0,40}(?:m²|m2|qm))/i);
  if (mGen && !/hausgeld/i.test(t.slice(Math.max(0, mGen.index-40), mGen.index+60))) {
    rentMonthly = parseEuroToNumber(mGen[1]);
    rentSource  = rentSource || 'text:monat';
    }
    }

  if (!rentMonthly && rentAnnual) rentMonthly = Math.round(rentAnnual/12);
  return { rentMonthly: rentMonthly || null, rentAnnual: rentAnnual || null, rentSource };
}

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
            const normEC = (s) => {
            if (!s) return null;
            const m = String(s).toUpperCase().replace(/\s+/g,'').match(/\b([A-H](?:\+{1,2}|-)?)/);
            return m ? m[1] : null;
            };

            let ec = getText(['.is24qa-energieeffizienzklasse','[data-qa="energy-efficiency-class"]']);
            if (!ec) {
            const m = document.body.innerText.match(/Energieeffizienzklasse\s*[:\-]?\s*([A-H][+\-]?)/i);
            if (m) ec = m[1];
            }

            return {
            title: getText(['h1', '#expose-title']),
            price: getNumber(getText(['.is24qa-kaufpreis', '.is24qa-gesamtmiete', '[data-qa="price"]'])),
            livingSpace: getNumber(getText(['.is24qa-wohnflaeche', '[data-qa="area-living"]'])),
            rooms: getNumber(getText(['.is24qa-zimmer', '[data-qa="rooms"]'])),
            address: getText(['.address-block', '.is24qa-expose-address']),
            yearBuilt: getNumber(getText(['.is24qa-baujahr'])),
            energyClass: normEC(ec),
            fullText: document.body.innerText
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
            const cleaned = text.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
            return parseFloat(cleaned) || null;
            };
            const getEuroFromText = (txt) => {
            const m = txt.match(/([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)/i);
            return m ? parseFloat(m[1].replace(/\./g,'').replace(',','.')) : null;
            };

            // Attribute aus der Seite extrahieren
            const attributes = {};
            document.querySelectorAll('[class*="addetails"] li, [class*="attribute"]').forEach(el => {
            const text = el.textContent.replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();
            if (/wohnfl/i.test(text)) attributes.livingSpace = getNumber(text);
            if (/zimmer/i.test(text)) attributes.rooms = getNumber(text);
            if (/baujahr/i.test(text)) attributes.yearBuilt = getNumber(text);
            });

            // Miete aus Attributen und Beschreibung ziehen
            let rentMonthly = null, rentAnnual = null;
            const blobs = [
            document.querySelector('#viewad-description-text'),
            ...document.querySelectorAll('[class*="addetails"] li, [class*="attribute"]')
            ].filter(Boolean);

            blobs.forEach(el => {
            const txt = el.textContent.replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();

            // Jahresmiete / Mieteinnahmen p.a.
            if (!rentAnnual && /(jahres(?:netto)?kaltmiete|jahresmiete|(?:soll|ist)[-\s]?mieteinnahmen|mieteinnahmen)/i.test(txt)) {
                const n = getEuroFromText(txt);
                if (n) rentAnnual = n;
            }

            // "vermietet für 350 € kalt" / "derzeit für ... kalt"
            if (!rentMonthly) {
            const m = txt.match(/(?:derzeit|aktuell)?\s*vermietet\s*(?:für|zu)?\s*([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)[^.\n]{0,30}\b(kalt|netto)\b/i);
            if (m) {
                const v = parseFloat(m[1].replace(/\./g,'').replace(',','.'));
                if (v && v >= 100 && v <= 10000) rentMonthly = v;
            }
            }

            // "Mieteinnahmen monatlich: 450 €" (nicht p.a.)
            if (!rentMonthly) {
            const m = txt.match(/mieteinnahmen[^.\n]{0,20}\bmonatlich\b[^.\n]{0,20}([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)/i);
            if (m) {
                const v = parseFloat(m[1].replace(/\./g,'').replace(',','.'));
                if (v && v >= 100 && v <= 10000) rentMonthly = v;
            }
            }

            // Monats-kaltmiete (bevorzuge klare Kaltmiete-Begriffe; Warmmiete vermeiden)
            if (!rentMonthly && !/hausgeld/i.test(txt)) {
            const m = txt.match(/([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)\s*(?:\/|pro)?\s*(?:monat|mtl\.|m|monatlich|p\.?\s*m\.?)/i);
            if (m && !/(m²|m2|qm)/i.test(txt)) {
                const v = parseFloat(m[1].replace(/\./g,'').replace(',','.'));
                if (v && v >= 100 && v <= 10000) rentMonthly = v; // Plausibilitätsfilter
            }
            }

            // Generischer Monats-Hinweis (€/Monat), aber KEIN €/m², KEIN Hausgeld
            if (!rentMonthly &&
                /([\d.\s]+(?:,\d{1,2})?)\s*(?:€|eur)\s*(?:\/|pro)?\s*(?:monat|mtl\.|m|monatlich|p\.?\s*m\.?)/i.test(txt) &&
                !/m²|m2|qm/i.test(txt) &&
                !/hausgeld/i.test(txt)) {
                const n = getEuroFromText(txt);
                if (n) rentMonthly = n;
            }
            });

            // Falls nur Jahreswert: in Monatswert umrechnen
            if (!rentMonthly && rentAnnual) rentMonthly = Math.round(rentAnnual / 12);

            const ecMatch = document.body.innerText.match(/Energieeffizienzklasse\s*[:\-]?\s*([A-H][+\-]?)/i);
            const energyClass = ecMatch ? ecMatch[1].toUpperCase() : null;

            return {
            title: getText(['h1', '#viewad-title']),
            price: getNumber(getText(['#viewad-price', '[class*="price"]', 'h2[class*="price"]'])),
            livingSpace: attributes.livingSpace,
            rooms: attributes.rooms,
            yearBuilt: attributes.yearBuilt,
            address: getText(['#viewad-locality', '[class*="location"]']),
            description: getText(['#viewad-description-text']),
            fullText: document.body.innerText, // nicht abschneiden!
            energyClass,
            rentMonthly: rentMonthly || null,
            rentAnnual: rentAnnual || null
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
            const normEC = (s) => {
            if (!s) return null;
            const m = String(s).toUpperCase().replace(/\s+/g,'').match(/\b([A-H](?:\+{1,2}|-)?)/);
            return m ? m[1] : null;
            };

            // Energieklasse im Fließtext suchen
            let ec = null;
            const m = document.body.innerText.match(/Energieeffizienzklasse\s*[:\-]?\s*([A-H][+\-]?)/i);
            if (m) ec = m[1];

            return {
            title: getText('h1'),
            price: getNumber(getText('[class*="price"], [data-test="price"]')),
            livingSpace: getNumber(getText('[data-test="living-area"], [class*="living"]')),
            rooms: getNumber(getText('[data-test="rooms"], [class*="rooms"]')),
            address: getText('[class*="location"], [class*="address"]'),
            energyClass: normEC(ec),
            fullText: document.body.innerText
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
        
        // 🔁 Fallback: Energieklasse aus fullText herausziehen, falls noch leer
        if (!propertyData.energyClass && propertyData.fullText) {
        const m = propertyData.fullText.match(/Energieeffizienzklasse\s*[:\-]?\s*([A-H][+\-]?)/i);
        if (m) propertyData.energyClass = m[1].toUpperCase().replace(/\s+/g,'');
        }

        // 🔎 Miet-Erkennung aus Fließtext
        try {
        const rent = extractRentFromText(propertyData.fullText || '');
        if (rent.rentMonthly && !propertyData.rentMonthly) propertyData.rentMonthly = rent.rentMonthly;
        if (rent.rentAnnual && !propertyData.rentAnnual)   propertyData.rentAnnual   = rent.rentAnnual;
        if (rent.rentSource) propertyData.rentSource = rent.rentSource;
        } catch(e) {
        console.log('Rent-Extract Fehler:', e.message);
        }

        console.log('✅ Scraping erfolgreich!');
        console.log('📋 Gefundene Daten:', {
        title: propertyData.title ? '✓' : '✗',
        price: propertyData.price ? `✓ (${propertyData.price}€)` : '✗',
        livingSpace: propertyData.livingSpace ? `✓ (${propertyData.livingSpace}m²)` : '✗',
        rooms: propertyData.rooms ? `✓ (${propertyData.rooms})` : '✗',
        energyClass: propertyData.energyClass ? `✓ (${propertyData.energyClass})` : '✗',
        rentMonthly: propertyData.rentMonthly ? `✓ (${propertyData.rentMonthly} €/Monat)` : '✗',
        rentAnnual: propertyData.rentAnnual ? `✓ (${propertyData.rentAnnual} €/Jahr)` : '✗'
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
            rentMonthly: scrapedData.rentMonthly || null,
            rentAnnual: scrapedData.rentAnnual || (scrapedData.rentMonthly ? scrapedData.rentMonthly * 12 : null),
            analysis: "OpenAI API Key fehlt. Für detaillierte KI-Analyse bitte API Key in .env eintragen."
        };
    }

    try {
        console.log('🤖 Starte KI-Analyse...');
        
        const prompt = `
            Analysiere das folgende deutsche Immobilien-Inserat streng faktenbasiert. Antworte AUSSCHLIESSLICH als gültiges JSON-Objekt gemäß Schema unten – keine Erklärungen, keine Code-Fences.

            VERFÜGBARE DATEN:
            URL: ${url}
            Titel: ${scrapedData.title || 'Unbekannt'}
            Preis: ${scrapedData.price ? scrapedData.price + ' €' : 'Unbekannt'}
            Wohnfläche: ${scrapedData.livingSpace ? scrapedData.livingSpace + ' m²' : 'Unbekannt'}
            Zimmer: ${scrapedData.rooms || 'Unbekannt'}
            Adresse: ${scrapedData.address || 'Unbekannt'}
            Baujahr: ${scrapedData.yearBuilt || 'Unbekannt'}
            Inseratsmiete (falls erwähnt): ${scrapedData.rentMonthly ? scrapedData.rentMonthly + ' €/Monat' : 'Unbekannt'} / ${scrapedData.rentAnnual ? scrapedData.rentAnnual + ' €/Jahr' : 'Unbekannt'}
            Energieklasse: ${scrapedData.energyClass || 'Unbekannt'}

            AUS DEM TEXTPASSUS (gekürzt):
            ${(scrapedData.fullText || '').slice(0, 1600)}

            ANWEISUNGEN:
            - Nutze echte Zahlen aus dem Text. Wenn Werte fehlen, schätze vorsichtig und markiere sie mit "estimated": true.
            - Nutze die (ggf. erkannte) Monatskaltmiete für Rendite/Kapitalisierungsrate. Wenn nur Jahresmiete vorliegt, umrechnen.
            - Keine Warmmieten für Renditen.
            - Beziehe dich auf Lage/Objektzustand/Energie, erkenne Chancen & Risiken.
            - Sei präzise und knapp.

            SCHEMA (GENAU SO BENENNEN):
            {
            "summary": "Stichpunktartiges Kurzfazit",
            "scores": {
                "location": 0-10,
                "building_condition": 0-10,
                "energy": "A++|A+|A|B|C|D|E|F|G|H|null",
                "value_for_money": 0-10,
                "rent_security": 0-10
            },
            "valuation": {
                "asking_price_eur": number|null,
                "fair_value_low_eur": number|null,
                "fair_value_high_eur": number|null,
                "over_under_pricing_pct": number|null  // negativ = unter Preis (günstig)
            },
            "rental": {
                "current_rent_monthly_eur": number|null,
                "market_rent_monthly_eur": number|null,
                "vacancy_risk": "low|medium|high",
                "notes": "kurzer Satz"
            },
            "returns": {
                "gross_yield_pct": number|null,
                "net_yield_pct": number|null,
                "cap_rate_pct": number|null
            },
            "pros": ["...","..."],
            "cons": ["...","..."],
            "red_flags": ["..."],         // harte Risiken (leer lassen, wenn keine)
            "actions": ["Nächste Schritte / ToDos"],
            "confidence": 0.0-1.0
            }

            BERECHNUNGEN:
            - gross_yield_pct = (current_rent_monthly_eur * 12 / asking_price_eur) * 100
            - cap_rate_pct ≈ gross_yield_pct (falls keine Nettokosten verfügbar)
            - net_yield_pct: grob = ((current_rent_monthly_eur - 100) * 12 / asking_price_eur) * 100 (100 € pauschal nicht umlagefähige Kosten, falls nichts angegeben)
            - over_under_pricing_pct = ((asking_price_eur - fair_value_mid) / fair_value_mid) * 100, fair_value_mid = (low+high)/2

            GIB NUR DAS JSON OBEN AUS.
            `;


        const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 800,
        // Hart ansagen: NUR JSON
        response_format: { type: "json_object" }, // falls Lib/Modell das kann; sonst ignoriert
        messages: [
            {
            role: "system",
            content: "Gib AUSSCHLIESSLICH ein gültiges JSON-Objekt zurück. Keine Erklärungen, keine Fences."
            },
            {
            role: "user",
            content: prompt
            }
        ]
        });

const raw = completion.choices?.[0]?.message?.content || "";
console.log('✅ KI-Analyse erhalten');

const parsed = extractJsonObject(raw);
if (!parsed) {
  throw new Error("KI-JSON konnte nicht geparst werden");
}
        
        // Überschreibe mit echten Scraping-Daten wo vorhanden
        if (scrapedData.title) parsed.title = scrapedData.title;
        if (scrapedData.price) parsed.estimatedValue = scrapedData.price;
        if (scrapedData.livingSpace) parsed.livingSpace = scrapedData.livingSpace;
        if (scrapedData.rooms) parsed.rooms = scrapedData.rooms;
        if (scrapedData.address) parsed.address = scrapedData.address;
        if (scrapedData.yearBuilt) parsed.yearBuilt = scrapedData.yearBuilt; // 👈 auch Baujahr durchreichen
        if (scrapedData.energyClass) {
        parsed.energyClass = String(scrapedData.energyClass).toUpperCase().replace(/\s+/g,'');
        }
        if (scrapedData.rentMonthly) parsed.rentMonthly = scrapedData.rentMonthly;
        if (scrapedData.rentAnnual)  parsed.rentAnnual  = scrapedData.rentAnnual;

        
        // Berechne Preis/m² neu
        if (parsed.estimatedValue && parsed.livingSpace) {
            parsed.pricePerSqm = Math.round(parsed.estimatedValue / parsed.livingSpace);
        }
        
        return parsed;
        
    } catch (error) {
    console.error("❌ KI-Fehler:", error.message);

    // Fallback mit Scraping- und KI-Mietdaten (aiExtractRent hat scrapedData.rentMonthly/rentAnnual befüllt)
    const rentMonthly = scrapedData.rentMonthly || (scrapedData.rentAnnual ? Math.round(scrapedData.rentAnnual/12) : null);
    const rentAnnual  = scrapedData.rentAnnual  || (rentMonthly ? rentMonthly * 12 : null);

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
        rentMonthly,               // ✅ jetzt dabei
        rentAnnual,                // ✅ jetzt dabei
        rentContext: scrapedData.rentContext || null,
        analysis: "KI-Analyse fehlgeschlagen. Mietwert aus Inserat übernommen."
    };
}

}

// ===== Mietspiegel by PLZ – Robust Helpers =====

function slugIS24(s) {
  if (!s) return "";
  return String(s)
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim().replace(/\s+/g, "-").toLowerCase();
}

const BREMEN_PLZ_TO_SUBURB = { 
    '28195': 'Mitte',
    '28197': 'Woltmershausen',
    '28199': 'Neustadt',
    '28201': 'Huckelriede',
    '28203': 'Ostertor',
    '28205': 'Hulsberg',
    '28207': 'Hastedt',
    '28209': 'Barkhof',
    '28211': 'Gete',
    '28213': 'Riensberg',
    '28215': 'Findorff',
    '28217': 'Walle',
    '28219': 'Osterfeuerberg',
    '28237': 'Gröpelingen',
    '28239': 'Oslebshausen',
    '28259': 'Huchting',
    '28277': 'Kattenturm',
    '28279': 'Habenhausen',
    '28307': 'Mahndorf',
    '28309': 'Sebaldsbrück',
    '28325': 'Osterholz',
    '28327': 'Blockdiek',
    '28329': 'Vahr',
    '28355': 'Oberneuland',
    '28357': 'Borgfeld',
    '28359': 'Horn-Lehe',
    '28717': 'Lesum',
    '28719': 'Burg-Grambke',
    '28755': 'Vegesack',
    '28757': 'St. Magnus',
    '28759': 'Grohn',
    '28777': 'Blumenthal',
    '28779': 'Lüssum-Bockhorn' 
}; 

async function resolveAreaByPLZ(plz) {
  let city = null, state = null, lat = null, lon = null;

  // 1) Zippopotam
  try {
    const r = await fetch(`https://api.zippopotam.us/de/${plz}`);
    if (r.ok) {
      const j = await r.json();
      const p = j.places?.[0];
      if (p) {
        city  = p["place name"];
        state = p["state"] || null;
        lat   = parseFloat(p["latitude"]);
        lon   = parseFloat(p["longitude"]);
      }
    }
  } catch (_) {}

  // 2) Nominatim-Suche (falls Koordinaten fehlen)
  if (lat == null || lon == null) {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${plz}&country=de&format=json&addressdetails=1&limit=1`;
    const r2 = await fetch(url, { headers: { "User-Agent":"ImmoAI/1.0", "Accept-Language":"de-DE,de;q=0.9" }});
    const j2 = await r2.json();
    if (j2?.length) {
      const a = j2[0].address || {};
      city  = city  || a.city || a.town || a.village || a.county || null;
      state = state || a.state || null;
      lat   = parseFloat(j2[0].lat);
      lon   = parseFloat(j2[0].lon);
    }
  }

  // 3) Reverse-Geocode (zoom 16, mehr Felder)
  let suburb = null;
  if (lat != null && lon != null) {
    try {
      const rev = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`,
        { headers: { "User-Agent":"ImmoAI/1.0", "Accept-Language":"de-DE,de;q=0.9" } }
      );
      const j = await rev.json();
      const a = j.address || {};
      suburb = a.suburb || a.city_district || a.neighbourhood || a.borough || a.quarter || a.residential || null;
    } catch(_) {}
  }

  // 4) Fallback-Mapping (Beispiel: Bremen)
  if (!suburb && city === 'Bremen' && BREMEN_PLZ_TO_SUBURB[plz]) {
    suburb = BREMEN_PLZ_TO_SUBURB[plz];
  }

  return { city, state, suburb };
}

function parseIS24Mietspiegel(text) {
  if (!text) return null;
  const L = text.toLowerCase();
  const toNum = s => Number(s.replace(',', '.'));

  // Debug: Text-Sample ausgeben
  console.log('IS24 Text Sample:', L.substring(0, 1000));

  // Niedrig / Hoch
  const low  = L.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)\s*niedrigster\s*preis/);
  const high = L.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)\s*h[öo]chster\s*preis/);

  // Durchschnitt - Spezifisch für IS24 Format "Ø 10,51 €/m²"
  const avgCircle = L.match(/ø\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)/);
  const avgExplicit = L.match(/durchschnittlicher\s*preis[^0-9]{0,50}ø?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)/);
  
  // Allgemeinere Patterns
  const avg1 = L.match(/durchschnitt[^0-9]{0,50}(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)/);
  const avg2 = L.match(/(?:durchschnittspreis)[^0-9]{0,50}(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*\/?\s*(?:m²|m2|qm)/);

  const out = {};
  if (low)  {
    out.low  = toNum(low[1]);
    console.log('Found LOW:', low[1], '→', out.low);
  }
  if (high) {
    out.high = toNum(high[1]);
    console.log('Found HIGH:', high[1], '→', out.high);
  }
  
  // Priorisierung: Erst spezifische Ø-Pattern, dann allgemeine
  const avgMatch = avgCircle || avgExplicit || avg1 || avg2;
  if (avgMatch) {
    out.avg = toNum(avgMatch[1]);
    console.log('Found AVG:', avgMatch[1], '→', out.avg, 'via pattern:', avgMatch.input.substring(avgMatch.index, avgMatch.index + 50));
  }

  // Fallback: Wenn kein expliziter Durchschnitt gefunden, aber low und high existieren
  if (out.low && out.high && !out.avg) {
    out.avg = +( ((out.low + out.high)/2).toFixed(2) );
    console.log('Calculated AVG from low/high:', out.avg);
  }

  console.log('IS24 Final Parse Result:', out);

  if ((out.low && out.high) || out.avg) return out;
  return null;
}

async function fetchMietspiegelFromIS24(city, suburb, state) {
  const sCity   = slugIS24(city);
  const sState  = state ? slugIS24(state) : null;
  const sSuburb = suburb ? slugIS24(suburb) : null;

  const candidates = [];
  if (sSuburb) {
    if (sState) candidates.push({ label:'is24 deep (state/city/suburb)', url:`https://www.immobilienscout24.de/immobilienpreise/${sState}/${sCity}/${sSuburb}/mietspiegel` });
    candidates.push({ label:'is24 deep (city/city/suburb)', url:`https://www.immobilienscout24.de/immobilienpreise/${sCity}/${sCity}/${sSuburb}/mietspiegel` });
    candidates.push({ label:'is24 shallow (city/suburb)',   url:`https://www.immobilienscout24.de/immobilienpreise/${sCity}/${sSuburb}/mietspiegel` });
  }
  if (sState) candidates.push({ label:'is24 city (state/city)', url:`https://www.immobilienscout24.de/immobilienpreise/${sState}/${sCity}/mietspiegel` });
  candidates.push({ label:'is24 city (city)', url:`https://www.immobilienscout24.de/immobilienpreise/${sCity}/mietspiegel` });

  for (const cand of candidates) {
    console.log('IS24: versuche', cand.label, cand.url);
    const text = await safeGetText(cand.url);
    if (!text) { console.log('IS24: kein Text', cand.label); continue; }
    const rng = parseIS24Mietspiegel(text);
    if (rng) {
    console.log('IS24: Treffer', cand.label, rng);
    return {
        source: cand.url,
        rangeLow: rng.low ?? null,
        rangeHigh: rng.high ?? null,
        avgPerSqm: rng.avg ?? (rng.low && rng.high ? +( ((rng.low + rng.high)/2).toFixed(2) ) : null),
        scope: sSuburb ? 'suburb' : 'city'
    };
    }
    console.log('IS24: kein Range bei', cand.label);
  }
  return null;
}

function slugCityForUrl(city) {
  if (!city) return "";
  let c = String(city).trim();

  // Deutsche Umlaute korrekt transliterieren
  c = c.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
       .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
       .replace(/ß/g, "ss");

  // sonstige Diakritika entfernen
  c = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // in URL-Form bringen
  return c.replace(/[^a-zA-Z0-9 ]/g, " ")
          .trim()
          .replace(/\s+/g, "-")
          .toLowerCase();
}

function normalizeCityForSearch(city) {
  if (!city) return city;
  // z.B. "Bremen-Horn-Lehe" -> "Bremen"; "München Altstadt-Lehel" -> "Muenchen"
  let c = city.split('-')[0].split('/')[0].split('(')[0].trim();
  c = c.replace(/ß/g, 'ss').normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return c;
}

async function getTextSimple(url) {
  const r = await fetch(url, { headers: { "User-Agent": "ImmoAI/1.0", "Accept-Language": "de-DE,de;q=0.9" } });
  const html = await r.text();
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
             .replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ");
}

// Fallback für stark JS-lastige Seiten
async function getTextWithPuppeteer(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    // Ressourcen drosseln
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'image' || t === 'font' || t === 'media') req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // kleine Wartezeit, damit Client-Rendering greifen kann
    await new Promise(r => setTimeout(r, 1500));
    const txt = await page.evaluate(() => document.body.innerText);
    return txt.replace(/\s+/g, ' ');
  } catch (e) {
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

function tryExtractRangeEuroPerSqm(text) {
  if (!text) return null;
  const t = text;
  const L = t.toLowerCase();

  // 0) Hilfsfunktion: Kontext um eine Fundstelle (für Pos/Neg-Filter)
  const ctx = (i, j) => L.slice(Math.max(0, i - 80), Math.min(L.length, j + 80));

  // 1) Explizite Range: "von 7,50 bis 12,00 €/m²" (inkl. qm/m2/Quadratmeter, Euro/EUR)
  const pairRe = /von\s+(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)[^0-9]{0,30}bis\s+(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)[^0-9]{0,20}(?:\/|\bpro\b)?\s*(?:m²|m2|qm|quadratmeter)/i;
  const p = t.match(pairRe);
  if (p) {
    const a = Number(p[1].replace(',', '.'));
    const b = Number(p[2].replace(',', '.'));
    const low  = Math.min(a, b);
    const high = Math.max(a, b);
    if (low >= 3 && high <= 40) return { low, high };
  }

  // 2) Einzelwerte mit Kontextfilter: MUSS Miet-Kontext enthalten, DARF KEIN Kauf-Kontext enthalten
  const POS = /(miet|miete|kaltmiete|nettokaltmiete|mietspiegel|mietpreis)/;
  const NEG = /(kauf|kaufpreis|kaufen|verkauf|eigentum|kaufpreise|preis\/m²\s*kauf)/;

  const re = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*(?:\/|\bpro\b)?\s*(?:m²|m2|qm|quadratmeter)/gi;
  let m, values = [];
  while ((m = re.exec(t)) !== null) {
    const val = Number(m[1].replace(',', '.'));
    const window = ctx(m.index, re.lastIndex);
    if (!POS.test(window)) continue;   // ohne Miet-Kontext überspringen
    if (NEG.test(window)) continue;    // alles mit Kauf-Kontext verwerfen
    if (val >= 3 && val <= 25) values.push(val);  // realistische Mieten
  }

  if (values.length >= 2) {
    return { low: Math.min(...values), high: Math.max(...values) };
  }
  if (values.length === 1) {
    const avg = values[0];
    return { low: +(avg*0.85).toFixed(2), high: +(avg*1.15).toFixed(2) }; // ±15% Range aus Ø
  }

  // 3) Fallback: alle €/m² ohne Kontext (z. B. Portale ohne Textumfeld)
  const singles = [...t.matchAll(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:€|eur|euro)\s*(?:\/|\bpro\b)?\s*(?:m²|m2|qm|quadratmeter)/gi)]
    .map(x => Number(x[1].replace(',', '.')))
    .filter(n => n >= 3 && n <= 25);

  if (singles.length >= 2) return { low: Math.min(...singles), high: Math.max(...singles) };
  if (singles.length === 1) {
    const avg = singles[0];
    return { low: +(avg*0.85).toFixed(2), high: +(avg*1.15).toFixed(2) };
  }

  return null;
}

async function safeGetText(url) {
  // 1) Versuch: leichtes Fetch
  try {
    const t = await getTextSimple(url);
    if (t && t.length > 200) return t;
  } catch (_) { /* ignorieren */ }

  // 2) Fallback: Puppeteer (umgeht viele Blocker)
  try {
    const t2 = await getTextWithPuppeteer(url);
    if (t2 && t2.length > 100) return t2;
  } catch (_) { /* ignorieren */ }

  return null;
}

async function fetchMietspiegelForCity(cityRaw) {
  const city = normalizeCityForSearch(cityRaw);
  const slug = slugCityForUrl(city);

  // mehrere Varianten (einige Seiten erwarten /{slug}/mietspiegel statt -mietspiegel)
  const candidates = [
    { url: `https://www.immowelt.de/immobilienpreise/${slug}/mietspiegel`, label: "immowelt v1" },
    { url: `https://www.immowelt.de/immobilienpreise/${slug}-mietspiegel`, label: "immowelt v2" },
    { url: `https://www.wohnungsboerse.net/mietspiegel-${slug}`, label: "wohnungsboerse" },
    { url: `https://www.meinestadt.de/${slug}/immobilien/mietspiegel`, label: "meinestadt" },
    { url: `https://miet-check.de/mietspiegel/${slug}`, label: "miet-check" },
    { url: `https://mietspiegel.com/${slug}`, label: "mietspiegel.com" }
  ];

  for (const c of candidates) {
    try {
      console.log("Mietspiegel: versuche", c.label, c.url);
      let text = await getTextSimple(c.url);
      let rng = tryExtractRangeEuroPerSqm(text);
      if (!rng) {
        // Fallback: Seite rendern (JS-lastig)
        text = await getTextWithPuppeteer(c.url);
        rng = tryExtractRangeEuroPerSqm(text);
      }
      if (rng) {
        console.log("Mietspiegel: Treffer", c.label, rng);
        return { source: c.url, rangeLow: rng.low, rangeHigh: rng.high };
      }
      console.log("Mietspiegel: kein Range gefunden bei", c.label);
    } catch (e) {
      console.log("Mietspiegel: Fehler bei", c.label, e.message);
      // nächste Quelle probieren
    }
  }
  return null;
}

// === API ENDPOINTS ===

app.post('/api/mietspiegel-by-plz', async (req, res) => {
  try {
    const { plz } = req.body || {};
    if (!plz) return res.status(400).json({ ok:false, error:'PLZ fehlt' });

    const geo = await resolveAreaByPLZ(plz);
    console.log('Mietspiegel: PLZ', plz, '->', geo);
    if (!geo?.city) return res.json({ ok:false, error:'PLZ nicht gefunden' });

    // 1) IS24 mit state
    let ms = await fetchMietspiegelFromIS24(geo.city, geo.suburb, geo.state);

    // 2) Fallback: andere Quellen
    if (!ms) ms = await fetchMietspiegelForCity(geo.city, geo.suburb);

    if (!ms) return res.json({ ok:false, error:'Kein Mietspiegel gefunden' });

    return res.json({ ok:true, city: geo.city, suburb: geo.suburb || null, state: geo.state || null, ...ms });
  } catch (e) {
    console.error('Mietspiegel-Endpoint Fehler:', e.message);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

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

        // --- KI liest explizit NUR die Miete aus dem Volltext ---
        let aiRent = null;
        try {
        aiRent = await aiExtractRent(scrapedData, url);
        if (aiRent?.rentMonthly) scrapedData.rentMonthly = aiRent.rentMonthly;
        if (aiRent?.rentAnnual)  scrapedData.rentAnnual  = aiRent.rentAnnual;
        if (aiRent?.context_snippet) scrapedData.rentContext = aiRent.context_snippet;

        console.log('🤖 KI-Miet-Extrakt:',
            { rentMonthly: scrapedData.rentMonthly, rentAnnual: scrapedData.rentAnnual, from: aiRent?.source, conf: aiRent?.confidence }
        );
        } catch(e) {
        console.log('AI-Rent Extract Fehler:', e.message);
        }

        
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
        
        // Safety: Stelle sicher, dass Miete ins Result kommt – egal, was analyzeWithAI geliefert hat
        if (!result.rentMonthly && scrapedData.rentMonthly) result.rentMonthly = scrapedData.rentMonthly;
        if (!result.rentAnnual  && scrapedData.rentAnnual)  result.rentAnnual  = scrapedData.rentAnnual;
        if (scrapedData.rentContext && !result.rentContext) result.rentContext = scrapedData.rentContext;

        res.json(result);
        
    } catch (error) {
        console.error('❌ Fehler:', error);
        res.status(500).json({ 
            error: 'Analyse fehlgeschlagen',
            message: error.message 
        });
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



