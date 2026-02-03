// utils/gemini.js

async function gerarAnaliseGemini(promptText, imagensBase64 = []) {
  let analysis = 'Ótimo progresso! Continue assim que os resultados vão aparecer cada vez mais. 💪';
  let modelUsado = 'fallback';

  // Modelos que suportam visão (imagens) - use 1.5-flash primeiro (rápido e barato)
  // utils/gemini.js (parte alterada)

const modelsToTry = [
  'gemini-2.5-flash',         // Primeiro: o que já funciona perfeitamente no seu /test-gemini
  'gemini-2.5-flash-lite',    // Segundo: o que você usa no e-mail (mais barato/rápido)
  'gemini-1.5-pro'            // Terceiro: fallback com visão robusta (se sua chave tiver acesso)
];

  let success = false;

  for (const model of modelsToTry) {
    if (success) break;

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries && !success) {
      attempt++;
      console.log(`[GEMINI BODY PROGRESS] Tentativa ${attempt}/${maxRetries} - Modelo: ${model}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutos (imagens demoram mais)

      // Monta o payload com texto + imagens em base64
      const contents = [
        {
          parts: [
            { text: promptText },
            ...imagensBase64.map(base64 => ({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64
              }
            }))
          ]
        }
      ];

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents,
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192
              }
            })
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[GEMINI BODY ERRO] ${model} - HTTP ${response.status}: ${errorText}`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, attempt * 30000)); // espera crescente
          }
          continue;
        }

        const json = await response.json();

        if (json.candidates?.[0]?.content?.parts?.[0]?.text) {
          analysis = json.candidates[0].content.parts[0].text.trim();
          success = true;
          modelUsado = model;
          console.log(`[GEMINI BODY SUCESSO] ${model} - ${analysis.length} caracteres gerados`);
        } else {
          console.warn(`[GEMINI BODY] Resposta sem texto válido (${model})`);
        }
      } catch (err) {
        console.error(`[GEMINI BODY FALHA] ${model} - Tentativa ${attempt}:`, err.message);
        if (err.name === 'AbortError') {
          console.error('[GEMINI BODY] Timeout de 2 minutos atingido');
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 30000));
        }
      }
    }
  }

  return { analysis, model: modelUsado };
}

module.exports = { gerarAnaliseGemini };