'use strict';
// AgroSensor IA: análise de imagem por modelo de visão REAL (API Anthropic). Sem chave configurada, a análise fica indisponível;
// nenhum resultado é inventado.
const fs = require('fs');
const config = require('../config');

const SYSTEM = `Você é um assistente de apoio à identificação de problemas fitossanitários em lavouras, dentro do aplicativo AgroSensor Tech.
Analise a foto e as informações fornecidas e responda SOMENTE com um objeto JSON válido (sem texto fora do JSON), em português do Brasil, com este formato:
{
 "image_usable": true|false,
 "summary": "resumo curto do que a imagem permite observar",
 "observed_symptoms": ["sintomas visíveis"],
 "possibilities": [ {"name": "praga/doença/problema possível", "category": "praga|doenca|daninha|deficiencia|outro", "confidence": 0.0-1.0, "reasoning": "por que"} ],
 "alternative_causes": ["causas alternativas (nutricional, hídrica, clima, fitotoxicidade, etc.)"],
 "investigation_steps": ["como confirmar em campo (monitoramento, amostragem, análise laboratorial)"],
 "general_management": ["recomendações gerais de manejo cultural e monitoramento"],
 "needs_agronomist": true,
 "limitations": "o que a imagem NÃO permite concluir"
}
Regras obrigatórias: nunca afirme certeza quando a imagem não permitir; use confiança baixa quando houver dúvida; se a imagem não mostrar planta ou estiver ruim, use image_usable=false e possibilities vazio;
NÃO recomende produtos químicos, princípios ativos, marcas ou dosagens; indique sempre a avaliação por engenheiro agrônomo habilitado (receituário agronômico quando aplicável).`;

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('A resposta do modelo não veio em JSON.');
  return JSON.parse(s.slice(start, end + 1));
}

function normalize(obj) {
  const arr = (x) => (Array.isArray(x) ? x.map((i) => String(i).slice(0, 500)).slice(0, 12) : []);
  const poss = Array.isArray(obj.possibilities) ? obj.possibilities.slice(0, 6).map((p) => {
    let c = Number(p && p.confidence);
    if (!Number.isFinite(c)) c = 0;
    if (c > 1 && c <= 100) c /= 100;
    return {
      name: String((p && p.name) || 'Não especificado').slice(0, 150),
      category: ['praga', 'doenca', 'daninha', 'deficiencia', 'outro'].includes(p && p.category) ? p.category : 'outro',
      confidence: Math.max(0, Math.min(1, c)), reasoning: String((p && p.reasoning) || '').slice(0, 600),
    };
  }) : [];
  poss.sort((a, b) => b.confidence - a.confidence);
  return {
    image_usable: obj.image_usable !== false, summary: String(obj.summary || '').slice(0, 800), observed_symptoms: arr(obj.observed_symptoms),
    possibilities: poss, alternative_causes: arr(obj.alternative_causes), investigation_steps: arr(obj.investigation_steps),
    general_management: arr(obj.general_management), needs_agronomist: true, limitations: String(obj.limitations || '').slice(0, 800),
  };
}

async function analyze({ imagePath, mime, crop, symptoms, plotName, farmName }) {
  if (!config.ai.enabled) {
    return { status: 'indisponivel', message: 'A análise automática ainda não foi configurada neste servidor (defina ANTHROPIC_API_KEY). A foto e as informações foram salvas e poderão ser analisadas depois.' };
  }
  const data = fs.readFileSync(imagePath).toString('base64');
  const info = [
    farmName && `Fazenda: ${farmName}`, plotName && `Talhão: ${plotName}`, crop && `Cultura: ${crop}`, symptoms && `Sintomas descritos pelo usuário: ${symptoms}`,
  ].filter(Boolean).join('\n') || 'Sem informações adicionais.';
  const body = {
    model: config.ai.model, max_tokens: 1800, system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: `Informações:\n${info}\n\nResponda apenas com o JSON.` }] }],
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.ai.timeoutMs);
  try {
    const r = await fetch(`${config.ai.apiBase}/v1/messages`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[ia] erro da API:', r.status, txt.slice(0, 300));
      return { status: 'erro', message: `O serviço de análise respondeu com erro (${r.status}). Tente novamente mais tarde.` };
    }
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const result = normalize(extractJson(text));
    const top = result.possibilities[0];
    return { status: 'concluida', result, confidence: top ? top.confidence : null, model: j.model || config.ai.model };
  } catch (e) {
    console.error('[ia] falha:', e.message);
    return { status: 'erro', message: e.name === 'AbortError' ? 'A análise demorou demais e foi cancelada. Tente novamente.' : 'Não foi possível concluir a análise automática. Tente novamente mais tarde.' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { analyze };
