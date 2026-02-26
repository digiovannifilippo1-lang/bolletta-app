// api/bolletta-ai.js
import OpenAI from "openai";

// Legge la chiave IA da Vercel / variabili d'ambiente
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

    // Prompt IA
    const prompt = buildPrompt(text, tipo);

    // Chiamata modello (blindata)
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

// Prompt con esempio di bolletta italiana
function buildPrompt(text, tipo) {
  return `
Sei un esperto di bollette italiane di energia ${
    tipo === "luce" ? "elettrica" : "gas"
  }.
Ricevi il TESTO ESTRATTO (solo testo, niente tabelle) di una bolletta.

Devi estrarre questi dati e restituirli SOLO come JSON:

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
- "spesaPeriodo": TOTALE DA PAGARE relativo alla bolletta corrente (euro, IVA inclusa).
  Cerca frasi come "TOTALE DA PAGARE", "TOTALE BOLLETTA", "IMPORTO DA PAGARE".
  Se ci sono più totali, scegli quello riferito al periodo corrente, non saldi pregressi.
- "consumoPeriodo": consumo (kWh/Smc) usato per questa bolletta.
- "periodo": se trovi "dal 01/11/2024 al 31/12/2024", usa "01/11/2024 - 31/12/2024".
- "mesi": calcolo dal periodo o da frasi tipo "fatturazione bimestrale/trimestrale/mensile".
- "consumoAnnuo" e "spesaAnnua": usa eventuali riquadri storici (ARERA, "spesa annua sostenuta", "consumo annuo").
- "quotaFissaAnnua": canone fisso annuo del cliente. Se vedi 2 mesi x 19,55 €, annualizza: 39,10 € * (12/2) = 234,60 €.
- Se non trovi un valore con sicurezza, metti null. Non inventare.
- Tutti i numeri devono usare il punto come separatore decimale, senza simbolo €.
- NON aggiungere testo fuori dal JSON.

ESEMPIO:

TESTO:
"IREN MERCATO SPA ... Periodo di riferimento 01/11/2024 - 31/12/2024 ...
Consumo nel periodo 86 kWh ... Consumo annuo kWh 443 ...
Spesa annua sostenuta iva compresa ... 471,12 € ...
Quota fissa 2 mesi x 19,55 € = 39,10 € ...
TOTALE DA PAGARE 78,52 € ..."

JSON:
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

ORA ANALIZZA QUESTA BOLLETTA:

TESTO:
"""${text.slice(0, 15000)}"""
`;
}

// Chiamata OpenAI blindata
async function callModel(prompt) {
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      response_format: { type: "json_object" },
    });

    const content = response.output[0]?.content[0];
    if (!content) {
      throw new Error("Risposta IA vuota");
    }

    if (content.json) {
      return typeof content.json === "string"
        ? content.json.trim()
        : JSON.stringify(content.json);
    }

    if (content.text) {
      return content.text.trim();
    }

    throw new Error("Formato risposta IA inatteso");
  } catch (err) {
    console.error("Errore chiamata OpenAI:", err);
    throw new Error("Chiamata a OpenAI fallita: " + err.message);
  }
}
