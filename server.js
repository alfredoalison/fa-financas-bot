require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  WHATSAPP_GROUP_NAME = 'F&A Finanças',
  TZ_APP = 'America/Fortaleza',
  PORT = 3000,
  QR_TOKEN,
  GEMINI_MODEL = 'gemini-2.0-flash',
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY })) {
  if (!v) {
    console.error(`❌ Variável ${k} ausente no .env`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const logger = pino({ level: 'silent' });

let sock = null;
let groupJid = null;
let currentQR = null; // último QR gerado pelo Baileys (null quando não há pareamento pendente)
let whatsappConectado = false;

// ---------- utilidades ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phoneOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// Chave de comparação de telefone: DDD + últimos 8 dígitos. Ignora o 55 e o 9º dígito,
// que o WhatsApp às vezes omite em números brasileiros (5584981767874 x 558481767874).
function phoneKey(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : d;
}

// ---- Identificação do remetente quando o WhatsApp envia "xxx@lid" ----
const isLid = (jid) => String(jid || '').endsWith('@lid');
const lidKey = (jid) => `${phoneOf(jid)}@lid`; // remove sufixo de dispositivo (":12")
const lidParaTelefone = new Map(); // "123456@lid" -> "5584981767874"

// Mapeamento manual opcional (último recurso): LID_MAP="111@lid=5584981767874,222@lid=5584986250294"
for (const par of (process.env.LID_MAP || '').split(',')) {
  const [lid, tel] = par.split('=').map((x) => x && x.trim());
  if (lid && tel) lidParaTelefone.set(lidKey(lid), tel.replace(/\D/g, ''));
}

// Aprende LID -> telefone a partir da lista de participantes do grupo.
// Baileys 7.x: { id: "xxx@lid", phoneNumber: "55...@s.whatsapp.net" }; 6.x: { id: "55...@s.whatsapp.net", lid: "xxx@lid" }.
function guardarParticipantes(participants = []) {
  for (const p of participants) {
    const ids = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).map(String);
    const lid = ids.find(isLid);
    const pn = ids.find((x) => x.endsWith('@s.whatsapp.net'));
    if (lid && pn) lidParaTelefone.set(lidKey(lid), phoneOf(pn));
  }
}

// Devolve o telefone real (só dígitos) de quem enviou a mensagem, ou null.
async function resolverRemetente(msg) {
  const k = msg.key;
  if (k.fromMe) return phoneOf(sock.user?.id); // bot pareado no número de um dos dois

  const candidatos = [k.participantPn, k.participantAlt, k.senderPn, msg.participant, k.participant].filter(Boolean);

  // 1) o número real já veio na mensagem
  const pn = candidatos.find((j) => String(j).endsWith('@s.whatsapp.net'));
  if (pn) return phoneOf(pn);

  // 2) veio como @lid: cache -> mapeamento interno do Baileys -> metadados do grupo
  const lid = candidatos.find(isLid);
  if (!lid) return null;
  if (lidParaTelefone.has(lidKey(lid))) return lidParaTelefone.get(lidKey(lid));

  try {
    const viaBaileys = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
    if (viaBaileys) {
      lidParaTelefone.set(lidKey(lid), phoneOf(viaBaileys));
      return phoneOf(viaBaileys);
    }
  } catch (_) { /* versão sem lidMapping */ }

  const agora = Date.now();
  if (agora - (lidTentativas.get(lidKey(lid)) || 0) > 10 * 60 * 1000) {
    lidTentativas.set(lidKey(lid), agora);
    try {
      const meta = await sock.groupMetadata(groupJid);
      guardarParticipantes(meta.participants);
    } catch (_) { /* segue para o fallback */ }
  }

  return lidParaTelefone.get(lidKey(lid)) || null;
}

// ---- Vínculo LID -> usuário, aprendido uma vez e guardado no Supabase (tabela lid_usuarios) ----
const lidUsuario = new Map();   // "219228300943587@lid" -> usuarios.id
const pendentes = new Map();    // lidKey -> { msg, midia } aguardando o remetente se identificar
const lidTentativas = new Map(); // lidKey -> timestamp da última consulta aos metadados do grupo

const lidDoRemetente = (msg) =>
  [msg.key.participantPn, msg.key.participantAlt, msg.key.senderPn, msg.participant, msg.key.participant]
    .filter(Boolean)
    .find(isLid);

async function carregarLidUsuarios() {
  const { data, error } = await supabase.from('lid_usuarios').select('lid,usuario_id');
  if (error) return console.log('⚠️ Tabela lid_usuarios indisponível (rode o SQL novo do schema.sql):', error.message);
  for (const r of data) lidUsuario.set(lidKey(r.lid), r.usuario_id);
  console.log(`🔗 ${data.length} vínculo(s) de ID do WhatsApp carregado(s).`);
}

let usuariosCache = { at: 0, data: [] };
async function getUsuarios() {
  if (Date.now() - usuariosCache.at < 60_000 && usuariosCache.data.length) return usuariosCache.data;
  const { data, error } = await supabase.from('usuarios').select('*');
  if (error) throw error;
  usuariosCache = { at: Date.now(), data };
  return data;
}

// Aceita imagem e PDF. Devolve null para qualquer outro tipo de mensagem.
const MAX_MIDIA = 18 * 1024 * 1024; // limite prático para enviar inline ao Gemini
function extrairMidia(content) {
  const img = content?.imageMessage;
  if (img) return { tipo: 'imagem', mimetype: img.mimetype || 'image/jpeg', caption: img.caption || '' };
  const doc = content?.documentMessage;
  if (doc && String(doc.mimetype || '').toLowerCase().startsWith('application/pdf')) {
    return { tipo: 'PDF', mimetype: 'application/pdf', caption: doc.caption || '' };
  }
  return null;
}
const hojeLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ_APP });
const pad = (n) => String(n).padStart(2, '0');

