// api/bolletta-ai.js

import OpenAI from "openai";

// Usa la chiave che hai messo in Vercel come OPENAI_API_KEY
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, error: "Metodo non consentito" });
  }

  try {
    const { text } = req.body || {};
    const tipo = (req.query.tipo || "luce").toLowerCase();

    if (!text || text.length < 50) {
      return res.status(400).json({
        success: false,
        error: "Testo PDF troppo corto o vuoto",
      });
    }

    const prompt = buildPrompt(text, tipo);
    const rawAnswer = await callModel(prompt);

    let parsed;
    try {
      parsed = JSON.parse(rawAnswer);
    } catch (e) {
      console.error("JSON parse error:", e, rawAnswer);
      return res.status(500).json({
        success: false,
        error: "IA: risposta non in JSON valido.",
      });
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.consumoPeriodo == null ||
      parsed.spesaPeriodo == null
    ) {
      return res.status(400).json({
        success: false,
        error:
          "IA: non ha trovato consumoPeriodo o spesaPeriodo in modo affidabile.",
      });
    }

    const mesi =
      typeof parsed.mesi === "number" && parsed.mesi > 0 && parsed.mesi <= 12
        ? parsed.mesi
        : 2;

    return res.json({
      success: true,
      tipo,
      operatore: parsed.operatore || "Operatore attuale",
      periodo: parsed.periodo || "",
      mesi,
      consumoPeriodo: Number(parsed.consumoPeriodo),
      spesaPeriodo: Number(parsed.spesaPeriodo),
      consumoAnnuo:
        parsed.consumoAnnuo != null ? Number(parsed.consumoAnnuo) : null,
      spesaAnnua:
        parsed.spesaAnnua != null ? Number(parsed.spesaAnnua) : null,
      quotaFissaAnnua:
        parsed.quotaFissaAnnua != null ? Number(parsed.quotaFissaAnnua) : null,
    });
  } catch (err) {
    console.error("Errore API bolletta-ai:", err);
    return res.status(500).json({
      success: false,
      error: "Errore server IA: " + err.message,
    });
  }
}

function buildPrompt(text, tipo) {
  return `
Sei un esperto di bollette italiane di energia ${
    tipo === "luce" ? "elettrica" : "gas"
  }.
Ricevi il TESTO ESTRATTO (solo testo, niente tabelle) di una bolletta.

Il tuo obiettivo è estrarre i dati chiave in modo robusto, anche se:
- le frasi cambiano da operatore a operatore,
- l'ordine dei campi è diverso,
- ci sono più importi (es. rate, saldi, pagamenti precedenti).

DEVI RESTITUIRE SOLO un JSON valido con queste chiavi (niente testo fuori dal JSON):

{
  "operatore": string,
  "periodo": string,
  "mesi": number,
  "consumoPeriodo": number,
  "spesaPeriodo": number,
  "consumoAnnuo": number|null,
  "spesaAnnua": number|null,
  "quotaFissaAnnua": number|null
}

REGOLE:
- "spesaPeriodo" è il TOTALE DA PAGARE per il PERIODO corrente (euro, IVA inclusa).
  Cerca diciture come "TOTALE DA PAGARE", "TOTALE BOLLETTA", "IMPORTO DA PAGARE".
  Se ci sono più totali, scegli quello riferito alla bolletta corrente, non saldi pregressi.
- "consumoPeriodo" è il consumo usato per questa bolletta (kWh/Smc periodo), non l'annuo.
- "periodo": se trovi date tipo "dal 01/11/2024 al 31/12/2024", scrivi "01/11/2024 - 31/12/2024".
- "mesi": calcolalo dal periodo (es. 2 mesi per 01/11-31/12) oppure usa "fatturazione bimestrale/trimestrale/mensile".
- Se vedi "Consumo annuo" o "Spesa annua sostenuta", usali per "consumoAnnuo" e "spesaAnnua".
- "quotaFissaAnnua": se vedi un canone per N mesi, annualizzalo: importo_periodo * (12 / N).
- Se non trovi un valore con sicurezza, metti null e NON inventare.
- Tutti i numeri devono usare il punto come separatore decimale, senza simbolo €.
- NON aggiungere spiegazioni: restituisci SOLO il JSON finale.

ESEMPIO:

TESTO:
"IREN MERCATO SPA ... Periodo di riferimento 01/11/2024 - 31/12/2024 ...
Consumo nel periodo 86 kWh ... Consumo annuo kWh 443 ...
Spesa annua sostenuta iva compresa ... 471,12 € ...
Quota fissa 2 mesi x 19,55 € = 39,10 € ...
TOTALE DA PAGARE 78,52 € ..."

JSON CORRETTO:
{
  "operatore": "IREN Mercato",
  "periodo": "01/11/2024 - 31/12/2024",
  "mesi": 2,
  "consumoPeriodo": 86,
  "spesaPeriodo": 78.52,
  "consumoAnnuo": 443,
  "spesaAnnua": 471.12,
  "quotaFissaAnnua": 234.60
}

ADESSO ANALIZZA QUESTA BOLLETTA:

TESTO:
"""${text.slice(0, 15000)}"""
`;
}

async function callModel(prompt) {
  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    response_format: { type: "text" },
  });

  const content = response.output[0].content[0].text;
  return content.trim();
}
