// utils/gemini.js
async function gerarAnaliseGemini(promptText, imagensBase64 = []) {
  let comentarioIA = 'Ótimo progresso! Continue assim que os resultados vão aparecer cada vez mais. 💪';
  let iaUsada = 'fallback';

  const modelsToTry = [
    'gemini-1.5-flash',        // Suporta visão perfeitamente
    'gemini-1.5-pro'           // Fallback mais poderoso (se precisar)
  ];

  let success = false;

  for (const model of modelsToTry) {
    if (success) break;

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries && !success) {
      attempt++;
      console.log(`[GEMINI BODY] Tentativa ${attempt}/${maxRetries} - Modelo: ${model}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s (mais tempo por causa das imagens)

      // Monta as parts: texto + imagens
      const contents = [
        {
          parts: [
            { text: promptText },
            ...imagensBase64.map(base64 => ({
              inlineData: {
                mimeType: "image/jpeg",
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
            await new Promise(r => setTimeout(r, attempt * 30000));
          }
          continue;
        }

        const json = await response.json();

        if (json.candidates?.[0]?.content?.parts?.[0]?.text) {
          comentarioIA = json.candidates[0].content.parts[0].text.trim();
          success = true;
          iaUsada = model;
          console.log(`[GEMINI BODY SUCESSO] ${model} - ${comentarioIA.length} chars`);
        }
      } catch (err) {
        console.error(`[GEMINI BODY FALHA] ${model} - Tentativa ${attempt}: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 30000));
        }
      }
    }
  }

  return { analysis: comentarioIA, model: iaUsada };
}

module.exports = { gerarAnaliseGemini };