function toNum(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : 0;
  let s = String(x ?? '').replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function addMonths(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n - 1;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}

// Mês (YYYY-MM) de vencimento da fatura que recebe a compra.
// Nubank (fecha 30, vence 7): compra 15/10 -> 2026-11. Mercado Pago (fecha 7, vence 14): compra 10/10 -> 2026-11.
function calcularFatura(dataISO, diaFech, diaVenc) {
  const [y, m, d] = dataISO.split('-').map(Number);
  let fy = y, fm = m;
  if (d > diaFech) { fm++; if (fm > 12) { fm = 1; fy++; } }
  let vy = fy, vm = fm;
  if (diaVenc <= diaFech) { vm++; if (vm > 12) { vm = 1; vy++; } }
  return `${vy}-${pad(vm)}`;
}

// ---------- Gemini ----------
async function extrairNota(buffer, mimeType, categorias) {
  const prompt = `Você extrai dados de notas fiscais, cupons e comprovantes brasileiros.
Analise o arquivo (imagem ou PDF) e responda SOMENTE com um JSON válido neste formato:
{"estabelecimento": string, "data": "YYYY-MM-DD" ou null, "valor_total": number, "categoria": string, "itens": [{"nome_produto": string, "quantidade": number, "valor_unitario": number, "valor_total": number}]}
Regras:
- Números com ponto decimal, sem símbolo de moeda.
- "categoria" deve ser exatamente uma de: ${categorias.join(' | ')}.
- Se não houver itens legíveis, devolva "itens": [].
- Não invente dados que não aparecem no arquivo.`;

  const res = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { inlineData: { mimeType, data: buffer.toString('base64') } },
      { text: prompt },
    ],
    config: { responseMimeType: 'application/json', temperature: 0 },
  });

  const txt = (res.text || '').replace(/```json|```/g, '').trim();
  const raw = JSON.parse(txt);

  const itens = (Array.isArray(raw.itens) ? raw.itens : []).map((i) => {
    const quantidade = toNum(i.quantidade) || 1;
    const valor_total = toNum(i.valor_total);
    const valor_unitario = toNum(i.valor_unitario) || (valor_total ? valor_total / quantidade : 0);
    return {
      nome_produto: String(i.nome_produto || 'Item').slice(0, 200),
      quantidade,
      valor_unitario: +valor_unitario.toFixed(2),
      valor_total: +(valor_total || valor_unitario * quantidade).toFixed(2),
    };
  });

  let valor_total = toNum(raw.valor_total);
  if (!valor_total) valor_total = itens.reduce((s, i) => s + i.valor_total, 0);

  const data = /^\d{4}-\d{2}-\d{2}$/.test(raw.data || '') ? raw.data : null;
  return {
    estabelecimento: String(raw.estabelecimento || 'Não identificado').slice(0, 200),
    data,
    valor_total: +valor_total.toFixed(2),
    categoria: raw.categoria || 'Outros',
    itens,
  };
}

