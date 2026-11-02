require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
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

// ---------- utilidades ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phoneOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
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
Analise a imagem e responda SOMENTE com um JSON válido neste formato:
{"estabelecimento": string, "data": "YYYY-MM-DD" ou null, "valor_total": number, "categoria": string, "itens": [{"nome_produto": string, "quantidade": number, "valor_unitario": number, "valor_total": number}]}
Regras:
- Números com ponto decimal, sem símbolo de moeda.
- "categoria" deve ser exatamente uma de: ${categorias.join(' | ')}.
- Se não houver itens legíveis, devolva "itens": [].
- Não invente dados que não aparecem na imagem.`;

  const res = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
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
async function processarFoto(msg, usuario, baileys) {
  const { downloadMediaMessage, normalizeMessageContent } = baileys;
  const content = normalizeMessageContent(msg.message);
  const img = content?.imageMessage;
  if (!img) return;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });

    const [{ data: categorias }, { data: cartoes }] = await Promise.all([
      supabase.from('categorias').select('id,nome'),
      supabase.from('cartoes_credito').select('*').order('nome_cartao'),
    ]);

    const nota = await extrairNota(buffer, img.mimetype || 'image/jpeg', categorias.map((c) => c.nome));
    if (!nota.valor_total) throw new Error('valor total não identificado');

    const { tipo, cartao, parcelas } = lerLegenda(img.caption || '', cartoes);
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
      { text: '⚠️ Não consegui ler essa nota. Tente outra foto, mais nítida e com o cupom inteiro, ou lance pelo app.' },
      { quoted: msg }
    );
  }
}

// ---------- WhatsApp ----------
async function resolverGrupo() {
  const grupos = await sock.groupFetchAllParticipating();
  const g = Object.values(grupos).find((x) => norm(x.subject) === norm(WHATSAPP_GROUP_NAME));
  if (g) groupJid = g.id;
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
      console.log('\n📱 Escaneie o QR Code com o WhatsApp (Aparelhos conectados > Conectar um aparelho):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp conectado.');
      const jid = await resolverGrupo().catch(() => null);
      console.log(jid ? `👥 Grupo "${WHATSAPP_GROUP_NAME}" encontrado.` : `⚠️ Grupo "${WHATSAPP_GROUP_NAME}" não encontrado. O número pareado precisa estar nele.`);
    }
    if (connection === 'close') {
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
        if (!content?.imageMessage) continue;

        // Se o bot está pareado no número de um dos dois, a mensagem vem como fromMe.
        const remetente = msg.key.fromMe ? sock.user?.id : msg.key.participantPn || msg.key.participant;
        const tel = phoneOf(remetente);

        const { data: usuarios } = await supabase.from('usuarios').select('*');
        const usuario = usuarios?.find((u) => phoneOf(u.telefone_whatsapp) === tel);
        if (!usuario) {
          console.log(`Foto ignorada: remetente ${remetente} não está cadastrado.`);
          continue;
        }
        await processarFoto(msg, usuario, baileys);
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
app.listen(PORT, () => console.log(`🌐 PWA em http://localhost:${PORT}`));

iniciarWhatsApp().catch((e) => {
  console.error('Falha ao iniciar WhatsApp:', e);
  process.exit(1);
});
