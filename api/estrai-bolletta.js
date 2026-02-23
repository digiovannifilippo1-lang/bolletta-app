// api/estrai-bolletta.js
// Invia il testo estratto lato client (pdf.js) e fa il parsing server-side
// Restituisce: operatore, consumo, totale, mesi, quotaFissaPeriodo,
//              speseVendita, speseRete, speseOneri, imposte

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo non consentito' });
  }
  try {
    const body = await req.json();
    const testo = (body.text || '').replace(/\s+/g, ' ');
    const tipo  = (req.query.tipo || 'luce').toLowerCase();

    if (!testo || testo.length < 80) {
      return res.json({ success: false, error: 'Testo PDF troppo corto o vuoto' });
    }

    const dati = parseUniversale(testo, tipo);

    if (!dati.consumo || !dati.totale) {
      return res.json({
        success: false,
        error: 'Consumo o totale non trovati. Controlla che il PDF sia leggibile.',
        debug: {
          anteprima:     testo.slice(0, 500),
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

// ─────────────────────────────────────────────────────────────
// PARSER UNIVERSALE — IREN, Enel, ENI/Plenitude, A2A, Hera,
// Edison, ACEA, Sorgenia, Illumia, E.ON, Dolomiti, Optima…
// ─────────────────────────────────────────────────────────────
function parseUniversale(raw, tipo) {
  const t  = raw;
  const tl = raw.toLowerCase();

  const out = {
    operatore:         rilevOp(t),
    consumo:           null,
    totale:            null,
    mesi:              null,
    quotaFissaPeriodo: null,  // € quota fissa totale nel periodo fatturato
    speseVendita:      null,  // materia energia/gas (esclusa quota fissa vendita)
    speseRete:         null,  // trasporto + distribuzione + misura
    speseOneri:        null,  // oneri generali di sistema
    imposte:           null,  // accise + IVA
  };

  out.consumo           = tipo === 'luce' ? estraiConsumoLuce(tl) : estraiConsumoGas(tl);
  out.totale            = estraiTotale(tl);
  out.mesi              = estraiMesi(tl, t);
  out.quotaFissaPeriodo = estraiQuotaFissa(tl, out.mesi);

  const voci = estraiVoci(tl, out.totale, out.quotaFissaPeriodo);
  out.speseVendita = voci.speseVendita;
  out.speseRete    = voci.speseRete;
  out.speseOneri   = voci.speseOneri;
  out.imposte      = voci.imposte;

  return out;
}

// ── RILEVAMENTO OPERATORE ─────────────────────────────────────
function rilevOp(t) {
  const tl = t.toLowerCase();
  const ops = [
    ['iren mercato',       'IREN Mercato'],
    ['iren luce e gas',    'IREN'],
    ['iren',               'IREN'],
    ['plenitude',          'Plenitude (ENI)'],
    ['enel energia',       'Enel Energia'],
    ['enel',               'Enel'],
    ['eni gas e luce',     'ENI Gas e Luce'],
    ['eni ',               'ENI'],
    ['a2a energia',        'A2A Energia'],
    ['a2a',                'A2A'],
    ['acea energia',       'ACEA Energia'],
    ['acea',               'ACEA'],
    ['sorgenia',           'Sorgenia'],
    ['illumia',            'Illumia'],
    ['e.on',               'E.ON'],
    ['eon ',               'E.ON'],
    ['edison energia',     'Edison'],
    ['edison',             'Edison'],
    ['hera comm',          'Hera Comm'],
    ['hera',               'Hera'],
    ['2i rete gas',        '2i Rete Gas'],
    ['italgas',            'Italgas'],
    ['green network',      'Green Network'],
    ['bluenergy',          'Bluenergy'],
    ['dolomiti energia',   'Dolomiti Energia'],
    ['engie',              'ENGIE'],
    ['wekiwi',             'Wekiwi'],
    ['agsm',               'AGSM'],
    ['optima energia',     'Optima Italia'],
    ['optima',             'Optima Italia'],
    ['duferco',            'Duferco Energia'],
    ['axpo',               'Axpo'],
    ['estra',              'Estra'],
    ['amg energia',        'AMG Energia'],
  ];
  for (const [k, v] of ops) if (tl.includes(k)) return v;
  const m = t.match(/([A-ZÀÈÌÒÙ][A-Za-zÀ-ú\s&\.]{2,30})\s+S\.(?:p\.)?A\./);
  if (m) return m[1].trim();
  return 'Operatore attuale';
}

// ── CONSUMO LUCE ──────────────────────────────────────────────
function estraiConsumoLuce(tl) {
  const pp = [
    /consumo\s+totale\s+fatturato[^\d]*([\d]{2,5}[,\.]?\d*)\s*kwh/i,
    /energia\s+attiva[^\d]*([\d]{2,5}[,\.]?\d*)\s*kwh/i,
    /totale\s+(?:energia|consumi?)[^\d]*([\d]{2,5}[,\.]?\d*)\s*kwh/i,
    /consumo[^\d]*([\d]{2,5}[,\.]?\d*)\s*kwh/i,
    /([\d]{2,5})\s*kwh/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 20 && v <= 99999) return v; }
  }
  return null;
}

// ── CONSUMO GAS ───────────────────────────────────────────────
function estraiConsumoGas(tl) {
  const pp = [
    /consumo\s+(?:gas\s+)?(?:totale|fatturato|periodo)[^\d]*([\d]{1,5}[,\.]?\d*)\s*(?:smc|sm3)/i,
    /volume\s+(?:convertito|fatturato|totale)[^\d]*([\d]{1,5}[,\.]?\d*)\s*(?:smc|sm3)?/i,
    /([\d]{1,5}[,\.]?\d*)\s*(?:smc|sm3)/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 5 && v <= 99999) return v; }
  }
  return null;
}

// ── TOTALE ────────────────────────────────────────────────────
function estraiTotale(tl) {
  const pp = [
    /totale\s+da\s+pagare[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /importo\s+da\s+pagare[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+fattura[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+bolletta[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    /importo\s+totale[^\d€]*([\d]{1,5}[,\.]\d{2})/i,
    /€\s*([\d]{1,5}[,\.]\d{2})/i,
    /totale[^\d]{0,30}([\d]{1,5}[,\.]\d{2})/i,
  ];
  for (const p of pp) {
    const m = tl.match(p);
    if (m) { const v = pf(m[1]); if (v >= 5 && v <= 99999) return v; }
  }
  return null;
}

// ── MESI FATTURATI ────────────────────────────────────────────
function estraiMesi(tl, tOrig) {
  const m1 = tl.match(/periodo\s+di\s+(?:fornitura|fatturazione)[^\d]*(\d+)\s+mes/i);
  if (m1) { const v = parseInt(m1[1]); if (v >= 1 && v <= 12) return v; }

  const m2 = tl.match(/(\d+)\s+mes[ei]\s+(?:di\s+)?(?:consumo|fornitura|fatturazione)/i);
  if (m2) { const v = parseInt(m2[1]); if (v >= 1 && v <= 12) return v; }

  // Cerca pattern "N mesi x €/mesi" tipico di quota fissa
  const m3 = tl.match(/(\d)\s+mes[ei]\s+x\s+[\d,\.]+\s+(?:€\/)?mes/i);
  if (m3) { const v = parseInt(m3[1]); if (v >= 1 && v <= 12) return v; }

  if (tl.includes('bimestrale')) return 2;
  if (tl.includes('trimestrale')) return 3;
  if (tl.includes('quadrimestrale')) return 4;
  if (tl.match(/mensile/) && !tl.includes('bimestrale')) return 1;

  // Calcola da intervallo date
  const dm = [...tOrig.matchAll(/(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})\s*[-–]\s*(\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4})/g)];
  if (dm.length > 0) {
    const a = parseDateIT(dm[0][1]);
    const b = parseDateIT(dm[0][2]);
    if (a && b) {
      const diff = Math.round((b - a) / (1000 * 60 * 60 * 24 * 30));
      if (diff >= 1 && diff <= 12) return diff;
    }
  }
  return 2; // default bimestrale
}

// ── QUOTA FISSA DEL CLIENTE (periodo) ────────────────────────
// Estrae la quota fissa totale addebitata nella bolletta (voce esplicita)
function estraiQuotaFissa(tl, mesi) {
  // Pattern "N mesi x 19,55 €/mesi 39,10" → prende l'importo totale
  const p1 = tl.match(/(\d)\s+mes[ei]\s+x\s+([\d,\.]+)\s*(?:€?\/?\s*mes[ei])\s+([\d,\.]+)/i);
  if (p1) { const v = pf(p1[3]); if (v > 0 && v < 1000) return v; }

  // "quota fissa ... 39,10" (importo diretto in periodo)
  const p2 = tl.match(/quota\s+fissa[^\d]*([\d]{1,3}[,\.]\d{2})/i);
  if (p2) { const v = pf(p2[1]); if (v > 0 && v < 500) return v; }

  // "quota fissa 2 mesi ... 39,10"
  const p3 = tl.match(/quota\s+fissa\s+\d\s+mes[ei][^\d]*([\d]{1,3}[,\.]\d{2})/i);
  if (p3) { const v = pf(p3[1]); if (v > 0 && v < 500) return v; }

  // "fisso ... €/mese × mesi" → calcola
  const p4 = tl.match(/([\d]{1,3}[,\.]\d{2,5})\s*€?\s*\/\s*mes[ei]/i);
  if (p4 && mesi) { const v = pf(p4[1]) * mesi; if (v > 0 && v < 500) return parseFloat(v.toFixed(2)); }

  return null;
}

// ── VOCI DISAGGREGATE ────────────────────────────────────────
function estraiVoci(tl, totale, quotaFissa) {
  const r = { speseVendita: null, speseRete: null, speseOneri: null, imposte: null };

  // SPESE VENDITA
  const svP = [
    /spesa\s+per\s+la\s+(?:materia\s+)?(?:energia|gas|vendita)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /materia\s+(?:energia|gas|prima)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+di\s+spesa\s+dovuto[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /corrispettivo\s+(?:energia|gas|vendita)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /costo\s+(?:della\s+)?(?:energia|gas)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseVendita = fm(tl, svP, totale);

  // SPESE RETE
  const srP = [
    /spesa\s+per\s+(?:il\s+)?(?:trasporto|rete|distribuzione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /trasporto\s+(?:e\s+)?(?:distribuzione|gestione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /rete\s+(?:e\s+)?(?:misura|distribuzione)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /servizi\s+di\s+rete[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseRete = fm(tl, srP, totale);

  // ONERI DI SISTEMA
  const soP = [
    /oneri\s+(?:generali\s+di\s+sistema|di\s+sistema)[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /spesa\s+per\s+oneri[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /componenti\s+tariffarie[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.speseOneri = fm(tl, soP, totale);

  // IMPOSTE
  const imP = [
    /totale\s+(?:accise?\s+e\s+)?iva[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /totale\s+imposte?[^\d]*([\d]{1,5}[,\.]\d{2})/i,
    /accise?\s+e\s+iva[^\d]*([\d]{1,5}[,\.]\d{2})/i,
  ];
  r.imposte = fm(tl, imP, totale);

  return r;
}

// ── UTILITY ───────────────────────────────────────────────────
function pf(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}
function fm(tl, patterns, totale) {
  for (const p of patterns) {
    const m = tl.match(p);
    if (m) {
      const v = pf(m[1]);
      if (v > 0 && (!totale || v < totale)) return v;
    }
  }
  return null;
}
function parseDateIT(s) {
  const sep = s.includes('/') ? '/' : s.includes('-') ? '-' : '.';
  const p = s.split(sep);
  if (p.length !== 3) return null;
  return new Date(`${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`);
}