// Legenda da foto: "credito nubank 3x", "pix", "debito".
function lerLegenda(caption, cartoes) {
  const t = norm(caption);
  let tipo = 'DÉBITO';
  let cartao = null;
  if (/\bpix\b/.test(t)) tipo = 'PIX';
  else if (/\bdebito\b/.test(t)) tipo = 'DÉBITO';
  else {
    cartao = cartoes.find((c) => t.includes(norm(c.nome_cartao).split(' ')[0])) || null;
    if (cartao || /\b(credito|cred)\b/.test(t)) tipo = 'CRÉDITO';
  }
  if (tipo === 'CRÉDITO' && !cartao) cartao = cartoes[0] || null;
  const m = t.match(/(\d{1,2})\s*x\b/);
  const parcelas = tipo === 'CRÉDITO' && m ? Math.min(24, Math.max(1, parseInt(m[1], 10))) : 1;
  return { tipo, cartao, parcelas };
}

// ---------- processamento de foto ----------
async function processarMidia(msg, usuario, midia, baileys) {
  const { downloadMediaMessage } = baileys;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    if (buffer.length > MAX_MIDIA) throw new Error('arquivo muito grande');

    const [{ data: categorias }, { data: cartoes }] = await Promise.all([
      supabase.from('categorias').select('id,nome'),
      supabase.from('cartoes_credito').select('*').order('nome_cartao'),
    ]);

    const nota = await extrairNota(buffer, midia.mimetype, categorias.map((c) => c.nome));
    if (!nota.valor_total) throw new Error('valor total não identificado');

    const { tipo, cartao, parcelas } = lerLegenda(midia.caption, cartoes);
    const dataISO = nota.data || hojeLocal();
    const cat =
      categorias.find((c) => norm(c.nome) === norm(nota.categoria)) ||
      categorias.find((c) => norm(c.nome) === 'outros') ||
      null;

    const base = {
      usuario_id: usuario.id,
      tipo_pagamento: tipo,
      categoria_id: cat?.id || null,
      estabelecimento: nota.estabelecimento,
      data_transacao: dataISO,
    };

    const rows = [];
    if (tipo === 'CRÉDITO' && cartao) {
      const fat = calcularFatura(dataISO, cartao.dia_fechamento, cartao.dia_vencimento);
      const cents = Math.round(nota.valor_total * 100);
      const parte = Math.floor(cents / parcelas);
      for (let i = 0; i < parcelas; i++) {
        const c = i === parcelas - 1 ? cents - parte * (parcelas - 1) : parte;
        rows.push({
          ...base,
          cartao_id: cartao.id,
          fatura_mes_ano: addMonths(fat, i),
          valor_total: c / 100,
          parcelado: parcelas > 1,
          parcela_atual: i + 1,
          parcelas_totais: parcelas,
        });
      }
    } else {
      rows.push({ ...base, valor_total: nota.valor_total, parcelado: false });
    }

    const { data: inseridas, error } = await supabase.from('transacoes').insert(rows).select('id,parcela_atual');
    if (error) throw error;

    // Itens ficam na primeira parcela (ou na única transação).
    const primeira = inseridas.find((t) => (t.parcela_atual || 1) === 1) || inseridas[0];
    if (nota.itens.length) {
      const { error: errItens } = await supabase
        .from('itens_transacao')
        .insert(nota.itens.map((i) => ({ ...i, transacao_id: primeira.id })));
      if (errItens) throw errItens;
    }

    const primeiroNome = usuario.nome.split(' ')[0];
    let resp = `✅ Nota de R$ ${brl(nota.valor_total)} registrada para ${primeiroNome}! ${nota.itens.length} itens salvos.`;
    resp += `\n${midia.tipo === 'PDF' ? '📄 Lido de um PDF' : '🖼️ Lido de uma imagem'}`;
    resp += `\n🏪 ${nota.estabelecimento} · ${tipo}`;
    if (tipo === 'CRÉDITO' && cartao) {
      const [fy, fm] = rows[0].fatura_mes_ano.split('-');
      resp += ` · ${cartao.nome_cartao}${parcelas > 1 ? ` ${parcelas}x` : ''} (fatura ${fm}/${fy})`;
    }
    await sock.sendMessage(groupJid, { text: resp }, { quoted: msg });
  } catch (err) {
    console.error('Erro ao processar foto:', err);
    await sock.sendMessage(
      groupJid,
      { text: `⚠️ Não consegui ler ${midia.tipo === 'PDF' ? 'esse PDF' : 'essa imagem'}. Tente outro arquivo, mais nítido e com a nota inteira, ou lance pelo app.` },
      { quoted: msg }
    );
  }
}

