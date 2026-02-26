// pages/api/bolletta-ai.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Metodo non consentito' });
  }

  try {
    const { text } = req.body || {};
    const tipo = (req.query.tipo || 'luce').toLowerCase();

    if (!text || text.length < 50) {
      return res.status(400).json({ success: false, error: 'Testo PDF troppo corto o vuoto' });
    }

    // PER ORA: simuliamo un risultato fisso, giusto per collegare il front‑end
    const fake = {
      operatore: 'Operatore sconosciuto',
      periodo: '01/01/2025 - 28/02/2025',
      mesi: 2,
      consumoPeriodo: 200,
      spesaPeriodo: 100,
      consumoAnnuo: 1200,
      spesaAnnua: 600,
      quotaFissaAnnua: 120
    };

    return res.json({ success: true, tipo, ...fake });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Errore server IA: ' + err.message });
  }
}
