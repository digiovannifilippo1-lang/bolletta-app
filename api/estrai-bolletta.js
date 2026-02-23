// api/estrai-bolletta.js
// Parser universale bollette italiane — IREN, Enel, ENI/Plenitude,
// A2A, Hera, Edison, ACEA, Sorgenia, Illumia, E.ON, Dolomiti, ecc.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo non consentito' });
  }
  try {
    const body = await req.json();
    const testo = body.text || '';
    const tipo  = (req.query.tipo || 'luce').toLowerCase();

    if (!testo || testo.length < 100) {
      return res.json({ success: false, error: 'Testo PDF troppo corto o vuoto' });
    }

    const dati = parseUniversale(testo, tipo);

    if (!dati.consumo || !dati.totale) {
      return res.json({
        success: false,
        error: 'Consumo o totale non trovati. Verifica che il PDF sia leggibile.',
        debug: {
          primiCaratteri: testo.slice(0, 600),
          consumoTrovato: dati.consumo,
          totaleTrovato:  dati.totale
        }
      });
    }

    return res.json({ success: true, tipo, ...dati });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Errore server: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER UNIVERSALE
// ─────────────────────────────────────────────────────────────────────────────
function parseUniversale(raw, tipo) {
  const t  = raw;           // testo originale (mantiene case per operatore)
  const tl = raw.toLowerCase().replace(/\s+/g, ' '); // minuscolo normalizzato

  const result = {
    operatore:            rilevOp(t),
    consumo:              null,
    totale:               null,
    mesi:                 null,
    // Voci disaggregate (null = non trovato → il frontend userà proporzioni)
    speseVendita:         null,  // materia energia/gas
    speseRete:            null,  // trasporto + distribuzione
    speseOneri:           null,  // oneri di sistema
    imposte:              null,  // accise + IVA
    quotaFissa:           null,  // quota fissa periodo
  };

  // ── 1. CONSUMO ────────────────────────────────────────────────
  result.consumo = tipo === 'luce'
    ? estraiConsumoLuce(tl)
    : estraiConsumoGas(tl);

  // ── 2. TOTALE DA PAGARE ───────────────────────────────────────
  result.totale = estraiTotale(tl);

  // ── 3. MESI FATTURATI ─────────────────────────────────────────
  result.mesi = estraiMesi(tl, t);

  // ── 4. VOCI DISAGGREGATE ──────────────────────────────────────
  const voci = estraiVociDisagregate(tl, tipo, result.totale);
  result.speseVendita  = voci.speseVendita;
  result.speseRete     = voci.speseRete;
  result.speseOneri    = voci.speseOneri;
  result.imposte       = voci.imposte;
  result.quotaFissa    = voci.quotaFissa;

  return result;
}

// ── CONSUMO LUCE ──────────────────────────────────────────────────────────────
function estraiConsumoLuce(tl) {
  const patterns = [
    // "energia attiva totale 450 kWh"
    /energia\s+attiva\s+totale[^\d]*([\d]{2,5}(?:[,\.]\d{1,3})?)\s*(?:kwh|kw)?/i,
    // "totale energia 450 kWh" / "totale consumi 450 kWh"
    /totale\s+(?:energia|consumi?)[^\d]*([\d]{2,5}(?:[,\.]\d{1,3})?)\s*kwh/i,
    // "consumo 450 kWh" / "consumo: 450"
    /consumo(?:\s+totale)?[^\d]*([\d]{2,5}(?:[,\.]\d{1,3})?)\s*kwh/i,
    // "450 kWh" come numero prima di "kwh"
    /([\d]{2,5}(?:[,\.]\d{1,3})?)\s*kwh/i,
    // solo numero prima di "energia"
    /energia[^\d]{0,20}([\d]{3,5})/i,
  ];
  for (const p of patterns) {
    const m = tl.match(p);
    if (m) {
      const v = pf(m[1]);
      if (v >= 50 && v <= 99999) return v;
    }
  }
  return null;
}

// ── CONSUMO GAS ───────────────────────────────────────────────────────────────
function estraiConsumoGas(tl) {
  const patterns = [
    /consumo\s+(?:gas\s+)?(?:totale|fatturato|periodo|rilevato)[^\d]*([\d]{1,5}(?:[,\.]\d{1,3})?)\s*(?:smc|sm3|mc)?/i,
    /volume\s+(?:convertito|fatturato|totale)[^\d]*([\d]{1,5}(?:[,\.]\d{1,3})?)\s*(?:smc|sm3)?/i,
    /([\d]{1,5}(?:[,\.]\d{1,3})?)\s*(?:smc|sm3|metro\s+cubo)/i,
    /gas\s+(?:naturale\s+)?consumato[^\d]*([\d]{1,5})/i,
  ];
  for (const p of patterns) {
    const m = tl.match(p);
    if (m) {
      const v = pf(m[1]);
      if (v >= 5 && v <= 99999) return v;
    }
  }
  return null;
}

// ── TOTALE ────────────────────────────────────────────────────────────────────
function estraiTotale(tl) {
  const patterns = [
    // "totale da pagare € 78,52" / "importo da pagare 78,52"
    /(?:totale|importo)\s+da\s+pagare[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    // "totale fattura € 78,52"
    /totale\s+fattura[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    // "importo totale € 78,52"
    /importo\s+totale[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    // "totale bolletta"
    /totale\s+bolletta[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    // "€ 78,52" come importo finale
    /€\s*([\d]{1,5}[,\.]\d{2})\s*(?:iva\s+inclusa|compreso|incluso)?/i,
    // Fallback: numero con decimali vicino a "totale"
    /totale[^\d]{0,30}([\d]{1,5}[,\.]\d{2})/i,
  ];
  for (const p of patterns) {
    const m = tl.match(p);
    if (m) {
      const v = pf(m[1]);
      if (v >= 5 && v <= 99999) return v;
    }
  }
  return null;
}

// ── MESI FATTURATI ────────────────────────────────────────────────────────────
function estraiMesi(tl, tOrig) {
  // Pattern espliciti
  const m1 = tl.match(/periodo\s+di\s+(?:fornitura|fatturazione)[^\d]*(\d+)\s+mes[ei]/i);
  if (m1) { const v=parseInt(m1[1]); if(v>=1&&v<=12) return v; }

  const m2 = tl.match(/(\d+)\s+mes[ei]\s+(?:di\s+)?(?:consumo|fornitura|fatturazione)/i);
  if (m2) { const v=parseInt(m2[1]); if(v>=1&&v<=12) return v; }

  // "bimestrale" → 2 mesi
  if (tl.includes('bimestrale')) return 2;
  if (tl.includes('mensile') && !tl.includes('bimestrale')) return 1;
  if (tl.includes('trimestrale')) return 3;
  if (tl.includes('quadrimestrale')) return 4;

  // Calcola da date: "01/11/2025 - 31/12/2025"
  const dateMatches = [...tOrig.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/g)];
  if (dateMatches.length > 0) {
    const inizio = parseDateIT(dateMatches[0][1]);
    const fine   = parseDateIT(dateMatches[0][2]);
    if (inizio && fine) {
      const diffMesi = Math.round((fine - inizio) / (1000*60*60*24*30));
      if (diffMesi >= 1 && diffMesi <= 12) return diffMesi;
    }
  }

  // Fallback: 2 mesi (bimestrale è il più comune in Italia)
  return 2;
}

// ── VOCI DISAGGREGATE ────────────────────────────────────────────────────────
function estraiVociDisagregate(tl, tipo, totale) {
  const r = { speseVendita: null, speseRete: null, speseOneri: null, imposte: null, quotaFissa: null };

  // SPESE VENDITA / MATERIA ENERGIA
  const svPatterns = [
    /spesa\s+per\s+la\s+(?:materia\s+)?(?:energia|gas|vendita)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /materia\s+(?:energia|gas|prima)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /componente\s+(?:materia|energia|gas|vendita)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /corrispettivo\s+(?:energia|gas|vendita)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /costo\s+(?:della\s+)?(?:energia|gas)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseVendita = firstMatch(tl, svPatterns, 1, totale);

  // SPESE RETE / TRASPORTO
  const srPatterns = [
    /spesa\s+per\s+(?:il\s+)?(?:trasporto|rete|distribuzione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /trasporto\s+(?:e\s+)?(?:distribuzione|gestione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /rete\s+(?:e\s+)?(?:misura|distribuzione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /distribuzione\s+(?:e\s+)?misura[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /servizi\s+di\s+rete[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseRete = firstMatch(tl, srPatterns, 1, totale);

  // ONERI DI SISTEMA
  const soPatterns = [
    /oneri\s+(?:generali\s+di\s+sistema|di\s+sistema)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /oneri\s+(?:di\s+)?sistema[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /componenti\s+tariffarie\s+e\s+oneri[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /spesa\s+per\s+oneri[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseOneri = firstMatch(tl, soPatterns, 1, totale);

  // IMPOSTE (accise + IVA)
  const imPatterns = [
    /(?:totale\s+)?(?:accise?\s+e\s+iva|imposte?)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /iva\s+(?:\d+%\s+)?[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /imposta\s+sul\s+valore\s+aggiunto[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+imposte?[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.imposte = firstMatch(tl, imPatterns, 1, totale);

  // QUOTA FISSA (€/mese × N mesi)
  const qfPatterns = [
    /quota\s+(?:fissa\s+)?(?:annua|mensile|commercializzazione)[^\d]*([\d]{1,4}[,\.]\d{2})\s*€?\s*\/\s*mes[ei]/i,
    /([\d]{1,4}[,\.]\d{2})\s*€\s*\/\s*mes[ei]/i,
    /quota\s+(?:variabile\s+)?fissa[^\d]*([\d]{1,4}[,\.]\d{2})/i,
  ];
  // Per la quota fissa restituiamo il valore mensile (il frontend moltiplica per mesi)
  for (const p of qfPatterns) {
    const m = tl.match(p);
    if (m) {
      const v = pf(m[1]);
      if (v > 0 && v < 500) { r.quotaFissa = v; break; }
    }
  }

  return r;
}

// ── RILEVA OPERATORE ──────────────────────────────────────────────────────────
function rilevOp(t) {
  const tl = t.toLowerCase();
  const ops = [
    // Più specifici prima
    ['iren mercato','IREN Mercato'],['iren luce e gas','IREN'],['iren','IREN'],
    ['plenitude','Plenitude (ENI)'],
    ['enel energia','Enel Energia'],['enel','Enel'],
    ['eni gas e luce','ENI Gas e Luce'],['eni','ENI'],
    ['a2a energia','A2A Energia'],['a2a','A2A'],
    ['acea energia','ACEA Energia'],['acea','ACEA'],
    ['sorgenia','Sorgenia'],
    ['illumia','Illumia'],
    ['e.on energia','E.ON'],['e.on','E.ON'],['eon ','E.ON'],
    ['edison energia','Edison'],['edison','Edison'],
    ['hera comm','Hera Comm'],['hera','Hera'],
    ['2i rete gas','2i Rete Gas'],
    ['italgas','Italgas'],
    ['green network','Green Network'],
    ['bluenergy','Bluenergy'],
    ['dolomiti energia','Dolomiti Energia'],
    ['engie','ENGIE'],
    ['wekiwi','Wekiwi'],
    ['agsm ago','AGSM AGO'],['agsm','AGSM'],
    ['amag','AMAG'],
    ['aem','AEM'],
    ['gala','Gala SpA'],
    ['axpo','Axpo'],
    ['optima energia','Optima Italia'],['optima','Optima Italia'],
    ['duferco','Duferco Energia'],
    ['econogas','EconoGas'],
    ['energia d.o.o','Energia DOO'],
  ];
  for (const [k,v] of ops) if (tl.includes(k)) return v;
  // Fallback: cerca "Xxx S.p.A." nel testo originale
  const m = t.match(/([A-ZÀÈÌÒÙ][A-Za-zÀ-ú\s&]{2,30})\s+S\.(?:p\.)?A\./);
  if (m) return m[1].trim();
  return 'Operatore attuale';
}

// ── UTILITY ───────────────────────────────────────────────────────────────────
function pf(s) {
  if (!s) return 0;
  // Gestisce sia "1.234,56" (IT) che "1234.56" (EN)
  const str = String(s).trim();
  if (str.match(/\d\.\d{3},/)) {
    // Formato IT: 1.234,56
    return parseFloat(str.replace(/\./g,'').replace(',','.'));
  }
  return parseFloat(str.replace(',','.'));
}

function firstMatch(tl, patterns, group, totale) {
  for (const p of patterns) {
    const m = tl.match(p);
    if (m && m[group]) {
      const v = pf(m[group]);
      if (v > 0 && v < (totale || 99999)) return v;
    }
  }
  return null;
}

function parseDateIT(s) {
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
}