// ---------- WhatsApp ----------
async function resolverGrupo() {
  const grupos = await sock.groupFetchAllParticipating();
  const g = Object.values(grupos).find((x) => norm(x.subject) === norm(WHATSAPP_GROUP_NAME));
  if (g) {
    groupJid = g.id;
    guardarParticipantes(g.participants);
  }
  return groupJid;
}

async function iniciarWhatsApp() {
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.makeWASocket || baileys.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger, browser: ['F&A Finanças', 'Chrome', '1.0.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      whatsappConectado = false;
      console.log('\n📱 Novo QR Code gerado. Abra a rota /qr no navegador para escanear (ou use o QR abaixo):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      currentQR = null;
      whatsappConectado = true;
      console.log('✅ WhatsApp conectado.');
      await carregarLidUsuarios();
      const jid = await resolverGrupo().catch(() => null);
      console.log(jid ? `👥 Grupo "${WHATSAPP_GROUP_NAME}" encontrado.` : `⚠️ Grupo "${WHATSAPP_GROUP_NAME}" não encontrado. O número pareado precisa estar nele.`);
    }
    if (connection === 'close') {
      whatsappConectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('🚪 Sessão encerrada. Apague a pasta auth_info e reinicie para parear de novo.');
      } else {
        console.log('🔄 Conexão perdida, reconectando...');
        setTimeout(iniciarWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid || '';
        if (!jid.endsWith('@g.us')) continue;
        if (!groupJid) await resolverGrupo();
        if (jid !== groupJid) continue;

        const content = baileys.normalizeMessageContent(msg.message);
        const midia = extrairMidia(content);
        const texto = content?.conversation || content?.extendedTextMessage?.text || '';
        // "sou Alfredo" / "sou a Fernanda": usado só para vincular um ID desconhecido a um usuário.
        const reivindicacao = norm(texto).match(/^(?:eu\s+)?sou\s+(?:o\s+|a\s+)?([a-z]+)\s*[.!]?$/);
        if (!midia && !reivindicacao) continue;

        const usuarios = await getUsuarios();
        const tel = await resolverRemetente(msg);
        const lid = lidDoRemetente(msg);

        let usuario = tel ? usuarios.find((u) => phoneKey(u.telefone_whatsapp) === phoneKey(tel)) : null;
        if (!usuario && lid) usuario = usuarios.find((u) => u.id === lidUsuario.get(lidKey(lid)));

        if (usuario) {
          if (midia) await processarMidia(msg, usuario, midia, baileys);
          continue;
        }

        if (!lid) {
          console.log(`Mensagem ignorada: remetente ${tel ? `com telefone ${tel} não cadastrado` : 'não identificado'}.`);
          continue;
        }

        const nomes = usuarios.map((u) => `"sou ${u.nome.split(' ')[0]}"`).join(' ou ');

        if (reivindicacao) {
          const alvo = usuarios.find((u) => norm(u.nome).split(' ')[0] === reivindicacao[1]);
          if (!alvo) {
            await sock.sendMessage(groupJid, { text: `Não conheço "${reivindicacao[1]}". Responda ${nomes}.` }, { quoted: msg });
            continue;
          }
          lidUsuario.set(lidKey(lid), alvo.id);
          const { error } = await supabase.from('lid_usuarios').upsert({ lid: lidKey(lid), usuario_id: alvo.id });
          if (error) console.log('⚠️ Vínculo não salvo no banco (vale só até reiniciar):', error.message);
          await sock.sendMessage(groupJid, { text: `✅ Combinado, ${alvo.nome.split(' ')[0]}! Guardei seu ID, não precisa repetir.` }, { quoted: msg });
          const pend = pendentes.get(lidKey(lid));
          if (pend) {
            pendentes.delete(lidKey(lid));
            await processarMidia(pend.msg, alvo, pend.midia, baileys);
          }
          continue;
        }

        // Arquivo de alguém ainda não identificado: guarda e pede identificação (uma vez).
        const jaPediu = pendentes.has(lidKey(lid));
        pendentes.set(lidKey(lid), { msg, midia });
        if (!jaPediu) {
          await sock.sendMessage(
            groupJid,
            { text: `👋 Não consegui identificar quem enviou esse arquivo. Responda ${nomes} que eu registro agora (só precisa fazer isso uma vez).` },
            { quoted: msg }
          );
        }
      } catch (err) {
        console.error('Erro na mensagem:', err);
      }
    }
  });
}

