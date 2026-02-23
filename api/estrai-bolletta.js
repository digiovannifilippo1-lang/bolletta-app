// api/estrai-bolletta.js
module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Metodo non consentito' });
    return;
  }

  try {
    const tipo = (req.query.tipo || 'luce').toLowerCase();

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const bodyText = bodyBuffer.toString('utf8');

    // Il testo estratto arriva come campo "text" nel body JSON
    let testo = '';
    try {
      const parsed = JSON.parse(bodyText);
      testo = parsed.text || '';
    } catch (e) {
      res.status(400).json({ success: false, error: 'Body non valido' });
      return;
    }

    if (!testo || testo.length < 20) {
      res.json({ success: false, error: 'Testo della bolletta troppo corto o vuoto' });
      return;
    }

    const dati = parseInvoiceText(testo, tipo);

    if (!dati || !dati.consumo || !dati.totale) {
      res.json({
        success: false,
        error: 'Consumo o totale non trovati nella bolletta',
        rawTextPreview: testo.slice(0, 500)
      });
      return;
    }

    res.json({
      success: true,
      tipo,
      consumo: dati.consumo,
      totale: dati.totale
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Errore server: ' + err.message });
  }

};

function parseInvoiceText(text, type) {
  if (!text || text.length < 20) return null;
  let data = { consumo: null, totale: null };
  const cleanedText = text.toLowerCase().replace(/\s+/g, ' ');

  if (type === 'luce') {
    const kwhPatterns = [
      /(?:consumo|kwh|energia lorda)[\s:]*(\d{1,5}[.,]\d{0,3})\s*(?:kw?h)?/i,
      /(\d{1,5}[.,]\d{0,3})\s*kwh/i,
      /(\d{3,5})\s*kwh/i
    ];
    for (let pattern of kwhPatterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 50 && val < 50000) { data.consumo = parseFloat(val.toFixed(2)); break; }
      }
    }
    const euroPatterns = [
      /(?:totale|importo da pagare|importo)[\s:]*€?\s*(\d{1,5}[.,]\d{2})/i,
      /(?:euro|eur)[\s:]*(\d{1,5}[.,]\d{2})/i,
      /€\s*(\d{1,5}[.,]\d{2})/
    ];
    for (let pattern of euroPatterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 5 && val < 10000) { data.totale = parseFloat(val.toFixed(2)); break; }
      }
    }
  } else {
    const smcPatterns = [
      /(?:consumo|smc|volume)[\s:]*(\d{1,5}[.,]\d{0,3})\s*(?:smc)?/i,
      /(\d{1,5}[.,]\d{0,3})\s*smc/i,
      /(\d{2,4})\s*smc/i
    ];
    for (let pattern of smcPatterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 20 && val < 50000) { data.consumo = parseFloat(val.toFixed(2)); break; }
      }
    }
    const euroPatterns = [
      /(?:totale|importo da pagare|importo)[\s:]*€?\s*(\d{1,5}[.,]\d{2})/i,
      /(?:euro|eur)[\s:]*(\d{1,5}[.,]\d{2})/i,
      /€\s*(\d{1,5}[.,]\d{2})/
    ];
    for (let pattern of euroPatterns) {
      const match = cleanedText.match(pattern);
      if (match && match[1]) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (val > 5 && val < 5000) { data.totale = parseFloat(val.toFixed(2)); break; }
      }
    }
  }

  return (data.consumo && data.totale) ? data : null;
}
