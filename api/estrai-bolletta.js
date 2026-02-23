// api/estrai-bolletta.js
// Estrae DATI ANNUALI dalla bolletta (consumo annuo + spesa annua)
// come indicati nel riquadro "Informazioni storiche" ARERA obbligatorio.
// Fallback: usa i dati del periodo e li annualizza.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo non consentito' });
  }
  try {
    const body = await req.json();
    const raw  = (body.text || '').replace(/\s+/g, ' ');
    const tipo = (req.query.tipo || 'luce').toLowerCase();

    if (!raw || raw.length < 80) {
      return res.json({ success: false, error: 'Testo PDF troppo corto o vuoto' });
    }

    const dati = parse(raw, tipo);

    if (!dati.consumoAnnuo || !dati.spesaAnnua) {
      return res.json({
        success: false,
        error: 'Impossibile trovare i dati annuali. Verifica che il PDF sia leggibile.',
        debug: { anteprima: raw.slice(0, 600), dati }
      });
    }

    return res.json({ success: true, tipo, ...dati });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Errore server: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────
function parse(raw, tipo) {
  const t  = raw;
  const tl = raw.toLowerCase();

  const out = {
    operatore:     detectOp(t),
    consumoAnnuo:  null,   // kWh o Smc / anno
    spesaAnnua:    null,   // € / anno (IVA inclusa)
    // dati periodo (secondari, per mostrare la bolletta reale)
    consumoPeriodo: null,
    spesaPeriodo:   null,
    mesi:           null,
    // quota fissa annuale del cliente attuale
    quotaFissaAnnua: null,
  };

  // ── 1. DATI ANNUALI (fonte principale) ───────────────
  // ARERA impone il riquadro "Spesa annua sostenuta" e "Consumo Annuo kWh"
  // in tutte le bollette del mercato libero.

  if (tipo === 'luce') {
    // Pattern "Consumo Annuo kWh ... 443" / "consumo annuo ... 443 kwh"
    const caP = [
      /consumo\s+annuo\s+(?:kwh\s+)?(?:dal[^\d]*al[^\d]*)?(?:f\d\s+\d+\s+f\d\s+\d+\s+f\d\s+\d+\s+totale\s+)?([\d\.]+)\s*kwh?/i,
      /consumo\s+annuo[^\d]*([\d]{2,5})\s*kwh/i,
      /totale\s+([\d]{3,5})\s*kwh.*consumo\s+annuo/i,
    ];
    for (const p of caP) {
      const m = tl.match(p);
      if (m) { const v = pf(m[1]); if (v >= 100 && v <= 50000) { out.consumoAnnuo = v; break; } }
    }

    // Spesa annua sostenuta (obbligatoria ARERA)
    const saP = [
      /spesa\s+annua\s+sostenuta[^\d]*([\d]{2,5}[,\.]\d{2})/i,
      /spesa\s+annua[^\d]*([\d]{2,5}[,\.]\d{2})/i,
      /importo\s+annuo[^\d]*([\d]{2,5}[,\.]\d{2})/i,
    ];
    for (const p of saP) {
      const m = tl.match(p);
      if (m) { const v = pf(m[1]); if (v >= 50 && v <= 5000) { out.spesaAnnua = v; break; } }
    }
  } else {
    // GAS — consumo annuo Smc
    const caP = [
      /consumo\s+annuo[^\d]*([\d]{2,5}[,\.]?\d*)\s*(?:smc|sm3|mc)/i,
      /consumo\s+annuo\s+(?:gas\s+)?[\d\s]*?(?:smc|sm3)\s*([\d]{2,5})/i,
    ];
    for (const p of caP) {
      const m = tl.match(p);
      if (m) { const v = pf(m[1]); if (v >= 50 && v <= 50000) { out.consumoAnnuo = v; break; } }
    }
    const saP = [
      /spesa\s+annua\s+sostenuta[^\d]*([\d]{2,5}[,\.]\d{2})/i,
      /spesa\s+annua[^\d]*([\d]{2,5}[,\.]\d{2})/i,
    ];
    for (const p of saP) {
      const m = tl.match(p);
      if (m) { const v = pf(m[1]); if (v >= 50 && v <= 9999) { out.spesaAnnua = v; break; } }
    }
  }

  // ── 2. DATI PERIODO (fallback + info secondaria) ─────
  out.mesi           = estraiMesi(tl, t);
  out.consumoPeriodo = tipo === 'luce' ? estraiConsumoLucePeriodo(tl) : estraiConsumoGasPeriodo(tl);
  out.spesaPeriodo   = estraiTotale(tl);

  // Fallback annuale da periodo × fattore
  if (!out.consumoAnnuo && out.consumoPeriodo && out.mesi) {
    out.consumoAnnuo = parseFloat((out.consumoPeriodo * (12 / out.mesi)).toFixed(0));
  }
  if (!out.spesaAnnua && out.spesaPeriodo && out.mesi) {
    out.spesaAnnua = parseFloat((out.spesaPeriodo * (12 / out.mesi)).toFixed(2));
  }

  // ── 3. QUOTA FISSA ANNUALE CLIENTE ───────────────────
  out.quotaFissaAnnua = estraiQuotaFissaAnnua(tl, out.mesi);

  return out;
}

// ── CONSUMO PERIODO LUCE ─────────────────────────────────────
function estraiConsumoLucePeriodo(tl) {
  const pp = [
    /consumo\s+totale\s+fatturato[^\d]*([\d]{2,4})\s*kwh/i,
    /energia\s+attiva[^\d\s]+\s*([\d]{2,4})\s*kwh/i,
    /totale\s+consum[oi][^\d]*([\d]{2,4})\s*kwh/i,
    // "86 kWh x 0,20" (struttura tipica scontrino)
    /([\d]{2,3})\s*kwh\s+x\s+[\d,\.]+/i,
    /([\d]{2,4})\s*kwh/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 10 && v <= 5000) return v; }
  }
  return null;
}

