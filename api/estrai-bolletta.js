// api/estrai-bolletta.js

module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Metodo non consentito' });
    return;
  }

  try {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ success: false, error: 'OCR key non configurata' });
      return;
    }

    const tipo = (req.query.tipo || 'luce').toLowerCase();

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const bodyBuffer = Buffer.concat(chunks);

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      res.status(400).json({ success: false, error: 'Form-data non valido' });
      return;
    }

    const boundary = boundaryMatch[1];

    const ocrResp = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'apikey': apiKey
      },
      body: bodyBuffer
    });

    const ocrJson = await ocrResp.json();

    if (ocrJson.IsErroredOnProcessing) {
      res.status(500).json({
        success: false,
        error: ocrJson.ErrorMessage || 'Errore OCR'
      });
      return;
    }

    const parsedText = ocrJson.ParsedResults?.[0]?.ParsedText || '';
    const dati = parseInvoiceText(parsedText, tipo);

    if (!dati || !dati.consumo || !dati.totale) {
      res.json({
        success: false,
        error: 'Consumo/totale non trovati nel testo OCR',
        rawTextPreview: parsedText.slice(0, 500)
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
  const normalizedText = text.toLowerCase();
  const cleanedText = normalizedText.replace(/\s+/g, ' ');

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
        if (val > 50 && val < 50000) {
          data.consumo = parseFloat(val.toFixed(2));
          break;
        }
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
        if (val > 5 && val < 10000) {
          data.totale = parseFloat(val.toFixed(2));
          break;
        }
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
        if (val > 20 && val < 50000) {
          data.consumo = parseFloat(val.toFixed(2));
          break;
        }
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
        if (val > 5 && val < 5000) {
          data.totale = parseFloat(val.toFixed(2));
          break;
        }
      }
    }
  }

  return (data.consumo && data.totale) ? data : null;
}