// ---------- Resumo diário 21:00 ----------
async function enviarResumoDiario() {
  try {
    if (!sock || !groupJid) await resolverGrupo().catch(() => null);
    if (!sock || !groupJid) return console.log('Resumo não enviado: grupo indisponível.');

    const hoje = hojeLocal();
    const [{ data: usuarios }, { data: trans, error }] = await Promise.all([
      supabase.from('usuarios').select('id,nome').order('nome'),
      supabase.from('transacoes').select('usuario_id,valor_total').eq('data_transacao', hoje).neq('tipo_pagamento', 'RECEITA'),
    ]);
    if (error) throw error;

    const totais = {};
    for (const t of trans) totais[t.usuario_id] = (totais[t.usuario_id] || 0) + Number(t.valor_total);

    const linhas = usuarios.map((u) => `👤 ${u.nome.split(' ')[0]}: R$ ${brl(totais[u.id] || 0)}`);
    const total = Object.values(totais).reduce((s, v) => s + v, 0);
    const texto = `📊 RESUMO DO DIA - F&A FINANÇAS\n---\n${linhas.join('\n')}\n💰 Total do Dia: R$ ${brl(total)}`;
    await sock.sendMessage(groupJid, { text: texto });
  } catch (err) {
    console.error('Erro no resumo diário:', err);
  }
}

cron.schedule('0 21 * * *', enviarResumoDiario, { timezone: TZ_APP });

// ---------- Servidor web (serve o PWA) ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Página com o QR Code de pareamento do WhatsApp (atualiza sozinha a cada 5 s).
// Se QR_TOKEN estiver definido no ambiente, acesse /qr?token=SEU_TOKEN.
app.get('/qr', async (req, res) => {
  if (QR_TOKEN && req.query.token !== QR_TOKEN) return res.status(401).send('Não autorizado.');
  res.set('Cache-Control', 'no-store');

  const page = (body, refresh) => `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>F&A Finanças - QR Code</title>
<style>
  *{border-radius:0!important;box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A0A;color:#EDEDED;font-family:'Courier New',monospace;text-align:center;padding:16px}
  main{max-width:420px;width:100%;background:#161616;border:1px solid #333;padding:24px}
  h1{font-size:18px;margin:0 0 16px}
  img{display:block;width:100%;max-width:320px;margin:0 auto 16px;background:#fff;image-rendering:pixelated}
  p{margin:0;color:#8A8A8A;font-size:13px;line-height:1.5}
</style></head><body><main>${body}</main></body></html>`;

  if (whatsappConectado) {
    return res.send(page('<h1>✅ WhatsApp conectado</h1><p>Não é preciso escanear nada.</p>', false));
  }
  if (!currentQR) {
    return res.send(page('<h1>Aguardando QR Code…</h1><p>Um novo código aparece em instantes. A página atualiza sozinha.</p>', true));
  }
  try {
    const img = await QRCode.toDataURL(currentQR, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.send(page(
      `<h1>Escaneie com o WhatsApp</h1><img src="${img}" alt="QR Code do WhatsApp"><p>WhatsApp &gt; Aparelhos conectados &gt; Conectar um aparelho. O código troca a cada ~20 s e esta página atualiza sozinha.</p>`,
      true
    ));
  } catch (err) {
    console.error('Erro ao gerar imagem do QR:', err);
    res.status(500).send('Erro ao gerar o QR Code.');
  }
});
app.listen(PORT, () => console.log(`🌐 PWA em http://localhost:${PORT}`));

iniciarWhatsApp().catch((e) => {
  console.error('Falha ao iniciar WhatsApp:', e);
  process.exit(1);
});