// ── CONSUMO PERIODO GAS ──────────────────────────────────────
function estraiConsumoGasPeriodo(tl) {
  const pp = [
    /consumo\s+(?:gas\s+)?(?:totale|fatturato|periodo)[^\d]*([\d]{1,5}[,\.]?\d*)\s*(?:smc|sm3)/i,
    /volume\s+(?:convertito|fatturato)[^\d]*([\d]{1,4})\s*(?:smc|sm3)/i,
    /([\d]{2,4})\s*(?:smc|sm3)/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 5 && v <= 9999) return v; }
  }
  return null;
}

// ── TOTALE PERIODO ───────────────────────────────────────────
function estraiTotale(tl) {
  const pp = [
    /totale\s+da\s+pagare[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /importo\s+da\s+pagare[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+fattura[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+bolletta[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    /€\s*([\d]{1,5}[,\.]\d{2})/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 5 && v <= 9999) return v; }
  }
  return null;
}

// ── MESI ─────────────────────────────────────────────────────
function estraiMesi(tl, tOrig) {
  const m3 = tl.match(/(\d)\s+mes[ei]\s+x\s+[\d,\.]+/i);
  if (m3) { const v=parseInt(m3[1]); if(v>=1&&v<=12) return v; }
  if (tl.includes('bimestrale')) return 2;
  if (tl.includes('trimestrale')) return 3;
  if (tl.match(/mensile/) && !tl.includes('bimestrale')) return 1;
  // Da date
  const dm=[...tOrig.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*[-–]\s*(\d{2}\/\d{2}\/\d{4})/g)];
  if (dm.length>0) {
    const a=pDate(dm[0][1]), b=pDate(dm[0][2]);
    if(a&&b){ const d=Math.round((b-a)/(1000*60*60*24*30)); if(d>=1&&d<=12) return d; }
  }
  return 2;
}

// ── QUOTA FISSA ANNUALE CLIENTE ──────────────────────────────
// Cerca la quota fissa mensile × 12, o il totale di periodo × 12/mesi
function estraiQuotaFissaAnnua(tl, mesi) {
  // "2 mesi x 19,55 €/mesi 39,10" → prende importo totale periodo poi × 6
  const p1 = tl.match(/(\d)\s+mes[ei]\s+x\s+([\d,\.]+)\s*(?:€?\/?\s*mes[ei])\s+([\d,\.]+)/i);
  if (p1) {
    const nMesi = parseInt(p1[1]);
    const totQF = pf(p1[3]);
    if (totQF > 0 && totQF < 500) return parseFloat((totQF * (12 / nMesi)).toFixed(2));
  }
  // "quota fissa ... importo"
  const p2 = tl.match(/quota\s+fissa[^\d]{0,30}([\d]{1,3}[,\.]\d{2})/i);
  if (p2) {
    const v = pf(p2[1]);
    if (v > 0 && v < 500 && mesi) return parseFloat((v * (12 / mesi)).toFixed(2));
  }
  // €/mese esplicito
  const p3 = tl.match(/([\d]{1,3}[,\.]\d{2,5})\s*€?\s*\/\s*mes[ei]/i);
  if (p3) { const v = pf(p3[1]) * 12; if (v > 0 && v < 999) return parseFloat(v.toFixed(2)); }
  return null;
}

// ── OPERATORE ────────────────────────────────────────────────
function detectOp(t) {
  const tl = t.toLowerCase();
  const ops=[
    ['iren mercato','IREN Mercato'],['iren luce e gas','IREN'],['iren','IREN'],
    ['plenitude','Plenitude (ENI)'],['enel energia','Enel Energia'],['enel','Enel'],
    ['eni gas e luce','ENI Gas e Luce'],['eni ','ENI'],
    ['a2a energia','A2A Energia'],['a2a','A2A'],
    ['acea energia','ACEA Energia'],['acea','ACEA'],
    ['sorgenia','Sorgenia'],['illumia','Illumia'],
    ['e.on','E.ON'],['eon ','E.ON'],
    ['edison energia','Edison'],['edison','Edison'],
    ['hera comm','Hera Comm'],['hera','Hera'],
    ['green network','Green Network'],['bluenergy','Bluenergy'],
    ['dolomiti energia','Dolomiti Energia'],['engie','ENGIE'],
    ['wekiwi','Wekiwi'],['optima energia','Optima Italia'],['optima','Optima Italia'],
    ['duferco','Duferco Energia'],['estra','Estra'],
  ];
  for (const [k,v] of ops) if (tl.includes(k)) return v;
  const m = t.match(/([A-ZÀÈÌÒÙ][A-Za-zÀ-ú\s&\.]{2,30})\s+S\.(?:p\.)?A\./);
  return m ? m[1].trim() : 'Operatore attuale';
}

function pf(s) {
  return parseFloat(String(s||0).replace(/\./g,'').replace(',','.')) || 0;
}
function pDate(s) {
  const p=s.split('/');
  return p.length===3 ? new Date(`${p[2]}-${p[1]}-${p[0]}`) : null;
}
